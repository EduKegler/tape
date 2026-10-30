import { describe, expect, it } from 'vitest'
import { bestAsk, bestBid, initialSync, stepBook, visibleBook } from '@tape/core/book'
import type { BookInput, BookSync } from '@tape/core/book'
import { NETWORKS, VENUE_IDS } from '@tape/core/ids'
import type { MarketKey, VenueId } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { recordedFetch, wsFrames } from './fixtures'
import { toCandle, toLevels, toTrades } from './normalize'
import { venues } from './index'

const RECORDED_ON = NETWORKS.find((network) => network === (process.env.NETWORK ?? 'mainnet'))
if (!RECORDED_ON) throw new Error(`NETWORK must be one of ${NETWORKS.join(', ')}`)
const VENUES = venues(RECORDED_ON)

async function specsOf(venue: VenueId) {
  const specs = await VENUES[venue].fetchSpecs(recordedFetch)
  const bySymbol = new Map([...specs.values()].map((s) => [s.venueSymbol, s]))
  const byKey = new Map<MarketKey, MarketSpec>([...specs.values()].map((s) => [s.key, s]))
  return { specs, lookup: (sym: string) => bySymbol.get(sym)?.key ?? null, byKey }
}

async function replay(venue: VenueId) {
  const adapter = VENUES[venue]
  const { lookup, byKey } = await specsOf(venue)
  const spec = byKey.get(`${venue}:BTC` as MarketKey)!
  let step = initialSync(adapter.book.protocol)
  let sync: BookSync = step.sync
  const feed = (input: BookInput) => {
    step = stepBook(adapter.book.protocol, sync, input)
    sync = step.sync
  }
  let trades = 0
  let candles = 0
  for (const raw of wsFrames(venue)) {
    for (const e of adapter.parse(raw, lookup)) {
      if (e.kind === 'book-snapshot')
        feed({ kind: 'snapshot', bids: toLevels(e.bids, spec), asks: toLevels(e.asks, spec), time: e.time })
      if (e.kind === 'book-delta')
        feed({ kind: 'delta', bids: toLevels(e.bids, spec), asks: toLevels(e.asks, spec), seq: e.seq, time: e.time })
      if (e.kind === 'trades') trades += toTrades(e.trades, spec).length
      if (e.kind === 'candle') candles += e.candles.map((c) => toCandle(c, spec)).length
    }
    if (step.effect.kind === 'fetch-snapshot' && adapter.book.protocol === 'rest-snapshot-sequenced') {
      const snap = await adapter.book.fetchSnapshot(spec, recordedFetch)
      feed({
        kind: 'rest-snapshot',
        epoch: step.effect.epoch,
        lastUpdateId: snap.lastUpdateId,
        bids: toLevels(snap.bids, spec),
        asks: toLevels(snap.asks, spec),
      })
    }
  }
  return { sync, trades, candles }
}

describe.each(VENUE_IDS)('%s adapter', (venue) => {
  const adapter = VENUES[venue]

  it('loads specs for every base', async () => {
    const { specs } = await specsOf(venue)
    expect([...specs.keys()].sort()).toEqual(['BTC', 'ETH', 'SOL'])
  })

  it('replays the recording into an uncrossed live book', async () => {
    const { sync } = await replay(venue)
    expect(sync.phase).toBe('live')
    const book = visibleBook(sync)!
    expect(bestBid(book)!).toBeLessThan(bestAsk(book)!)
  })

  // The venues' testnets have books a few levels deep and can go seconds without a trade.
  it.skipIf(RECORDED_ON === 'testnet')('records a book ten levels deep, trades and candles', async () => {
    const { sync, trades, candles } = await replay(venue)
    const book = visibleBook(sync)!
    expect(book.bids.prices.length).toBeGreaterThanOrEqual(10)
    expect(book.asks.prices.length).toBeGreaterThanOrEqual(10)
    expect(trades).toBeGreaterThan(0)
    expect(candles).toBeGreaterThan(0)
  })

  it('fetches candle history in time order', async () => {
    const bars = await adapter.fetchCandles('BTC', '1m', recordedFetch)
    expect(bars.length).toBeGreaterThan(1)
    expect(bars.map((b) => b.time)).toEqual([...bars.map((b) => b.time)].sort((a, b) => a - b))
    expect(bars[0]!.close).toBeGreaterThan(1000)
  })

  it('reads 24h stats', async () => {
    const stats = await adapter.fetchStats('BTC', recordedFetch)
    expect(Math.abs(stats.changePct)).toBeLessThan(50)
    expect(stats.volumeQuote).toBeGreaterThan(0)
    expect(stats.fundingRate === null).toBe(venue === 'binance')
  })

  it('writes subscribe frames the venue understands', async () => {
    const { byKey } = await specsOf(venue)
    const spec = byKey.get(`${venue}:ETH` as MarketKey)!
    const frames = adapter.subscribeFrames([
      { spec, channel: 'book', interval: null },
      { spec, channel: 'candle', interval: '5m' },
    ])
    const expected = {
      binance: /ethusdt@depth@100ms.*ethusdt@kline_5m/s,
      dydx: /ETH-USD\/5MINS/,
      hyperliquid: /"coin":"ETH","interval":"5m"/,
      orderly: /PERP_ETH_USDC@orderbook.*PERP_ETH_USDC@kline_5m/s,
    }
    expect(frames.join('\n')).toMatch(expected[venue])
  })
})
