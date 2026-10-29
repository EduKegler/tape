import type { Side } from './types'

/** From `lowerBound` notional up, a position gets at most `maxLeverage`. Sorted by lowerBound, the first at 0. */
export interface MarginTier {
  readonly lowerBound: number
  readonly maxLeverage: number
}

/** Cross collateral around one market, valued at mark before the order. */
export type MarginState =
  | {
      readonly kind: 'cross'
      readonly accountValue: number
      /** What every other cross position needs, so it is not collateral for this one. */
      readonly othersMaintenance: number
      readonly tiers: readonly MarginTier[]
      /** Signed size, negative for a short. */
      readonly position: { readonly size: number; readonly mark: number } | null
    }
  | { readonly kind: 'unsupported'; readonly reason: string }

export type Liquidation =
  | { readonly kind: 'price'; readonly px: number }
  | { readonly kind: 'none' }
  | { readonly kind: 'insufficient-margin' }
  | { readonly kind: 'unsupported'; readonly reason: string }

export interface Entry {
  readonly side: Side
  readonly size: number
  readonly px: number
}

/**
 * Maintenance is half the initial margin at the tier's max leverage, less a deduction
 * that keeps it continuous across tiers (Hyperliquid docs, Margin tiers).
 */
function maintenanceSteps(tiers: readonly MarginTier[]) {
  let deduction = 0
  let previous = 0
  return tiers.map((tier, i) => {
    const rate = 1 / (2 * tier.maxLeverage)
    if (i > 0) deduction += tier.lowerBound * (rate - previous)
    previous = rate
    return { lowerBound: tier.lowerBound, upperBound: tiers[i + 1]?.lowerBound ?? Infinity, rate, deduction }
  })
}

export function maintenanceMargin(tiers: readonly MarginTier[], notional: number): number {
  const step = maintenanceSteps(tiers).findLast((s) => notional >= s.lowerBound)
  return step ? notional * step.rate - step.deduction : 0
}

/**
 * The mark at which equity meets maintenance once `entry` fills, with every other position held at its mark.
 * Fees and funding are left out. Null entry gives the open position's own price.
 */
export function estimateLiquidation(state: MarginState, entry: Entry | null): Liquidation {
  if (state.kind === 'unsupported') return state
  const held = state.position?.size ?? 0
  const added = entry ? (entry.side === 'buy' ? entry.size : -entry.size) : 0
  const size = held + added
  if (Math.abs(size) < 1e-12) return { kind: 'none' }
  // Equity at mark p is fixed + size * p.
  const fixed = state.accountValue - held * (state.position?.mark ?? 0) - added * (entry?.px ?? 0)
  const at = entry?.px ?? state.position?.mark ?? 0
  if (fixed + size * at <= state.othersMaintenance + maintenanceMargin(state.tiers, Math.abs(size) * at)) {
    return { kind: 'insufficient-margin' }
  }
  for (const step of maintenanceSteps(state.tiers)) {
    const px = (state.othersMaintenance - step.deduction - fixed) / (size - Math.abs(size) * step.rate)
    const notional = Math.abs(size) * px
    if (px > 0 && notional >= step.lowerBound && notional < step.upperBound) return { kind: 'price', px }
  }
  return { kind: 'none' }
}
