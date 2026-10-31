import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bestAsk, bestBid, initialSync, stepBook, visibleBook } from '@tape/core/book'
import type { BookInput, BookSync } from '@tape/core/book'
import { NETWORKS, VENUE_IDS, isBase, marketKey } from '@tape/core/ids'
import type { Base, MarketKey, VenueId } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { recordedFetch, wsFrames } from './fixtures'
import { toCandle, toLevels, toTrades } from './normalize'
import { VenueParseError } from './types'
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

const decimalsOf = (increment: string) => {
  const fraction = increment.split('.')[1] ?? ''
  let end = fraction.length
  while (fraction[end - 1] === '0') end--
  return end
}

const RULES_IN_RECORDING: Record<VenueId, (base: Base) => Pick<MarketSpec, 'venueSymbol' | 'scale'>> = {
  hyperliquid: (base) => {
    const { szDecimals } = recording<{ universe: { name: string; szDecimals: number }[] }>(
      'hyperliquid.meta.json',
    ).universe.find((u) => u.name === base)!
    return { venueSymbol: base, scale: { px: 6 - szDecimals, qty: szDecimals } as MarketSpec['scale'] }
  },
  dydx: (base) => {
    const m = recording<{ markets: Record<string, { tickSize: string; stepSize: string }> }>(
      `dydx.markets-${base}.json`,
    ).markets[`${base}-USD`]!
    return {
      venueSymbol: `${base}-USD`,
      scale: { px: decimalsOf(m.tickSize), qty: decimalsOf(m.stepSize) } as MarketSpec['scale'],
    }
  },
  orderly: (base) => {
    const m = recording<{ data: { quote_tick: number | string; base_tick: number | string } }>(
      `orderly.info-${base}.json`,
    ).data
    return {
      venueSymbol: `PERP_${base}_USDC`,
      scale: { px: decimalsOf(String(m.quote_tick)), qty: decimalsOf(String(m.base_tick)) } as MarketSpec['scale'],
    }
  },
  binance: (base) => {
    const { filters } = recording<{
      symbols: { symbol: string; filters: { filterType: string; tickSize?: string; stepSize?: string }[] }[]
    }>('binance.markets.json').symbols.find((s) => s.symbol === `${base}USDT`)!
    const tick = filters.find((f) => f.filterType === 'PRICE_FILTER')!.tickSize!
    const step = filters.find((f) => f.filterType === 'LOT_SIZE')!.stepSize!
    return { venueSymbol: `${base}USDT`, scale: { px: decimalsOf(tick), qty: decimalsOf(step) } as MarketSpec['scale'] }
  },
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

  it('reads as null a symbol Orderly cannot parse', async () => {
    const orderly = answering(400, { success: false, code: -1000, message: 'error path format' })
    expect(await VENUES.orderly.fetchMarket('币安人生' as Base, orderly)).toBeNull()
  })

  it('still fails on any other error', async () => {
    await expect(VENUES.dydx.fetchMarket(BTC, answering(503, {}))).rejects.toThrow('503')
  })

  it.each(['dydx', 'orderly', 'binance'] as const)('reads a HIP-3 name as null on %s without asking', async (venue) => {
    const refuse: typeof fetch = () => Promise.reject(new Error('asked'))
    expect(await VENUES[venue].fetchMarket('xyz:TSLA' as Base, refuse)).toBeNull()
  })

  it('reads a name outside the symbols Binance accepts as null without asking', async () => {
    const refuse: typeof fetch = () => Promise.reject(new Error('asked'))
    expect(await VENUES.binance.fetchMarket('kPEPE' as Base, refuse)).toBeNull()
  })

  it('asks Binance for a symbol outside ASCII', async () => {
    const asked: string[] = []
    const recorded: typeof fetch = (input, init) => {
      asked.push(input instanceof Request ? input.url : input.toString())
      return recordedFetch(input, init)
    }
    expect((await VENUES.binance.fetchMarket('币安人生' as Base, recorded))?.venueSymbol).toBe('币安人生USDT')
    expect(asked).toEqual([expect.stringContaining(`symbol=${encodeURIComponent('币安人生USDT')}`)])
  })

  it("looks in Binance's whole list when a browser hides its 400", async () => {
    const hidden: typeof fetch = (input, init) =>
      (input instanceof Request ? input.url : input.toString()).includes('exchangeInfo?symbol=')
        ? Promise.reject(new TypeError('Failed to fetch'))
        : recordedFetch(input, init)
    expect(await VENUES.binance.fetchMarket('NOTAMARKET' as Base, hidden)).toBeNull()
    expect((await VENUES.binance.fetchMarket(BTC, hidden))?.venueSymbol).toBe('BTCUSDT')
  })

  it('still fails when the whole Binance list does not come either', async () => {
    const down: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'))
    await expect(VENUES.binance.fetchMarket('NOTAMARKET' as Base, down)).rejects.toThrow('Failed to fetch')
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

  it('reads the 24h stats of a HIP-3 market from its own dex', async () => {
    const ctx = (markPx: string) => ({ funding: '0', prevDayPx: markPx, dayNtlVlm: '0', oraclePx: markPx, markPx })
    const tsla = {
      funding: '-0.0000259184',
      prevDayPx: '393.8',
      dayNtlVlm: '40248019.5430800095',
      oraclePx: '399.83',
      markPx: '399.59',
    }
    const dexes: typeof fetch = async (_, init) =>
      (JSON.parse(init?.body as string) as { dex: string }).dex === 'xyz'
        ? Response.json([{ universe: [{ name: 'xyz:NVDA' }, { name: 'xyz:TSLA' }] }, [ctx('180.1'), tsla]])
        : Response.json([{ universe: [{ name: 'BTC' }] }, [ctx('110000')]])
    const stats = await VENUES.hyperliquid.fetchStats('xyz:TSLA' as Base, dexes)
    expect(stats.changePct).toBeCloseTo(1.47029, 5)
    expect(stats).toMatchObject({ volumeQuote: 40248019.54308001, fundingRate: -0.0000259184, indexPrice: 399.83 })
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

  it('reads one market without the list, with the rules the venue recorded for it', async () => {
    for (const base of ['BTC', 'ETH', 'SOL'] as Base[])
      expect(await adapter.fetchMarket(base, recordedFetch)).toMatchObject(RULES_IN_RECORDING[venue](base))
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

// The fields each recorded message in __fixtures__/*.ws.jsonl carries and Tape reads.
const REQUIRED: { venue: VenueId; frame: string[]; at: (string | number)[]; fields: (string | number)[] }[] = [
  { venue: 'binance', frame: ['"e":"depthUpdate"'], at: ['data'], fields: ['E', 'U', 'u', 'b', 'a'] },
  { venue: 'binance', frame: ['"e":"trade"'], at: ['data'], fields: ['t', 'p', 'q', 'T', 'm'] },
  { venue: 'binance', frame: ['"e":"kline"'], at: ['data'], fields: ['k'] },
  { venue: 'binance', frame: ['"e":"kline"'], at: ['data', 'k'], fields: ['t', 'i', 'o', 'h', 'l', 'c', 'v'] },
  { venue: 'hyperliquid', frame: ['"l2Book"', '"levels"'], at: ['data'], fields: ['time', 'levels'] },
  { venue: 'hyperliquid', frame: ['"l2Book"', '"levels"'], at: ['data', 'levels'], fields: [1] },
  { venue: 'hyperliquid', frame: ['"l2Book"', '"levels"'], at: ['data', 'levels', 0, 0], fields: ['px', 'sz'] },
  { venue: 'hyperliquid', frame: ['"channel":"trades"'], at: ['data', 0], fields: ['side', 'px', 'sz', 'time', 'tid'] },
  { venue: 'hyperliquid', frame: ['"channel":"candle"'], at: ['data'], fields: ['t', 'i', 'o', 'c', 'h', 'l', 'v'] },
  { venue: 'dydx', frame: ['"subscribed"', 'v4_orderbook'], at: [], fields: ['contents'] },
  { venue: 'dydx', frame: ['"subscribed"', 'v4_orderbook'], at: ['contents', 'bids', 0], fields: ['price', 'size'] },
  { venue: 'dydx', frame: ['"channel_data"', 'v4_orderbook', '"asks"'], at: [], fields: ['contents'] },
  { venue: 'dydx', frame: ['"channel_data"', 'v4_orderbook', '"asks"'], at: ['contents', 'asks', 0], fields: [1] },
  { venue: 'dydx', frame: ['"subscribed"', 'v4_trades'], at: ['contents'], fields: ['trades'] },
  {
    venue: 'dydx',
    frame: ['"subscribed"', 'v4_trades'],
    at: ['contents', 'trades', 0],
    fields: ['id', 'side', 'size', 'price', 'createdAt'],
  },
  {
    venue: 'dydx',
    frame: ['"subscribed"', 'v4_candles'],
    at: ['contents', 'candles', 0],
    fields: ['startedAt', 'open', 'high', 'low', 'close', 'baseTokenVolume'],
  },
  { venue: 'orderly', frame: ['@orderbook"'], at: [], fields: ['ts'] },
  { venue: 'orderly', frame: ['@orderbook"'], at: ['data'], fields: ['bids', 'asks'] },
  { venue: 'orderly', frame: ['@trade"'], at: ['data'], fields: ['price', 'size', 'side'] },
  {
    venue: 'orderly',
    frame: ['@kline_1m"'],
    at: ['data'],
    fields: ['open', 'close', 'high', 'low', 'volume', 'startTime'],
  },
]

function without(raw: string, at: readonly (string | number)[], field: string | number): string {
  const json = JSON.parse(raw) as Record<string | number, unknown>
  let parent = json
  for (const key of at) parent = parent[key] as typeof json
  if (Array.isArray(parent)) parent.splice(Number(field), 1)
  else Reflect.deleteProperty(parent, field)
  return JSON.stringify(json)
}

describe('a known message missing a field', () => {
  const cases = REQUIRED.flatMap(({ venue, frame, at, fields }) =>
    fields.map((field) => ({
      venue,
      frame,
      at,
      field,
      name: `${venue} ${frame.join(' ')} without ${[...at, field].join('.')}`,
    })),
  )
  it.each(cases)('$name throws a VenueParseError for its market', async ({ venue, frame, at, field }) => {
    const { lookup } = await specsOf(venue)
    const recorded = wsFrames(venue).find((raw) => frame.every((part) => raw.includes(part)))!
    expect(venues(RECORDED_ON)[venue].parse(recorded, lookup)).not.toEqual([])
    let error: unknown
    try {
      venues(RECORDED_ON)[venue].parse(without(recorded, at, field), lookup)
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(VenueParseError)
    expect(error).toMatchObject({ venue, market: marketKey(venue, BTC) })
  })
})
