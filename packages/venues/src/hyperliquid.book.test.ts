import { describe, expect, it } from 'vitest'
import { marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import { recordedFetch } from './fixtures'
import { hyperliquid } from './hyperliquid'
import type { RawLevel, VenueEvent } from './types'

const BTC = marketKey('hyperliquid', 'BTC' as Base)
const lookup = (coin: string) => (coin === 'BTC' ? BTC : null)

// Recorded in this order from wss://api.hyperliquid.xyz/ws on 2026-10-31, subscribed to l2Book BTC with and without fast.
const FAST_BEFORE =
  '{"channel":"l2Book","data":{"coin":"BTC","time":1793462732684,"levels":[[{"px":"77591.0","sz":"19.30262","n":10},{"px":"77590.0","sz":"0.00257","n":1},{"px":"77589.0","sz":"0.00015","n":1},{"px":"77587.0","sz":"0.04466","n":2},{"px":"77586.0","sz":"0.00615","n":2}],[{"px":"77592.0","sz":"12.3334","n":44},{"px":"77593.0","sz":"3.11613","n":10},{"px":"77594.0","sz":"2.1367","n":11},{"px":"77595.0","sz":"0.43715","n":3},{"px":"77596.0","sz":"13.62642","n":10}]],"fast":true}}'
const SNAPSHOT =
  '{"channel":"l2Book","data":{"coin":"BTC","time":1793462733291,"levels":[[{"px":"77591.0","sz":"19.30246","n":10},{"px":"77590.0","sz":"0.00257","n":1},{"px":"77589.0","sz":"0.00015","n":1},{"px":"77587.0","sz":"0.04466","n":2},{"px":"77586.0","sz":"0.00615","n":2},{"px":"77585.0","sz":"0.01762","n":3},{"px":"77584.0","sz":"0.006","n":1},{"px":"77583.0","sz":"0.1072","n":3},{"px":"77582.0","sz":"0.01086","n":2},{"px":"77581.0","sz":"0.09649","n":3},{"px":"77580.0","sz":"0.95042","n":4},{"px":"77579.0","sz":"0.13127","n":6},{"px":"77578.0","sz":"0.119","n":3},{"px":"77577.0","sz":"1.19603","n":6},{"px":"77576.0","sz":"1.70811","n":7},{"px":"77575.0","sz":"0.9848","n":6},{"px":"77574.0","sz":"3.87866","n":10},{"px":"77573.0","sz":"0.38449","n":5},{"px":"77572.0","sz":"3.94253","n":7},{"px":"77571.0","sz":"6.83654","n":10}],[{"px":"77592.0","sz":"12.34941","n":45},{"px":"77593.0","sz":"3.11613","n":10},{"px":"77594.0","sz":"2.1367","n":11},{"px":"77595.0","sz":"0.43715","n":3},{"px":"77596.0","sz":"13.62642","n":10},{"px":"77597.0","sz":"4.99732","n":9},{"px":"77598.0","sz":"2.21263","n":9},{"px":"77599.0","sz":"6.4952","n":12},{"px":"77600.0","sz":"3.42455","n":15},{"px":"77601.0","sz":"1.91638","n":7},{"px":"77602.0","sz":"4.25795","n":9},{"px":"77603.0","sz":"8.67721","n":9},{"px":"77604.0","sz":"5.04599","n":7},{"px":"77605.0","sz":"7.91242","n":11},{"px":"77606.0","sz":"0.33123","n":20},{"px":"77607.0","sz":"6.24154","n":8},{"px":"77608.0","sz":"3.28707","n":8},{"px":"77609.0","sz":"5.44351","n":8},{"px":"77610.0","sz":"2.24474","n":7},{"px":"77611.0","sz":"5.14334","n":6}]]}}'
const FAST_AFTER =
  '{"channel":"l2Book","data":{"coin":"BTC","time":1793462734910,"levels":[[{"px":"77591.0","sz":"19.30581","n":11},{"px":"77590.0","sz":"0.00257","n":1},{"px":"77589.0","sz":"0.00015","n":1},{"px":"77588.0","sz":"0.03866","n":1},{"px":"77587.0","sz":"0.006","n":1}],[{"px":"77592.0","sz":"12.01582","n":42},{"px":"77593.0","sz":"3.11613","n":10},{"px":"77594.0","sz":"2.1367","n":11},{"px":"77595.0","sz":"0.51125","n":4},{"px":"77596.0","sz":"13.62642","n":10}]],"fast":true}}'

const sides = (raw: string): [RawLevel[], RawLevel[]] => {
  const { levels } = (JSON.parse(raw) as { data: { levels: { px: string; sz: string }[][] } }).data
  const side = (i: 0 | 1) => levels[i]!.map((l) => [l.px, l.sz] as const)
  return [side(0), side(1)]
}

describe('hyperliquid book', () => {
  it('lays the newer fast top over the 20-level snapshot', () => {
    const adapter = hyperliquid('mainnet')
    adapter.parse(SNAPSHOT, lookup)
    const [snapBids, snapAsks] = sides(SNAPSHOT)
    const [fastBids, fastAsks] = sides(FAST_AFTER)
    // The fast bids add 77588.0 and end at 77587.0, the snapshot's 4th bid. The fast asks end at 77596.0, its 5th ask.
    expect(adapter.parse(FAST_AFTER, lookup)).toEqual<VenueEvent[]>([
      {
        kind: 'book-snapshot',
        market: BTC,
        bids: [...fastBids, ...snapBids.slice(4)],
        asks: [...fastAsks, ...snapAsks.slice(5)],
        time: 1793462734910,
      },
    ])
  })
  it('drops a fast frame older than the snapshot, so the ladder keeps the snapshot', () => {
    const adapter = hyperliquid('mainnet')
    adapter.parse(SNAPSHOT, lookup)
    expect(adapter.parse(FAST_BEFORE, lookup)).toEqual([])
  })
  it('subscribes to the 20-level book and the fast top, and unsubscribes both', async () => {
    const adapter = hyperliquid('mainnet')
    const spec = (await adapter.fetchMarket('BTC' as Base, recordedFetch))!
    const book = [{ spec, channel: 'book' as const, interval: null }]
    expect(adapter.subscribeFrames(book)).toEqual([
      '{"method":"subscribe","subscription":{"type":"l2Book","coin":"BTC"}}',
      '{"method":"subscribe","subscription":{"type":"l2Book","coin":"BTC","fast":true}}',
    ])
    expect(adapter.unsubscribeFrames(book)).toEqual([
      '{"method":"unsubscribe","subscription":{"type":"l2Book","coin":"BTC"}}',
      '{"method":"unsubscribe","subscription":{"type":"l2Book","coin":"BTC","fast":true}}',
    ])
  })
  it.each(['unsubscribeFrames', 'subscribeFrames'] as const)(
    'forgets the snapshot on %s, so a fast frame waits for the next one',
    async (frames) => {
      const adapter = hyperliquid('mainnet')
      const spec = (await adapter.fetchMarket('BTC' as Base, recordedFetch))!
      adapter.parse(SNAPSHOT, lookup)
      adapter[frames]([{ spec, channel: 'book', interval: null }])
      expect(adapter.parse(FAST_AFTER, lookup)).toEqual([])
    },
  )
})
