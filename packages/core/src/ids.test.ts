import { describe, expect, it } from 'vitest'
import { marketKey, parseStreamKey, streamKey } from './ids'

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
