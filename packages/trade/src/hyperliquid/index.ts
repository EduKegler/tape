import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { z } from 'zod'
import type { Address, Hex } from 'viem'
import { parsePx, wireDecimal } from '@tape/core/fixed'
import type { Decimals, Px } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import type { Network } from '@tape/core/ids'
import { checkPrice, checkSize, worstPrice } from '../intent'
import { maintenanceMargin } from '../liquidation'
import type { MarginState, MarginTier } from '../liquidation'
import { post, send } from '../send'
import type { Classify } from '../send'
import { localSigner } from '../typed-data'
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
  TradeError,
  TradingVenue,
  VenueContext,
  WalletSigner,
} from '../types'
import { signL1Action, signUserAction, signatureChainIdHex } from './sign'
import { cancelAction, leverageAction, orderAction, orderWire } from './wire'
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

interface Asset {
  readonly index: number
  readonly spec: MarketSpec
  readonly tiers: readonly MarginTier[]
  readonly isolatedOnly: boolean
}

type HlMeta = {
  universe: { name: string; szDecimals: string; maxLeverage: number; marginTableId: number; onlyIsolated?: boolean }[]
  marginTables: [number, { marginTiers: { lowerBound: string; maxLeverage: number }[] }][]
}

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

const classify: Classify = (_status, body) => {
  const b = body as { status?: string; response?: unknown } | null
  return b?.status === 'err' ? classifyText(String(b.response)) : null
}

const info = <T>(ctx: VenueContext, body: unknown) =>
  send<T>('hyperliquid', ctx.fetch, `${API[ctx.ref.network]}/info`, { ...post(body), mutates: false }, () => null)

/** Asset ids and szDecimals differ between mainnet and testnet, so each network gets its own rules. */
function meta(ctx: VenueContext): Promise<Meta> {
  const network = ctx.ref.network
  let cached = metas.get(network)
  if (!cached) {
    cached = info<HlMeta>(ctx, { type: 'meta' }).then((m) => {
      const tables = new Map(m.marginTables)
      return new Map(
        m.universe.map((u, index) => {
          const qty = Number(u.szDecimals) as Decimals
          const spec = {
            venueSymbol: u.name,
            scale: { px: (6 - qty) as Decimals, qty },
            tick: { kind: 'sigfig', figures: 5 },
            step: 1,
          } as unknown as MarketSpec
          // A table id the list lacks is a single tier at the asset's max leverage.
          const tiers = (
            tables.get(u.marginTableId)?.marginTiers ?? [{ lowerBound: '0', maxLeverage: u.maxLeverage }]
          ).map((t) => ({ lowerBound: Number(t.lowerBound), maxLeverage: t.maxLeverage }))
          return [u.name, { index, spec, tiers, isolatedOnly: Boolean(u.onlyIsolated) }] as const
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

function recheckPx(a: Asset, intent: OrderIntent, px: Px, what: string): string {
  const wire = wireDecimal(px, intent.spec.scale.px)
  const issue = checkPrice(a.spec, wire)
  return issue ? fail({ kind: 'invalid-order', detail: `${what} ${wire}: ${issue} on this network` }) : wire
}

async function touch(ctx: VenueContext, a: Asset, side: 'buy' | 'sell'): Promise<Px> {
  const book = await info<{ levels: [{ px: string }[], { px: string }[]] }>(ctx, {
    type: 'l2Book',
    coin: a.spec.venueSymbol,
  })
  const far = side === 'buy' ? book.levels[1][0] : book.levels[0][0]
  return far
    ? parsePx(far.px, a.spec.scale)
    : fail({ kind: 'invalid-order', detail: 'The book on this network is empty' })
}

async function placeWires(
  ctx: VenueContext,
  intent: OrderIntent,
): Promise<{ wires: OrderWire[]; grouping: 'na' | 'normalTpsl' }> {
  const a = await asset(ctx, intent.spec.venueSymbol)
  const size = wireDecimal(intent.size, intent.spec.scale.qty)
  const sizeIssue = checkSize(a.spec, size)
  if (sizeIssue) fail({ kind: 'invalid-order', detail: `Size ${size}: ${sizeIssue} on this network` })
  const isBuy = intent.side === 'buy'
  const limit =
    intent.order.kind === 'limit'
      ? { px: recheckPx(a, intent, intent.order.px, 'Price'), tif: TIF[intent.order.tif] }
      : {
          px: wireDecimal(
            worstPrice(a.spec, intent.side, await touch(ctx, a, intent.side), intent.order.slippage),
            a.spec.scale.px,
          ),
          tif: 'Ioc' as const,
        }
  const wires = [
    orderWire(a.index, isBuy, limit.px, size, intent.reduceOnly, { limit: { tif: limit.tif } }, intent.clientId),
  ]
  const closing = isBuy ? 'sell' : 'buy'
  for (const [tpsl, px] of [
    ['tp', intent.triggers.takeProfit],
    ['sl', intent.triggers.stopLoss],
  ] as const) {
    if (px === null) continue
    const triggerPx = recheckPx(a, intent, px, tpsl === 'tp' ? 'Take profit' : 'Stop loss')
    const bound = wireDecimal(
      worstPrice(a.spec, closing, parsePx(triggerPx, a.spec.scale), TRIGGER_SLIPPAGE_BPS),
      a.spec.scale.px,
    )
    wires.push(orderWire(a.index, !isBuy, bound, size, true, { trigger: { isMarket: true, triggerPx, tpsl } }))
  }
  return { wires, grouping: wires.length > 1 ? 'normalTpsl' : 'na' }
}

let lastNonce = 0
const nextNonce = () => (lastNonce = Math.max(Date.now(), lastNonce + 1))

function agentOf(ctx: VenueContext) {
  const secret = ctx.keys.read()?.secret
  return secret
    ? privateKeyToAccount(secret as Hex)
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
  response: z.object({ type: z.string(), data: z.object({ statuses: z.array(Status) }).optional() }),
})
type Statuses = z.infer<typeof Reply>

async function exchange(ctx: VenueContext, action: unknown): Promise<Statuses> {
  const nonce = nextNonce()
  const signature = await signL1Action(localSigner(agentOf(ctx)), action, nonce, CHAIN[ctx.ref.network])
  const body = await send<unknown>(
    'hyperliquid',
    ctx.fetch,
    `${API[ctx.ref.network]}/exchange`,
    { ...post({ action, nonce, signature }), mutates: true },
    classify,
  )
  const reply = Reply.safeParse(body)
  return reply.success
    ? reply.data
    : fail({ kind: 'unknown-outcome', detail: `Unreadable reply: ${JSON.stringify(body)}` })
}

const GONE = /never placed|already canceled|filled/i
const legName = (w: OrderWire | undefined) => (w && 'trigger' in w.t ? w.t.trigger.tpsl.toUpperCase() : 'Leg')

async function execute(ctx: VenueContext, command: Command): Promise<CommandOutcome> {
  switch (command.kind) {
    case 'place': {
      const { wires, grouping } = await placeWires(ctx, command.intent)
      const reply = await exchange(ctx, orderAction(wires, grouping, ctx.config.hyperliquid.builder))
      const [first, ...legs] = reply.response.data?.statuses ?? []
      if (first === undefined)
        fail({ kind: 'unknown-outcome', detail: `No order status in the reply: ${JSON.stringify(reply)}` })
      if (typeof first === 'object' && first.error) fail(classifyText(first.error))
      // The order stands even when a TP/SL leg is refused, so the refusal rides in the detail.
      const refused = legs.flatMap((s, i) =>
        typeof s === 'object' && s.error ? [`${legName(wires[i + 1])} not placed: ${s.error}`] : [],
      )
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
    case 'cancel':
    case 'cancel-all': {
      const targets = command.kind === 'cancel' ? [refParts(command.order)] : await openOf(ctx, command.symbol)
      if (targets.length === 0) return { kind: 'done', detail: 'Nothing to cancel' }
      const reply = await exchange(ctx, cancelAction(targets))
      const errors = (reply.response.data?.statuses ?? []).flatMap((s) =>
        typeof s === 'object' && s.error && !GONE.test(s.error) ? [s.error] : [],
      )
      if (errors.length > 0) fail(classifyText(errors.join('; ')))
      return { kind: 'done', detail: `Canceled ${targets.length}` }
    }
    case 'leverage': {
      const a = await asset(ctx, command.symbol)
      await exchange(ctx, leverageAction(a.index, true, command.leverage))
      return { kind: 'done', detail: `Leverage ${command.leverage}x cross` }
    }
  }
}

/** Orders belong to the owner, whichever agent signed them, and `orderStatus` takes the cloid as the oid. */
async function lookup(ctx: VenueContext, intent: OrderIntent): Promise<OrderLookup> {
  const reply = await info<{ status: string; order?: { status: string } }>(ctx, {
    type: 'orderStatus',
    user: ctx.ref.owner,
    oid: intent.clientId,
  })
  return reply.status === 'order' && reply.order
    ? { kind: 'found', detail: `Order ${reply.order.status}` }
    : { kind: 'absent', detail: `Hyperliquid answered ${reply.status}` }
}

const refOf = (index: number, oid: string) => `${index}:${oid}` as OrderRef
function refParts(ref: OrderRef) {
  const [index, oid] = ref.split(':')
  return { asset: Number(index), oid: Number(oid) }
}

interface HlOrder {
  coin: string
  side: 'A' | 'B'
  limitPx: string
  sz: string
  oid: string
  timestamp: string
  orderType: string
  reduceOnly: boolean
  isTrigger: boolean
  triggerPx: string
}

async function openOf(ctx: VenueContext, symbol: string) {
  const [orders, m] = await Promise.all([
    info<HlOrder[]>(ctx, { type: 'frontendOpenOrders', user: ctx.ref.owner }),
    meta(ctx),
  ])
  return orders.filter((o) => o.coin === symbol).map((o) => ({ asset: m.get(o.coin)?.index ?? -1, oid: Number(o.oid) }))
}

const UNIFIED = new Set(['unifiedAccount', 'portfolioMargin'])

async function account(ctx: VenueContext): Promise<AccountView> {
  const user = ctx.ref.owner
  type State = {
    marginSummary: { accountValue: string }
    withdrawable: string
    assetPositions: {
      position: {
        coin: string
        szi: string
        entryPx: string
        unrealizedPnl: string
        liquidationPx: string | null
        leverage: { type: string; value: string }
      }
    }[]
  }
  type Spot = {
    balances: { coin: string; token: number; total: string }[]
    tokenToAvailableAfterMaintenance?: [number, string][]
  }
  type HlFill = { coin: string; px: string; sz: string; side: 'A' | 'B'; time: string; fee: string; tid: string }
  const [state, spot, mode, orders, fills, m] = await Promise.all([
    info<State>(ctx, { type: 'clearinghouseState', user }),
    info<Spot>(ctx, { type: 'spotClearinghouseState', user }),
    info<string>(ctx, { type: 'userAbstraction', user }),
    info<HlOrder[]>(ctx, { type: 'frontendOpenOrders', user }),
    info<HlFill[]>(ctx, { type: 'userFills', user }),
    meta(ctx),
  ])
  const d = (s: string) => s as Decimal
  // A unified or portfolio margin account keeps one USDC balance in spot for spot and perps alike.
  // Its perp state holds only the margin in use, so it is not the balance.
  const usdc = UNIFIED.has(mode) ? spot.balances.find((b) => b.coin === 'USDC') : undefined
  const equity = usdc ? usdc.total : state.marginSummary.accountValue
  const available = usdc
    ? (spot.tokenToAvailableAfterMaintenance?.find(([token]) => token === usdc.token)?.[1] ?? usdc.total)
    : state.withdrawable
  if (Number(equity) === 0 && state.assetPositions.length === 0 && orders.length === 0 && fills.length === 0)
    return { kind: 'empty' }
  return {
    kind: 'live',
    snapshot: {
      equity: d(equity),
      available: d(available),
      positions: state.assetPositions.map(({ position: p }) => ({
        symbol: p.coin,
        side: p.szi.startsWith('-') ? 'short' : 'long',
        size: d(p.szi.replace(/^-/, '')),
        entry: d(p.entryPx),
        unrealizedPnl: d(p.unrealizedPnl),
        // An estimate the venue sends unrounded, so it gets the market's price decimals.
        liquidation: p.liquidationPx ? d(Number(p.liquidationPx).toFixed(m.get(p.coin)?.spec.scale.px ?? 6)) : null,
        leverage: `${p.leverage.value}x ${p.leverage.type}`,
      })),
      orders: orders.map((o) => ({
        ref: refOf(m.get(o.coin)?.index ?? -1, o.oid),
        symbol: o.coin,
        side: o.side === 'B' ? 'buy' : 'sell',
        kind: o.orderType,
        px: d(o.isTrigger ? o.triggerPx : o.limitPx),
        size: d(o.sz),
        reduceOnly: o.reduceOnly,
        placedAt: Number(o.timestamp),
      })),
      fills: fills.slice(0, 20).map((f) => ({
        id: f.tid,
        symbol: f.coin,
        side: f.side === 'B' ? 'buy' : 'sell',
        px: d(f.px),
        size: d(f.sz),
        fee: d(f.fee),
        time: Number(f.time),
      })),
    },
  }
}

async function margin(ctx: VenueContext, symbol: string): Promise<MarginState> {
  const user = ctx.ref.owner
  type State = {
    crossMarginSummary: { accountValue: string }
    crossMaintenanceMarginUsed: string
    assetPositions: { position: { coin: string; szi: string; positionValue: string; leverage: { type: string } } }[]
  }
  const [a, mode, state, active] = await Promise.all([
    asset(ctx, symbol),
    info<string>(ctx, { type: 'userAbstraction', user }),
    info<State>(ctx, { type: 'clearinghouseState', user }),
    info<{ leverage: { type: string } }>(ctx, { type: 'activeAssetData', user, coin: symbol }),
  ])
  if (UNIFIED.has(mode)) return { kind: 'unsupported', reason: 'Not estimated for unified accounts' }
  const held = state.assetPositions.find((p) => p.position.coin === symbol)?.position
  if (a.isolatedOnly || (held ?? active).leverage.type !== 'cross')
    return { kind: 'unsupported', reason: 'Not estimated for isolated margin' }
  const size = held ? Number(held.szi) : 0
  const value = held ? Number(held.positionValue) : 0
  return {
    kind: 'cross',
    accountValue: Number(state.crossMarginSummary.accountValue),
    othersMaintenance: Number(state.crossMaintenanceMarginUsed) - maintenanceMargin(a.tiers, value),
    tiers: a.tiers,
    position: size ? { size, mark: value / Math.abs(size) } : null,
  }
}

async function steps(ctx: VenueContext): Promise<readonly SetupStep[]> {
  const key = ctx.keys.read()
  const agent = key?.public.agent?.toLowerCase()
  const builder = ctx.config.hyperliquid.builder
  const [agents, fee] = await Promise.all([
    info<{ address: string; validUntil: string }[]>(ctx, { type: 'extraAgents', user: ctx.ref.owner }),
    builder
      ? info<string>(ctx, { type: 'maxBuilderFee', user: ctx.ref.owner, builder: builder.b })
      : Promise.resolve(null),
  ])
  const approved = Boolean(
    key?.secret && agent && agents.some((a) => a.address.toLowerCase() === agent && Number(a.validUntil) > Date.now()),
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
  for (const step of (await steps(ctx)).filter((s) => !s.done)) {
    onStep(step.id)
    if (step.id === 'approve-agent') {
      const existing = ctx.keys.read()
      const secret = (existing?.secret as Hex | null) ?? generatePrivateKey()
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

export const hyperliquid = {
  id: 'hyperliquid',
  label: 'Hyperliquid',
  secrets: 'device',
  capabilities: { tif: ['gtc', 'ioc', 'post-only'], triggers: true, leverage: true },
  unavailable: (network, config) =>
    network === 'mainnet' && !config.mainnet ? 'Mainnet trading is off in this build' : null,
  steps,
  enable,
  account,
  margin,
  execute,
  lookup,
} satisfies TradingVenue & { id: 'hyperliquid' }
