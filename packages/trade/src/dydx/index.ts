import { bytesToHex } from 'viem'
import { z } from 'zod'
import { decimalsOf, parsePx, parseQty, wireDecimal } from '@tape/core/fixed'
import type { Px, Scale } from '@tape/core/fixed'
import type { Network } from '@tape/core/ids'
import { canceled, onMarket } from '../cancel-all'
import { closeEach } from '../close-all'
import { EXIT_NAMES, capitalized, exitDetail, notePrice } from '../protect'
import { checkPrice, checkSize, midPrice, worstPrice } from '../intent'
import { lookupSummary } from '../scale-order'
import { readReply, send } from '../send'
import { TradeFailure, orderRef, toDecimal } from '../types'
import type {
  AccountView,
  ClientOrderId,
  Command,
  CommandOutcome,
  HistoryRequest,
  OpenOrder,
  OrderExit,
  OrderIntent,
  OrderLookup,
  OrderRules,
  ProtectIntent,
  OrderRef,
  SentOrders,
  Side,
  SetupStep,
  StepId,
  TradeError,
  TradingVenue,
  VenueContext,
  WalletSigner,
} from '../types'
import type { FundingPayment, HistoryFill, VenueHistory } from '../history'
import { ONBOARDING_CHAIN, deriveKey, onboarding, sdk, validatorOf, walletOf } from './client'
import type { Validator } from './client'
import { LONG_TERM_SECONDS, clientIdOf, quantums, subticks } from './wire'
import type { ClobMarket } from './wire'

const INDEXER: Record<Network, string> = {
  mainnet: 'https://indexer.dydx.trade/v4',
  testnet: 'https://indexer.v4testnet.dydx.exchange/v4',
}
const CANCEL_SECONDS = 60
const SIDE = { buy: 1, sell: 2 } as const
const TIF = { gtc: 0, ioc: 1, 'post-only': 2 } as const
const FLAGS = { short: 0, conditional: 32, long: 64 } as const
/** Order_ConditionType in dydxprotocol/v4-chain proto/dydxprotocol/clob/order.proto. */
const CONDITION = { sl: 1, tp: 2 } as const
/** v4-client-js calculateClientMetadata marks a market order 1, which is how the indexer and v4-web tell one. */
const MARKET_METADATA = 1
/** v4-web bounds a market take profit or stop loss 5% past the trigger on these markets and 10% on the rest. */
const MAJOR_MARKETS = new Set(['BTC-USD', 'ETH-USD', 'SOL-USD'])
const exitSlippageBps = (ticker: string) => (MAJOR_MARKETS.has(ticker) ? 500 : 1000)

interface Market extends ClobMarket {
  readonly spec: OrderRules
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

const indexerAt = <T>(network: Network, fetch: typeof globalThis.fetch, path: string, reply: z.ZodType<T>) =>
  send('dydx', fetch, `${INDEXER[network]}${path}`, { mutates: false }, (status, _b, text) =>
    status === 404 ? { kind: 'rejected', detail: text } : null,
  ).then((body) => readReply('dydx', reply, body, false))
const indexer = <T>(ctx: VenueContext, path: string, reply: z.ZodType<T>) =>
  indexerAt(ctx.ref.network, ctx.fetch, path, reply)

const PerpetualMarkets = z.object({
  markets: z.record(
    z.string(),
    z.object({
      clobPairId: z.string(),
      atomicResolution: z.string(),
      quantumConversionExponent: z.string(),
      stepBaseQuantums: z.string(),
      subticksPerTick: z.string(),
      tickSize: z.string(),
      stepSize: z.string(),
    }),
  ),
})

const markets = new Map<string, Promise<Market>>()
function market(ctx: VenueContext, ticker: string): Promise<Market> {
  const key = `${ctx.ref.network}:${ticker}`
  let cached = markets.get(key)
  if (!cached) {
    cached = indexer(ctx, `/perpetualMarkets?ticker=${ticker}`, PerpetualMarkets).then(({ markets: all }) => {
      const listed =
        all[ticker] ?? fail({ kind: 'invalid-order', detail: `${ticker} is not listed on dYdX ${ctx.ref.network}` })
      const scale: Scale = { px: decimalsOf(listed.tickSize), qty: decimalsOf(listed.stepSize) }
      return {
        clobPairId: Number(listed.clobPairId),
        atomicResolution: Number(listed.atomicResolution),
        quantumConversionExponent: Number(listed.quantumConversionExponent),
        stepBaseQuantums: Number(listed.stepBaseQuantums),
        subticksPerTick: Number(listed.subticksPerTick),
        spec: {
          venueSymbol: ticker,
          scale,
          tick: { kind: 'fixed', tick: parsePx(listed.tickSize, scale) },
          step: parseQty(listed.stepSize, scale),
        },
      }
    })
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

/** v4-client-js takes no AbortSignal and its cosmjs requests set no timeout, so Tape stops waiting well past the client's own 8 s commit wait. */
const BROADCAST_TIMEOUT_MS = 20_000

function withinTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new TradeFailure('dydx', {
            kind: 'unknown-outcome',
            detail: `No reply from the dYdX chain after ${BROADCAST_TIMEOUT_MS / 1000} s`,
          }),
        ),
      BROADCAST_TIMEOUT_MS,
    )
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** The fields Tape reads from the TxResponse or IndexedTx that v4-client-js resolves a broadcast with. */
const BroadcastReply = z
  .looseObject({
    code: z.number().optional(),
    log: z.string().optional(),
    hash: z.union([z.instanceof(Uint8Array), z.string()]).optional(),
  })
  .optional()

/** The client throws plain errors for chain refusals; a reply with a non-zero code is a refusal too. */
async function broadcast(network: Network, run: (client: Validator) => Promise<unknown>): Promise<string> {
  let reply: z.infer<typeof BroadcastReply>
  try {
    reply = readReply('dydx', BroadcastReply, await withinTimeout(validatorOf(network).then(run)), true)
  } catch (error) {
    if (error instanceof TradeFailure) throw error
    fail(classifyMessage(error instanceof Error ? error.message : String(error)))
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

function recheckPx(perp: Market, intent: OrderIntent, px: Px): Px {
  const wire = wireDecimal(px, intent.spec.scale.px)
  const issue = checkPrice(perp.spec, wire)
  return issue
    ? fail({ kind: 'invalid-order', detail: `Price ${wire}: ${issue} on this network` })
    : parsePx(wire, perp.spec.scale)
}

const Level = z.object({ price: z.string() })
const Orderbook = z.object({ bids: z.array(Level), asks: z.array(Level) })

async function priced(
  ctx: VenueContext,
  intent: OrderIntent,
): Promise<{ perp: Market; size: string; px: Px; tif: 0 | 1 | 2 }> {
  if (intent.order.kind === 'trailing') fail({ kind: 'unsupported', detail: 'dYdX has no trailing stop' })
  if (intent.triggers.takeProfits.length > 0 || intent.triggers.stopLoss !== null)
    fail({ kind: 'unsupported', detail: 'dYdX takes no take profit or stop loss from Tape' })
  const perp = await market(ctx, intent.spec.venueSymbol)
  const size = wireDecimal(intent.size, intent.spec.scale.qty)
  const sizeIssue = checkSize(perp.spec, size)
  if (sizeIssue) fail({ kind: 'invalid-order', detail: `Size ${size}: ${sizeIssue} on this network` })
  if (intent.order.kind === 'scale') fail({ kind: 'unsupported', detail: 'dYdX takes no scale order from Tape' })
  const order = intent.order
  if (intent.reduceOnly && (order.kind === 'mid' || (order.kind === 'limit' && order.tif !== 'ioc')))
    fail({ kind: 'invalid-order', detail: 'dYdX takes a reduce-only order only as IOC' })
  let px: Px
  let tif: 0 | 1 | 2
  if (order.kind === 'limit') {
    px = recheckPx(perp, intent, order.px)
    tif = TIF[order.tif]
  } else {
    const book = await indexer(ctx, `/orderbooks/perpetualMarket/${intent.spec.venueSymbol}`, Orderbook)
    const [bid, ask] = [book.bids[0], book.asks[0]].map((level) => level && parsePx(level.price, perp.spec.scale))
    if (order.kind === 'mid') {
      if (bid === undefined || ask === undefined)
        fail({ kind: 'invalid-order', detail: 'The book on this network has no mid' })
      px = midPrice(perp.spec, intent.side, bid, ask)
      tif = TIF.gtc
    } else {
      const far = intent.side === 'buy' ? ask : bid
      if (far === undefined) fail({ kind: 'invalid-order', detail: 'The book on this network is empty' })
      px = worstPrice(perp.spec, intent.side, far, order.slippage)
      tif = TIF.ioc
    }
  }
  return { perp, size, px, tif }
}

async function chainNumbers(perp: Market, size: string, px: Px) {
  const { default: Long } = await import('long')
  return {
    baseQuantums: Long.fromString(quantums(parseQty(size, perp.spec.scale), perp.spec.scale, perp).toString(), true),
    orderSubticks: Long.fromString(subticks(px, perp.spec.scale, perp).toString(), true),
  }
}

async function place(ctx: VenueContext, intent: OrderIntent): Promise<CommandOutcome> {
  const { perp, size, px, tif } = await priced(ctx, intent)
  const { SubaccountInfo, SHORT_BLOCK_FORWARD } = await sdk()
  const wallet = await walletOf(mnemonicOf(ctx))
  const subaccount = SubaccountInfo.forLocalWallet(wallet, 0)
  const { baseQuantums, orderSubticks } = await chainNumbers(perp, size, px)
  const builder = ctx.config.dydx.builder ?? undefined
  const clientId = clientIdOf(intent.clientId)
  const short = tif === TIF.ioc
  const hash = short
    ? await broadcast(ctx.ref.network, async (client) => {
        const height = await client.get.latestBlockHeight()
        return client.post.placeOrder(
          subaccount,
          clientId,
          perp.clobPairId,
          SIDE[intent.side],
          baseQuantums,
          orderSubticks,
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
        broadcast(ctx.ref.network, (client) =>
          client.post.placeOrder(
            subaccount,
            clientId,
            perp.clobPairId,
            SIDE[intent.side],
            baseQuantums,
            orderSubticks,
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

/**
 * dYdX has no amend. The cancel and the new order go in one transaction, which the chain runs whole
 * or not at all (v4-client-js bulkCancelAndTransferAndPlaceStatefulOrders), so a refused new order
 * leaves the old one open.
 */
async function modify(ctx: VenueContext, ref: OrderRef, intent: OrderIntent): Promise<CommandOutcome> {
  const [, oldClientId, oldFlags, oldClobPairId] = ref.split(':')
  if (Number(oldFlags) === FLAGS.short)
    fail({ kind: 'invalid-order', detail: 'A short-term dYdX order cannot be edited' })
  if (intent.order.kind !== 'limit' || intent.order.tif === 'ioc')
    fail({ kind: 'invalid-order', detail: 'An edit rests on the book, so it is a GTC or post-only limit' })
  const { perp, size, px, tif } = await priced(ctx, intent)
  const { baseQuantums, orderSubticks } = await chainNumbers(perp, size, px)
  const { SubaccountInfo } = await sdk()
  const wallet = await walletOf(mnemonicOf(ctx))
  const address = wallet.address ?? ''
  const subaccount = SubaccountInfo.forLocalWallet(wallet, 0)
  const now = Math.floor(Date.now() / 1000)
  const hash = await sequenced(address, () =>
    broadcast(ctx.ref.network, (client) =>
      client.post.send(
        subaccount,
        async () => [
          await client.post.cancelOrderMsg(
            address,
            0,
            Number(oldClientId),
            Number(oldFlags),
            Number(oldClobPairId),
            0,
            now + CANCEL_SECONDS,
          ),
          await client.post.placeOrderMsg(
            address,
            0,
            clientIdOf(intent.clientId),
            perp.clobPairId,
            SIDE[intent.side],
            baseQuantums,
            orderSubticks,
            tif,
            FLAGS.long,
            intent.reduceOnly,
            0,
            now + LONG_TERM_SECONDS,
            undefined,
            undefined,
            undefined,
            undefined,
            ctx.config.dydx.builder ?? undefined,
          ),
        ],
        false,
      ),
    ),
  )
  return { kind: 'placed', status: 'resting', detail: `Broadcast ${hash}` }
}

/**
 * dYdX has no whole-position exit, so each leg is a reduce-only conditional market order for the
 * position's size. The cancels of the legs it replaces and the new legs go in one transaction, which
 * the chain runs whole or not at all.
 */
async function protect(ctx: VenueContext, intent: ProtectIntent): Promise<CommandOutcome> {
  const ticker = intent.spec.venueSymbol
  const perp = await market(ctx, ticker)
  const size = wireDecimal(intent.size, intent.spec.scale.qty)
  const sizeIssue = checkSize(perp.spec, size)
  if (sizeIssue) fail({ kind: 'invalid-order', detail: `Size ${size}: ${sizeIssue} on this network` })
  const closing: Side = intent.position === 'long' ? 'sell' : 'buy'
  const cancels: OrderRef[] = []
  const places: { tpsl: 'tp' | 'sl'; trigger: Px; clientId: ClientOrderId }[] = []
  const notes: string[] = []
  for (const [tpsl, edit, name] of [
    ['tp', intent.takeProfit, EXIT_NAMES.tp],
    ['sl', intent.stopLoss, EXIT_NAMES.sl],
  ] as const) {
    if (edit.kind === 'keep') continue
    cancels.push(...edit.legs)
    if (edit.kind === 'remove') {
      notes.push(`${name} removed`)
      continue
    }
    const px = wireDecimal(edit.px, intent.spec.scale.px)
    const issue = checkPrice(perp.spec, px)
    if (issue) fail({ kind: 'invalid-order', detail: `${capitalized(name)} ${px}: ${issue} on this network` })
    places.push({ tpsl, trigger: parsePx(px, perp.spec.scale), clientId: edit.clientId })
    notes.push(`${name} at ${notePrice(edit.px, intent.spec.scale)}`)
  }
  const detail = exitDetail(notes)
  if (cancels.length === 0 && places.length === 0) return { kind: 'done', detail }
  const { default: Long } = await import('long')
  const baseQuantums = Long.fromString(
    quantums(parseQty(size, perp.spec.scale), perp.spec.scale, perp).toString(),
    true,
  )
  const { SubaccountInfo } = await sdk()
  const wallet = await walletOf(mnemonicOf(ctx))
  const address = wallet.address ?? ''
  const subaccount = SubaccountInfo.forLocalWallet(wallet, 0)
  const now = Math.floor(Date.now() / 1000)
  const units = (px: Px) => Long.fromString(subticks(px, perp.spec.scale, perp).toString(), true)
  const hash = await sequenced(address, () =>
    broadcast(ctx.ref.network, (client) =>
      client.post.send(
        subaccount,
        async () => [
          ...(await Promise.all(
            cancels.map((ref) => {
              const [, clientId, flags, clobPairId] = ref.split(':')
              return client.post.cancelOrderMsg(
                address,
                0,
                Number(clientId),
                Number(flags),
                Number(clobPairId),
                0,
                now + CANCEL_SECONDS,
              )
            }),
          )),
          ...(await Promise.all(
            places.map((leg) =>
              client.post.placeOrderMsg(
                address,
                0,
                clientIdOf(leg.clientId),
                perp.clobPairId,
                SIDE[closing],
                baseQuantums,
                units(worstPrice(perp.spec, closing, leg.trigger, exitSlippageBps(ticker))),
                TIF.ioc,
                FLAGS.conditional,
                true,
                0,
                now + LONG_TERM_SECONDS,
                MARKET_METADATA,
                CONDITION[leg.tpsl],
                units(leg.trigger),
                undefined,
                ctx.config.dydx.builder ?? undefined,
              ),
            ),
          )),
        ],
        false,
      ),
    ),
  )
  return { kind: 'done', detail: `${detail}. Broadcast ${hash}` }
}

const IndexerOrder = z.object({
  clientId: z.string(),
  clobPairId: z.string(),
  ticker: z.string(),
  side: z.string(),
  size: z.string(),
  price: z.string(),
  type: z.string(),
  reduceOnly: z.boolean(),
  orderFlags: z.string(),
  updatedAt: z.string().optional(),
  triggerPrice: z.string().nullish(),
})
type IndexerOrder = z.infer<typeof IndexerOrder>

/** The indexer stores every conditional as TAKE_PROFIT or STOP_LIMIT, market ones too (v4-chain protocol-translations.ts). */
const EXIT_TYPES: Partial<Record<string, OrderExit['kind']>> = { TAKE_PROFIT: 'tp', STOP_LIMIT: 'sl' }
const exitOf = (order: IndexerOrder): OrderExit | null => {
  const kind = order.reduceOnly ? EXIT_TYPES[order.type] : undefined
  return kind ? { kind, whole: false } : null
}

const refOf = (order: IndexerOrder) => orderRef(order.ticker, order.clientId, order.orderFlags, order.clobPairId)

async function cancel(ctx: VenueContext, ref: OrderRef): Promise<void> {
  const [, clientId, flags, clobPairId] = ref.split(':')
  const wallet = await walletOf(mnemonicOf(ctx))
  const { SubaccountInfo, SHORT_BLOCK_FORWARD } = await sdk()
  const subaccount = SubaccountInfo.forLocalWallet(wallet, 0)
  const isShort = Number(flags) === FLAGS.short
  const run = async (client: Validator) => {
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
    const network = ctx.ref.network
    await (isShort ? broadcast(network, run) : sequenced(wallet.address ?? '', () => broadcast(network, run)))
  } catch (error) {
    if (!(
      error instanceof TradeFailure
      && 'detail' in error.error
      && /order.*(?:does not exist|not found)|already (?:filled|canceled|cancelled|removed)|cancel(?:lation)? .*already exists/i.test(
        error.error.detail,
      )
    ))
      throw error
  }
}

const addressOf = (ctx: VenueContext) => ctx.keys.read()?.public.address ?? null

const openOrderOf = (order: IndexerOrder): OpenOrder => ({
  ref: refOf(order),
  symbol: order.ticker,
  side: order.side === 'BUY' ? 'buy' : 'sell',
  kind: order.type,
  px: toDecimal(order.triggerPrice ?? order.price),
  size: toDecimal(order.size),
  reduceOnly: order.reduceOnly,
  placedAt: order.updatedAt ? Date.parse(order.updatedAt) : 0,
  cancelable: true,
  exit: exitOf(order),
})

async function openOrders(ctx: VenueContext, address: string): Promise<OpenOrder[]> {
  const orders = await indexer(
    ctx,
    `/orders?address=${address}&subaccountNumber=0&status=OPEN,BEST_EFFORT_OPENED,UNTRIGGERED&limit=50`,
    z.array(IndexerOrder),
  )
  return orders.map(openOrderOf)
}

/** The indexer has no clientId filter, so the latest orders on the market are searched. */
async function lookup(ctx: VenueContext, sent: SentOrders): Promise<OrderLookup> {
  const address = addressOf(ctx) ?? fail({ kind: 'needs-setup', detail: 'Unlock the dYdX key in this tab first' })
  let orders: { clientId: string; status: string }[]
  try {
    orders = await indexer(
      ctx,
      `/orders?address=${address}&subaccountNumber=0&ticker=${sent.venueSymbol}&limit=100&returnLatestOrders=true`,
      z.array(z.object({ clientId: z.string(), status: z.string() })),
    )
  } catch (error) {
    if (error instanceof TradeFailure && error.error.kind === 'rejected')
      return { kind: 'absent', detail: 'The dYdX indexer has no account for this address' }
    throw error
  }
  return lookupSummary(
    sent.clientIds.map((cloid) => {
      const hit = orders.find((order) => order.clientId === String(clientIdOf(cloid)))
      return hit
        ? { kind: 'found', detail: `Order ${hit.status.toLowerCase()}` }
        : { kind: 'absent', detail: 'Not in the dYdX indexer yet. It can lag the chain by a few blocks.' }
    }),
  )
}

async function execute(ctx: VenueContext, command: Command): Promise<CommandOutcome> {
  switch (command.kind) {
    case 'place':
      return place(ctx, command.intent)
    case 'close-all':
      return closeEach(command.intents, (intent) => place(ctx, intent))
    case 'modify':
      return modify(ctx, command.order, command.intent)
    case 'protect':
      return protect(ctx, command.intent)
    case 'cancel':
      await cancel(ctx, command.order)
      return { kind: 'done', detail: 'Cancel broadcast' }
    case 'cancel-all': {
      const address = addressOf(ctx) ?? fail({ kind: 'needs-setup', detail: 'Unlock the dYdX key in this tab first' })
      const orders = onMarket(await openOrders(ctx, address), command.symbol)
      for (const order of orders) await cancel(ctx, order.ref)
      return canceled(orders)
    }
    case 'leverage':
      return fail({ kind: 'unsupported', detail: 'dYdX sets leverage by margin, not by a setting' })
  }
}

const Subaccount = z.object({
  subaccount: z.object({
    equity: z.string(),
    freeCollateral: z.string(),
    openPerpetualPositions: z.record(
      z.string(),
      z.object({
        market: z.string(),
        side: z.string(),
        size: z.string(),
        entryPrice: z.string(),
        unrealizedPnl: z.string(),
      }),
    ),
  }),
})
const RecentFills = z.object({
  fills: z.array(
    z.object({
      id: z.string(),
      market: z.string(),
      side: z.string(),
      price: z.string(),
      size: z.string(),
      fee: z.string(),
      createdAt: z.string(),
    }),
  ),
})

async function account(ctx: VenueContext): Promise<AccountView> {
  const address = addressOf(ctx)
  if (!address) return { kind: 'unknown' }
  let sub: z.infer<typeof Subaccount>
  try {
    sub = await indexer(ctx, `/addresses/${address}/subaccountNumber/0`, Subaccount)
  } catch (error) {
    if (error instanceof TradeFailure && error.error.kind === 'rejected') return { kind: 'empty' }
    throw error
  }
  const [orders, fills] = await Promise.all([
    openOrders(ctx, address),
    indexer(ctx, `/fills?address=${address}&subaccountNumber=0&limit=20`, RecentFills),
  ])
  return {
    kind: 'live',
    snapshot: {
      equity: toDecimal(sub.subaccount.equity),
      available: toDecimal(sub.subaccount.freeCollateral),
      positions: Object.values(sub.subaccount.openPerpetualPositions).map((position) => ({
        symbol: position.market,
        side: position.side === 'LONG' ? 'long' : 'short',
        size: toDecimal(position.size.replace(/^-/, '')),
        entry: toDecimal(position.entryPrice),
        mark: null,
        unrealizedPnl: toDecimal(position.unrealizedPnl),
        liquidation: null,
        leverage: null,
      })),
      orders,
      fills: fills.fills.map((fill) => ({
        id: fill.id,
        symbol: fill.market,
        side: fill.side === 'BUY' ? 'buy' : 'sell',
        px: toDecimal(fill.price),
        size: toDecimal(fill.size),
        fee: toDecimal(fill.fee),
        time: Date.parse(fill.createdAt),
      })),
    },
  }
}

async function steps(ctx: VenueContext): Promise<readonly SetupStep[]> {
  return [{ id: 'derive-key', label: 'Unlock your dYdX key in this tab', done: Boolean(ctx.keys.read()?.secret) }]
}

/** v4-web's useGenerateKeys signs a second time only for an address with no subaccount, since a funded one proves the signature repeats. */
const holdsSubaccount = (ctx: VenueContext, address: string) =>
  indexer(ctx, `/addresses/${address}/subaccountNumber/0`, Subaccount).then(
    () => true,
    () => false,
  )

async function enable(ctx: VenueContext, wallet: WalletSigner, onStep: (step: StepId) => void): Promise<void> {
  if (ctx.keys.read()?.secret) return
  onStep('derive-key')
  const chainId = ONBOARDING_CHAIN[ctx.ref.network]
  if ((await wallet.chainId()) !== chainId) await wallet.switchChain(chainId)
  const request = onboarding(ctx.ref.network)
  const signature = await wallet.signTypedData(request)
  const { mnemonic, address } = await deriveKey(signature)
  if (!(await holdsSubaccount(ctx, address))) {
    onStep('confirm-key')
    if ((await wallet.signTypedData(request)) !== signature) fail({ kind: 'nondeterministic-wallet' })
  }
  ctx.keys.write({ status: 'linked', public: { address }, secret: mnemonic })
}

/** The indexer's largest page, and the last page its proxy serves. */
const PAGE = 1000
const LAST_PAGE = 25
/** Fills where the protocol, not the account's own order, closed the position. */
const FORCED = new Set(['LIQUIDATED', 'DELEVERAGED'])

const IndexerFill = z.object({
  id: z.string(),
  side: z.string(),
  type: z.string(),
  market: z.string(),
  marketType: z.string(),
  price: z.string(),
  size: z.string(),
  fee: z.string(),
  createdAt: z.string(),
})
type IndexerFill = z.infer<typeof IndexerFill>

const IndexerFunding = z.object({
  ticker: z.string(),
  payment: z.string(),
  rate: z.string(),
  size: z.string(),
  createdAt: z.string(),
})
type IndexerFunding = z.infer<typeof IndexerFunding>
const FillPage = z.object({ fills: z.array(IndexerFill) })
const FundingPage = z.object({ fundingPayments: z.array(IndexerFunding) })

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
      pages((page) => indexerAt(network, fetch, `/fills?${query}&page=${page}`, FillPage).then((reply) => reply.fills)),
      pages((page) =>
        indexerAt(network, fetch, `/fundingPayments?${query}&page=${page}`, FundingPage).then(
          (reply) => reply.fundingPayments,
        ),
      ),
    ])
  } catch (error) {
    if (error instanceof TradeFailure && error.error.kind === 'rejected') return { fills: [], funding: [], gaps: [] }
    throw error
  }
  const perps = fills.rows.filter((fill) => fill.marketType === 'PERPETUAL')
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
    fills: perps.map((fill): HistoryFill => ({
      venue: 'dydx',
      account: address,
      id: fill.id,
      symbol: fill.market,
      side: fill.side === 'BUY' ? 'buy' : 'sell',
      px: toDecimal(fill.price),
      size: toDecimal(fill.size),
      fee: toDecimal(fill.fee),
      asset: 'USDC',
      time: Date.parse(fill.createdAt),
      liquidation: FORCED.has(fill.type),
      venuePnl: null,
    })),
    funding: funding.rows.map((payment): FundingPayment => ({
      venue: 'dydx',
      account: address,
      symbol: payment.ticker,
      time: Date.parse(payment.createdAt),
      amount: toDecimal(payment.payment),
      asset: 'USDC',
      rate: toDecimal(payment.rate),
      position: toDecimal(payment.size),
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
    restingReduceOnly: false,
    wholeExits: false,
  },
  walletChain: ONBOARDING_CHAIN,
  unavailable: (network, config) =>
    network === 'mainnet' && !config.mainnet.has('dydx') ? 'Mainnet trading is off in this build' : null,
  steps,
  enable,
  account,
  execute,
  lookup,
  history,
} satisfies TradingVenue & { id: 'dydx' }
