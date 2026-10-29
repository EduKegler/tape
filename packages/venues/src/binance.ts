import { BASES, marketKey } from '@tape/core/ids'
import type { Base, Interval } from '@tape/core/ids'
import { decimalsOf, parsePx, parseQty } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import { VenueParseError, chartBar, getJson } from './types'
import type { RawLevel, StreamTarget, VenueAdapter } from './types'

const REST = 'https://data-api.binance.vision/api/v3'
const symbolOf = (base: Base) => `${base}USDT`

interface Filter {
  filterType: string
  tickSize?: string
  stepSize?: string
}
interface ExchangeInfo {
  symbols: { symbol: string; baseAsset: string; filters: Filter[] }[]
}

type Wire =
  | { e: 'depthUpdate'; E: number; s: string; U: number; u: number; b: RawLevel[]; a: RawLevel[] }
  | { e: 'trade'; s: string; t: number; p: string; q: string; T: number; m: boolean }
  | { e: 'kline'; s: string; k: { t: number; i: string; o: string; h: string; l: string; c: string; v: string } }

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

export const binance: VenueAdapter = {
  id: 'binance',
  label: 'Binance',
  chain: 'Spot',
  url: 'wss://data-stream.binance.vision/ws',
  book: {
    protocol: 'rest-snapshot-sequenced',
    async fetchSnapshot(spec, fetch, signal) {
      const url = `${REST}/depth?symbol=${spec.venueSymbol}&limit=1000`
      return getJson<{ lastUpdateId: number; bids: RawLevel[]; asks: RawLevel[] }>(fetch, url, { signal: signal ?? null })
    },
  },
  keepalive: null,
  silenceMs: 30_000,

  async fetchSpecs(fetch, signal) {
    const symbols = encodeURIComponent(JSON.stringify(BASES.map(symbolOf)))
    const info = await getJson<ExchangeInfo>(fetch, `${REST}/exchangeInfo?symbols=${symbols}`, { signal: signal ?? null })
    const specs = new Map<Base, MarketSpec>()
    for (const base of BASES) {
      const s = info.symbols.find((x) => x.symbol === symbolOf(base))
      const tick = s?.filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize
      const step = s?.filters.find((f) => f.filterType === 'LOT_SIZE')?.stepSize
      if (!s || !tick || !step) continue
      const scale = { px: decimalsOf(tick), qty: decimalsOf(step) }
      specs.set(base, {
        key: marketKey('binance', base), venue: 'binance', base, quote: 'USDT', kind: 'spot', venueSymbol: s.symbol,
        scale, tick: { kind: 'fixed', tick: parsePx(tick, scale) }, step: parseQty(step, scale),
      })
    }
    return specs
  },

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
        return [{ kind: 'book-delta', market, bids: m.b, asks: m.a, seq: { from: m.U, to: m.u }, time: m.E }]
      case 'trade':
        return [{ kind: 'trades', market, trades: [{ id: String(m.t), px: m.p, qty: m.q, side: m.m ? 'sell' : 'buy', time: m.T }] }]
      case 'kline':
        return [{ kind: 'candle', market, interval: m.k.i as Interval, candles: [{ open: m.k.t, o: m.k.o, h: m.k.h, l: m.k.l, c: m.k.c, v: m.k.v }] }]
      default:
        throw new VenueParseError('binance', market, raw)
    }
  },

  async fetchStats(base, fetch, signal) {
    const t = await getJson<{ priceChangePercent: string; quoteVolume: string }>(fetch, `${REST}/ticker/24hr?symbol=${symbolOf(base)}`, { signal: signal ?? null })
    return { changePct: Number(t.priceChangePercent), volumeQuote: Number(t.quoteVolume), fundingRate: null, indexPrice: null }
  },

  async fetchCandles(base, interval, fetch, signal) {
    const url = `${REST}/klines?symbol=${symbolOf(base)}&interval=${interval}&limit=500`
    const rows = await getJson<[number, string, string, string, string, string][]>(fetch, url, { signal: signal ?? null })
    return rows.map(([t, o, h, l, c, v]) => chartBar(t, o, h, l, c, v))
  },
}
