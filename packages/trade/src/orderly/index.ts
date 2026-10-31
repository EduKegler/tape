import { bytesToHex, hexToBytes } from 'viem'
import type { Hex } from 'viem'
import { decimalsOf, parsePx, parseQty, plainDecimal, toPx, wireDecimal } from '@tape/core/fixed'
import type { Px, Scale } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import type { Network } from '@tape/core/ids'
import { checkPrice, checkSize, worstPrice } from '../intent'
import { post, send } from '../send'
import type { Classify } from '../send'
import { TradeFailure, orderRef, toDecimal } from '../types'
import type {
  AccountView,
  Command,
  CommandOutcome,
  HistoryRequest,
  OrderIntent,
  OrderLookup,
  OrderRules,
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
import { clientIdsOf, lookupSummary, scaleOutcome, toTick } from '../scale-order'
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

/**
 * Kinds Orderly's error codes page fixes by code: -1001 an API key in the wrong format, -1002 one that is invalid,
 * expired or revoked, -1012 a refusal by an internal module, which a reduce only order with no position gets, and
 * -1102 an order value under the minimum.
 */
const KIND_OF_CODE: Readonly<Record<string, 'needs-setup' | 'rejected' | 'invalid-order'>> = {
  '-1001': 'needs-setup',
  '-1002': 'needs-setup',
  '-1012': 'rejected',
  '-1102': 'invalid-order',
}

const classify: Classify = (status, body, text) => {
  const reply = body as { success?: boolean; code?: string; message?: string } | null
  if (status === 429) return { kind: 'rate-limited', detail: reply?.message ?? text }
  if (reply?.success !== false) return null
  const kind = reply.code === undefined ? undefined : KIND_OF_CODE[reply.code]
  return kind ? { kind, detail: reply.message ?? text } : classifyMessage(reply.message ?? text)
}

/**
 * Orderly's code for data not found on the server, as when cancelling an order that is already CANCELLED or FILLED,
 * or looking up a client order id it never took.
 */
const NOT_FOUND = '-1006'
const notFound: TradeError = { kind: 'rejected', detail: 'Orderly holds no such order' }
const classifyOrder: Classify = (status, body, text) =>
  (body as { code?: unknown } | null)?.code === NOT_FOUND ? notFound : classify(status, body, text)

/** Not found comes back as `success: false`, sometimes with a 200, so reads treat it as rejected. */
const unsuccessful: Classify = (_s, body, text) => {
  const reply = body as { success?: boolean; message?: string } | null
  return reply?.success === false ? { kind: 'rejected', detail: reply.message ?? text } : null
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

interface NetworkRules {
  readonly spec: OrderRules
  readonly priceRange: string | null
}

const rulesCache = new Map<string, Promise<NetworkRules>>()

function networkRules(ctx: VenueContext, symbol: string): Promise<NetworkRules> {
  const cacheKey = `${ctx.ref.network}:${symbol}`
  let cached = rulesCache.get(cacheKey)
  if (!cached) {
    cached = publicGet<{ quote_tick: string; base_tick: string; price_range?: string }>(
      ctx,
      `/v1/public/info/${symbol}`,
    ).then(({ data }) => {
      const quoteTick = plainDecimal(data.quote_tick)
      const baseTick = plainDecimal(data.base_tick)
      const scale: Scale = { px: decimalsOf(quoteTick), qty: decimalsOf(baseTick) }
      const spec: OrderRules = {
        venueSymbol: symbol,
        scale,
        tick: { kind: 'fixed', tick: parsePx(quoteTick, scale) },
        step: parseQty(baseTick, scale),
      }
      return { spec, priceRange: data.price_range == null ? null : plainDecimal(data.price_range) }
    })
    cached.catch(() => rulesCache.delete(cacheKey))
    rulesCache.set(cacheKey, cached)
  }
  return cached
}

async function markPrice(ctx: VenueContext, symbol: string): Promise<string> {
  const { data } = await publicGet<{ mark_price?: string }>(ctx, `/v1/public/futures/${symbol}`)
  return data.mark_price == null
    ? fail({ kind: 'unreachable', detail: `Orderly sent no mark price for ${symbol}` })
    : plainDecimal(data.mark_price)
}

function exactDecimal(decimal: string): { units: bigint; scale: bigint } {
  const [whole, fraction = ''] = decimal.split('.') as [string, string?]
  return { units: BigInt(`${whole}${fraction}`), scale: 10n ** BigInt(fraction.length) }
}

/** Orderly's Order Price Limit page: a buy at most mark × (1 + price range), a sell at least mark × (1 − price range). */
function insidePriceRange(
  spec: Pick<MarketSpec, 'scale' | 'tick'>,
  side: Side,
  price: Px,
  mark: string,
  priceRange: string,
): Px {
  const exactMark = exactDecimal(mark)
  const exactRange = exactDecimal(priceRange)
  const numerator =
    exactMark.units
    * (side === 'buy' ? exactRange.scale + exactRange.units : exactRange.scale - exactRange.units)
    * 10n ** BigInt(spec.scale.px)
  const denominator = exactMark.scale * exactRange.scale
  const units = side === 'buy' ? numerator / denominator : (numerator + denominator - 1n) / denominator
  const bound = toTick(spec, side, Number(units))
  return toPx(side === 'buy' ? Math.min(price, bound) : Math.max(price, bound))
}

async function farTouch(ctx: VenueContext, spec: Pick<MarketSpec, 'venueSymbol' | 'scale'>, side: Side): Promise<Px> {
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
    const order = await signed<{ status: string }>(ctx, 'GET', `/v1/client/order/${clientId}`, '', classifyOrder)
    return { kind: 'found', detail: `Order ${order.status.toLowerCase()}` }
  } catch (error) {
    if (error instanceof TradeFailure && error.error === notFound)
      return { kind: 'absent', detail: 'Orderly has no order with this client id' }
    throw error
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
  spec: OrderRules,
): Promise<CommandOutcome> {
  const legs = order.legs.map((leg, index) => {
    const quantity = wireDecimal(leg.size, intent.spec.scale.qty)
    const price = wireDecimal(leg.px, intent.spec.scale.px)
    const issue = checkSize(spec, quantity) ?? checkPrice(spec, price)
    if (issue) fail({ kind: 'invalid-order', detail: `Order ${index + 1} at ${price}: ${issue} on this network` })
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
    rows.map((row) => (row.order_id == null ? (row.error_message ?? 'Refused without a reason') : undefined)),
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
      const { spec, priceRange } = await networkRules(ctx, symbol)
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
        const range = priceRange ?? fail({ kind: 'unreachable', detail: `Orderly sent no price range for ${symbol}` })
        const [far, mark] = await Promise.all([farTouch(ctx, spec, intent.side), markPrice(ctx, symbol)])
        const worst = worstPrice(spec, intent.side, far, intent.order.slippage)
        price = wireDecimal(insidePriceRange(spec, intent.side, worst, mark, range), spec.scale.px)
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
        await signed(ctx, 'DELETE', cancelPath(symbol, Number(id)), '', classifyOrder)
      } catch (error) {
        if (!(error instanceof TradeFailure && error.error === notFound)) throw error
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

const venueDecimal = (text: string) => toDecimal(plainDecimal(text))

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
  const live = positions.rows.filter((position) => Number(position.position_qty) !== 0)
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
      equity: venueDecimal(positions.total_collateral_value),
      available: venueDecimal(positions.free_collateral),
      positions: live.map((position) => ({
        symbol: position.symbol,
        side: position.position_qty.startsWith('-') ? 'short' : 'long',
        size: venueDecimal(position.position_qty.replace(/^-/, '')),
        entry: venueDecimal(position.average_open_price),
        unrealizedPnl: venueDecimal(position.unsettled_pnl),
        liquidation: Number(position.est_liq_price) > 0 ? venueDecimal(position.est_liq_price) : null,
        leverage: null,
      })),
      orders: orders.rows.map((order) => ({
        ref: orderRef(order.symbol, order.order_id),
        symbol: order.symbol,
        side: order.side === 'BUY' ? 'buy' : 'sell',
        kind: order.type,
        px: order.price === null ? null : venueDecimal(order.price),
        size: venueDecimal(order.quantity),
        reduceOnly: order.reduce_only,
        placedAt: Number(order.created_time),
        cancelable: true,
      })),
      fills: trades.rows.map((trade) => ({
        id: trade.id,
        symbol: trade.symbol,
        side: trade.side === 'BUY' ? 'buy' : 'sell',
        px: venueDecimal(trade.executed_price),
        size: venueDecimal(trade.executed_quantity),
        fee: venueDecimal(trade.fee),
        time: Number(trade.executed_timestamp),
      })),
    },
  }
}

async function registered(ctx: VenueContext): Promise<boolean> {
  try {
    await publicGet(ctx, `/v1/get_account?address=${ctx.ref.owner}&broker_id=${brokerFor(ctx)}`)
    return true
  } catch (error) {
    if (error instanceof TradeFailure && error.error.kind === 'rejected') return false
    throw error
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
  } catch (error) {
    if (error instanceof TradeFailure && error.error.kind === 'rejected') return false
    throw error
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
  for (const step of (await steps(ctx)).filter((entry) => !entry.done)) {
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
    ).then((reply) => reply.data)
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
  } catch (error) {
    if (error instanceof TradeFailure && error.error.kind === 'rejected') return { fills: [], funding: [], gaps: [] }
    throw error
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
      trades.map((trade): HistoryFill => ({
        venue: 'orderly',
        account: id,
        id: trade.id,
        symbol: trade.symbol,
        side: trade.side === 'BUY' ? 'buy' : 'sell',
        px: venueDecimal(trade.executed_price),
        size: venueDecimal(trade.executed_quantity),
        fee: venueDecimal(trade.fee),
        asset: trade.fee_asset,
        time: Number(trade.executed_timestamp),
        liquidation: trade.order_id === null,
        venuePnl: trade.realized_pnl === null ? null : venueDecimal(trade.realized_pnl),
      })),
    ),
    // Accrued payments are not settled yet and can still change.
    funding: read.flatMap(({ id, payments }) =>
      payments
        .filter((payment) => payment.funding_status === 'Settled')
        .map((payment): FundingPayment => ({
          venue: 'orderly',
          account: id,
          symbol: payment.symbol,
          time: Number(payment.funding_rate_timestamp),
          amount: plain(negate(amount(payment.funding_fee))),
          asset: 'USDC',
          rate: venueDecimal(payment.funding_rate),
          position: venueDecimal(payment.position_qty),
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
