import { describe, expect, it } from 'vitest'
import { estimateLiquidation } from './liquidation'
import type { Liquidation, MarginState } from './liquidation'

type Cross = Extract<MarginState, { kind: 'cross' }>

const flat = (accountValue: number, tiers = [{ lowerBound: 0, maxLeverage: 50 }]): Cross => ({
  kind: 'cross',
  accountValue,
  othersMaintenance: 0,
  tiers,
  position: null,
})

const px = (l: Liquidation) => (l.kind === 'price' ? l.px : l.kind)

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

  it('passes on why a venue cannot estimate', () => {
    const state: MarginState = { kind: 'unsupported', reason: 'Isolated margin' }
    expect(estimateLiquidation(state, { side: 'buy', size: 1, px: 100_000 })).toEqual(state)
  })
})
