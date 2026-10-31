import { formatQty } from '@tape/core/fixed'
import type { Px, Qty } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import { priceTick } from '@tape/core/market'
import type { ClientOrderId, CommandOutcome, OrderIntent, OrderLookup, Side } from './types'

export const SKEW = { min: 0.1, max: 10 } as const

/** Splits whole units by weight. Each share is floored, and the units left go to the largest fractions first. */
export function apportion(units: number, weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const exact = weights.map((weight) => (units * weight) / total)
  const shares = exact.map(Math.floor)
  const left = units - shares.reduce((sum, share) => sum + share, 0)
  const order = exact
    .map((share, index) => ({ i: index, fraction: share - Math.floor(share) }))
    .sort((first, second) => second.fraction - first.fraction)
  for (const { i } of order.slice(0, left)) shares[i] = (shares[i] ?? 0) + 1
  return shares
}

export interface ScaleRange {
  readonly start: Px
  readonly end: Px
  readonly count: number
  /** The last order's size over the first's. */
  readonly skew: number
}

export interface Slice {
  readonly px: Px
  readonly size: Qty
}

export type ScaleLegs =
  | { readonly ok: true; readonly legs: readonly Slice[] }
  | { readonly ok: false; readonly field: 'count' | 'size'; readonly message: string }

/** Onto the tick on the passive side: a buy rounds down, a sell up. */
export function toTick(spec: MarketSpec, side: Side, raw: number): Px {
  const rough = side === 'buy' ? Math.floor(raw) : Math.ceil(raw)
  const tick = priceTick(spec, rough as Px)
  return (side === 'buy' ? Math.floor(rough / tick) * tick : Math.ceil(rough / tick) * tick) as Px
}

/**
 * Prices step evenly from start to end, each on the tick on the passive side. Sizes grow linearly
 * from the first to the last by the skew, in whole steps. Takes a count of at least 2 and a skew
 * within SKEW.
 */
export function scaleLegs(spec: MarketSpec, side: Side, range: ScaleRange, total: Qty): ScaleLegs {
  const { start, end, count, skew } = range
  const prices = Array.from({ length: count }, (_, index) =>
    toTick(spec, side, start + ((end - start) * index) / (count - 1)),
  )
  if (new Set(prices).size < count)
    return { ok: false, field: 'count', message: `The range is too narrow for ${count} orders` }
  const weights = prices.map((_, index) => 1 + ((skew - 1) * index) / (count - 1))
  const sizes = apportion(total / spec.step, weights).map((units) => (units * spec.step) as Qty)
  if (sizes.some((size) => size < spec.step))
    return { ok: false, field: 'size', message: `Each order needs at least ${formatQty(spec.step, spec.scale)}` }
  return { ok: true, legs: prices.map((px, index) => ({ px, size: sizes[index] as Qty })) }
}

/** Every client id the intent sent: one per leg for a scale order. */
export function clientIdsOf(intent: OrderIntent): readonly ClientOrderId[] {
  return intent.order.kind === 'scale' ? intent.order.legs.map((leg) => leg.clientId) : [intent.clientId]
}

/** One refusal or undefined per leg, in leg order. Refuses the whole order only when every leg was refused. */
export function scaleOutcome(
  refusals: readonly (string | undefined)[],
  status: 'resting' | 'filled' | 'accepted',
  refuse: (error: string) => never,
  tally = '',
): CommandOutcome {
  const notes = refusals.flatMap((refusal, index) => (refusal ? [`. Order ${index + 1} not placed: ${refusal}`] : []))
  if (notes.length === refusals.length) refuse(refusals.find(Boolean) ?? 'Every order was refused')
  const placed = refusals.length - notes.length
  return { kind: 'placed', status, detail: `${placed} of ${refusals.length} orders placed${tally}${notes.join('')}` }
}

/** Found when any leg is on the venue, since a scale order can stand with some legs refused. */
export function lookupSummary(results: readonly OrderLookup[]): OrderLookup {
  const [first] = results
  if (results.length === 1 && first) return first
  const found = results.filter((result) => result.kind === 'found').length
  return found > 0
    ? { kind: 'found', detail: `${found} of ${results.length} orders on the venue` }
    : { kind: 'absent', detail: `None of the ${results.length} orders. ${first?.detail ?? ''}`.trim() }
}
