import { INTERVALS } from '@tape/core/ids'
import type { Base, Interval, Network } from '@tape/core/ids'
import { isRecord, parseExactJson } from '@tape/core/json'
import { readOrderlyMarket, readOrderlyMarkets } from './markets'
import { VenueParseError, chartBar, getExactJson, readReply } from './types'
import type { RawLevel, StreamTarget, VenueAdapter } from './types'
import { isPairs, isText } from './wire'

const symbolOf = (base: Base) => `PERP_${base}_USDC`
const RESOLUTION: Record<Interval, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60' }
const INTERVAL_MS: Record<Interval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 }
const KLINE: Record<Interval, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h' }
const intervalOf = (kline: string) => INTERVALS.find((interval) => KLINE[interval] === kline)

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
type Fields = Record<string, unknown>

const isBook = (book: Fields): book is Fields & WireBook => isPairs(book.bids) && isPairs(book.asks)
const isTrade = (trade: Fields): trade is Fields & WireTrade =>
  isText(trade.price) && isText(trade.size) && (trade.side === 'BUY' || trade.side === 'SELL')
const isKline = (kline: Fields): kline is Fields & WireKline =>
  [kline.open, kline.close, kline.high, kline.low, kline.volume, kline.startTime].every(isText)

interface Futures {
  index_price: string
  est_funding_rate: string
  '24h_open': string
  '24h_close': string
  '24h_amount': string
}
const isFutures = (reply: unknown): reply is { data: Futures } =>
  isRecord(reply)
  && isRecord(reply.data)
  && [
    reply.data.index_price,
    reply.data.est_funding_rate,
    reply.data['24h_open'],
    reply.data['24h_close'],
    reply.data['24h_amount'],
  ].every(isText)
const isFundingPeriod = (reply: unknown): reply is { data: { funding_period: string } } =>
  isRecord(reply) && isRecord(reply.data) && isText(reply.data.funding_period)
const isTexts = (values: unknown): values is string[] => Array.isArray(values) && values.every(isText)
const isBars = (
  reply: unknown,
): reply is { t: string[]; o: string[]; h: string[]; l: string[]; c: string[]; v: string[] } =>
  isRecord(reply) && [reply.t, reply.o, reply.h, reply.l, reply.c, reply.v].every(isTexts)

function topicOf(target: StreamTarget): string {
  const symbol = target.spec.venueSymbol
  if (target.channel === 'book') return `${symbol}@orderbook`
  if (target.channel === 'trades') return `${symbol}@trade`
  return `${symbol}@kline_${KLINE[target.interval ?? '1m']}`
}

const frame = (event: 'subscribe' | 'unsubscribe') => (targets: readonly StreamTarget[]) =>
  targets.map((target) => JSON.stringify({ id: topicOf(target), topic: topicOf(target), event }))

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
      const message = parseExactJson(raw)
      if (!isRecord(message)) throw new VenueParseError('orderly', null, raw)
      if ('event' in message) {
        if (message.event === 'subscribe' && message.success === false) throw new VenueParseError('orderly', null, raw)
        return []
      }
      if (!isText(message.topic)) throw new VenueParseError('orderly', null, raw)
      const [symbol = '', stream = ''] = message.topic.split('@')
      const market = symbols(symbol)
      if (!market) return []
      if (!isText(message.ts)) throw new VenueParseError('orderly', market, raw)
      const data = isRecord(message.data) ? message.data : {}
      const time = Number(message.ts)
      if (stream === 'orderbook' && isBook(data))
        return [{ kind: 'book-snapshot', market, bids: data.bids, asks: data.asks, time }]
      if (stream === 'trade' && isTrade(data)) {
        return [
          {
            kind: 'trades',
            market,
            trades: [
              {
                id: `${message.ts}:${data.price}:${data.size}:${data.side}`,
                px: data.price,
                qty: data.size,
                side: data.side === 'BUY' ? 'buy' : 'sell',
                time,
              },
            ],
          },
        ]
      }
      if (stream.startsWith('kline_') && isKline(data)) {
        const interval = intervalOf(stream.slice('kline_'.length))
        if (!interval) return []
        return [
          {
            kind: 'candle',
            market,
            interval,
            candles: [
              { open: Number(data.startTime), o: data.open, h: data.high, l: data.low, c: data.close, v: data.volume },
            ],
          },
        ]
      }
      throw new VenueParseError('orderly', market, raw)
    },

    async fetchStats(base, fetch, signal) {
      const [futures, info] = await Promise.all([
        getExactJson(fetch, `${rest}/public/futures/${symbolOf(base)}`, isFutures, { signal: signal ?? null }),
        getExactJson(fetch, `${rest}/public/info/${symbolOf(base)}`, isFundingPeriod, { signal: signal ?? null }),
      ])
      const stats = futures.data
      const open = Number(stats['24h_open'])
      return {
        changePct: ((Number(stats['24h_close']) - open) / open) * 100,
        volumeQuote: Number(stats['24h_amount']),
        fundingRate: Number(stats.est_funding_rate) / Number(info.data.funding_period),
        indexPrice: Number(stats.index_price),
      }
    },

    async fetchCandles(base, interval, fetch, signal) {
      const to = Math.floor(Date.now() / 1000)
      const from = to - (500 * INTERVAL_MS[interval]) / 1000
      const url = `${rest}/tv/history?symbol=${symbolOf(base)}&resolution=${RESOLUTION[interval]}&from=${from}&to=${to}`
      const reply = await getExactJson(fetch, url, isRecord, { signal: signal ?? null })
      if (reply.s !== 'ok') return []
      const history = readReply(url, reply, isBars)
      return history.t.map((openTime, index) =>
        chartBar(
          Number(openTime) * 1000,
          history.o[index]!,
          history.h[index]!,
          history.l[index]!,
          history.c[index]!,
          history.v[index]!,
        ),
      )
    },
  }
}
