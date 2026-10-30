import { describe, expect, it } from 'vitest'
import { parsePx } from '@tape/core/fixed'
import type { Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { checkPrice } from './intent'
import { apportion, scaleLegs } from './scale-order'

const fixed: MarketSpec = {
  key: marketKey('dydx', 'ETH'),
  venue: 'dydx',
  base: 'ETH',
  quote: 'USD',
  kind: 'perp',
  venueSymbol: 'ETH-USD',
  scale: { px: 1, qty: 3 },
  tick: { kind: 'fixed', tick: 1 as Px },
  step: 1 as Qty,
}
const sigfig: MarketSpec = {
  ...fixed,
  key: marketKey('hyperliquid', 'BTC'),
  venue: 'hyperliquid',
  venueSymbol: 'BTC',
  scale: { px: 1, qty: 5 },
  tick: { kind: 'sigfig', figures: 5 },
}
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)

describe('apportion', () => {
  it('hands out every unit, the remainder to the largest fractions first', () => {
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3])
    expect(apportion(60, [1, 2, 3])).toEqual([10, 20, 30])
    expect(apportion(7, [3, 1])).toEqual([5, 2])
    expect(sum(apportion(100_003, [1, 1.5, 2, 2.5, 3]))).toBe(100_003)
  })
})

describe('scale order', () => {
  it('splits the size evenly over prices from start to end', () => {
    const built = scaleLegs(fixed, 'buy', { start: 30_000 as Px, end: 27_000 as Px, count: 4, skew: 1 }, 2_000 as Qty)
    expect(built).toEqual({
      ok: true,
      legs: [
        { px: 30_000, size: 500 },
        { px: 29_000, size: 500 },
        { px: 28_000, size: 500 },
        { px: 27_000, size: 500 },
      ],
    })
  })

  it('grows the size toward the end by the skew and keeps the sum exact', () => {
    const built = scaleLegs(fixed, 'buy', { start: 30_000 as Px, end: 28_000 as Px, count: 3, skew: 3 }, 1_001 as Qty)
    if (!built.ok) throw new Error(built.message)
    expect(built.legs.map((l) => l.size)).toEqual([167, 334, 500])
    expect(sum(built.legs.map((l) => l.size))).toBe(1_001)
  })

  it('rounds a buy down and a sell up onto the tick, so no leg is worse than the line', () => {
    const range = { start: 30_000 as Px, end: 29_990 as Px, count: 4, skew: 1 }
    const buy = scaleLegs(fixed, 'buy', range, 4_000 as Qty)
    const sell = scaleLegs(fixed, 'sell', { ...range, start: 29_990 as Px, end: 30_000 as Px }, 4_000 as Qty)
    expect(buy.ok && buy.legs.map((l) => l.px)).toEqual([30_000, 29_996, 29_993, 29_990])
    expect(sell.ok && sell.legs.map((l) => l.px)).toEqual([29_990, 29_994, 29_997, 30_000])
  })

  it('keeps every leg on a Hyperliquid tick when the tick changes inside the range', () => {
    const built = scaleLegs(
      sigfig,
      'buy',
      { start: parsePx('10020', sigfig.scale), end: parsePx('9980', sigfig.scale), count: 4, skew: 1 },
      100_000 as Qty,
    )
    if (!built.ok) throw new Error(built.message)
    for (const leg of built.legs) expect(checkPrice(sigfig, String(leg.px / 10))).toBeUndefined()
    expect(built.legs.map((l) => l.px / 10)).toEqual([10_020, 10_006, 9_993.3, 9_980])
  })

  it('refuses a range too narrow for the count instead of stacking legs on one price', () => {
    const built = scaleLegs(fixed, 'buy', { start: 30_000 as Px, end: 29_998 as Px, count: 4, skew: 1 }, 4_000 as Qty)
    expect(built).toEqual({ ok: false, field: 'count', message: 'The range is too narrow for 4 orders' })
  })

  it('refuses a leg below one step', () => {
    const tiny = scaleLegs(fixed, 'buy', { start: 30_000 as Px, end: 29_000 as Px, count: 5, skew: 1 }, 4 as Qty)
    expect(tiny).toEqual({ ok: false, field: 'size', message: 'Each order needs at least 0.001' })
  })
})
