import { describe, expect, it } from 'vitest'
import { isInterval, marketKey, parseMarketKey, parseStreamKey, streamKey } from './ids'

describe('stream keys', () => {
  it('reads back the market, channel and interval a stream key names', () => {
    expect(parseStreamKey(streamKey(marketKey('dydx', 'ETH'), 'candle', '5m'))).toEqual({
      market: 'dydx:ETH',
      channel: 'candle',
      interval: '5m',
    })
    expect(parseStreamKey(streamKey(marketKey('binance', 'BTC'), 'book'))).toEqual({
      market: 'binance:BTC',
      channel: 'book',
      interval: null,
    })
  })
})

describe('market keys', () => {
  it('refuses a market on a venue or base Tape does not list', () => {
    expect([parseMarketKey('kraken', 'BTC'), parseMarketKey('dydx', 'doge'), parseMarketKey('dydx', 'eth')]).toEqual([
      null,
      null,
      'dydx:ETH',
    ])
  })
})

describe('intervals', () => {
  it('accepts only the candle intervals every venue serves', () => {
    expect([isInterval('5m'), isInterval('2m')]).toEqual([true, false])
  })
})
