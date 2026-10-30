import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parsePx, wireDecimal } from '@tape/core/fixed'
import type { Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { priceTick } from '@tape/core/market'
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

describe('scale order properties', () => {
  const market = fc.oneof(
    fc.integer({ min: 0, max: 6 }).chain((px) =>
      fc.integer({ min: 1, max: 10 ** px }).map((tick): MarketSpec => ({
        ...fixed,
        scale: { px: px as 1, qty: 3 },
        tick: { kind: 'fixed', tick: tick as Px },
      })),
    ),
    fc.integer({ min: 0, max: 6 }).map((px): MarketSpec => ({ ...sigfig, scale: { px: px as 1, qty: 5 } })),
  )
  const onGrid = (unit: number, max: number) =>
    fc
      .oneof(
        fc.tuple(fc.integer({ min: 1, max }), fc.integer({ min: 1, max })),
        fc
          .tuple(fc.integer({ min: 1, max }), fc.integer({ min: -100, max: 100 }))
          .map(([at, ticks]): [number, number] => [at, at + ticks])
          .filter(([, end]) => end >= 1 && end <= max),
      )
      .map(([start, end]) => ({ start: start * unit, end: end * unit }))
  const prices = ({ tick, scale }: MarketSpec) =>
    tick.kind === 'fixed'
      ? onGrid(tick.tick, 10_000_000)
      : fc.oneof(
          fc.integer({ min: 0, max: 6 }).chain((power) => onGrid(10 ** power, 99_999)),
          onGrid(10 ** scale.px, 10_000_000),
        )
  const order = fc
    .tuple(market, fc.integer({ min: 1, max: 1_000 }))
    .map(([spec, step]) => ({ ...spec, step: step as Qty }))
    .chain((spec) =>
      fc.record({
        spec: fc.constant(spec),
        side: fc.constantFrom('buy' as const, 'sell' as const),
        range: prices(spec),
        count: fc.integer({ min: 2, max: 50 }),
        skew: fc.double({ min: 0.1, max: 10, noNaN: true }),
        steps: fc.oneof(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1, max: 100_000 })),
      }),
    )
  const linear = (start: number, end: number, count: number, i: number) => start + ((end - start) * i) / (count - 1)
  const shares = (steps: number, count: number, skew: number) => {
    const weights = Array.from({ length: count }, (_, i) => 1 + ((skew - 1) * i) / (count - 1))
    return weights.map((w) => (steps * w) / sum(weights))
  }

  it('splits an accepted order into legs on the nearest passive tick to the line, sized by the skew', () => {
    fc.assert(
      fc.property(order, ({ spec, side, range: { start, end }, count, skew, steps }) => {
        const built = scaleLegs(
          spec,
          side,
          { start: start as Px, end: end as Px, count, skew },
          (steps * spec.step) as Qty,
        )
        fc.pre(built.ok)
        const { legs } = built
        const passive = side === 'buy' ? 1 : -1
        const exact = shares(steps, count, skew)
        expect(legs).toHaveLength(count)
        expect(new Set(legs.map((l) => l.px)).size).toBe(count)
        expect(sum(legs.map((l) => l.size))).toBe(steps * spec.step)
        expect([legs[0]?.px, legs.at(-1)?.px]).toEqual([start, end])
        const first = legs[0]?.size ?? 0
        const last = legs.at(-1)?.size ?? 0
        expect(Math.abs(last - skew * first) / spec.step).toBeLessThan(1 + skew + 1e-9)
        legs.forEach((leg, i) => {
          expect(checkPrice(spec, wireDecimal(leg.px, spec.scale.px))).toBeUndefined()
          const line = linear(start, end, count, i)
          expect(passive * (leg.px - line)).toBeLessThanOrEqual(0)
          expect(Math.abs(leg.px - line)).toBeLessThan(priceTick(spec, Math.ceil(line) as Px))
          expect(leg.size % spec.step).toBe(0)
          expect(leg.size).toBeGreaterThanOrEqual(spec.step)
          expect(Math.abs(leg.size / spec.step - (exact[i] ?? 0))).toBeLessThan(1 + 1e-9)
        })
      }),
    )
  })

  it('refuses only a range under one tick per leg, or a leg whose share is under one step', () => {
    fc.assert(
      fc.property(order, ({ spec, side, range: { start, end }, count, skew, steps }) => {
        const built = scaleLegs(
          spec,
          side,
          { start: start as Px, end: end as Px, count, skew },
          (steps * spec.step) as Qty,
        )
        const wideEnough = Math.abs(end - start) / (count - 1) >= priceTick(spec, Math.max(start, end) as Px)
        const bigEnough = Math.min(...shares(steps, count, skew)) >= 1
        const refusedFor = built.ok ? null : built.field
        expect(refusedFor === null || !(wideEnough && bigEnough)).toBe(true)
        expect(refusedFor === 'size' && bigEnough).toBe(false)
      }),
    )
  })

  it('refuses a fixed-tick range exactly when its legs would sit under one tick apart', () => {
    fc.assert(
      fc.property(order, ({ spec, side, range: { start, end }, count, skew, steps }) => {
        fc.pre(spec.tick.kind === 'fixed')
        const built = scaleLegs(
          spec,
          side,
          { start: start as Px, end: end as Px, count, skew },
          (steps * spec.step) as Qty,
        )
        const tooNarrow = Math.abs(end - start) < spec.tick.tick * (count - 1)
        expect(!built.ok && built.field === 'count').toBe(tooNarrow)
      }),
    )
  })
})
