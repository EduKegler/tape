import type { Base, Interval, Network } from '@tape/core/ids'
import { readBinanceMarket, readBinanceMarkets } from './markets'
import { VenueParseError, chartBar, getJson } from './types'
import type { RawLevel, StreamTarget, VenueAdapter } from './types'
import { isNumber, isPairs, isText } from './wire'

const symbolOf = (base: Base) => `${base}USDT`

interface WireKline {
  t: number
  i: string
  o: string
  h: string
  l: string
  c: string
  v: string
}
type Wire =
  | { e: 'depthUpdate'; E: number; s: string; U: number; u: number; b: RawLevel[]; a: RawLevel[] }
  | { e: 'trade'; s: string; t: number; p: string; q: string; T: number; m: boolean }
  | { e: 'kline'; s: string; k: WireKline }

const isKline = (kline: Partial<WireKline> | undefined): kline is WireKline =>
  isNumber(kline?.t) && [kline.i, kline.o, kline.h, kline.l, kline.c, kline.v].every(isText)

function streamName(target: StreamTarget): string {
  const symbol = target.spec.venueSymbol.toLowerCase()
  if (target.channel === 'book') return `${symbol}@depth@100ms`
  if (target.channel === 'trades') return `${symbol}@trade`
  return `${symbol}@kline_${target.interval ?? '1m'}`
}

let requestId = 0
function control(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', targets: readonly StreamTarget[]): string[] {
  if (targets.length === 0) return []
  return [JSON.stringify({ method, params: targets.map(streamName), id: ++requestId })]
}

const HOST: Record<Network, { rest: string; ws: string }> = {
  mainnet: { rest: 'data-api.binance.vision', ws: 'data-stream.binance.vision' },
  testnet: { rest: 'testnet.binance.vision', ws: 'stream.testnet.binance.vision' },
}

export function binance(network: Network): VenueAdapter {
  const rest = `https://${HOST[network].rest}/api/v3`
  return {
    id: 'binance',
    label: 'Binance',
    chain: 'Spot',
    url: `wss://${HOST[network].ws}/ws`,
    book: {
      protocol: 'rest-snapshot-sequenced',
      async fetchSnapshot(spec, fetch, signal) {
        const url = `${rest}/depth?symbol=${spec.venueSymbol}&limit=1000`
        return getJson<{ lastUpdateId: number; bids: RawLevel[]; asks: RawLevel[] }>(fetch, url, {
          signal: signal ?? null,
        })
      },
    },
    keepalive: null,
    silenceMs: 30_000,

    fetchMarkets: (fetch, signal) => readBinanceMarkets(fetch, rest, signal),
    fetchMarket: (base, fetch, signal) => readBinanceMarket(fetch, rest, base, signal),

    subscribeFrames: (targets) => control('SUBSCRIBE', targets),
    unsubscribeFrames: (targets) => control('UNSUBSCRIBE', targets),

    parse(raw, symbols) {
      const json = JSON.parse(raw) as { data?: Wire; result?: unknown } & Partial<Wire>
      if ('result' in json) return []
      const frame = (json.data ?? json) as Wire
      const market = symbols(frame.s)
      if (!market) return []
      switch (frame.e) {
        case 'depthUpdate':
          if (!isPairs(frame.b) || !isPairs(frame.a) || !isNumber(frame.U) || !isNumber(frame.u) || !isNumber(frame.E))
            break
          return [
            {
              kind: 'book-delta',
              market,
              bids: frame.b,
              asks: frame.a,
              seq: { from: frame.U, to: frame.u },
              time: frame.E,
            },
          ]
        case 'trade':
          if (
            !isNumber(frame.t)
            || !isText(frame.p)
            || !isText(frame.q)
            || typeof frame.m !== 'boolean'
            || !isNumber(frame.T)
          )
            break
          return [
            {
              kind: 'trades',
              market,
              trades: [
                { id: String(frame.t), px: frame.p, qty: frame.q, side: frame.m ? 'sell' : 'buy', time: frame.T },
              ],
            },
          ]
        case 'kline':
          if (!isKline(frame.k)) break
          return [
            {
              kind: 'candle',
              market,
              interval: frame.k.i as Interval,
              candles: [{ open: frame.k.t, o: frame.k.o, h: frame.k.h, l: frame.k.l, c: frame.k.c, v: frame.k.v }],
            },
          ]
      }
      throw new VenueParseError('binance', market, raw)
    },

    async fetchStats(base, fetch, signal) {
      const ticker = await getJson<{ priceChangePercent: string; quoteVolume: string }>(
        fetch,
        `${rest}/ticker/24hr?symbol=${symbolOf(base)}`,
        { signal: signal ?? null },
      )
      return {
        changePct: Number(ticker.priceChangePercent),
        volumeQuote: Number(ticker.quoteVolume),
        fundingRate: null,
        indexPrice: null,
      }
    },

    async fetchCandles(base, interval, fetch, signal) {
      const url = `${rest}/klines?symbol=${symbolOf(base)}&interval=${interval}&limit=500`
      const rows = await getJson<[number, string, string, string, string, string][]>(fetch, url, {
        signal: signal ?? null,
      })
      return rows.map(([openTime, open, high, low, close, volume]) =>
        chartBar(openTime, open, high, low, close, volume),
      )
    },
  }
}
