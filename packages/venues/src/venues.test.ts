import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bestAsk, bestBid, initialSync, stepBook, visibleBook } from '@tape/core/book'
import type { BookInput, BookSync } from '@tape/core/book'
import { NETWORKS, VENUE_IDS, isBase, marketKey } from '@tape/core/ids'
import type { Base, MarketKey, VenueId } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { recordedFetch, wsFrames } from './fixtures'
import { toCandle, toLevels, toTrades } from './normalize'
import { venues } from './index'

const RECORDED_ON = NETWORKS.find((network) => network === (process.env.NETWORK ?? 'mainnet'))
if (!RECORDED_ON) throw new Error(`NETWORK must be one of ${NETWORKS.join(', ')}`)
const VENUES = venues(RECORDED_ON)

async function specsOf(venue: VenueId) {
  const specs = (await VENUES[venue].fetchMarkets(recordedFetch)).flatMap((g) => g.markets)
  const bySymbol = new Map(specs.map((s) => [s.venueSymbol, s]))
  const byKey = new Map<MarketKey, MarketSpec>(specs.map((s) => [s.key, s]))
  return { specs, lookup: (sym: string) => bySymbol.get(sym)?.key ?? null, byKey }
}

const recording = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')) as T

const hyperliquidDexes = () =>
  recording<{ universe: { name: string; isDelisted?: boolean }[]; collateralToken: number }[]>(
    'hyperliquid.allPerpMetas.json',
  )

const fits = (increment: string) => !/[1-9]/.test((increment.split('.')[1] ?? '').slice(8))

const TRADABLE_IN_RECORDING: Record<VenueId, () => string[]> = {
  hyperliquid: () =>
    hyperliquidDexes()
      .filter((dex) => dex.collateralToken === 0)
      .flatMap((dex) => dex.universe.filter((u) => !u.isDelisted).map((u) => u.name)),
  dydx: () =>
    Object.values(
      recording<{ markets: Record<string, { ticker: string; status: string; tickSize: string; stepSize: string }> }>(
        'dydx.markets.json',
      ).markets,
    )
      .filter((m) => m.status === 'ACTIVE' && fits(m.tickSize) && fits(m.stepSize))
      .map((m) => m.ticker.replace(/-USD$/, '')),
  orderly: () =>
    recording<{ data: { rows: { symbol: string; status: string; broker_id: string | null }[] } }>('orderly.info.json')
      .data.rows.filter((r) => r.status === 'ACTIVE' && r.broker_id === null)
      .map((r) => r.symbol.replace(/^PERP_(.+)_USDC$/, '$1')),
  binance: () =>
    recording<{ symbols: { baseAsset: string; quoteAsset: string; status: string }[] }>('binance.markets.json')
      .symbols.filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT')
      .map((s) => s.baseAsset),
}

const SYMBOL: Record<VenueId, (base: Base) => string> = {
  hyperliquid: (base) => base,
  dydx: (base) => `${base}-USD`,
  orderly: (base) => `PERP_${base}_USDC`,
  binance: (base) => `${base}USDT`,
}

const BTC = 'BTC' as Base

async function replay(venue: VenueId) {
  const adapter = VENUES[venue]
  const { lookup, byKey } = await specsOf(venue)
  const spec = byKey.get(marketKey(venue, BTC))!
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

describe('a market the venue does not list', () => {
  const answering =
    (status: number, body: unknown): typeof fetch =>
    async () =>
      Response.json(body, { status })

  it('reads as null where dYdX and Binance answer 400', async () => {
    const dydx = answering(400, {
      errors: [{ value: 'NOTAMARKET-USD', msg: 'ticker must be a valid ticker (BTC-USD, etc)', param: 'ticker' }],
    })
    const binance = answering(400, { code: -1121, msg: 'Invalid symbol.' })
    expect(await VENUES.dydx.fetchMarket('NOTAMARKET' as Base, dydx)).toBeNull()
    expect(await VENUES.binance.fetchMarket('NOTAMARKET' as Base, binance)).toBeNull()
  })

  it('still fails on any other error', async () => {
    await expect(VENUES.dydx.fetchMarket(BTC, answering(503, {}))).rejects.toThrow('503')
  })
})

describe('hyperliquid adapter', () => {
  it('lists the main dex unnamed, then each HIP-3 dex with a live market under its full name', async () => {
    const fullNames = recording<({ fullName: string } | null)[]>('hyperliquid.perpDexs.json')
    const live = hyperliquidDexes().flatMap((dex, i) =>
      dex.collateralToken === 0 && dex.universe.some((u) => !u.isDelisted && isBase(u.name))
        ? [fullNames[i]?.fullName ?? null]
        : [],
    )
    const groups = await VENUES.hyperliquid.fetchMarkets(recordedFetch)
    expect(groups.map((g) => g.name)).toEqual(live)
    expect(live[0]).toBeNull()
    expect(live.length).toBeGreaterThan(1)
  })
})

describe.each(VENUE_IDS)('%s adapter', (venue) => {
  const adapter = VENUES[venue]

  it('lists every market the venue marks tradable, under the name the venue streams it by', async () => {
    const { specs } = await specsOf(venue)
    expect(specs.map((s) => s.base).sort()).toEqual(TRADABLE_IN_RECORDING[venue]().filter(isBase).sort())
    expect(specs.map((s) => s.base)).toEqual(expect.arrayContaining(['BTC', 'ETH', 'SOL']))
    for (const s of specs) {
      expect(s.key).toBe(marketKey(venue, s.base))
      expect(s.venue).toBe(venue)
      expect(s.venueSymbol).toBe(SYMBOL[venue](s.base))
    }
  })

  it('reads one market without the list, with the rules the list gives it', async () => {
    const { byKey } = await specsOf(venue)
    for (const base of ['BTC', 'ETH', 'SOL'] as Base[])
      expect(await adapter.fetchMarket(base, recordedFetch)).toEqual(byKey.get(marketKey(venue, base)))
    expect(await adapter.fetchMarket('NOTAMARKET' as Base, recordedFetch)).toBeNull()
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
    const bars = await adapter.fetchCandles(BTC, '1m', recordedFetch)
    expect(bars.length).toBeGreaterThan(1)
    expect(bars.map((b) => b.time)).toEqual([...bars.map((b) => b.time)].sort((a, b) => a - b))
    expect(bars[0]!.close).toBeGreaterThan(1000)
  })

  it('reads 24h stats', async () => {
    const stats = await adapter.fetchStats(BTC, recordedFetch)
    expect(Math.abs(stats.changePct)).toBeLessThan(50)
    expect(stats.volumeQuote).toBeGreaterThan(0)
    expect(stats.fundingRate === null).toBe(venue === 'binance')
  })

  it('writes subscribe frames the venue understands', async () => {
    const { byKey } = await specsOf(venue)
    const spec = byKey.get(marketKey(venue, 'ETH' as Base))!
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
