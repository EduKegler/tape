import type { Base, Interval, Network } from '@tape/core/ids'
import { parseExactJson } from '@tape/core/json'
import { readOrderlyMarket, readOrderlyMarkets } from './markets'
import { VenueParseError, chartBar, getExactJson } from './types'
import type { RawLevel, StreamTarget, VenueAdapter } from './types'
import { isPairs, isText } from './wire'

const symbolOf = (base: Base) => `PERP_${base}_USDC`
const RESOLUTION: Record<Interval, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60' }
const INTERVAL_MS: Record<Interval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 }
const KLINE: Record<Interval, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h' }
const INTERVAL_OF = Object.fromEntries(Object.entries(KLINE).map(([k, v]) => [v, k])) as Record<string, Interval>

interface WireBook {
  bids: RawLevel[]
  asks: RawLevel[]
}
interface WireTrade {
  price: string
  size: string
  side: 'BUY' | 'SELL'
}
interface WireKline {
  open: string
  close: string
  high: string
  low: string
  volume: string
  startTime: string
}
type Wire =
  | { topic: string; ts: string; data?: Partial<WireBook & WireTrade & WireKline> | null }
  | { event: 'ping' | 'pong' | 'subscribe' | 'unsubscribe'; success?: boolean; topic?: undefined }

const isBook = (d: Partial<WireBook>): d is WireBook => isPairs(d.bids) && isPairs(d.asks)
const isTrade = (d: Partial<WireTrade>): d is WireTrade =>
  isText(d.price) && isText(d.size) && (d.side === 'BUY' || d.side === 'SELL')
const isKline = (d: Partial<WireKline>): d is WireKline =>
  [d.open, d.close, d.high, d.low, d.volume, d.startTime].every(isText)

function topicOf(target: StreamTarget): string {
  const symbol = target.spec.venueSymbol
  if (target.channel === 'book') return `${symbol}@orderbook`
  if (target.channel === 'trades') return `${symbol}@trade`
  return `${symbol}@kline_${KLINE[target.interval ?? '1m']}`
}

const frame = (event: 'subscribe' | 'unsubscribe') => (targets: readonly StreamTarget[]) =>
  targets.map((t) => JSON.stringify({ id: topicOf(t), topic: topicOf(t), event }))

const HOST: Record<Network, { rest: string; ws: string }> = {
  mainnet: { rest: 'api.orderly.org', ws: 'ws-evm.orderly.org' },
  testnet: { rest: 'testnet-api.orderly.org', ws: 'testnet-ws-evm.orderly.org' },
}
const PUBLIC_STREAM_ID = 'OqdphuyCtYWxwzhxyLLjOWNdFP7sQt8RPWzmb5xY'

export function orderly(network: Network): VenueAdapter {
  const rest = `https://${HOST[network].rest}/v1`
  return {
    id: 'orderly',
    label: 'Orderly',
    chain: 'Orderly Network',
    // Public topics need an id in the path but no account behind it.
    url: `wss://${HOST[network].ws}/ws/stream/${PUBLIC_STREAM_ID}`,
    book: { protocol: 'snapshots' },
    keepalive: { everyMs: 10_000, frame: '{"event":"pong"}' },
    silenceMs: 30_000,

    fetchMarkets: (fetch, signal) => readOrderlyMarkets(fetch, rest, signal),
    fetchMarket: (base, fetch, signal) => readOrderlyMarket(fetch, rest, base, signal),

    subscribeFrames: frame('subscribe'),
    unsubscribeFrames: frame('unsubscribe'),

    parse(raw, symbols) {
      const m = parseExactJson<Wire>(raw)
      if ('event' in m) {
        if (m.event === 'subscribe' && m.success === false) throw new VenueParseError('orderly', null, raw)
        return []
      }
      const [symbol = '', stream = ''] = m.topic.split('@')
      const market = symbols(symbol)
      if (!market) return []
      if (!isText(m.ts)) throw new VenueParseError('orderly', market, raw)
      const d = m.data ?? {}
      const time = Number(m.ts)
      if (stream === 'orderbook' && isBook(d))
        return [{ kind: 'book-snapshot', market, bids: d.bids, asks: d.asks, time }]
      if (stream === 'trade' && isTrade(d)) {
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
      if (stream.startsWith('kline_') && isKline(d)) {
        const interval = INTERVAL_OF[stream.slice('kline_'.length)]
        if (!interval) return []
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
        getExactJson<{ data: Futures }>(fetch, `${rest}/public/futures/${symbolOf(base)}`, { signal: signal ?? null }),
        getExactJson<{ data: { funding_period: string } }>(fetch, `${rest}/public/info/${symbolOf(base)}`, {
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
      const url = `${rest}/tv/history?symbol=${symbolOf(base)}&resolution=${RESOLUTION[interval]}&from=${from}&to=${to}`
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
}
