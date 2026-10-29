import { describe, expect, it } from 'vitest'
import {
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
import type { Px, Qty } from './fixed'
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

  it('snaps a requested group to the closest allowed step', () => {
    expect(groupOptions(binance, 8_100_000 as Px)).toEqual([1, 2, 5, 10, 25, 50])
    expect(snapGroup(binance, 8_100_000 as Px, '0.1')).toBe(10)
    expect(snapGroup(binance, 8_100_000 as Px, 'nope')).toBe(1)
    expect(groupDecimals(binance, snapGroup(binance, 8_100_000 as Px, '0.5'))).toBe(1)
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

  it('replaces the forming bar and ignores older ones', () => {
    const bar = (open: number, c: number): Candle => ({
      open,
      o: 1 as Px,
      h: 1 as Px,
      l: 1 as Px,
      c: c as Px,
      v: 1 as Qty,
    })
    let bars = upsertCandle([], bar(60, 1))
    bars = upsertCandle(bars, bar(60, 2))
    bars = upsertCandle(bars, bar(0, 9))
    expect(bars).toEqual([bar(60, 2)])
  })
})
