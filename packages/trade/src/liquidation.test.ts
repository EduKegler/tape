import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { estimateLiquidation } from './liquidation'
import type { Liquidation, MarginState, MarginTier } from './liquidation'

type Cross = Extract<MarginState, { kind: 'cross' }>

const flat = (accountValue: number, tiers = [{ lowerBound: 0, maxLeverage: 50 }]): Cross => ({
  kind: 'cross',
  accountValue,
  othersMaintenance: 0,
  tiers,
  position: null,
})

const px = (l: Liquidation) => (l.kind === 'price' ? l.px : l.kind)

const twoTiers = [
  { lowerBound: 0, maxLeverage: 50 },
  { lowerBound: 100_000, maxLeverage: 20 },
]

/** Hyperliquid docs, Margin tiers: notional in each tier adds maintenance at that tier's rate. */
const bandedMaintenance = (tiers: readonly MarginTier[], notional: number) =>
  tiers.reduce((total, tier, i) => {
    const upper = tiers[i + 1]?.lowerBound ?? Infinity
    const inBand = Math.max(0, Math.min(notional, upper) - tier.lowerBound)
    return total + inBand / (2 * tier.maxLeverage)
  }, 0)

const tierShapeArb = fc
  .uniqueArray(fc.integer({ min: 3, max: 50 }), { minLength: 1, maxLength: 4 })
  .chain((leverages) =>
    fc
      .array(fc.double({ min: 0.05, max: 1.5, noNaN: true }), {
        minLength: leverages.length - 1,
        maxLength: leverages.length - 1,
      })
      .map((shares) => ({ leverages: leverages.toSorted((x, y) => y - x), shares })),
  )

const tiersAround = (shape: { leverages: number[]; shares: number[] }, notional: number): MarginTier[] => {
  let lowerBound = 0
  return shape.leverages.map((maxLeverage, i) => {
    if (i > 0) lowerBound += (shape.shares[i - 1] ?? 0) * notional
    return { lowerBound, maxLeverage }
  })
}

describe('liquidation estimate', () => {
  it('puts a long below entry where equity meets maintenance', () => {
    expect(px(estimateLiquidation(flat(10_000), { side: 'buy', size: 1, px: 100_000 }))).toBeCloseTo(90_909.09, 2)
  })

  it('puts a short above entry', () => {
    expect(px(estimateLiquidation(flat(10_000), { side: 'sell', size: 1, px: 100_000 }))).toBeCloseTo(108_910.89, 2)
  })

  it('has no price when the collateral covers the long down to zero', () => {
    expect(estimateLiquidation(flat(200_000), { side: 'buy', size: 1, px: 100_000 })).toEqual({ kind: 'none' })
  })

  it('says the margin falls short when equity at entry is under maintenance', () => {
    expect(estimateLiquidation(flat(0), { side: 'buy', size: 1, px: 100_000 })).toEqual({
      kind: 'insufficient-margin',
    })
  })

  it('counts the margin other positions hold', () => {
    const state = { ...flat(10_000), othersMaintenance: 500 }
    expect(px(estimateLiquidation(state, { side: 'buy', size: 1, px: 100_000 }))).toBeCloseTo(91_414.14, 2)
  })

  it('adds to the position already open in the market', () => {
    const state: Cross = { ...flat(10_000), position: { size: 1, mark: 100_000 } }
    expect(px(estimateLiquidation(state, { side: 'buy', size: 1, px: 100_000 }))).toBeCloseTo(95_959.6, 1)
  })

  it('has no price when the order closes the position', () => {
    const state: Cross = { ...flat(10_000), position: { size: 1, mark: 100_000 } }
    expect(estimateLiquidation(state, { side: 'sell', size: 1, px: 100_000 })).toEqual({ kind: 'none' })
  })

  it('uses the tier the notional reaches at the liquidation price', () => {
    const tiers = [
      { lowerBound: 0, maxLeverage: 50 },
      { lowerBound: 100_000, maxLeverage: 20 },
    ]
    expect(px(estimateLiquidation(flat(30_000, tiers), { side: 'buy', size: 2, px: 100_000 }))).toBeCloseTo(
      86_410.26,
      2,
    )
  })

  it('says the margin falls short when equity at entry is under maintenance on any tier', () => {
    expect(estimateLiquidation(flat(500), { side: 'buy', size: 1, px: 100_000 })).toEqual({
      kind: 'insufficient-margin',
    })
    expect(estimateLiquidation(flat(400, twoTiers), { side: 'buy', size: 0.5, px: 100_000 })).toEqual({
      kind: 'insufficient-margin',
    })
  })

  it('uses the tier deduction at entry', () => {
    expect(px(estimateLiquidation(flat(5_000, twoTiers), { side: 'buy', size: 2, px: 100_000 }))).toBeCloseTo(
      99_230.77,
      2,
    )
  })

  it('has no price for a fully collateralized long', () => {
    expect(estimateLiquidation(flat(100_000), { side: 'buy', size: 1, px: 100_000 })).toEqual({ kind: 'none' })
  })

  it('puts the price where equity meets the banded maintenance, or says why there is none', () => {
    fc.assert(
      fc.property(
        tierShapeArb,
        fc.double({ min: 0.001, max: 1.5, noNaN: true }),
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        fc.constantFrom('buy' as const, 'sell' as const),
        fc.double({ min: 0.001, max: 100, noNaN: true }),
        fc.double({ min: 1, max: 200_000, noNaN: true }),
        (shape, marginRatio, othersShare, side, size, entryPx) => {
          const tiers = tiersAround(shape, size * entryPx)
          const accountValue = marginRatio * size * entryPx
          const othersMaintenance = othersShare * accountValue
          const signed = side === 'buy' ? size : -size
          const slack = (p: number) =>
            accountValue + signed * (p - entryPx) - othersMaintenance - bandedMaintenance(tiers, size * p)
          const scale = accountValue + size * entryPx
          fc.pre(Math.abs(slack(entryPx)) > 1e-9 * scale && Math.abs(slack(0)) > 1e-9 * scale)

          const result = estimateLiquidation(
            { kind: 'cross', accountValue, othersMaintenance, tiers, position: null },
            { side, size, px: entryPx },
          )

          const expected =
            slack(entryPx) < 0 ? 'insufficient-margin' : side === 'buy' && slack(0) > 0 ? 'none' : 'price'
          const liquidation = result.kind === 'price' ? result.px : null
          const beyondEntry =
            liquidation === null || (side === 'buy' ? liquidation > 0 && liquidation < entryPx : liquidation > entryPx)
          expect(result.kind).toBe(expected)
          expect(beyondEntry).toBe(true)
          expect(liquidation === null ? 0 : Math.abs(slack(liquidation))).toBeLessThan(1e-9 * scale)
        },
      ),
    )
  })

  it('passes on why a venue cannot estimate', () => {
    const state: MarginState = { kind: 'unsupported', reason: 'Isolated margin' }
    expect(estimateLiquidation(state, { side: 'buy', size: 1, px: 100_000 })).toEqual(state)
  })
})
