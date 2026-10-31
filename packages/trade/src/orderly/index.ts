import { bytesToHex, hexToBytes } from 'viem'
import { z } from 'zod'
import type { Hex } from 'viem'
import { decimalsOf, parsePx, parseQty, plainDecimal, toPx, wireDecimal } from '@tape/core/fixed'
import type { Px, Scale } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import type { Network } from '@tape/core/ids'
import { isRecord } from '@tape/core/json'
import { checkPrice, checkSize, worstPrice } from '../intent'
import { post, readReply, send } from '../send'
import type { Classify } from '../send'
import { TradeFailure, orderRef, secretHex, toDecimal } from '../types'
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

const messageOf = (reply: Record<string, unknown>, text: string) =>
  typeof reply.message === 'string' ? reply.message : text

const classify: Classify = (status, body, text) => {
  const reply = isRecord(body) ? body : {}
  if (status === 429) return { kind: 'rate-limited', detail: messageOf(reply, text) }
  if (reply.success !== false) return null
  const kind = typeof reply.code === 'string' ? KIND_OF_CODE[reply.code] : undefined
  return kind ? { kind, detail: messageOf(reply, text) } : classifyMessage(messageOf(reply, text))
}

/**
 * Orderly's code for data not found on the server, as when cancelling an order that is already CANCELLED or FILLED,
 * or looking up a client order id it never took.
 */
const NOT_FOUND = '-1006'
const notFound: TradeError = { kind: 'rejected', detail: 'Orderly holds no such order' }
const classifyOrder: Classify = (status, body, text) =>
  isRecord(body) && body.code === NOT_FOUND ? notFound : classify(status, body, text)

/** Not found comes back as `success: false`, sometimes with a 200, so reads treat it as rejected. */
const unsuccessful: Classify = (_s, body, text) =>
  isRecord(body) && body.success === false ? { kind: 'rejected', detail: messageOf(body, text) } : null

const publicGet = <T>(ctx: VenueContext, path: string, reply: z.ZodType<T>) =>
  send('orderly', ctx.fetch, `${API[ctx.ref.network]}${path}`, { mutates: false }, unsuccessful).then((body) =>
    readReply('orderly', reply, body, false),
  )

const SOME_DATA = z.unknown().refine((data) => data != null)

function keyOf(ctx: VenueContext): OrderlyKey | null {
  const secret = ctx.keys.read()?.secret
  return secret ? orderlyKey(hexToBytes(secretHex(secret))) : null
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
  data: z.ZodType<T>,
  body = '',
  classifier = classify,
): Promise<T> {
  const key = keyOf(ctx) ?? fail({ kind: 'needs-setup', detail: 'Enable trading on this device first' })
  const headers = {
    ...signRequest(key, accountId(ctx.ref.owner, brokerFor(ctx)), Date.now(), method, path, body),
    'content-type': method === 'POST' ? 'application/json' : 'application/x-www-form-urlencoded',
  }
  const mutates = method !== 'GET'
  const reply = await send(
    'orderly',
    ctx.fetch,
    `${API[ctx.ref.network]}${path}`,
    { method, headers, ...(body ? { body } : {}), mutates },
    classifier,
  )
  return readReply('orderly', z.object({ data }), reply, mutates).data
}

interface NetworkRules {
  readonly spec: OrderRules
  readonly priceRange: string | null
}

const rulesCache = new Map<string, Promise<NetworkRules>>()

const SymbolInfo = z.object({
  data: z.object({ quote_tick: z.string(), base_tick: z.string(), price_range: z.string().nullish() }),
})
const Futures = z.object({ data: z.object({ mark_price: z.string().nullish() }) })

function networkRules(ctx: VenueContext, symbol: string): Promise<NetworkRules> {
  const cacheKey = `${ctx.ref.network}:${symbol}`
  let cached = rulesCache.get(cacheKey)
  if (!cached) {
    cached = publicGet(ctx, `/v1/public/info/${symbol}`, SymbolInfo).then(({ data }) => {
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
  const { data } = await publicGet(ctx, `/v1/public/futures/${symbol}`, Futures)
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

const Level = z.object({ price: z.string() })
const Touch = z.object({ data: z.object({ asks: z.array(Level), bids: z.array(Level) }) })

async function farTouch(ctx: VenueContext, spec: Pick<MarketSpec, 'venueSymbol' | 'scale'>, side: Side): Promise<Px> {
  const reply = await send(
    'orderly',
    ctx.fetch,
    `${API[ctx.ref.network]}/v1/public/query`,
    { ...post({ type: 'orderbook', symbol: spec.venueSymbol, max_level: 1 }), mutates: false },
    unsuccessful,
  )
  const { data } = readReply('orderly', Touch, reply, false)
  const far = (side === 'buy' ? data.asks : data.bids)[0]
  return far
    ? parsePx(plainDecimal(far.price), spec.scale)
    : fail({ kind: 'invalid-order', detail: 'The book on this network is empty' })
}

async function lookupOne(ctx: VenueContext, clientId: string): Promise<OrderLookup> {
  try {
    const order = await signed(
      ctx,
      'GET',
      `/v1/client/order/${clientId}`,
      z.object({ status: z.string() }),
      '',
      classifyOrder,
    )
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

const BatchRows = z.looseObject({
  rows: z.array(z.object({ order_id: z.string().nullish(), error_message: z.string().nullish() })).optional(),
})

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
  const data = await signed(ctx, 'POST', '/v1/batch-order', BatchRows, batchBody(legs))
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
      const data = await signed(ctx, 'POST', '/v1/order', z.object({ order_id: z.string() }), body)
      return {
        kind: 'placed',
        status: type === 'IOC' ? 'accepted' : 'resting',
        detail: `Order ${data.order_id}`,
      }
    }
    case 'cancel': {
      const [symbol, id] = command.order.split(':') as [string, string]
      try {
        await signed(ctx, 'DELETE', cancelPath(symbol, Number(id)), SOME_DATA, '', classifyOrder)
      } catch (error) {
        if (!(error instanceof TradeFailure && error.error === notFound)) throw error
      }
      return { kind: 'done', detail: 'Canceled' }
    }
    case 'cancel-all':
      await signed(ctx, 'DELETE', `/v1/orders?symbol=${command.symbol}`, SOME_DATA)
      return { kind: 'done', detail: `Canceled open ${command.symbol} orders` }
    case 'leverage':
      await signed(ctx, 'POST', '/v1/client/leverage', SOME_DATA, JSON.stringify({ leverage: command.leverage }))
      return { kind: 'done', detail: `Account leverage ${command.leverage}x` }
  }
}

const venueDecimal = (text: string) => toDecimal(plainDecimal(text))

const Positions = z.object({
  total_collateral_value: z.string(),
  free_collateral: z.string(),
  rows: z.array(
    z.object({
      symbol: z.string(),
      position_qty: z.string(),
      average_open_price: z.string(),
      unsettled_pnl: z.string(),
      est_liq_price: z.string(),
    }),
  ),
})
const Orders = z.object({
  rows: z.array(
    z.object({
      order_id: z.string(),
      symbol: z.string(),
      side: z.string(),
      type: z.string(),
      price: z.string().nullable(),
      quantity: z.string(),
      reduce_only: z.boolean(),
      created_time: z.string(),
    }),
  ),
})
const Trades = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      symbol: z.string(),
      side: z.string(),
      executed_price: z.string(),
      executed_quantity: z.string(),
      fee: z.string(),
      executed_timestamp: z.string(),
    }),
  ),
})

async function account(ctx: VenueContext): Promise<AccountView> {
  if (!keyOf(ctx) || ctx.keys.read()?.status !== 'linked') return { kind: 'unknown' }
  const [positions, orders, trades] = await Promise.all([
    signed(ctx, 'GET', '/v1/positions', Positions),
    signed(ctx, 'GET', '/v1/orders?status=INCOMPLETE', Orders),
    signed(ctx, 'GET', '/v1/trades?size=20', Trades),
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
    await publicGet(ctx, `/v1/get_account?address=${ctx.ref.owner}&broker_id=${brokerFor(ctx)}`, z.unknown())
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
    const { data } = await publicGet(
      ctx,
      `/v1/get_orderly_key?account_id=${accountId(ctx.ref.owner, brokerFor(ctx))}&orderly_key=${encodeURIComponent(key.id)}`,
      z.object({ data: z.object({ expiration: z.string().optional() }) }),
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
      const { data } = await publicGet(
        ctx,
        '/v1/registration_nonce',
        z.object({ data: z.object({ registration_nonce: z.string() }) }),
      )
      const typed = registrationTypedData(brokerId, chainId, data.registration_nonce, Date.now())
      await submit('/v1/register_account', typed.message, await wallet.signTypedData(typed))
    }
    if (step.id === 'add-key') {
      const existing = ctx.keys.read()
      const key = existing?.secret ? orderlyKey(hexToBytes(secretHex(existing.secret))) : orderlyKey()
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

const QueryTrade = z.object({
  id: z.string(),
  symbol: z.string(),
  side: z.string(),
  executed_price: z.string(),
  executed_quantity: z.string(),
  fee: z.string(),
  fee_asset: z.string(),
  /** Null on liquidation fills. */
  order_id: z.string().nullable(),
  realized_pnl: z.string().nullable(),
  executed_timestamp: z.string(),
})

const QueryFunding = z.object({
  symbol: z.string(),
  funding_rate: z.string(),
  funding_fee: z.string(),
  position_qty: z.string(),
  funding_rate_timestamp: z.string(),
  funding_status: z.string(),
})

const page = <T>(row: z.ZodType<T>) => z.object({ rows: z.array(row), next_cursor: z.string().nullable() })

/**
 * Orderly's public query reads any address without a key. Without a time range it returns only the
 * last 24 hours, so every read starts at 1 ms and follows the cursor into the archive.
 */
async function history({ network, address, fetch }: HistoryRequest): Promise<VenueHistory> {
  const query = <T>(body: Record<string, unknown>, data: z.ZodType<T>) =>
    send('orderly', fetch, `${API[network]}/v1/public/query`, { ...post(body), mutates: false }, unsuccessful).then(
      (reply) => readReply('orderly', z.object({ data }), reply, false).data,
    )
  const follow = async <T>(body: Record<string, unknown>, row: z.ZodType<T>): Promise<T[]> => {
    const rows: T[] = []
    let cursor: string | null = null
    do {
      const got: { rows: T[]; next_cursor: string | null } = await query(
        { ...body, ...(cursor ? { cursor } : {}) },
        page(row),
      )
      rows.push(...got.rows)
      cursor = got.next_cursor
    } while (cursor)
    return rows
  }
  let accounts: { account_id: string }[]
  try {
    accounts = (
      await query(
        { type: 'accountState', address },
        z.object({ accounts: z.array(z.object({ account_id: z.string() })) }),
      )
    ).accounts
  } catch (error) {
    if (error instanceof TradeFailure && error.error.kind === 'rejected') return { fills: [], funding: [], gaps: [] }
    throw error
  }
  const read = await Promise.all(
    accounts.map(async ({ account_id }) => {
      const scope = { address, account_id, start_time: 1 }
      const [trades, payments] = await Promise.all([
        follow({ type: 'trades', ...scope, limit: TRADE_PAGE }, QueryTrade),
        follow({ type: 'fundingPayments', ...scope, limit: FUNDING_PAGE }, QueryFunding),
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
