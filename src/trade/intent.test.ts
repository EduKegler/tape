import { describe, expect, it } from 'vitest'
import type { Px, Qty } from '#/core/fixed'
import { marketKey } from '#/core/ids'
import type { MarketSpec } from '#/core/market'
import { checkPrice, checkSize, worstPrice } from './intent'

const hl: MarketSpec = {
  key: marketKey('hyperliquid', 'BTC'), venue: 'hyperliquid', base: 'BTC', quote: 'USDC', kind: 'perp', venueSymbol: 'BTC',
  scale: { px: 1, qty: 5 }, tick: { kind: 'sigfig', figures: 5 }, step: 1 as Qty,
}
const dydx: MarketSpec = { ...hl, venue: 'dydx', scale: { px: 0, qty: 4 }, tick: { kind: 'fixed', tick: 1 as Px } }

describe('order intent', () => {
  it('rejects prices off the tick and sizes off the step', () => {
    expect(checkPrice(hl, '101234')).toBeUndefined()
    expect(checkPrice(hl, '101234.5')).toBe('Price must be a multiple of 1.0')
    expect(checkPrice(hl, '0')).toBe('Price must be above zero')
    expect(checkSize(dydx, '0.0001')).toBeUndefined()
    expect(checkSize(dydx, '0.00015')).toBe('At most 4 decimals')
  })

  it('caps a market buy at the slippage and keeps it on a Hyperliquid tick', () => {
    // Ask 101,234.0 plus 1% is 102,246.34, floored to five figures.
    expect(worstPrice(hl, 'buy', 1_012_340 as Px, 100)).toBe(1_022_460)
    expect(checkPrice(hl, '102246')).toBeUndefined()
  })

  it('floors a market sell at the slippage and rounds it up onto the tick', () => {
    // Bid 80,000 minus 0.5% is 79,600 exactly.
    expect(worstPrice(dydx, 'sell', 80_000 as Px, 50)).toBe(79_600)
    expect(worstPrice(dydx, 'sell', 80_001 as Px, 50)).toBe(79_601)
  })
})
