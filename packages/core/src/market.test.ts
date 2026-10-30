import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CANDLE_LIMIT,
  TRADE_LIMIT,
  effectiveTick,
  emptyTape,
  priceTick,
  groupDecimals,
  groupOptions,
  pushTrades,
  snapGroup,
  upsertCandle,
} from './market'
import type { Candle, MarketSpec, Trade } from './market'
import type { Decimals, Px, Qty } from './fixed'
import { marketKey } from './ids'

const hl = (px: 1 | 2 | 4): MarketSpec => ({
  key: marketKey('hyperliquid', 'BTC'),
  venue: 'hyperliquid',
  base: 'BTC',
  quote: 'USDC',
  kind: 'perp',
  venueSymbol: 'BTC',
  scale: { px, qty: 5 },
  tick: { kind: 'sigfig', figures: 5 },
  step: 1 as Qty,
})
const binance: MarketSpec = { ...hl(2), venue: 'binance', tick: { kind: 'fixed', tick: 1 as Px } }

describe('ticks', () => {
  it('keeps five significant figures on Hyperliquid', () => {
    expect(effectiveTick(hl(1), 809_990 as Px)).toBe(10)
    expect(effectiveTick(hl(2), 400_012 as Px)).toBe(10)
    expect(effectiveTick(hl(4), 2_001_234 as Px)).toBe(100)
    expect(priceTick(hl(1), 1_000_010 as Px)).toBe(10)
    expect(effectiveTick(hl(1), 1_000_010 as Px)).toBe(100)
  })

  const price = fc.oneof(
    fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    fc
      .tuple(fc.integer({ min: 0, max: 15 }), fc.integer({ min: -2, max: 2 }))
      .map(([power, offset]) => 10 ** power + offset)
      .filter((px) => px > 0),
  )
  const scale = fc.integer({ min: 0, max: 8 }).map((d) => d as Decimals)
  const onTick = (spec: MarketSpec, px: number) => px % priceTick(spec, px as Px) === 0

  it('accepts a Hyperliquid price when it is whole or has at most five significant figures', () => {
    fc.assert(
      fc.property(price, scale, (px, decimals) => {
        const spec = { ...hl(1), scale: { px: decimals, qty: 5 } as const }
        const whole = px % 10 ** decimals === 0
        const figures = String(px).replace(/(?<!0)0+$/, '').length
        expect(onTick(spec, px)).toBe(whole || figures <= 5)
      }),
    )
  })

  const tickUpToOneUnit = scale.chain((decimals) =>
    fc.tuple(fc.constant(decimals), fc.integer({ min: 1, max: 10 ** decimals })),
  )

  it('accepts a fixed-tick price only on a multiple of the tick', () => {
    fc.assert(
      fc.property(price, tickUpToOneUnit, (px, [decimals, tick]) => {
        const spec: MarketSpec = {
          ...binance,
          scale: { px: decimals, qty: 5 },
          tick: { kind: 'fixed', tick: tick as Px },
        }
        expect(onTick(spec, px)).toBe(px % tick === 0)
      }),
    )
  })

  it('snaps a requested group to the closest allowed step', () => {
    expect(groupOptions(binance, 8_100_000 as Px)).toEqual([1, 2, 5, 10, 25, 50])
    expect(snapGroup(binance, 8_100_000 as Px, '0.1')).toBe(10)
    expect(snapGroup(binance, 8_100_000 as Px, 'nope')).toBe(1)
    expect(snapGroup(binance, 8_100_000 as Px, '10')).toBe(50)
    expect(groupDecimals(binance, snapGroup(binance, 8_100_000 as Px, '0.5'))).toBe(1)
  })

  it('shows a whole-dollar group with no decimals, however many zeros it has', () => {
    expect([groupDecimals(hl(1), 500 as Px), groupDecimals(hl(1), 100 as Px)]).toEqual([0, 0])
  })
})

describe('trades and candles', () => {
  const t = (id: string, time: number): Trade => ({ id, time, px: 1 as Px, qty: 1 as Qty, side: 'buy' })

  it('dedupes overlapping trades and keeps newest first', () => {
    const tape = emptyTape()
    expect(pushTrades(tape, [t('a', 1), t('b', 2)])).toBe(true)
    expect(pushTrades(tape, [t('b', 2)])).toBe(false)
    pushTrades(tape, [t('c', 3)])
    expect(tape.items.map((x) => x.id)).toEqual(['c', 'b', 'a'])
  })

  it('keeps only the newest TRADE_LIMIT trades', () => {
    const tape = emptyTape()
    pushTrades(
      tape,
      Array.from({ length: TRADE_LIMIT + 1 }, (_, i) => t(`t${i + 1}`, i + 1)),
    )
    expect(tape.items).toHaveLength(TRADE_LIMIT)
    expect(tape.items.some((x) => x.time === 1)).toBe(false)
  })

  it('places a late trade by its time', () => {
    const tape = emptyTape()
    pushTrades(tape, [t('b', 2)])
    pushTrades(tape, [t('a', 1)])
    expect(tape.items.map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('remembers every trade on the tape but not every id it was ever sent', () => {
    const tape = emptyTape()
    for (let i = 1; i <= 330; i++) pushTrades(tape, [t(`t${i}`, i)])
    expect(pushTrades(tape, [t('t321', 321)])).toBe(false)
    expect(new Set(tape.items.map((x) => x.id)).size).toBe(tape.items.length)
    expect(tape.seen.size).toBeLessThan(330)
  })

  const bar = (open: number, c: number): Candle => ({
    open,
    o: 1 as Px,
    h: 1 as Px,
    l: 1 as Px,
    c: c as Px,
    v: 1 as Qty,
  })

  it('replaces the forming bar and ignores older ones', () => {
    let bars = upsertCandle([], bar(60, 1))
    bars = upsertCandle(bars, bar(60, 2))
    bars = upsertCandle(bars, bar(0, 9))
    expect(bars).toEqual([bar(60, 2)])
  })

  it('appends each new bar and keeps only the last CANDLE_LIMIT', () => {
    const opens = Array.from({ length: CANDLE_LIMIT + 1 }, (_, i) => i * 60)
    let bars: readonly Candle[] = []
    for (const open of opens) bars = upsertCandle(bars, bar(open, 1))
    expect(bars.map((b) => b.open)).toEqual(opens.slice(1))
  })
})
