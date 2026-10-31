import { DecimalError, formatPx, formatQty, notional, parsePx, parseQty, toPx, toQty } from '@tape/core/fixed'
import type { Px, Qty } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import { priceTick } from '@tape/core/market'
import { bytesToHex } from 'viem'
import { SKEW, scaleLegs, toTick } from './scale-order'
import type { Slice } from './scale-order'
import type {
  Bps,
  Capabilities,
  ClientOrderId,
  IntentFields,
  OrderIntent,
  Position,
  Retracement,
  Side,
  TakeProfit,
  Tif,
} from './types'

const intentOf = (fields: IntentFields, clientId = newClientId()) => ({ ...fields, clientId }) as OrderIntent

export function checkPrice(spec: MarketSpec, value: string): string | undefined {
  if (!value) return 'Enter a price'
  try {
    const px = parsePx(value, spec.scale)
    if (px <= 0) return 'Price must be above zero'
    const tick = priceTick(spec, px)
    if (px % tick !== 0) return `Price must be a multiple of ${formatPx(tick, spec.scale)}`
  } catch (error) {
    if (error instanceof DecimalError)
      return error.reason === 'precision' ? `At most ${spec.scale.px} decimals` : 'Not a number'
    throw error
  }
  return undefined
}

export function checkSize(spec: MarketSpec, value: string): string | undefined {
  if (!value) return 'Enter a size'
  try {
    const qty = parseQty(value, spec.scale)
    if (qty < spec.step) return `Minimum is ${formatQty(spec.step, spec.scale)}`
    if (qty % spec.step !== 0) return `Size must be a multiple of ${formatQty(spec.step, spec.scale)}`
  } catch (error) {
    if (error instanceof DecimalError)
      return error.reason === 'precision' ? `At most ${spec.scale.qty} decimals` : 'Not a number'
    throw error
  }
  return undefined
}

function belowMinimum(spec: MarketSpec, px: Px, size: Qty): string | undefined {
  if (spec.minNotional === undefined) return undefined
  return notional(px, size) < BigInt(spec.minNotional) * 10n ** BigInt(spec.scale.qty)
    ? `${formatPx(spec.minNotional, spec.scale)} ${spec.quote}`
    : undefined
}

/** A take profit as the ticket holds it: a trigger price, and the whole percent of the order size it closes. */
export interface TakeProfitDraft {
  readonly price: string
  readonly share: string
}

export interface IntentDraft {
  readonly side: Side
  readonly kind: 'limit' | 'market' | 'scale' | 'trailing'
  readonly price: string
  readonly size: string
  readonly tif: Tif
  readonly reduceOnly: boolean
  readonly takeProfits: readonly TakeProfitDraft[]
  readonly stopLoss: string
  readonly slippage: Bps
  /** The touch on screen, empty while the book has no side. */
  readonly bid: string
  readonly ask: string
  /** Scale order: the first and last leg price, how many legs, and the last leg's size over the first's. */
  readonly start: string
  readonly end: string
  readonly count: string
  readonly skew: string
  /** Trailing stop: how far the price comes back, as a percent or a price, and the price that arms it, empty to arm it at once. */
  readonly retracement: string
  readonly retracementUnit: 'pct' | 'px'
  readonly activation: string
}

/** The nth take profit of a draft, counted from 1. */
export type TakeProfitField = `takeProfit${number}`
export type ExitField = TakeProfitField | 'stopLoss'
/** `takeProfits` holds what is wrong with the take profits together, such as sizes that miss the order size. */
export type DraftField =
  | 'price'
  | 'size'
  | 'tif'
  | 'takeProfits'
  | ExitField
  | 'start'
  | 'end'
  | 'count'
  | 'skew'
  | 'retracement'
  | 'activation'
type Errors = Partial<Record<DraftField, string>>
export type Built =
  { readonly ok: true; readonly intent: OrderIntent } | { readonly ok: false; readonly errors: Errors }

export interface ExitReference {
  /** Null for a market order. */
  readonly px: Px | null
  readonly bid: Px | null
  readonly ask: Px | null
}

export const takeProfitField = (index: number): TakeProfitField => `takeProfit${index + 1}`

/** Each take profit beyond the order price, or the far touch for a market order. Stop loss short of the order price and the near touch. */
export function checkExits(
  side: Side,
  entry: ExitReference,
  exits: { readonly takeProfits: readonly Px[]; readonly stopLoss: Px | null },
): Partial<Record<ExitField, string>> {
  const errors: Partial<Record<ExitField, string>> = {}
  const buy = side === 'buy'
  const near = buy ? entry.bid : entry.ask
  const far = buy ? entry.ask : entry.bid
  const beyond = (price: Px, bound: Px) => (buy ? price > bound : price < bound)
  const nearName = buy ? 'the bid' : 'the ask'
  const farName = buy ? 'the ask' : 'the bid'
  const { takeProfits, stopLoss } = exits
  const against = entry.px ?? far
  takeProfits.forEach((takeProfit, index) => {
    if (against === null) errors[takeProfitField(index)] = 'No price on the book yet'
    else if (!beyond(takeProfit, against))
      errors[takeProfitField(index)] = `Must be ${buy ? 'above' : 'below'} ${entry.px === null ? farName : 'the price'}`
  })
  if (stopLoss !== null) {
    if (entry.px === null && near === null) errors.stopLoss = 'No price on the book yet'
    else if (entry.px !== null && !beyond(entry.px, stopLoss))
      errors.stopLoss = `Must be ${buy ? 'below' : 'above'} the price`
    else if (near !== null && !beyond(near, stopLoss))
      errors.stopLoss = `Must be ${buy ? 'below' : 'above'} ${nearName}`
  }
  return errors
}

export function checkCount(value: string, max: number): string | undefined {
  const count = Number(value)
  return Number.isInteger(count) && count >= 2 && count <= max ? undefined : `From 2 to ${max} orders`
}

export function checkShare(value: string): string | undefined {
  const share = Number(value)
  return value && Number.isInteger(share) && share >= 1 && share <= 100 ? undefined : 'From 1 to 100%'
}

/** Each whole-percent share of the size, floored to the step, with what the floors leave on the last one. */
export function splitSize(spec: MarketSpec, size: Qty, shares: readonly number[]): readonly Qty[] {
  const floored = shares.slice(0, -1).map((share) => toQty(Math.floor((size * share) / (100 * spec.step)) * spec.step))
  return [...floored, toQty(size - floored.reduce((sum, part) => sum + part, 0))]
}

/** A percent above 0 and below 100 with at most 2 decimals, or a price distance on the tick. */
export function checkRetracement(spec: MarketSpec, unit: 'pct' | 'px', value: string): string | undefined {
  if (unit === 'px') return checkPrice(spec, value)
  if (!value) return 'Enter a percent'
  if (!/^\d+(?:\.\d+)?$/.test(value)) return 'Not a number'
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return 'At most 2 decimals'
  const percent = Number(value)
  return percent > 0 && percent < 100 ? undefined : 'Above 0 and below 100%'
}

function retracementOf(spec: MarketSpec, draft: IntentDraft): Retracement {
  return draft.retracementUnit === 'pct'
    ? { pct: Math.round(Number(draft.retracement) * 100) as Bps }
    : { px: parsePx(draft.retracement, spec.scale) }
}

function checkTrailing(spec: MarketSpec, draft: IntentDraft, caps: Capabilities, errors: Errors) {
  if (!caps.trailingStop) {
    errors.retracement = 'Not offered on this venue'
    return
  }
  const retracement = checkRetracement(spec, draft.retracementUnit, draft.retracement)
  if (retracement) errors.retracement = retracement
  const activation = draft.activation ? checkPrice(spec, draft.activation) : undefined
  if (activation) errors.activation = activation
}

export function checkSkew(value: string): string | undefined {
  const skew = Number(value)
  return value && skew >= SKEW.min && skew <= SKEW.max ? undefined : `Between ${SKEW.min} and ${SKEW.max}`
}

export type ScaleDraft = Pick<IntentDraft, 'side' | 'size' | 'start' | 'end' | 'count' | 'skew'>
export type BuiltScale =
  { readonly ok: true; readonly legs: readonly Slice[] } | { readonly ok: false; readonly errors: Errors }

/** The legs of a scale order, before the venue minimum. */
export function buildScale(spec: MarketSpec, draft: ScaleDraft, maxOrders: number): BuiltScale {
  const errors: Errors = {}
  const checks = {
    size: checkSize(spec, draft.size),
    start: checkPrice(spec, draft.start),
    end: checkPrice(spec, draft.end),
    count: checkCount(draft.count, maxOrders),
    skew: checkSkew(draft.skew),
  }
  for (const [field, issue] of Object.entries(checks)) if (issue) errors[field as DraftField] = issue
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const built = scaleLegs(
    spec,
    draft.side,
    {
      start: parsePx(draft.start, spec.scale),
      end: parsePx(draft.end, spec.scale),
      count: Number(draft.count),
      skew: Number(draft.skew),
    },
    parseQty(draft.size, spec.scale),
  )
  return built.ok ? built : { ok: false, errors: { [built.field]: built.message } }
}

function scaleSlices(spec: MarketSpec, draft: IntentDraft, caps: Capabilities, errors: Errors): readonly Slice[] {
  if (caps.scaleOrders === 0) {
    errors.count = 'Not offered on this venue'
    return []
  }
  const built = buildScale(spec, draft, caps.scaleOrders)
  if (!built.ok) {
    Object.assign(errors, built.errors)
    return []
  }
  const small = draft.reduceOnly
    ? undefined
    : built.legs.map((leg) => belowMinimum(spec, leg.px, leg.size)).find(Boolean)
  if (small) errors.size = `Each order must be worth at least ${small}`
  return built.legs
}

function takeProfitsOf(
  spec: MarketSpec,
  draft: IntentDraft,
  caps: Capabilities,
  errors: Errors,
): readonly TakeProfit[] {
  const rows = draft.takeProfits
  const withStop = draft.stopLoss !== ''
  const most = (caps.triggers?.orders ?? 0) - (withStop ? 1 : 0)
  if (rows.length > most) {
    errors.takeProfits = withStop ? `At most ${most} with a stop loss on this venue` : `At most ${most} on this venue`
    return []
  }
  rows.forEach((row, index) => {
    const issue = checkPrice(spec, row.price) ?? checkShare(row.share)
    if (issue) errors[takeProfitField(index)] = issue
  })
  if (rows.some((_, index) => errors[takeProfitField(index)])) return []
  const shares = rows.map((row) => Number(row.share))
  const total = shares.reduce((sum, share) => sum + share, 0)
  const size = errors.size ? null : parseQty(draft.size, spec.scale)
  if (total !== 100) {
    const left = total < 100 && size !== null ? Math.round((size * (100 - total)) / (100 * spec.step)) * spec.step : 0
    const missing =
      left > 0 ? `, so ${formatQty(toQty(left), spec.scale)} ${spec.base} has no take profit` : ', not 100%'
    errors.takeProfits = `Sizes add up to ${total}%${missing}`
    return []
  }
  if (size === null) return []
  const sizes = splitSize(spec, size, shares)
  sizes.forEach((part, index) => {
    if (part < spec.step) errors[takeProfitField(index)] = `Size rounds below ${formatQty(spec.step, spec.scale)}`
  })
  return rows.map((row, index) => ({ px: parsePx(row.price, spec.scale), size: sizes[index]! }))
}

function touchPx(spec: MarketSpec, value: string): Px | null {
  try {
    return value ? parsePx(value, spec.scale) : null
  } catch {
    return null
  }
}

type ExitDraft = Pick<IntentDraft, 'side' | 'kind' | 'price' | 'takeProfits' | 'stopLoss' | 'bid' | 'ask'>

/** Each take profit and the stop loss whose price parses, checked on its own against the order price or the touch. Empty while a limit has no valid price. */
export function checkExitPrices(spec: MarketSpec, draft: ExitDraft): Partial<Record<ExitField, string>> {
  const priced = (value: string) => (value && !checkPrice(spec, value) ? parsePx(value, spec.scale) : null)
  const entry = draft.kind === 'limit' ? priced(draft.price) : null
  if (draft.kind === 'limit' && entry === null) return {}
  const reference = { px: entry, bid: touchPx(spec, draft.bid), ask: touchPx(spec, draft.ask) }
  const issues: Partial<Record<ExitField, string>> = {}
  draft.takeProfits.forEach((row, index) => {
    const px = priced(row.price)
    const issue = px === null ? undefined : checkExits(draft.side, reference, { takeProfits: [px], stopLoss: null })
    if (issue?.takeProfit1) issues[takeProfitField(index)] = issue.takeProfit1
  })
  const stopLoss = priced(draft.stopLoss)
  const issue = stopLoss === null ? undefined : checkExits(draft.side, reference, { takeProfits: [], stopLoss })
  if (issue?.stopLoss) issues.stopLoss = issue.stopLoss
  return issues
}

export function buildIntent(spec: MarketSpec, draft: IntentDraft, caps: Capabilities): Built {
  const errors: Errors = {}
  const size = checkSize(spec, draft.size)
  if (size) errors.size = size
  if (draft.kind === 'limit') {
    const price = checkPrice(spec, draft.price)
    if (price) errors.price = price
  }
  if (draft.kind === 'trailing') checkTrailing(spec, draft, caps, errors)
  const rests = draft.kind === 'limit' || draft.kind === 'scale'
  if (rests && !caps.tif.includes(draft.tif)) errors.tif = 'Not offered on this venue'
  const scaleTif = draft.kind === 'scale' && draft.tif !== 'ioc' ? draft.tif : null
  if (draft.kind === 'scale' && scaleTif === null) errors.tif = 'Not with a scale order'
  const offered = (field: 'takeProfits' | 'stopLoss') => {
    if (draft.kind === 'scale') errors[field] = 'Not with a scale order'
    else if (draft.kind === 'trailing') errors[field] = 'Not with a trailing stop'
    else if (!caps.triggers) errors[field] = 'Not offered on this venue'
    return !errors[field]
  }
  const priced = (value: string) => {
    const issue = checkPrice(spec, value)
    if (issue) errors.stopLoss = issue
    return issue ? null : parsePx(value, spec.scale)
  }
  const stopLoss = draft.stopLoss && offered('stopLoss') ? priced(draft.stopLoss) : null
  const takeProfits =
    draft.takeProfits.length > 0 && offered('takeProfits') ? takeProfitsOf(spec, draft, caps, errors) : []
  const entry = draft.kind === 'limit' ? (errors.price ? undefined : parsePx(draft.price, spec.scale)) : null
  if (entry !== undefined && (takeProfits.length > 0 || stopLoss !== null))
    Object.assign(
      errors,
      checkExits(
        draft.side,
        { px: entry, bid: touchPx(spec, draft.bid), ask: touchPx(spec, draft.ask) },
        { takeProfits: takeProfits.map((takeProfit) => takeProfit.px), stopLoss },
      ),
    )
  const slices = draft.kind === 'scale' ? scaleSlices(spec, draft, caps, errors) : []
  const reference = draft.kind === 'limit' ? entry : touchPx(spec, draft.side === 'buy' ? draft.ask : draft.bid)
  if (draft.kind !== 'scale' && !errors.size && !draft.reduceOnly && reference) {
    const small = belowMinimum(spec, reference, parseQty(draft.size, spec.scale))
    if (small) errors.size = `Must be worth at least ${small}`
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const clientId = newClientId()
  const order: IntentFields['order'] =
    draft.kind === 'limit'
      ? { kind: 'limit', px: parsePx(draft.price, spec.scale), tif: draft.tif }
      : draft.kind === 'trailing'
        ? {
            kind: 'trailing',
            retracement: retracementOf(spec, draft),
            activation: draft.activation ? parsePx(draft.activation, spec.scale) : null,
          }
        : scaleTif !== null
          ? {
              kind: 'scale' as const,
              tif: scaleTif,
              legs: slices.map((slice, index) => ({ ...slice, clientId: index === 0 ? clientId : newClientId() })),
            }
          : { kind: 'market' as const, slippage: draft.slippage }
  return {
    ok: true,
    intent: intentOf(
      {
        spec,
        side: draft.side,
        size: parseQty(draft.size, spec.scale),
        reduceOnly: draft.reduceOnly,
        order,
        triggers: { takeProfits, stopLoss },
      },
      clientId,
    ),
  }
}

/** A reduce-only market order for the whole position. Null when the size is off this market's step. */
export function closeIntent(spec: MarketSpec, position: Position, slippage: Bps): OrderIntent | null {
  const size = position.size.replace(/^-/, '')
  if (checkSize(spec, size)) return null
  return intentOf({
    spec,
    side: position.side === 'long' ? 'sell' : 'buy',
    size: parseQty(size, spec.scale),
    reduceOnly: true,
    order: { kind: 'market', slippage },
    triggers: { takeProfits: [], stopLoss: null },
  })
}

export function newClientId(): ClientOrderId {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16))) as ClientOrderId
}

/**
 * The limit a taking order carries: the far touch moved by the slippage, then onto the tick on
 * the side that keeps it inside the slippage. All three venues send a market order as an IOC limit.
 */
export function worstPrice(spec: MarketSpec, side: Side, far: Px, slippageBps: number): Px {
  const moved = side === 'buy' ? (far * (10_000 + slippageBps)) / 10_000 : (far * (10_000 - slippageBps)) / 10_000
  const snapped = toTick(spec, side, moved)
  return toPx(Math.max(snapped, priceTick(spec, snapped)))
}
