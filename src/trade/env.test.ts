import { describe, expect, it } from 'vitest'
import { parseTradeConfig } from './env'

describe('VITE_TRADE_MAINNET', () => {
  it('turns no venue on when unset or empty', () => {
    expect(parseTradeConfig({}).mainnet).toEqual(new Set())
    for (const value of ['', ' ', ','])
      expect(parseTradeConfig({ VITE_TRADE_MAINNET: value }).mainnet).toEqual(new Set())
  })

  it('turns on the venues it lists, and only those', () => {
    for (const value of ['hyperliquid', 'hyperliquid,', ' hyperliquid '])
      expect(parseTradeConfig({ VITE_TRADE_MAINNET: value }).mainnet).toEqual(new Set(['hyperliquid']))
    expect(parseTradeConfig({ VITE_TRADE_MAINNET: 'hyperliquid, orderly' }).mainnet).toEqual(
      new Set(['hyperliquid', 'orderly']),
    )
  })

  it.each(['1', '0', 'true', 'binance', 'hyperliquid,1', 'Hyperliquid'])('refuses %j', (value) => {
    expect(() => parseTradeConfig({ VITE_TRADE_MAINNET: value })).toThrow(/not a trading venue id/)
  })
})
