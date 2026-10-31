import { bytesToHex, hexToBytes } from 'viem'
import type { Hex } from 'viem'
import { decimalsOf, parsePx, parseQty, plainDecimal, wireDecimal } from '@tape/core/fixed'
import type { Px, Scale } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import type { Network } from '@tape/core/ids'
import { checkPrice, checkSize, worstPrice } from '../intent'
import { post, send } from '../send'
import type { Classify } from '../send'
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
  Side,
  StepId,
  TradeConfig,
  TradeError,
  TradingVenue,
  VenueContext,
  WalletSigner,
} from '../types'
import type { FundingPayment, HistoryFill, VenueHistory } from '../history'
import { amount, negate, plain } from '../money'
import { clientIdsOf, lookupSummary, scaleOutcome } from '../scale-order'
import { accountId, addKeyTypedData, orderlyKey, registrationTypedData, signRequest } from './sign'
import type { OrderlyKey } from './sign'
import { batchBody, cancelPath, orderBody } from './wire'
import type { OrderType } from './wire'

const API: Record<Network, string> = { mainnet: 'https://api.orderly.org', testnet: 'https://testnet-api.orderly.org' }
/** Orderly signs EIP-712 against a chain it supports, and wallets sign only for the active chain. */
const CHAIN_ID: Record<Network, number> = { mainnet: 42161, testnet: 421614 }
/** `read` lets the key fetch positions and orders. Never `asset`: that scope withdraws. */
const SCOPE = 'read,trading'
const KEY_DAYS = 365
const TYPE: Record<'gtc' | 'ioc' | 'post-only', OrderType> = { gtc: 'LIMIT', ioc: 'IOC', 'post-only': 'POST_ONLY' }
/** Orderly's batch endpoint takes at most 10 orders. */
const BATCH_ORDERS = 10

const brokerOf = (config: TradeConfig, network: Network) => config.orderly.brokerId[network]

function fail(error: TradeError): never {
  throw new TradeFailure('orderly', error)
}

export function classifyMessage(message: string): TradeError {
  if (/orderly key|signature|not registered|account.*(?:not found|not exist)/i.test(message))
    return { kind: 'needs-setup', detail: message }
  if (/insufficient|margin|collateral|risk exposure/i.test(message))
    return { kind: 'insufficient-margin', detail: message }
  if (/price|quantity|notional|tick|size/i.test(message)) return { kind: 'invalid-order', detail: message }
  return { kind: 'rejected', detail: message }
}

/** Orderly's codes for an API key in the wrong format, and for one that is invalid, expired or revoked. */
const BAD_KEY = new Set(['-1001', '-1002'])

const classify: Classify = (status, body, text) => {
  const b = body as { success?: boolean; code?: string; message?: string } | null
  if (status === 429) return { kind: 'rate-limited', detail: b?.message ?? text }
  if (b?.success !== false) return null
  return b.code !== undefined && BAD_KEY.has(b.code)
    ? { kind: 'needs-setup', detail: b.message ?? text }
    : classifyMessage(b.message ?? text)
}

/** Orderly's code for data not found on the server, as when cancelling an order that is already CANCELLED. */
const NOT_FOUND = '-1006'
const gone: TradeError = { kind: 'rejected', detail: 'The order is no longer open' }
const classifyCancel: Classify = (status, body, text) =>
  (body as { code?: unknown } | null)?.code === NOT_FOUND ? gone : classify(status, body, text)

/** Not found comes back as `success: false`, sometimes with a 200, so reads treat it as rejected. */
const unsuccessful: Classify = (_s, body, text) => {
  const b = body as { success?: boolean; message?: string } | null
  return b?.success === false ? { kind: 'rejected', detail: b.message ?? text } : null
}

const publicGet = <T>(ctx: VenueContext, path: string) =>
  send<{ data: T }>('orderly', ctx.fetch, `${API[ctx.ref.network]}${path}`, { mutates: false }, unsuccessful)

function keyOf(ctx: VenueContext): OrderlyKey | null {
  const secret = ctx.keys.read()?.secret
  return secret ? orderlyKey(hexToBytes(secret as Hex)) : null
}

function brokerFor(ctx: VenueContext): string {
  return (
    brokerOf(ctx.config, ctx.ref.network) ?? fail({ kind: 'unsupported', detail: 'No Orderly broker id configured' })
  )
}

async function signed<T>(
  ctx: VenueContext,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body = '',
  classifier = classify,
): Promise<T> {
  const key = keyOf(ctx) ?? fail({ kind: 'needs-setup', detail: 'Enable trading on this device first' })
  const headers = {
    ...signRequest(key, accountId(ctx.ref.owner, brokerFor(ctx)), Date.now(), method, path, body),
    'content-type': method === 'POST' ? 'application/json' : 'application/x-www-form-urlencoded',
  }
  const mutates = method !== 'GET'
  const reply = await send<{ data?: T } | null>(
    'orderly',
    ctx.fetch,
    `${API[ctx.ref.network]}${path}`,
    { method, headers, ...(body ? { body } : {}), mutates },
    classifier,
  )
  if (reply?.data != null) return reply.data
  const detail = `Unreadable reply: ${JSON.stringify(reply)}`
  return fail(mutates ? { kind: 'unknown-outcome', detail } : { kind: 'unreachable', detail })
}

const specs = new Map<string, Promise<MarketSpec>>()

function networkSpec(ctx: VenueContext, symbol: string): Promise<MarketSpec> {
  const cacheKey = `${ctx.ref.network}:${symbol}`
  let cached = specs.get(cacheKey)
  if (!cached) {
    cached = publicGet<{ quote_tick: string; base_tick: string }>(ctx, `/v1/public/info/${symbol}`).then(({ data }) => {
      const quoteTick = plainDecimal(data.quote_tick)
      const baseTick = plainDecimal(data.base_tick)
      const scale: Scale = { px: decimalsOf(quoteTick), qty: decimalsOf(baseTick) }
      return {
        venueSymbol: symbol,
        scale,
        tick: { kind: 'fixed', tick: parsePx(quoteTick, scale) },
        step: parseQty(baseTick, scale),
      } as unknown as MarketSpec
    })
    cached.catch(() => specs.delete(cacheKey))
    specs.set(cacheKey, cached)
  }
  return cached
}

async function farTouch(ctx: VenueContext, spec: MarketSpec, side: Side): Promise<Px> {
  const { data } = await send<{ data: { asks: { price: string }[]; bids: { price: string }[] } }>(
    'orderly',
    ctx.fetch,
    `${API[ctx.ref.network]}/v1/public/query`,
    { ...post({ type: 'orderbook', symbol: spec.venueSymbol, max_level: 1 }), mutates: false },
    unsuccessful,
  )
  const far = (side === 'buy' ? data.asks : data.bids)[0]
  return far
    ? parsePx(plainDecimal(far.price), spec.scale)
    : fail({ kind: 'invalid-order', detail: 'The book on this network is empty' })
}

async function lookupOne(ctx: VenueContext, clientId: string): Promise<OrderLookup> {
  try {
    const order = await signed<{ status: string }>(ctx, 'GET', `/v1/client/order/${clientId}`)
    return { kind: 'found', detail: `Order ${order.status.toLowerCase()}` }
  } catch (e) {
    if (
      e instanceof TradeFailure
      && e.error.kind === 'rejected'
      && /order.*(?:not exist|not found)/i.test(e.error.detail)
    )
      return { kind: 'absent', detail: e.error.detail }
    throw e
  }
}

async function lookup(ctx: VenueContext, intent: OrderIntent): Promise<OrderLookup> {
  const results: OrderLookup[] = []
  for (const id of clientIdsOf(intent)) results.push(await lookupOne(ctx, id))
  return lookupSummary(results)
}

async function placeScale(
  ctx: VenueContext,
  intent: OrderIntent,
  order: Extract<OrderIntent['order'], { kind: 'scale' }>,
  spec: MarketSpec,
): Promise<CommandOutcome> {
  const legs = order.legs.map((leg, i) => {
    const quantity = wireDecimal(leg.size, intent.spec.scale.qty)
    const price = wireDecimal(leg.px, intent.spec.scale.px)
    const issue = checkSize(spec, quantity) ?? checkPrice(spec, price)
    if (issue) fail({ kind: 'invalid-order', detail: `Order ${i + 1} at ${price}: ${issue} on this network` })
    return {
      symbol: intent.spec.venueSymbol,
      clientOrderId: leg.clientId,
      type: TYPE[order.tif],
      side: intent.side === 'buy' ? ('BUY' as const) : ('SELL' as const),
      price,
      quantity,
      reduceOnly: intent.reduceOnly,
    }
  })
  const data = await signed<{ rows?: { order_id?: number | string | null; error_message?: string | null }[] }>(
    ctx,
    'POST',
    '/v1/batch-order',
    batchBody(legs),
  )
  const rows = data.rows ?? []
  if (rows.length === 0)
    fail({ kind: 'unknown-outcome', detail: `No order rows in the reply: ${JSON.stringify(data)}` })
  // Orderly writes "none" in error_message on a placed row, so a row stands by its order_id.
  return scaleOutcome(
    rows.map((r) => (r.order_id == null ? (r.error_message ?? 'Refused without a reason') : undefined)),
    'resting',
    (error) => fail(classifyMessage(error)),
  )
}

async function execute(ctx: VenueContext, command: Command): Promise<CommandOutcome> {
  switch (command.kind) {
    case 'place': {
      const intent = command.intent
      if (intent.order.kind === 'trailing')
        fail({ kind: 'unsupported', detail: 'Orderly takes no trailing stop from Tape' })
      if (intent.triggers.takeProfits.length > 0 || intent.triggers.stopLoss !== null)
        fail({ kind: 'unsupported', detail: 'Orderly takes no take profit or stop loss from Tape' })
      const symbol = intent.spec.venueSymbol
      const spec = await networkSpec(ctx, symbol)
      if (intent.order.kind === 'scale') return placeScale(ctx, intent, intent.order, spec)
      const quantity = wireDecimal(intent.size, intent.spec.scale.qty)
      const sizeIssue = checkSize(spec, quantity)
      if (sizeIssue) fail({ kind: 'invalid-order', detail: `Size ${quantity}: ${sizeIssue} on this network` })
      let price: string
      if (intent.order.kind === 'limit') {
        price = wireDecimal(intent.order.px, intent.spec.scale.px)
        const issue = checkPrice(spec, price)
        if (issue) fail({ kind: 'invalid-order', detail: `Price ${price}: ${issue} on this network` })
      } else {
        const far = await farTouch(ctx, spec, intent.side)
        price = wireDecimal(worstPrice(spec, intent.side, far, intent.order.slippage), spec.scale.px)
      }
      const type = intent.order.kind === 'limit' ? TYPE[intent.order.tif] : 'IOC'
      const body = orderBody({
        symbol,
        clientOrderId: intent.clientId,
        type,
        side: intent.side === 'buy' ? 'BUY' : 'SELL',
        price,
        quantity,
        reduceOnly: intent.reduceOnly,
      })
      const data = await signed<{ order_id: string }>(ctx, 'POST', '/v1/order', body)
      return {
        kind: 'placed',
        status: type === 'IOC' ? 'accepted' : 'resting',
        detail: `Order ${data.order_id}`,
      }
    }
    case 'cancel': {
      const [symbol, id] = command.order.split(':') as [string, string]
      try {
        await signed(ctx, 'DELETE', cancelPath(symbol, Number(id)), '', classifyCancel)
      } catch (e) {
        if (!(e instanceof TradeFailure && e.error === gone)) throw e
      }
      return { kind: 'done', detail: 'Canceled' }
    }
    case 'cancel-all':
      await signed(ctx, 'DELETE', `/v1/orders?symbol=${command.symbol}`)
      return { kind: 'done', detail: `Canceled open ${command.symbol} orders` }
    case 'leverage':
      await signed(ctx, 'POST', '/v1/client/leverage', JSON.stringify({ leverage: command.leverage }))
      return { kind: 'done', detail: `Account leverage ${command.leverage}x` }
  }
}

const d = (n: string) => plainDecimal(n) as Decimal

async function account(ctx: VenueContext): Promise<AccountView> {
  if (!keyOf(ctx) || ctx.keys.read()?.status !== 'linked') return { kind: 'unknown' }
  type Positions = {
    total_collateral_value: string
    free_collateral: string
    rows: {
      symbol: string
      position_qty: string
      average_open_price: string
      unsettled_pnl: string
      est_liq_price: string
    }[]
  }
  type Orders = {
    rows: {
      order_id: string
      symbol: string
      side: 'BUY' | 'SELL'
      type: string
      price: string | null
      quantity: string
      reduce_only: boolean
      created_time: string
    }[]
  }
  type Trades = {
    rows: {
      id: string
      symbol: string
      side: 'BUY' | 'SELL'
      executed_price: string
      executed_quantity: string
      fee: string
      executed_timestamp: string
    }[]
  }
  const [positions, orders, trades] = await Promise.all([
    signed<Positions>(ctx, 'GET', '/v1/positions'),
    signed<Orders>(ctx, 'GET', '/v1/orders?status=INCOMPLETE'),
    signed<Trades>(ctx, 'GET', '/v1/trades?size=20'),
  ])
  const live = positions.rows.filter((p) => Number(p.position_qty) !== 0)
  if (
    Number(positions.total_collateral_value) === 0
    && live.length === 0
    && orders.rows.length === 0
    && trades.rows.length === 0
  )
    return { kind: 'empty' }
  return {
    kind: 'live',
    snapshot: {
      equity: d(positions.total_collateral_value),
      available: d(positions.free_collateral),
      positions: live.map((p) => ({
        symbol: p.symbol,
        side: p.position_qty.startsWith('-') ? 'short' : 'long',
        size: d(p.position_qty.replace(/^-/, '')),
        entry: d(p.average_open_price),
        unrealizedPnl: d(p.unsettled_pnl),
        liquidation: Number(p.est_liq_price) > 0 ? d(p.est_liq_price) : null,
        leverage: null,
      })),
      orders: orders.rows.map((o) => ({
        ref: `${o.symbol}:${o.order_id}` as OrderRef,
        symbol: o.symbol,
        side: o.side === 'BUY' ? 'buy' : 'sell',
        kind: o.type,
        px: o.price === null ? null : d(o.price),
        size: d(o.quantity),
        reduceOnly: o.reduce_only,
        placedAt: Number(o.created_time),
        cancelable: true,
      })),
      fills: trades.rows.map((t) => ({
        id: t.id,
        symbol: t.symbol,
        side: t.side === 'BUY' ? 'buy' : 'sell',
        px: d(t.executed_price),
        size: d(t.executed_quantity),
        fee: d(t.fee),
        time: Number(t.executed_timestamp),
      })),
    },
  }
}

async function registered(ctx: VenueContext): Promise<boolean> {
  try {
    await publicGet(ctx, `/v1/get_account?address=${ctx.ref.owner}&broker_id=${brokerFor(ctx)}`)
    return true
  } catch (e) {
    if (e instanceof TradeFailure && e.error.kind === 'rejected') return false
    throw e
  }
}

async function keyValid(ctx: VenueContext): Promise<boolean> {
  const key = keyOf(ctx)
  if (!key) return false
  try {
    const { data } = await publicGet<{ expiration?: string }>(
      ctx,
      `/v1/get_orderly_key?account_id=${accountId(ctx.ref.owner, brokerFor(ctx))}&orderly_key=${encodeURIComponent(key.id)}`,
    )
    return Number(data.expiration ?? 0) > Date.now()
  } catch (e) {
    if (e instanceof TradeFailure && e.error.kind === 'rejected') return false
    throw e
  }
}

async function steps(ctx: VenueContext): Promise<readonly SetupStep[]> {
  const exists = await registered(ctx)
  return [
    { id: 'register-account', label: 'Register an Orderly account', done: exists },
    { id: 'add-key', label: 'Add a trading key', done: exists && (await keyValid(ctx)) },
  ]
}

async function enable(ctx: VenueContext, wallet: WalletSigner, onStep: (step: StepId) => void): Promise<void> {
  const network = ctx.ref.network
  const brokerId = brokerFor(ctx)
  const chainId = CHAIN_ID[network]
  if ((await wallet.chainId()) !== chainId) await wallet.switchChain(chainId)
  const submit = (path: string, message: Record<string, unknown>, signature: Hex) =>
    send(
      'orderly',
      ctx.fetch,
      `${API[network]}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature, userAddress: wallet.address }),
        mutates: true,
      },
      classify,
    )
  for (const step of (await steps(ctx)).filter((s) => !s.done)) {
    onStep(step.id)
    if (step.id === 'register-account') {
      // The nonce is short-lived, so it is fetched right before the signature.
      const { data } = await publicGet<{ registration_nonce: string }>(ctx, '/v1/registration_nonce')
      const typed = registrationTypedData(brokerId, chainId, data.registration_nonce, Date.now())
      await submit('/v1/register_account', typed.message, await wallet.signTypedData(typed))
    }
    if (step.id === 'add-key') {
      const existing = ctx.keys.read()
      const key = existing?.secret ? orderlyKey(hexToBytes(existing.secret as Hex)) : orderlyKey()
      if (!existing?.secret)
        ctx.keys.write({ status: 'draft', public: { key: key.id }, secret: bytesToHex(key.secret) })
      const now = Date.now()
      const typed = addKeyTypedData({
        brokerId,
        chainId,
        orderlyKey: key.id,
        scope: SCOPE,
        timestamp: now,
        expiration: now + KEY_DAYS * 86_400_000,
      })
      await submit('/v1/orderly_key', typed.message, await wallet.signTypedData(typed))
    }
  }
  const key = ctx.keys.read()
  if (key) ctx.keys.write({ ...key, status: 'linked' })
}

/** Largest pages the public query takes with a time range. */
const TRADE_PAGE = 2000
const FUNDING_PAGE = 500

interface QueryTrade {
  id: string
  symbol: string
  side: 'BUY' | 'SELL'
  executed_price: string
  executed_quantity: string
  fee: string
  fee_asset: string
  /** Null on liquidation fills. */
  order_id: string | null
  realized_pnl: string | null
  executed_timestamp: string
}

interface QueryFunding {
  symbol: string
  funding_rate: string
  funding_fee: string
  position_qty: string
  funding_rate_timestamp: string
  funding_status: string
}

/**
 * Orderly's public query reads any address without a key. Without a time range it returns only the
 * last 24 hours, so every read starts at 1 ms and follows the cursor into the archive.
 */
async function history({ network, address, fetch }: HistoryRequest): Promise<VenueHistory> {
  const query = <T>(body: Record<string, unknown>) =>
    send<{ data: T }>(
      'orderly',
      fetch,
      `${API[network]}/v1/public/query`,
      { ...post(body), mutates: false },
      unsuccessful,
    ).then((r) => r.data)
  const follow = async <T>(body: Record<string, unknown>): Promise<T[]> => {
    const rows: T[] = []
    let cursor: string | null = null
    do {
      const page: { rows: T[]; next_cursor: string | null } = await query({ ...body, ...(cursor ? { cursor } : {}) })
      rows.push(...page.rows)
      cursor = page.next_cursor
    } while (cursor)
    return rows
  }
  let accounts: { account_id: string }[]
  try {
    accounts = (await query<{ accounts: { account_id: string }[] }>({ type: 'accountState', address })).accounts
  } catch (e) {
    if (e instanceof TradeFailure && e.error.kind === 'rejected') return { fills: [], funding: [], gaps: [] }
    throw e
  }
  const read = await Promise.all(
    accounts.map(async ({ account_id }) => {
      const scope = { address, account_id, start_time: 1 }
      const [trades, payments] = await Promise.all([
        follow<QueryTrade>({ type: 'trades', ...scope, limit: TRADE_PAGE }),
        follow<QueryFunding>({ type: 'fundingPayments', ...scope, limit: FUNDING_PAGE }),
      ])
      // Orderly pages trades newest first, and fills in one millisecond must stay in the order they matched.
      return { id: account_id, trades: trades.reverse(), payments }
    }),
  )
  return {
    fills: read.flatMap(({ id, trades }) =>
      trades.map((t): HistoryFill => ({
        venue: 'orderly',
        account: id,
        id: t.id,
        symbol: t.symbol,
        side: t.side === 'BUY' ? 'buy' : 'sell',
        px: d(t.executed_price),
        size: d(t.executed_quantity),
        fee: d(t.fee),
        asset: t.fee_asset,
        time: Number(t.executed_timestamp),
        liquidation: t.order_id === null,
        venuePnl: t.realized_pnl === null ? null : d(t.realized_pnl),
      })),
    ),
    // Accrued payments are not settled yet and can still change.
    funding: read.flatMap(({ id, payments }) =>
      payments
        .filter((p) => p.funding_status === 'Settled')
        .map((p): FundingPayment => ({
          venue: 'orderly',
          account: id,
          symbol: p.symbol,
          time: Number(p.funding_rate_timestamp),
          amount: plain(negate(amount(p.funding_fee))) as Decimal,
          asset: 'USDC',
          rate: d(p.funding_rate),
          position: d(p.position_qty),
        })),
    ),
    gaps: [],
  }
}

export const orderly = {
  id: 'orderly',
  label: 'Orderly',
  secrets: 'device',
  capabilities: {
    tif: ['gtc', 'ioc', 'post-only'],
    triggers: null,
    leverage: true,
    scaleOrders: BATCH_ORDERS,
    trailingStop: false,
  },
  walletChain: CHAIN_ID,
  unavailable: (network, config) => {
    if (network === 'mainnet' && !config.mainnet) return 'Mainnet trading is off in this build'
    return brokerOf(config, network) ? null : 'No Orderly broker id is configured'
  },
  steps,
  enable,
  account,
  execute,
  lookup,
  history,
} satisfies TradingVenue & { id: 'orderly' }
