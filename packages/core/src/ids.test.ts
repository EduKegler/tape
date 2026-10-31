import { describe, expect, it } from 'vitest'
import {
  isBase,
  isInterval,
  marketKey,
  parseMarketKey,
  parseStreamKey,
  splitBase,
  splitMarketKey,
  streamKey,
} from './ids'
import type { Base } from './ids'

const ETH = 'ETH' as Base
const TSLA = 'xyz:TSLA' as Base

describe('stream keys', () => {
  it('reads back the market, channel and interval a stream key names', () => {
    expect(parseStreamKey(streamKey(marketKey('dydx', ETH), 'candle', '5m'))).toEqual({
      market: 'dydx:ETH',
      channel: 'candle',
      interval: '5m',
    })
    expect(parseStreamKey(streamKey(marketKey('binance', 'BTC' as Base), 'book'))).toEqual({
      market: 'binance:BTC',
      channel: 'book',
      interval: null,
    })
  })

  it('reads back a Hyperliquid HIP-3 market, whose name holds a colon', () => {
    expect(parseStreamKey(streamKey(marketKey('hyperliquid', TSLA), 'candle', '1h'))).toEqual({
      market: 'hyperliquid:xyz:TSLA',
      channel: 'candle',
      interval: '1h',
    })
    expect(parseStreamKey(streamKey(marketKey('hyperliquid', TSLA), 'trades')).market).toBe('hyperliquid:xyz:TSLA')
  })
})

describe('market keys', () => {
  it('splits a HIP-3 market key at the venue only', () => {
    expect(splitMarketKey(marketKey('hyperliquid', TSLA))).toEqual({ venue: 'hyperliquid', base: 'xyz:TSLA' })
  })

  it('refuses a venue Tape does not know and a name no venue could list', () => {
    expect(
      [
        'kraken:BTC',
        'dydxB',
        'dydx:',
        'hyperliquid:tndex:A B:C/../中',
        'dydx:ETH',
        'hyperliquid:kPEPE',
        'hyperliquid:xyz:TSLA',
      ].map(parseMarketKey),
    ).toEqual([null, null, null, null, 'dydx:ETH', 'hyperliquid:kPEPE', 'hyperliquid:xyz:TSLA'])
  })
})

describe('bases', () => {
  it('takes the names venues list and refuses what would break a URL or a key', () => {
    const listed = ['BTC', 'kPEPE', '1000BONK', 'S', 'xyz:TSLA', 'TOON:UPSIDE', 'hb:BTC-29AUG25-120000-C', '币安人生']
    const refused = [
      '',
      'btc/usd',
      'a b',
      'i<3fl:TEST',
      'VOLMEX:$EVIV',
      'xyz:',
      ':TSLA',
      'BTC-',
      'a:b:c',
      'x'.repeat(65),
    ]
    expect(listed.filter((base) => !isBase(base))).toEqual([])
    expect(refused.filter(isBase)).toEqual([])
  })

  it('splits a HIP-3 name into its dex and symbol, and gives any other name no dex', () => {
    expect(splitBase(TSLA)).toEqual({ dex: 'xyz', symbol: 'TSLA' })
    expect(splitBase(ETH)).toEqual({ dex: '', symbol: 'ETH' })
  })
})

describe('intervals', () => {
  it('accepts only the candle intervals every venue serves', () => {
    expect([isInterval('5m'), isInterval('2m')]).toEqual([true, false])
  })
})
