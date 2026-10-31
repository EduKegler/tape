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

const isKline = (k: Partial<WireKline> | undefined): k is WireKline =>
  isNumber(k?.t) && [k.i, k.o, k.h, k.l, k.c, k.v].every(isText)

function streamName(target: StreamTarget): string {
  const s = target.spec.venueSymbol.toLowerCase()
  if (target.channel === 'book') return `${s}@depth@100ms`
  if (target.channel === 'trades') return `${s}@trade`
  return `${s}@kline_${target.interval ?? '1m'}`
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
      const m = (json.data ?? json) as Wire
      const market = symbols(m.s)
      if (!market) return []
      switch (m.e) {
        case 'depthUpdate':
          if (!isPairs(m.b) || !isPairs(m.a) || !isNumber(m.U) || !isNumber(m.u) || !isNumber(m.E)) break
          return [{ kind: 'book-delta', market, bids: m.b, asks: m.a, seq: { from: m.U, to: m.u }, time: m.E }]
        case 'trade':
          if (!isNumber(m.t) || !isText(m.p) || !isText(m.q) || typeof m.m !== 'boolean' || !isNumber(m.T)) break
          return [
            {
              kind: 'trades',
              market,
              trades: [{ id: String(m.t), px: m.p, qty: m.q, side: m.m ? 'sell' : 'buy', time: m.T }],
            },
          ]
        case 'kline':
          if (!isKline(m.k)) break
          return [
            {
              kind: 'candle',
              market,
              interval: m.k.i as Interval,
              candles: [{ open: m.k.t, o: m.k.o, h: m.k.h, l: m.k.l, c: m.k.c, v: m.k.v }],
            },
          ]
      }
      throw new VenueParseError('binance', market, raw)
    },

    async fetchStats(base, fetch, signal) {
      const t = await getJson<{ priceChangePercent: string; quoteVolume: string }>(
        fetch,
        `${rest}/ticker/24hr?symbol=${symbolOf(base)}`,
        { signal: signal ?? null },
      )
      return {
        changePct: Number(t.priceChangePercent),
        volumeQuote: Number(t.quoteVolume),
        fundingRate: null,
        indexPrice: null,
      }
    },

    async fetchCandles(base, interval, fetch, signal) {
      const url = `${rest}/klines?symbol=${symbolOf(base)}&interval=${interval}&limit=500`
      const rows = await getJson<[number, string, string, string, string, string][]>(fetch, url, {
        signal: signal ?? null,
      })
      return rows.map(([t, o, h, l, c, v]) => chartBar(t, o, h, l, c, v))
    },
  }
}
