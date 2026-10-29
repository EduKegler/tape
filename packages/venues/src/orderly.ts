import { BASES, marketKey } from '@tape/core/ids'
import type { Base, Interval } from '@tape/core/ids'
import { decimalsOf, parsePx, parseQty } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import { parseExactJson } from '@tape/core/json'
import { VenueParseError, chartBar, getExactJson } from './types'
import type { RawLevel, StreamTarget, VenueAdapter } from './types'

const REST = 'https://api.orderly.org/v1'
const symbolOf = (base: Base) => `PERP_${base}_USDC`
const RESOLUTION: Record<Interval, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60' }
const INTERVAL_MS: Record<Interval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 }
const KLINE: Record<Interval, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h' }
const INTERVAL_OF = Object.fromEntries(Object.entries(KLINE).map(([k, v]) => [v, k])) as Record<string, Interval>

type Wire =
  | { topic: string; ts: string; data: { symbol: string; bids: RawLevel[]; asks: RawLevel[] } }
  | { topic: string; ts: string; data: { symbol: string; price: string; size: string; side: 'BUY' | 'SELL' } }
  | {
      topic: string
      ts: string
      data: {
        symbol: string
        type: string
        open: string
        close: string
        high: string
        low: string
        volume: string
        startTime: string
      }
    }
  | { event: 'ping' | 'pong' | 'subscribe' | 'unsubscribe'; success?: boolean; topic?: undefined }

function topicOf(target: StreamTarget): string {
  const symbol = target.spec.venueSymbol
  if (target.channel === 'book') return `${symbol}@orderbook`
  if (target.channel === 'trades') return `${symbol}@trade`
  return `${symbol}@kline_${KLINE[target.interval ?? '1m']}`
}

const frame = (event: 'subscribe' | 'unsubscribe') => (targets: readonly StreamTarget[]) =>
  targets.map((t) => JSON.stringify({ id: topicOf(t), topic: topicOf(t), event }))

export const orderly: VenueAdapter = {
  id: 'orderly',
  label: 'Orderly',
  chain: 'Orderly Network',
  // Public topics need an id in the path but no account behind it.
  url: 'wss://ws-evm.orderly.org/ws/stream/OqdphuyCtYWxwzhxyLLjOWNdFP7sQt8RPWzmb5xY',
  book: { protocol: 'snapshots' },
  keepalive: { everyMs: 10_000, frame: '{"event":"pong"}' },
  silenceMs: 30_000,

  async fetchSpecs(fetch, signal) {
    const specs = new Map<Base, MarketSpec>()
    await Promise.all(
      BASES.map(async (base) => {
        const json = await getExactJson<{ data?: { quote_tick: string; base_tick: string; status: string } }>(
          fetch,
          `${REST}/public/info/${symbolOf(base)}`,
          { signal: signal ?? null },
        )
        const m = json.data
        if (!m || m.status !== 'ACTIVE') return
        const scale = { px: decimalsOf(m.quote_tick), qty: decimalsOf(m.base_tick) }
        specs.set(base, {
          key: marketKey('orderly', base),
          venue: 'orderly',
          base,
          quote: 'USDC',
          kind: 'perp',
          venueSymbol: symbolOf(base),
          scale,
          tick: { kind: 'fixed', tick: parsePx(m.quote_tick, scale) },
          step: parseQty(m.base_tick, scale),
        })
      }),
    )
    return specs
  },

  subscribeFrames: frame('subscribe'),
  unsubscribeFrames: frame('unsubscribe'),

  parse(raw, symbols) {
    const m = parseExactJson<Wire>(raw)
    if ('event' in m) {
      if (m.event === 'subscribe' && m.success === false) throw new VenueParseError('orderly', null, raw)
      return []
    }
    const [symbol, stream] = m.topic.split('@') as [string, string]
    const market = symbols(symbol)
    if (!market) return []
    const time = Number(m.ts)
    if (stream === 'orderbook' && 'bids' in m.data)
      return [{ kind: 'book-snapshot', market, bids: m.data.bids, asks: m.data.asks, time }]
    if (stream === 'trade' && 'price' in m.data) {
      const d = m.data
      return [
        {
          kind: 'trades',
          market,
          trades: [
            {
              id: `${m.ts}:${d.price}:${d.size}:${d.side}`,
              px: d.price,
              qty: d.size,
              side: d.side === 'BUY' ? 'buy' : 'sell',
              time,
            },
          ],
        },
      ]
    }
    if (stream.startsWith('kline_') && 'open' in m.data) {
      const interval = INTERVAL_OF[stream.slice('kline_'.length)]
      if (!interval) return []
      const d = m.data
      return [
        {
          kind: 'candle',
          market,
          interval,
          candles: [{ open: Number(d.startTime), o: d.open, h: d.high, l: d.low, c: d.close, v: d.volume }],
        },
      ]
    }
    throw new VenueParseError('orderly', market, raw)
  },

  async fetchStats(base, fetch, signal) {
    type Futures = {
      index_price: string
      est_funding_rate: string
      '24h_open': string
      '24h_close': string
      '24h_amount': string
    }
    const [futures, info] = await Promise.all([
      getExactJson<{ data: Futures }>(fetch, `${REST}/public/futures/${symbolOf(base)}`, { signal: signal ?? null }),
      getExactJson<{ data: { funding_period: string } }>(fetch, `${REST}/public/info/${symbolOf(base)}`, {
        signal: signal ?? null,
      }),
    ])
    const d = futures.data
    const open = Number(d['24h_open'])
    return {
      changePct: ((Number(d['24h_close']) - open) / open) * 100,
      volumeQuote: Number(d['24h_amount']),
      fundingRate: Number(d.est_funding_rate) / Number(info.data.funding_period),
      indexPrice: Number(d.index_price),
    }
  },

  async fetchCandles(base, interval, fetch, signal) {
    const to = Math.floor(Date.now() / 1000)
    const from = to - (500 * INTERVAL_MS[interval]) / 1000
    const url = `${REST}/tv/history?symbol=${symbolOf(base)}&resolution=${RESOLUTION[interval]}&from=${from}&to=${to}`
    const h = await getExactJson<{
      s: string
      t: string[]
      o: string[]
      h: string[]
      l: string[]
      c: string[]
      v: string[]
    }>(fetch, url, { signal: signal ?? null })
    if (h.s !== 'ok') return []
    return h.t.map((t, i) => chartBar(Number(t) * 1000, h.o[i]!, h.h[i]!, h.l[i]!, h.c[i]!, h.v[i]!))
  },
}
