import { bytesToHex } from 'viem'
import { decimalsOf, parsePx, parseQty, wireDecimal } from '@tape/core/fixed'
import type { Px, Scale } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import type { Network } from '@tape/core/ids'
import { checkPrice, checkSize, worstPrice } from '../intent'
import { send } from '../send'
import { TradeFailure } from '../types'
import type {
  AccountView,
  Command,
  CommandOutcome,
  Decimal,
  HistoryRequest,
  OrderIntent,
  OrderLookup,
  OrderRef,
  SetupStep,
  StepId,
  TradeError,
  TradingVenue,
  VenueContext,
  WalletSigner,
} from '../types'
import type { FundingPayment, HistoryFill, VenueHistory } from '../history'
import { ONBOARDING_CHAIN, deriveKey, onboarding, sdk, validatorOf, walletOf } from './client'
import { LONG_TERM_SECONDS, clientIdOf, quantums, subticks } from './wire'
import type { ClobMarket } from './wire'

const INDEXER: Record<Network, string> = {
  mainnet: 'https://indexer.dydx.trade/v4',
  testnet: 'https://indexer.v4testnet.dydx.exchange/v4',
}
const CANCEL_SECONDS = 60
const SIDE = { buy: 1, sell: 2 } as const
const TIF = { gtc: 0, ioc: 1, 'post-only': 2 } as const
const FLAGS = { short: 0, long: 64 } as const

interface Market extends ClobMarket {
  readonly spec: MarketSpec
}

function fail(error: TradeError): never {
  throw new TradeFailure('dydx', error)
}

/** The client queries the chain account before it signs, so an unfunded address fails there, not at broadcast. */
export function classifyMessage(message: string): TradeError {
  if (/account .*(?:does not exist|not found)|no subaccount/i.test(message))
    return { kind: 'no-account', detail: message }
  if (/rate (?:limit )?exceeded/i.test(message)) return { kind: 'rate-limited', detail: message }
  if (/insufficient|undercollateralized|collateral/i.test(message))
    return { kind: 'insufficient-margin', detail: message }
  if (/quantums|subticks|price|size|tick|step/i.test(message)) return { kind: 'invalid-order', detail: message }
  return { kind: 'unknown-outcome', detail: message }
}

const indexerAt = <T>(network: Network, fetch: typeof globalThis.fetch, path: string) =>
  send<T>('dydx', fetch, `${INDEXER[network]}${path}`, { mutates: false }, (status, _b, text) =>
    status === 404 ? { kind: 'rejected', detail: text } : null,
  )
const indexer = <T>(ctx: VenueContext, path: string) => indexerAt<T>(ctx.ref.network, ctx.fetch, path)

const markets = new Map<string, Promise<Market>>()
function market(ctx: VenueContext, ticker: string): Promise<Market> {
  const key = `${ctx.ref.network}:${ticker}`
  let cached = markets.get(key)
  if (!cached) {
    type M = {
      clobPairId: string
      atomicResolution: string
      quantumConversionExponent: string
      stepBaseQuantums: string
      subticksPerTick: string
      tickSize: string
      stepSize: string
    }
    cached = indexer<{ markets: Record<string, M> }>(ctx, `/perpetualMarkets?ticker=${ticker}`).then(
      ({ markets: all }) => {
        const m =
          all[ticker] ?? fail({ kind: 'invalid-order', detail: `${ticker} is not listed on dYdX ${ctx.ref.network}` })
        const scale: Scale = { px: decimalsOf(m.tickSize), qty: decimalsOf(m.stepSize) }
        return {
          clobPairId: Number(m.clobPairId),
          atomicResolution: Number(m.atomicResolution),
          quantumConversionExponent: Number(m.quantumConversionExponent),
          stepBaseQuantums: Number(m.stepBaseQuantums),
          subticksPerTick: Number(m.subticksPerTick),
          spec: {
            venueSymbol: ticker,
            scale,
            tick: { kind: 'fixed', tick: parsePx(m.tickSize, scale) },
            step: parseQty(m.stepSize, scale),
          } as unknown as MarketSpec,
        }
      },
    )
    cached.catch(() => markets.delete(key))
    markets.set(key, cached)
  }
  return cached
}

function mnemonicOf(ctx: VenueContext): string {
  return ctx.keys.read()?.secret ?? fail({ kind: 'needs-setup', detail: 'Unlock the dYdX key in this tab first' })
}

/** Long-term orders and cancels share the account sequence, so one tab at a time signs them. */
function sequenced<T>(address: string, run: () => Promise<T>): Promise<T> {
  return typeof navigator !== 'undefined' && 'locks' in navigator
    ? navigator.locks.request(`tape:dydx:sequence:${address}`, run)
    : run()
}

/** The client throws plain errors for chain refusals; a reply with a non-zero code is a refusal too. */
async function broadcast(run: () => Promise<unknown>): Promise<string> {
  let reply: { code?: number; log?: string; hash?: Uint8Array | string } | undefined
  try {
    reply = (await run()) as typeof reply
  } catch (e) {
    if (e instanceof TradeFailure) throw e
    fail(classifyMessage(e instanceof Error ? e.message : String(e)))
  }
  if (reply?.code) {
    const log = reply.log ?? `code ${reply.code}`
    const error = classifyMessage(log)
    fail(error.kind === 'unknown-outcome' ? { kind: 'rejected', detail: log } : error)
  }
  const hash = reply?.hash instanceof Uint8Array ? bytesToHex(reply.hash).slice(2).toUpperCase() : reply?.hash
  if (!hash) fail({ kind: 'unknown-outcome', detail: `No transaction hash in the reply: ${JSON.stringify(reply)}` })
  return hash
}

function recheckPx(m: Market, intent: OrderIntent, px: Px): Px {
  const wire = wireDecimal(px, intent.spec.scale.px)
  const issue = checkPrice(m.spec, wire)
  return issue
    ? fail({ kind: 'invalid-order', detail: `Price ${wire}: ${issue} on this network` })
    : parsePx(wire, m.spec.scale)
}

async function place(ctx: VenueContext, intent: OrderIntent): Promise<CommandOutcome> {
  if (intent.order.kind === 'trailing') fail({ kind: 'unsupported', detail: 'dYdX has no trailing stop' })
  if (intent.triggers.takeProfits.length > 0 || intent.triggers.stopLoss !== null)
    fail({ kind: 'unsupported', detail: 'dYdX takes no take profit or stop loss from Tape' })
  const m = await market(ctx, intent.spec.venueSymbol)
  const size = wireDecimal(intent.size, intent.spec.scale.qty)
  const sizeIssue = checkSize(m.spec, size)
  if (sizeIssue) fail({ kind: 'invalid-order', detail: `Size ${size}: ${sizeIssue} on this network` })
  if (intent.order.kind === 'scale') fail({ kind: 'unsupported', detail: 'dYdX takes no scale order from Tape' })
  let px: Px
  let tif: 0 | 1 | 2
  if (intent.order.kind === 'limit') {
    px = recheckPx(m, intent, intent.order.px)
    tif = TIF[intent.order.tif]
  } else {
    const book = await indexer<{ bids: { price: string }[]; asks: { price: string }[] }>(
      ctx,
      `/orderbooks/perpetualMarket/${intent.spec.venueSymbol}`,
    )
    const far = intent.side === 'buy' ? book.asks[0] : book.bids[0]
    if (!far) fail({ kind: 'invalid-order', detail: 'The book on this network is empty' })
    px = worstPrice(m.spec, intent.side, parsePx(far.price, m.spec.scale), intent.order.slippage)
    tif = TIF.ioc
  }
  const { default: Long } = await import('long')
  const { SubaccountInfo, SHORT_BLOCK_FORWARD } = await sdk()
  const wallet = await walletOf(mnemonicOf(ctx))
  const subaccount = SubaccountInfo.forLocalWallet(wallet, 0)
  const client = await validatorOf(ctx.ref.network)
  const q = Long.fromString(quantums(parseQty(size, m.spec.scale), m.spec.scale, m).toString(), true)
  const s = Long.fromString(subticks(px, m.spec.scale, m).toString(), true)
  const builder = ctx.config.dydx.builder ?? undefined
  const clientId = clientIdOf(intent.clientId)
  const short = tif === TIF.ioc
  const hash = short
    ? await broadcast(async () => {
        const height = await client.get.latestBlockHeight()
        return client.post.placeOrder(
          subaccount,
          clientId,
          m.clobPairId,
          SIDE[intent.side],
          q,
          s,
          tif,
          FLAGS.short,
          intent.reduceOnly,
          height + SHORT_BLOCK_FORWARD,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          builder,
        )
      })
    : await sequenced(wallet.address ?? '', () =>
        broadcast(() =>
          client.post.placeOrder(
            subaccount,
            clientId,
            m.clobPairId,
            SIDE[intent.side],
            q,
            s,
            tif,
            FLAGS.long,
            intent.reduceOnly,
            undefined,
            Math.floor(Date.now() / 1000) + LONG_TERM_SECONDS,
            undefined,
            undefined,
            undefined,
            undefined,
            builder,
          ),
        ),
      )
  return { kind: 'placed', status: short ? 'accepted' : 'resting', detail: `Broadcast ${hash}` }
}

interface IndexerOrder {
  id: string
  clientId: string
  clobPairId: string
  ticker: string
  side: 'BUY' | 'SELL'
  size: string
  price: string
  type: string
  reduceOnly: boolean
  orderFlags: string
  goodTilBlock?: string
  updatedAt?: string
}

const refOf = (o: IndexerOrder) => `${o.ticker}:${o.clientId}:${o.orderFlags}:${o.clobPairId}` as OrderRef

async function cancel(ctx: VenueContext, ref: OrderRef): Promise<void> {
  const [, clientId, flags, clobPairId] = ref.split(':') as [string, string, string, string]
  const wallet = await walletOf(mnemonicOf(ctx))
  const { SubaccountInfo, SHORT_BLOCK_FORWARD } = await sdk()
  const subaccount = SubaccountInfo.forLocalWallet(wallet, 0)
  const client = await validatorOf(ctx.ref.network)
  const isShort = Number(flags) === FLAGS.short
  const run = async () => {
    const height = isShort ? (await client.get.latestBlockHeight()) + SHORT_BLOCK_FORWARD : undefined
    return client.post.cancelOrder(
      subaccount,
      Number(clientId),
      Number(flags),
      Number(clobPairId),
      height,
      isShort ? undefined : Math.floor(Date.now() / 1000) + CANCEL_SECONDS,
    )
  }
  try {
    await (isShort ? broadcast(run) : sequenced(wallet.address ?? '', () => broadcast(run)))
  } catch (e) {
    if (!(
      e instanceof TradeFailure
      && 'detail' in e.error
      && /order.*(?:does not exist|not found)|already (?:filled|canceled|cancelled|removed)|cancel(?:lation)? .*already exists/i.test(
        e.error.detail,
      )
    ))
      throw e
  }
}

const addressOf = (ctx: VenueContext) => ctx.keys.read()?.public.address ?? null

async function openOrders(ctx: VenueContext, address: string): Promise<IndexerOrder[]> {
  return indexer<IndexerOrder[]>(
    ctx,
    `/orders?address=${address}&subaccountNumber=0&status=OPEN,BEST_EFFORT_OPENED,UNTRIGGERED&limit=50`,
  )
}

/** The indexer has no clientId filter, so the latest orders on the market are searched. */
async function lookup(ctx: VenueContext, intent: OrderIntent): Promise<OrderLookup> {
  const address = addressOf(ctx) ?? fail({ kind: 'needs-setup', detail: 'Unlock the dYdX key in this tab first' })
  const clientId = String(clientIdOf(intent.clientId))
  let orders: (IndexerOrder & { status: string })[]
  try {
    orders = await indexer(
      ctx,
      `/orders?address=${address}&subaccountNumber=0&ticker=${intent.spec.venueSymbol}&limit=100&returnLatestOrders=true`,
    )
  } catch (e) {
    if (e instanceof TradeFailure && e.error.kind === 'rejected')
      return { kind: 'absent', detail: 'The dYdX indexer has no account for this address' }
    throw e
  }
  const hit = orders.find((o) => o.clientId === clientId)
  return hit
    ? { kind: 'found', detail: `Order ${hit.status.toLowerCase()}` }
    : { kind: 'absent', detail: 'Not in the dYdX indexer yet. It can lag the chain by a few blocks.' }
}

async function execute(ctx: VenueContext, command: Command): Promise<CommandOutcome> {
  switch (command.kind) {
    case 'place':
      return place(ctx, command.intent)
    case 'cancel':
      await cancel(ctx, command.order)
      return { kind: 'done', detail: 'Cancel broadcast' }
    case 'cancel-all': {
      const address = addressOf(ctx) ?? fail({ kind: 'needs-setup', detail: 'Unlock the dYdX key in this tab first' })
      const orders = (await openOrders(ctx, address)).filter((o) => o.ticker === command.symbol)
      for (const o of orders) await cancel(ctx, refOf(o))
      return { kind: 'done', detail: `Canceled ${orders.length}` }
    }
    case 'leverage':
      return fail({ kind: 'unsupported', detail: 'dYdX sets leverage by margin, not by a setting' })
  }
}

async function account(ctx: VenueContext): Promise<AccountView> {
  const address = addressOf(ctx)
  if (!address) return { kind: 'unknown' }
  type Sub = {
    subaccount: {
      equity: string
      freeCollateral: string
      openPerpetualPositions: Record<
        string,
        { market: string; side: 'LONG' | 'SHORT'; size: string; entryPrice: string; unrealizedPnl: string }
      >
    }
  }
  type Fills = {
    fills: {
      id: string
      market: string
      side: 'BUY' | 'SELL'
      price: string
      size: string
      fee: string
      createdAt: string
    }[]
  }
  let sub: Sub
  try {
    sub = await indexer<Sub>(ctx, `/addresses/${address}/subaccountNumber/0`)
  } catch (e) {
    if (e instanceof TradeFailure && e.error.kind === 'rejected') return { kind: 'empty' }
    throw e
  }
  const [orders, fills] = await Promise.all([
    openOrders(ctx, address),
    indexer<Fills>(ctx, `/fills?address=${address}&subaccountNumber=0&limit=20`),
  ])
  const d = (s: string) => s as Decimal
  return {
    kind: 'live',
    snapshot: {
      equity: d(sub.subaccount.equity),
      available: d(sub.subaccount.freeCollateral),
      positions: Object.values(sub.subaccount.openPerpetualPositions).map((p) => ({
        symbol: p.market,
        side: p.side === 'LONG' ? 'long' : 'short',
        size: d(p.size.replace(/^-/, '')),
        entry: d(p.entryPrice),
        unrealizedPnl: d(p.unrealizedPnl),
        liquidation: null,
        leverage: null,
      })),
      orders: orders.map((o) => ({
        ref: refOf(o),
        symbol: o.ticker,
        side: o.side === 'BUY' ? 'buy' : 'sell',
        kind: o.type,
        px: d(o.price),
        size: d(o.size),
        reduceOnly: o.reduceOnly,
        placedAt: o.updatedAt ? Date.parse(o.updatedAt) : 0,
        cancelable: true,
      })),
      fills: fills.fills.map((f) => ({
        id: f.id,
        symbol: f.market,
        side: f.side === 'BUY' ? 'buy' : 'sell',
        px: d(f.price),
        size: d(f.size),
        fee: d(f.fee),
        time: Date.parse(f.createdAt),
      })),
    },
  }
}

async function steps(ctx: VenueContext): Promise<readonly SetupStep[]> {
  return [{ id: 'derive-key', label: 'Unlock your dYdX key in this tab', done: Boolean(ctx.keys.read()?.secret) }]
}

async function enable(ctx: VenueContext, wallet: WalletSigner, onStep: (step: StepId) => void): Promise<void> {
  if (ctx.keys.read()?.secret) return
  onStep('derive-key')
  const chainId = ONBOARDING_CHAIN[ctx.ref.network]
  if ((await wallet.chainId()) !== chainId) await wallet.switchChain(chainId)
  const { mnemonic, address } = await deriveKey(await wallet.signTypedData(onboarding(ctx.ref.network)))
  ctx.keys.write({ status: 'linked', public: { address }, secret: mnemonic })
}

/** The indexer's largest page, and the last page its proxy serves. */
const PAGE = 1000
const LAST_PAGE = 25
/** Fills where the protocol, not the account's own order, closed the position. */
const FORCED = new Set(['LIQUIDATED', 'DELEVERAGED'])

interface IndexerFill {
  id: string
  side: 'BUY' | 'SELL'
  type: string
  market: string
  marketType: string
  price: string
  size: string
  fee: string
  createdAt: string
}

interface IndexerFunding {
  ticker: string
  payment: string
  rate: string
  size: string
  createdAt: string
}

/** Page mode returns fills oldest first by event, which keeps fills in one block in the order they happened. */
async function pages<T>(read: (page: number) => Promise<T[]>): Promise<{ rows: T[]; capped: boolean }> {
  const rows: T[] = []
  for (let page = 1; page <= LAST_PAGE; page++) {
    const got = await read(page)
    rows.push(...got)
    if (got.length < PAGE) return { rows, capped: false }
  }
  return { rows, capped: true }
}

async function history({ network, address, fetch }: HistoryRequest): Promise<VenueHistory> {
  const query = `address=${address}&subaccountNumber=0&limit=${PAGE}`
  let fills: { rows: IndexerFill[]; capped: boolean }
  let funding: { rows: IndexerFunding[]; capped: boolean }
  try {
    ;[fills, funding] = await Promise.all([
      pages((page) =>
        indexerAt<{ fills: IndexerFill[] }>(network, fetch, `/fills?${query}&page=${page}`).then((r) => r.fills),
      ),
      pages((page) =>
        indexerAt<{ fundingPayments: IndexerFunding[] }>(network, fetch, `/fundingPayments?${query}&page=${page}`).then(
          (r) => r.fundingPayments,
        ),
      ),
    ])
  } catch (e) {
    if (e instanceof TradeFailure && e.error.kind === 'rejected') return { fills: [], funding: [], gaps: [] }
    throw e
  }
  const d = (s: string) => s as Decimal
  const perps = fills.rows.filter((f) => f.marketType === 'PERPETUAL')
  const gaps = [
    'dYdX reports no realized PnL per fill, so Tape computes it by average cost over the whole history.',
    'Only subaccount 0 is read. Isolated positions on dYdX live in other subaccounts.',
  ]
  if (fills.capped)
    gaps.push(`dYdX's indexer pages through ${PAGE * LAST_PAGE} fills at most, so some fills are missing.`)
  if (funding.capped)
    gaps.push(
      `dYdX's indexer pages through ${PAGE * LAST_PAGE} funding payments at most, so some payments are missing.`,
    )
  return {
    fills: perps.map((f): HistoryFill => ({
      venue: 'dydx',
      account: address,
      id: f.id,
      symbol: f.market,
      side: f.side === 'BUY' ? 'buy' : 'sell',
      px: d(f.price),
      size: d(f.size),
      fee: d(f.fee),
      asset: 'USDC',
      time: Date.parse(f.createdAt),
      liquidation: FORCED.has(f.type),
      venuePnl: null,
    })),
    funding: funding.rows.map((f): FundingPayment => ({
      venue: 'dydx',
      account: address,
      symbol: f.ticker,
      time: Date.parse(f.createdAt),
      amount: d(f.payment),
      asset: 'USDC',
      rate: d(f.rate),
      position: d(f.size),
    })),
    gaps,
  }
}

export const dydx = {
  id: 'dydx',
  label: 'dYdX',
  secrets: 'tab',
  capabilities: {
    tif: ['gtc', 'ioc', 'post-only'],
    triggers: null,
    leverage: false,
    scaleOrders: 0,
    trailingStop: false,
  },
  walletChain: ONBOARDING_CHAIN,
  unavailable: (network, config) =>
    network === 'mainnet' && !config.mainnet ? 'Mainnet trading is off in this build' : null,
  steps,
  enable,
  account,
  execute,
  lookup,
  history,
} satisfies TradingVenue & { id: 'dydx' }
