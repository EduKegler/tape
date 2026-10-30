import { bytesToHex, hexToBytes } from 'viem'
import type { Hex } from 'viem'
import { decimalsOf, parsePx, parseQty, plainDecimal, wireDecimal } from '@tape/core/fixed'
import type { Scale } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import { checkPrice, checkSize } from '../intent'
import { send } from '../send'
import type { Classify } from '../send'
import type { Network } from '@tape/core/ids'
import { TradeFailure } from '../types'
import type {
  AccountView,
  Command,
  CommandOutcome,
  Decimal,
  OrderIntent,
  OrderLookup,
  OrderRef,
  SetupStep,
  StepId,
  TradeConfig,
  TradeError,
  TradingVenue,
  VenueContext,
  WalletSigner,
} from '../types'
import { accountId, addKeyTypedData, orderlyKey, registrationTypedData, signRequest } from './sign'
import type { OrderlyKey } from './sign'
import { cancelPath, orderBody } from './wire'
import type { OrderType } from './wire'

const API: Record<Network, string> = { mainnet: 'https://api.orderly.org', testnet: 'https://testnet-api.orderly.org' }
/** Orderly signs EIP-712 against a chain it supports, and wallets sign only for the active chain. */
const CHAIN_ID: Record<Network, number> = { mainnet: 42161, testnet: 421614 }
/** `read` lets the key fetch positions and orders. Never `asset`: that scope withdraws. */
const SCOPE = 'read,trading'
const KEY_DAYS = 365
const TYPE: Record<'gtc' | 'ioc' | 'post-only', OrderType> = { gtc: 'LIMIT', ioc: 'IOC', 'post-only': 'POST_ONLY' }

const brokerOf = (config: TradeConfig, network: Network) => config.orderly.brokerId[network]

function fail(error: TradeError): never {
  throw new TradeFailure('orderly', error)
}

export function classifyMessage(message: string): TradeError {
  if (/orderly key|signature|not registered|account.*(?:not found|not exist)/i.test(message))
    return { kind: 'needs-setup', detail: message }
  if (/insufficient|margin|collateral/i.test(message)) return { kind: 'insufficient-margin', detail: message }
  if (/price|quantity|notional|tick|size/i.test(message)) return { kind: 'invalid-order', detail: message }
  return { kind: 'rejected', detail: message }
}

const classify: Classify = (status, body, text) => {
  const b = body as { success?: boolean; message?: string } | null
  if (status === 429) return { kind: 'rate-limited', detail: b?.message ?? text }
  return b?.success === false ? classifyMessage(b.message ?? text) : null
}

/** Not found comes back as `success: false`, sometimes with a 200, so reads treat it as rejected. */
const publicGet = <T>(ctx: VenueContext, path: string) =>
  send<{ data: T }>('orderly', ctx.fetch, `${API[ctx.ref.network]}${path}`, { mutates: false }, (_s, body, text) => {
    const b = body as { success?: boolean; message?: string } | null
    return b?.success === false ? { kind: 'rejected', detail: b.message ?? text } : null
  })

function keyOf(ctx: VenueContext): OrderlyKey | null {
  const secret = ctx.keys.read()?.secret
  return secret ? orderlyKey(hexToBytes(secret as Hex)) : null
}

function brokerFor(ctx: VenueContext): string {
  return (
    brokerOf(ctx.config, ctx.ref.network) ?? fail({ kind: 'unsupported', detail: 'No Orderly broker id configured' })
  )
}

async function signed<T>(ctx: VenueContext, method: 'GET' | 'POST' | 'DELETE', path: string, body = ''): Promise<T> {
  const key = keyOf(ctx) ?? fail({ kind: 'needs-setup', detail: 'Enable trading on this device first' })
  const headers = {
    ...signRequest(key, accountId(ctx.ref.owner, brokerFor(ctx)), Date.now(), method, path, body),
    'content-type': method === 'POST' ? 'application/json' : 'application/x-www-form-urlencoded',
  }
  const reply = await send<{ data: T }>(
    'orderly',
    ctx.fetch,
    `${API[ctx.ref.network]}${path}`,
    { method, headers, ...(body ? { body } : {}), mutates: method !== 'GET' },
    classify,
  )
  return reply.data
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

async function lookup(ctx: VenueContext, intent: OrderIntent): Promise<OrderLookup> {
  try {
    const order = await signed<{ status: string }>(ctx, 'GET', `/v1/client/order/${intent.clientId}`)
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

async function execute(ctx: VenueContext, command: Command): Promise<CommandOutcome> {
  switch (command.kind) {
    case 'place': {
      const intent = command.intent
      const symbol = intent.spec.venueSymbol
      const spec = await networkSpec(ctx, symbol)
      const quantity = wireDecimal(intent.size, intent.spec.scale.qty)
      const sizeIssue = checkSize(spec, quantity)
      if (sizeIssue) fail({ kind: 'invalid-order', detail: `Size ${quantity}: ${sizeIssue} on this network` })
      let price: string | null = null
      if (intent.order.kind === 'limit') {
        price = wireDecimal(intent.order.px, intent.spec.scale.px)
        const issue = checkPrice(spec, price)
        if (issue) fail({ kind: 'invalid-order', detail: `Price ${price}: ${issue} on this network` })
      }
      const type = intent.order.kind === 'limit' ? TYPE[intent.order.tif] : 'MARKET'
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
        status: type === 'MARKET' || type === 'IOC' ? 'accepted' : 'resting',
        detail: `Order ${data.order_id}`,
      }
    }
    case 'cancel': {
      const [symbol, id] = command.order.split(':') as [string, string]
      try {
        await signed(ctx, 'DELETE', cancelPath(symbol, Number(id)))
      } catch (e) {
        if (!(
          e instanceof TradeFailure
          && 'detail' in e.error
          && /order.*(?:not exist|not found)|already (?:filled|cancel)/i.test(e.error.detail)
        ))
          throw e
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

export const orderly = {
  id: 'orderly',
  label: 'Orderly',
  secrets: 'device',
  capabilities: { tif: ['gtc', 'ioc', 'post-only'], triggers: false, leverage: true },
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
} satisfies TradingVenue & { id: 'orderly' }
