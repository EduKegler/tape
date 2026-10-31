import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { z } from 'zod'
import type { Address } from 'viem'
import { parsePx, toDecimals, toQty, wireDecimal } from '@tape/core/fixed'
import type { Px } from '@tape/core/fixed'
import type { Network } from '@tape/core/ids'
import { isRecord } from '@tape/core/json'
import { checkExits, checkPrice, checkSize, takeProfitField, worstPrice } from '../intent'
import { clientIdsOf, lookupSummary, scaleOutcome } from '../scale-order'
import { maintenanceMargin } from '../liquidation'
import type { MarginState, MarginTier } from '../liquidation'
import { post, readReply, send } from '../send'
import type { Classify } from '../send'
import { localSigner } from '../typed-data'
import { TradeFailure, orderRef, secretHex, toDecimal } from '../types'
import type {
  AccountView,
  Bps,
  Command,
  CommandOutcome,
  HistoryRequest,
  IntentFields,
  OrderIntent,
  OrderLookup,
  OrderRules,
  OrderRef,
  SetupStep,
  StepId,
  TradeError,
  TradingVenue,
  VenueContext,
  WalletSigner,
} from '../types'
import { walkByTime } from '../history'
import type { FundingPayment, HistoryFill, VenueHistory } from '../history'
import { signL1Action, signUserAction, signatureChainIdHex } from './sign'
import { cancelAction, leverageAction, orderAction, orderWire, trailingStopAction } from './wire'
import type { OrderWire, Tif } from './wire'

const API: Record<Network, string> = {
  mainnet: 'https://api.hyperliquid.xyz',
  testnet: 'https://api.hyperliquid-testnet.xyz',
}
const CHAIN = { mainnet: 'Mainnet', testnet: 'Testnet' } as const
/** Re-approving under the same name replaces Tape's agent and leaves the user's other API wallets alone. */
const AGENT_NAME = 'tape'
/** Market triggers fill at market. The limit only bounds them, as Hyperliquid's own UI does at 10%. */
const TRIGGER_SLIPPAGE_BPS = 1000
const TIF: Record<'gtc' | 'ioc' | 'post-only', Tif> = { gtc: 'Gtc', ioc: 'Ioc', 'post-only': 'Alo' }
const SCALE_ORDERS = 20
/** Hyperliquid refuses a normalTpsl group with more trigger orders than this: "Unexpected number of trigger orders." */
const TRIGGERS = 2

interface Asset {
  readonly index: number
  readonly spec: OrderRules
  readonly tiers: readonly MarginTier[]
  readonly isolatedOnly: boolean
}

const HlMeta = z.object({
  universe: z.array(
    z.object({
      name: z.string(),
      szDecimals: z.string(),
      maxLeverage: z.string().optional(),
      marginTableId: z.string().optional(),
      onlyIsolated: z.boolean().optional(),
    }),
  ),
  marginTables: z
    .array(
      z.tuple([
        z.string(),
        z.object({ marginTiers: z.array(z.object({ lowerBound: z.string(), maxLeverage: z.string() })) }),
      ]),
    )
    .optional(),
})

type Meta = ReadonlyMap<string, Asset>

const metas = new Map<Network, Promise<Meta>>()

function fail(error: TradeError): never {
  throw new TradeFailure('hyperliquid', error)
}

/** Hyperliquid answers 200 with `status: err` or with an error per order, in prose. */
export function classifyText(text: string): TradeError {
  if (/does not exist/i.test(text)) return { kind: 'needs-setup', detail: text }
  if (/must deposit/i.test(text)) return { kind: 'no-account', detail: text }
  if (/insufficient margin/i.test(text)) return { kind: 'insufficient-margin', detail: text }
  if (/price|tick|size|invalid|minimum value/i.test(text)) return { kind: 'invalid-order', detail: text }
  return { kind: 'rejected', detail: text }
}

const classify: Classify = (_status, body) =>
  isRecord(body) && body.status === 'err' ? classifyText(String(body.response)) : null

const read = <T>(reply: z.ZodType<T>, body: unknown) => readReply('hyperliquid', reply, body, false)
const infoAt = <T>(network: Network, fetch: typeof globalThis.fetch, body: unknown, reply: z.ZodType<T>) =>
  send('hyperliquid', fetch, `${API[network]}/info`, { ...post(body), mutates: false }, () => null).then((got) =>
    read(reply, got),
  )
const info = <T>(ctx: VenueContext, body: unknown, reply: z.ZodType<T>) =>
  infoAt(ctx.ref.network, ctx.fetch, body, reply)

/** Asset ids and szDecimals differ between mainnet and testnet, so each network gets its own rules. */
function meta(ctx: VenueContext): Promise<Meta> {
  const network = ctx.ref.network
  let cached = metas.get(network)
  if (!cached) {
    cached = info(ctx, { type: 'meta' }, HlMeta).then((hlMeta) => {
      const tables = new Map(hlMeta.marginTables)
      return new Map(
        hlMeta.universe.map((perp, index) => {
          const qty = toDecimals(Number(perp.szDecimals))
          const spec: OrderRules = {
            venueSymbol: perp.name,
            scale: { px: toDecimals(6 - qty), qty },
            tick: { kind: 'sigfig', figures: 5 },
            step: toQty(1),
          }
          // A table id the list lacks is a single tier at the asset's max leverage.
          const tiers = (
            (perp.marginTableId === undefined ? undefined : tables.get(perp.marginTableId)?.marginTiers) ?? [
              { lowerBound: '0', maxLeverage: perp.maxLeverage },
            ]
          ).map((tier) => ({ lowerBound: Number(tier.lowerBound), maxLeverage: Number(tier.maxLeverage) }))
          return [perp.name, { index, spec, tiers, isolatedOnly: Boolean(perp.onlyIsolated) }] as const
        }),
      )
    })
    cached.catch(() => metas.delete(network))
    metas.set(network, cached)
  }
  return cached
}

async function asset(ctx: VenueContext, symbol: string): Promise<Asset> {
  return (
    (await meta(ctx)).get(symbol)
    ?? fail({ kind: 'invalid-order', detail: `${symbol} is not listed on Hyperliquid ${ctx.ref.network}` })
  )
}

function recheckPx(market: Asset, intent: OrderIntent, px: Px, what: string): string {
  const wire = wireDecimal(px, intent.spec.scale.px)
  const issue = checkPrice(market.spec, wire)
  return issue ? fail({ kind: 'invalid-order', detail: `${what} ${wire}: ${issue} on this network` }) : wire
}

function recheckSize(market: Asset, intent: OrderIntent): string {
  const size = wireDecimal(intent.size, intent.spec.scale.qty)
  const issue = checkSize(market.spec, size)
  return issue ? fail({ kind: 'invalid-order', detail: `Size ${size}: ${issue} on this network` }) : size
}

const Book = z.object({ levels: z.array(z.array(z.object({ px: z.string() }))) })

async function touch(ctx: VenueContext, market: Asset): Promise<{ bid: Px | null; ask: Px | null }> {
  const book = await info(ctx, { type: 'l2Book', coin: market.spec.venueSymbol }, Book)
  const [bid, ask] = book.levels.map((side) => (side[0] ? parsePx(side[0].px, market.spec.scale) : null))
  return { bid: bid ?? null, ask: ask ?? null }
}

async function placeWires(
  ctx: VenueContext,
  intent: OrderIntent,
): Promise<{ wires: OrderWire[]; grouping: 'na' | 'normalTpsl' }> {
  const { takeProfits, stopLoss } = intent.triggers
  if (takeProfits.length + (stopLoss === null ? 0 : 1) > TRIGGERS)
    fail({ kind: 'invalid-order', detail: `At most ${TRIGGERS} take profits and stop losses on one order` })
  const market = await asset(ctx, intent.spec.venueSymbol)
  const size = recheckSize(market, intent)
  const isBuy = intent.side === 'buy'
  if (intent.order.kind === 'scale') {
    if (takeProfits.length > 0 || stopLoss !== null)
      fail({ kind: 'invalid-order', detail: 'A scale order carries no take profit or stop loss' })
    const tif = TIF[intent.order.tif]
    const wires = intent.order.legs.map((leg, index) => {
      const legSize = wireDecimal(leg.size, intent.spec.scale.qty)
      const issue = checkSize(market.spec, legSize)
      if (issue) fail({ kind: 'invalid-order', detail: `Order ${index + 1} size ${legSize}: ${issue} on this network` })
      const px = recheckPx(market, intent, leg.px, `Order ${index + 1} price`)
      return orderWire(market.index, isBuy, px, legSize, intent.reduceOnly, { limit: { tif } }, leg.clientId)
    })
    return { wires, grouping: 'na' }
  }
  const named = takeProfits.length > 1 ? (index: number) => `Take profit ${index + 1}` : () => 'Take profit'
  const exits = {
    takeProfits: takeProfits.map((tp, index) => {
      const tpSize = wireDecimal(tp.size, intent.spec.scale.qty)
      const issue = checkSize(market.spec, tpSize)
      if (issue) fail({ kind: 'invalid-order', detail: `${named(index)} size ${tpSize}: ${issue} on this network` })
      return { px: parsePx(recheckPx(market, intent, tp.px, named(index)), market.spec.scale), size: tpSize }
    }),
    stopLoss: stopLoss === null ? null : parsePx(recheckPx(market, intent, stopLoss, 'Stop loss'), market.spec.scale),
  }
  const order = intent.order
  const limit =
    order.kind === 'limit' ? { px: recheckPx(market, intent, order.px, 'Price'), tif: TIF[order.tif] } : null
  const book =
    limit === null || exits.takeProfits.length > 0 || exits.stopLoss !== null ? await touch(ctx, market) : null
  if (book) {
    const issues = checkExits(
      intent.side,
      { px: limit && parsePx(limit.px, market.spec.scale), ...book },
      { takeProfits: exits.takeProfits.map((tp) => tp.px), stopLoss: exits.stopLoss },
    )
    const first =
      exits.takeProfits
        .map((_, index) => issues[takeProfitField(index)] && `${named(index)}: ${issues[takeProfitField(index)]}`)
        .find(Boolean)
      ?? (issues.stopLoss && `Stop loss: ${issues.stopLoss}`)
    if (first) fail({ kind: 'invalid-order', detail: `${first} on this network` })
  }
  const far = (isBuy ? book?.ask : book?.bid) ?? null
  const sent =
    limit
    ?? (order.kind === 'market' && far !== null
      ? {
          px: wireDecimal(worstPrice(market.spec, intent.side, far, order.slippage), market.spec.scale.px),
          tif: 'Ioc' as const,
        }
      : fail({ kind: 'invalid-order', detail: 'The book on this network is empty' }))
  const wires = [
    orderWire(market.index, isBuy, sent.px, size, intent.reduceOnly, { limit: { tif: sent.tif } }, intent.clientId),
  ]
  const closing = isBuy ? 'sell' : 'buy'
  const trigger = (tpsl: 'tp' | 'sl', px: Px, sz: string) => {
    const triggerPx = wireDecimal(px, market.spec.scale.px)
    const bound = wireDecimal(worstPrice(market.spec, closing, px, TRIGGER_SLIPPAGE_BPS), market.spec.scale.px)
    return orderWire(market.index, !isBuy, bound, sz, true, { trigger: { isMarket: true, triggerPx, tpsl } })
  }
  for (const tp of exits.takeProfits) wires.push(trigger('tp', tp.px, tp.size))
  if (exits.stopLoss !== null) wires.push(trigger('sl', exits.stopLoss, size))
  return { wires, grouping: wires.length > 1 ? 'normalTpsl' : 'na' }
}

let lastNonce = 0
const nextNonce = () => (lastNonce = Math.max(Date.now(), lastNonce + 1))

function agentOf(ctx: VenueContext) {
  const secret = ctx.keys.read()?.secret
  return secret
    ? privateKeyToAccount(secretHex(secret))
    : fail({ kind: 'needs-setup', detail: 'Enable trading on this device first' })
}

const Status = z.union([
  z.string(),
  z.looseObject({
    resting: z.object({ oid: z.string() }).optional(),
    filled: z.object({ totalSz: z.string(), avgPx: z.string() }).optional(),
    error: z.string().optional(),
  }),
])
const Reply = z.object({
  status: z.literal('ok'),
  response: z.object({
    type: z.string(),
    data: z.object({ statuses: z.array(Status).optional(), oid: z.string().optional() }).optional(),
  }),
})
type Statuses = z.infer<typeof Reply>

async function exchange(ctx: VenueContext, action: unknown): Promise<Statuses> {
  const nonce = nextNonce()
  const signature = await signL1Action(localSigner(agentOf(ctx)), action, nonce, CHAIN[ctx.ref.network])
  const body = await send(
    'hyperliquid',
    ctx.fetch,
    `${API[ctx.ref.network]}/exchange`,
    { ...post({ action, nonce, signature }), mutates: true },
    classify,
  )
  return readReply('hyperliquid', Reply, body, true)
}

const GONE = /never placed|already canceled|filled/i
function legNames(wires: readonly OrderWire[]): string[] {
  const tpsl = wires.map((wire) => ('trigger' in wire.t ? wire.t.trigger.tpsl : null))
  const tps = tpsl.filter((kind) => kind === 'tp').length
  let tpNumber = 0
  return tpsl.map((kind) => (kind === 'tp' ? (tps > 1 ? `TP ${++tpNumber}` : 'TP') : kind === 'sl' ? 'SL' : 'Leg'))
}

type OrderStatus = z.infer<typeof Status>
const errorOf = (status: OrderStatus | undefined) => (typeof status === 'object' ? status.error : undefined)

function orderOutcome(wires: readonly OrderWire[], statuses: readonly OrderStatus[]): CommandOutcome {
  const [first, ...legs] = statuses
  const error = errorOf(first)
  if (error) fail(classifyText(error))
  // The order stands even when a TP/SL leg is refused, so the refusal rides in the detail.
  const names = legNames(wires)
  const refused = legs.flatMap((status, index) => {
    const legError = errorOf(status)
    return legError ? [`${names[index + 1]} not placed: ${legError}`] : []
  })
  const note = refused.length > 0 ? `. ${refused.join('. ')}` : ''
  if (typeof first === 'object' && first.filled)
    return {
      kind: 'placed',
      status: 'filled',
      detail: `Filled ${first.filled.totalSz} at ${first.filled.avgPx}${note}`,
    }
  if (typeof first === 'object' && first.resting)
    return { kind: 'placed', status: 'resting', detail: `Resting as order ${first.resting.oid}${note}` }
  return {
    kind: 'placed',
    status: 'accepted',
    detail: `${typeof first === 'string' ? first : JSON.stringify(first)}${note}`,
  }
}

/** Hyperliquid judges each order of the action on its own, so some legs can stand while others are refused. */
function legsOutcome(statuses: readonly OrderStatus[]): CommandOutcome {
  const count = (key: 'resting' | 'filled') =>
    statuses.filter((status) => typeof status === 'object' && status[key]).length
  const refusals = statuses.map(errorOf)
  const stood = refusals.filter((refusal) => !refusal).length
  const resting = count('resting')
  const filled = count('filled')
  return scaleOutcome(
    refusals,
    filled === stood ? 'filled' : resting > 0 ? 'resting' : 'accepted',
    (error) => fail(classifyText(error)),
    `: ${resting} resting, ${filled} filled`,
  )
}

type Trailing = Extract<IntentFields['order'], { kind: 'trailing' }>
const percent = (bps: Bps): `${number}%` => `${bps / 100}%`

async function placeTrailing(ctx: VenueContext, intent: OrderIntent, order: Trailing): Promise<CommandOutcome> {
  if (intent.triggers.takeProfits.length > 0 || intent.triggers.stopLoss !== null)
    fail({ kind: 'invalid-order', detail: 'A trailing stop carries no take profit or stop loss' })
  const market = await asset(ctx, intent.spec.venueSymbol)
  const size = recheckSize(market, intent)
  const retracement =
    'pct' in order.retracement
      ? { pct: percent(order.retracement.pct) }
      : { px: recheckPx(market, intent, order.retracement.px, 'Retracement') }
  const activationPx =
    order.activation === null ? null : recheckPx(market, intent, order.activation, 'Activation price')
  const reply = await exchange(
    ctx,
    trailingStopAction(market.index, intent.side === 'buy', size, intent.reduceOnly, retracement, activationPx),
  )
  const oid = reply.response.data?.oid
  return oid
    ? { kind: 'placed', status: 'resting', detail: `Resting as order ${oid}` }
    : fail({ kind: 'unknown-outcome', detail: `No order id in the reply: ${JSON.stringify(reply)}` })
}

async function execute(ctx: VenueContext, command: Command): Promise<CommandOutcome> {
  switch (command.kind) {
    case 'place': {
      const { order } = command.intent
      if (order.kind === 'trailing') return placeTrailing(ctx, command.intent, order)
      const { wires, grouping } = await placeWires(ctx, command.intent)
      const reply = await exchange(ctx, orderAction(wires, grouping, ctx.config.hyperliquid.builder))
      const statuses = reply.response.data?.statuses ?? []
      if (statuses.length === 0)
        fail({ kind: 'unknown-outcome', detail: `No order status in the reply: ${JSON.stringify(reply)}` })
      return command.intent.order.kind === 'scale' ? legsOutcome(statuses) : orderOutcome(wires, statuses)
    }
    case 'cancel':
    case 'cancel-all': {
      const targets = command.kind === 'cancel' ? [refParts(command.order)] : await openOf(ctx, command.symbol)
      if (targets.length === 0) return { kind: 'done', detail: 'Nothing to cancel' }
      const reply = await exchange(ctx, cancelAction(targets))
      const errors = (reply.response.data?.statuses ?? []).flatMap((status) =>
        typeof status === 'object' && status.error && !GONE.test(status.error) ? [status.error] : [],
      )
      if (errors.length > 0) fail(classifyText(errors.join('; ')))
      return { kind: 'done', detail: `Canceled ${targets.length}` }
    }
    case 'leverage': {
      const market = await asset(ctx, command.symbol)
      await exchange(ctx, leverageAction(market.index, true, command.leverage))
      return { kind: 'done', detail: `Leverage ${command.leverage}x cross` }
    }
  }
}

const OrderLookupReply = z.object({ status: z.string(), order: z.object({ status: z.string() }).nullish() })

/** Orders belong to the owner, whichever agent signed them, and `orderStatus` takes the cloid as the oid. */
async function lookup(ctx: VenueContext, intent: OrderIntent): Promise<OrderLookup> {
  if (intent.order.kind === 'trailing')
    fail({
      kind: 'unsupported',
      detail: 'Hyperliquid takes no client id on a trailing stop, so it cannot be found by one',
    })
  const replies = await Promise.all(
    clientIdsOf(intent).map((oid) => info(ctx, { type: 'orderStatus', user: ctx.ref.owner, oid }, OrderLookupReply)),
  )
  return lookupSummary(
    replies.map((reply) =>
      reply.status === 'order' && reply.order
        ? { kind: 'found', detail: `Order ${reply.order.status}` }
        : { kind: 'absent', detail: `Hyperliquid answered ${reply.status}` },
    ),
  )
}

const refOf = (index: number, oid: string) => orderRef(index, oid)
function refParts(ref: OrderRef) {
  const [index, oid] = ref.split(':')
  return { asset: Number(index), oid: Number(oid) }
}

const HlOrders = z.array(
  z.object({
    coin: z.string(),
    side: z.string(),
    limitPx: z.string(),
    sz: z.string(),
    oid: z.string(),
    timestamp: z.string(),
    orderType: z.string(),
    reduceOnly: z.boolean(),
    isTrigger: z.boolean(),
    triggerPx: z.string(),
  }),
)

async function openOf(ctx: VenueContext, symbol: string) {
  const [orders, markets] = await Promise.all([
    info(
      ctx,
      { type: 'frontendOpenOrders', user: ctx.ref.owner },
      z.array(z.object({ coin: z.string(), oid: z.string() })),
    ),
    meta(ctx),
  ])
  return orders
    .filter((order) => order.coin === symbol)
    .map((order) => ({ asset: markets.get(order.coin)?.index ?? -1, oid: Number(order.oid) }))
}

const UNIFIED = new Set(['unifiedAccount', 'portfolioMargin'])
const isUnified = (mode: unknown) => typeof mode === 'string' && UNIFIED.has(mode)

const AccountState = z.object({
  marginSummary: z.object({ accountValue: z.string() }),
  withdrawable: z.string(),
  assetPositions: z.array(
    z.object({
      position: z.object({
        coin: z.string(),
        szi: z.string(),
        entryPx: z.string(),
        unrealizedPnl: z.string(),
        liquidationPx: z.string().nullable(),
        leverage: z.object({ type: z.string(), value: z.string() }),
      }),
    }),
  ),
})
const Spot = z.object({
  balances: z.array(z.object({ coin: z.string(), token: z.string(), total: z.string() })),
  tokenToAvailableAfterMaintenance: z.array(z.tuple([z.string(), z.string()])).optional(),
})
const HlFills = z.array(
  z.object({
    coin: z.string(),
    px: z.string(),
    sz: z.string(),
    side: z.string(),
    time: z.string(),
    fee: z.string(),
    tid: z.string(),
  }),
)

async function account(ctx: VenueContext): Promise<AccountView> {
  const user = ctx.ref.owner
  const [state, spotState, mode, orders, fills, markets] = await Promise.all([
    info(ctx, { type: 'clearinghouseState', user }, AccountState),
    info(ctx, { type: 'spotClearinghouseState', user }, z.unknown()),
    info(ctx, { type: 'userAbstraction', user }, z.unknown()),
    info(ctx, { type: 'frontendOpenOrders', user }, HlOrders),
    info(ctx, { type: 'userFills', user }, HlFills),
    meta(ctx),
  ])
  // A unified or portfolio margin account keeps one USDC balance in spot for spot and perps alike.
  // Its perp state holds only the margin in use, so it is not the balance.
  const spot = isUnified(mode) ? read(Spot, spotState) : null
  const usdc = spot?.balances.find((balance) => balance.coin === 'USDC')
  const equity = usdc ? usdc.total : state.marginSummary.accountValue
  const available = usdc
    ? (spot?.tokenToAvailableAfterMaintenance?.find(([token]) => token === usdc.token)?.[1] ?? usdc.total)
    : state.withdrawable
  if (Number(equity) === 0 && state.assetPositions.length === 0 && orders.length === 0 && fills.length === 0)
    return { kind: 'empty' }
  return {
    kind: 'live',
    snapshot: {
      equity: toDecimal(equity),
      available: toDecimal(available),
      positions: state.assetPositions.map(({ position }) => ({
        symbol: position.coin,
        side: position.szi.startsWith('-') ? 'short' : 'long',
        size: toDecimal(position.szi.replace(/^-/, '')),
        entry: toDecimal(position.entryPx),
        unrealizedPnl: toDecimal(position.unrealizedPnl),
        // An estimate the venue sends unrounded, so it gets the market's price decimals.
        liquidation: position.liquidationPx
          ? toDecimal(Number(position.liquidationPx).toFixed(markets.get(position.coin)?.spec.scale.px ?? 6))
          : null,
        leverage: `${position.leverage.value}x ${position.leverage.type}`,
      })),
      orders: orders.map((order) => ({
        ref: refOf(markets.get(order.coin)?.index ?? -1, order.oid),
        symbol: order.coin,
        side: order.side === 'B' ? 'buy' : 'sell',
        kind: order.orderType,
        px: toDecimal(order.isTrigger ? order.triggerPx : order.limitPx),
        size: toDecimal(order.sz),
        reduceOnly: order.reduceOnly,
        placedAt: Number(order.timestamp),
        cancelable: markets.has(order.coin),
      })),
      fills: fills.slice(0, 20).map((fill) => ({
        id: fill.tid,
        symbol: fill.coin,
        side: fill.side === 'B' ? 'buy' : 'sell',
        px: toDecimal(fill.px),
        size: toDecimal(fill.sz),
        fee: toDecimal(fill.fee),
        time: Number(fill.time),
      })),
    },
  }
}

const MarginState = z.object({
  crossMarginSummary: z.object({ accountValue: z.string() }),
  crossMaintenanceMarginUsed: z.string(),
  assetPositions: z.array(
    z.object({
      position: z.object({
        coin: z.string(),
        szi: z.string(),
        positionValue: z.string(),
        leverage: z.object({ type: z.string() }),
      }),
    }),
  ),
})
const ActiveAsset = z.object({ leverage: z.object({ type: z.string() }) })

async function margin(ctx: VenueContext, symbol: string): Promise<MarginState> {
  const user = ctx.ref.owner
  const [market, mode, state, active] = await Promise.all([
    asset(ctx, symbol),
    info(ctx, { type: 'userAbstraction', user }, z.unknown()),
    info(ctx, { type: 'clearinghouseState', user }, MarginState),
    info(ctx, { type: 'activeAssetData', user, coin: symbol }, z.unknown()),
  ])
  if (isUnified(mode)) return { kind: 'unsupported', reason: 'Not estimated for unified accounts' }
  const held = state.assetPositions.find((entry) => entry.position.coin === symbol)?.position
  if (market.isolatedOnly || (held ?? read(ActiveAsset, active)).leverage.type !== 'cross')
    return { kind: 'unsupported', reason: 'Not estimated for isolated margin' }
  const size = held ? Number(held.szi) : 0
  const value = held ? Number(held.positionValue) : 0
  return {
    kind: 'cross',
    accountValue: Number(state.crossMarginSummary.accountValue),
    othersMaintenance: Number(state.crossMaintenanceMarginUsed) - maintenanceMargin(market.tiers, value),
    tiers: market.tiers,
    position: size ? { size, mark: value / Math.abs(size) } : null,
  }
}

const Agents = z.array(z.object({ address: z.string(), validUntil: z.string() }))

async function steps(ctx: VenueContext): Promise<readonly SetupStep[]> {
  const key = ctx.keys.read()
  const agent = key?.public.agent?.toLowerCase()
  const builder = ctx.config.hyperliquid.builder
  const [agents, fee] = await Promise.all([
    info(ctx, { type: 'extraAgents', user: ctx.ref.owner }, Agents),
    builder ? info(ctx, { type: 'maxBuilderFee', user: ctx.ref.owner, builder: builder.b }, z.unknown()) : null,
  ])
  const approved = Boolean(
    key?.secret
    && agent
    && agents.some((entry) => entry.address.toLowerCase() === agent && Number(entry.validUntil) > Date.now()),
  )
  const list: SetupStep[] = [{ id: 'approve-agent', label: 'Approve a trading key', done: approved }]
  if (builder)
    list.push({
      id: 'approve-builder',
      label: `Approve Tape's fee of ${wireDecimal(BigInt(builder.f), 1)} bp`,
      done: Number(fee) >= builder.f,
    })
  return list
}

async function enable(ctx: VenueContext, wallet: WalletSigner, onStep: (step: StepId) => void): Promise<void> {
  const chain = CHAIN[ctx.ref.network]
  const chainId = await wallet.chainId()
  const signatureChainId = signatureChainIdHex(chainId)
  const user = async (
    primaryType: Parameters<typeof signUserAction>[1],
    message: Record<string, string | number>,
    action: Record<string, unknown>,
  ) => {
    const signature = await signUserAction(
      { address: wallet.address, signTypedData: (data) => wallet.signTypedData(data) },
      primaryType,
      message,
      chainId,
    )
    await send(
      'hyperliquid',
      ctx.fetch,
      `${API[ctx.ref.network]}/exchange`,
      {
        ...post({
          action: { ...action, signatureChainId, hyperliquidChain: chain, ...message },
          nonce: message.nonce,
          signature,
        }),
        mutates: true,
      },
      classify,
    )
  }
  for (const step of (await steps(ctx)).filter((entry) => !entry.done)) {
    onStep(step.id)
    if (step.id === 'approve-agent') {
      const existing = ctx.keys.read()
      const secret = existing?.secret ? secretHex(existing.secret) : generatePrivateKey()
      const agent = privateKeyToAccount(secret).address
      if (!existing?.secret) ctx.keys.write({ status: 'draft', public: { agent }, secret })
      await user(
        'HyperliquidTransaction:ApproveAgent',
        { hyperliquidChain: chain, agentAddress: agent, agentName: AGENT_NAME, nonce: Date.now() },
        { type: 'approveAgent' },
      )
    }
    if (step.id === 'approve-builder') {
      const builder = ctx.config.hyperliquid.builder as { b: Address; f: number }
      await user(
        'HyperliquidTransaction:ApproveBuilderFee',
        {
          hyperliquidChain: chain,
          maxFeeRate: `${wireDecimal(BigInt(builder.f), 3)}%`,
          builder: builder.b,
          nonce: Date.now(),
        },
        { type: 'approveBuilderFee' },
      )
    }
  }
  const key = ctx.keys.read()
  if (key) ctx.keys.write({ ...key, status: 'linked' })
}

/** Page sizes from the info endpoint docs. */
const FILL_PAGE = 2000
const FUNDING_PAGE = 500
const RECENT_FILLS = 10000

const HlHistoryFill = z.object({
  coin: z.string(),
  px: z.string(),
  sz: z.string(),
  side: z.string(),
  time: z.string(),
  startPosition: z.string(),
  closedPnl: z.string(),
  hash: z.string(),
  oid: z.string(),
  fee: z.string(),
  feeToken: z.string(),
  tid: z.string(),
  liquidation: z.object({ liquidatedUser: z.string() }).nullish(),
})
type HlHistoryFill = z.infer<typeof HlHistoryFill>

const HlFunding = z.object({
  time: z.string(),
  delta: z.object({ coin: z.string(), usdc: z.string(), szi: z.string(), fundingRate: z.string() }),
})

/** Spot coins are `@index` or `BASE/QUOTE`. Perps on HIP-3 dexes are `dex:COIN`. */
const isSpot = (coin: string) => coin.startsWith('@') || coin.includes('/')

async function history({ network, address, fetch }: HistoryRequest): Promise<VenueHistory> {
  const user = address.toLowerCase()
  const [fills, funding] = await Promise.all([
    walkByTime(
      (startTime) =>
        infoAt(
          network,
          fetch,
          { type: 'userFillsByTime', user, startTime, aggregateByTime: false },
          z.array(HlHistoryFill),
        ),
      // Dust conversions come with tid 0 and a zero hash, so the tid alone repeats.
      {
        size: FILL_PAGE,
        timeOf: (fill) => Number(fill.time),
        keyOf: (fill) => `${fill.tid}:${fill.oid}:${fill.coin}:${fill.hash}`,
      },
    ),
    walkByTime((startTime) => infoAt(network, fetch, { type: 'userFunding', user, startTime }, z.array(HlFunding)), {
      size: FUNDING_PAGE,
      timeOf: (payment) => Number(payment.time),
      keyOf: (payment) => `${payment.time}:${payment.delta.coin}`,
    }),
  ])
  const perps = fills.rows.filter((fill) => !isSpot(fill.coin))
  const firsts = new Map<string, HlHistoryFill>()
  for (const fill of perps) if (!firsts.has(fill.coin)) firsts.set(fill.coin, fill)
  const startsOpen = [...firsts.values()].some((fill) => Number(fill.startPosition) !== 0)
  const gaps: string[] = []
  if (fills.rows.length >= RECENT_FILLS)
    gaps.push(`Hyperliquid serves only its ${RECENT_FILLS} most recent fills, so earlier fills are missing.`)
  else if (startsOpen)
    gaps.push(
      'Hyperliquid serves only its most recent fills, and this history starts with a position already open. Earlier fills are missing.',
    )
  if (fills.stalled || funding.stalled)
    gaps.push('Hyperliquid sent more rows for one moment than a page holds, so later rows are missing.')
  if (perps.length < fills.rows.length) gaps.push('Spot fills are left out.')
  const collateral = new Map(perps.map((fill) => [fill.coin, fill.feeToken]))
  return {
    fills: perps.map((fill): HistoryFill => ({
      venue: 'hyperliquid',
      account: user,
      id: fill.tid,
      symbol: fill.coin,
      side: fill.side === 'B' ? 'buy' : 'sell',
      px: toDecimal(fill.px),
      size: toDecimal(fill.sz),
      fee: toDecimal(fill.fee),
      asset: fill.feeToken,
      time: Number(fill.time),
      liquidation: fill.liquidation?.liquidatedUser.toLowerCase() === user,
      venuePnl: toDecimal(fill.closedPnl),
    })),
    funding: funding.rows.map((payment): FundingPayment => ({
      venue: 'hyperliquid',
      account: user,
      symbol: payment.delta.coin,
      time: Number(payment.time),
      amount: toDecimal(payment.delta.usdc),
      asset: collateral.get(payment.delta.coin) ?? 'USDC',
      rate: toDecimal(payment.delta.fundingRate),
      position: toDecimal(payment.delta.szi),
    })),
    gaps,
  }
}

export const hyperliquid = {
  id: 'hyperliquid',
  label: 'Hyperliquid',
  secrets: 'device',
  capabilities: {
    tif: ['gtc', 'ioc', 'post-only'],
    triggers: { orders: TRIGGERS },
    leverage: true,
    scaleOrders: SCALE_ORDERS,
    trailingStop: true,
  },
  unavailable: (network, config) =>
    network === 'mainnet' && !config.mainnet ? 'Mainnet trading is off in this build' : null,
  steps,
  enable,
  account,
  margin,
  execute,
  lookup,
  history,
} satisfies TradingVenue & { id: 'hyperliquid' }
