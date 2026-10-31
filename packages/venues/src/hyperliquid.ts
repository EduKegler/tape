import { splitBase } from '@tape/core/ids'
import type { Interval, Network } from '@tape/core/ids'
import { readHyperliquidMarket, readHyperliquidMarkets } from './markets'
import { VenueParseError, chartBar, getJson } from './types'
import type { RawLevel, StreamTarget, VenueAdapter } from './types'
import { isNumber, isText } from './wire'

const HOST: Record<Network, string> = { mainnet: 'api.hyperliquid.xyz', testnet: 'api.hyperliquid-testnet.xyz' }
const INTERVAL_MS: Record<Interval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 }

interface WireLevel {
  px: string
  sz: string
}
interface WireBook {
  coin: string
  time: number
  levels: [WireLevel[], WireLevel[]]
  fast?: true
}
interface WireTrade {
  coin: string
  side: 'B' | 'A'
  px: string
  sz: string
  time: number
  tid: number
}
interface WireCandle {
  t: number
  s: string
  i: Interval
  o: string
  c: string
  h: string
  l: string
  v: string
}
type Wire =
  | { channel: 'l2Book'; data: WireBook }
  | { channel: 'trades'; data: WireTrade[] }
  | { channel: 'candle'; data: WireCandle }
  | { channel: 'subscriptionResponse' | 'pong' | 'error'; data: unknown }

const isSide = (side: unknown): side is WireLevel[] =>
  Array.isArray(side) && side.every((level: Partial<WireLevel> | null) => isText(level?.px) && isText(level.sz))
const isBook = (book: Partial<WireBook>) =>
  isNumber(book.time) && Array.isArray(book.levels) && isSide(book.levels[0]) && isSide(book.levels[1])
const isTrade = (trade: Partial<WireTrade>) =>
  (trade.side === 'B' || trade.side === 'A')
  && isText(trade.px)
  && isText(trade.sz)
  && isNumber(trade.time)
  && isNumber(trade.tid)
const isCandle = (candle: Partial<WireCandle>) =>
  isNumber(candle.t) && [candle.i, candle.o, candle.c, candle.h, candle.l, candle.v].every(isText)

const levels = (side: WireLevel[]): RawLevel[] => side.map((level) => [level.px, level.sz] as const)

function layOver(snapshot: WireLevel[], fast: WireLevel[], beyond: (px: number, edge: number) => boolean) {
  const edge = fast.at(-1)
  return edge ? [...fast, ...snapshot.filter((level) => beyond(Number(level.px), Number(edge.px)))] : fast
}

function withFastTop(snapshot: WireBook, fast: WireBook | null): WireBook {
  if (!fast || fast.time < snapshot.time) return snapshot
  return {
    ...fast,
    levels: [
      layOver(snapshot.levels[0], fast.levels[0], (px, edge) => px < edge),
      layOver(snapshot.levels[1], fast.levels[1], (px, edge) => px > edge),
    ],
  }
}

// Hyperliquid sends the plain l2Book, 20 levels a side, about every 5 s, and the fast one, 5 levels a side, about every 0.5 s.
function subscriptions(target: StreamTarget) {
  const coin = target.spec.venueSymbol
  if (target.channel === 'book')
    return [
      { type: 'l2Book', coin },
      { type: 'l2Book', coin, fast: true },
    ]
  if (target.channel === 'trades') return [{ type: 'trades', coin }]
  return [{ type: 'candle', coin, interval: target.interval ?? '1m' }]
}

const post = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  signal: signal ?? null,
})

export function hyperliquid(network: Network): VenueAdapter {
  const INFO = `https://${HOST[network]}/info`
  const books = new Map<string, { snapshot: WireBook; fast: WireBook | null }>()

  function frames(method: 'subscribe' | 'unsubscribe', targets: readonly StreamTarget[]) {
    for (const target of targets) if (target.channel === 'book') books.delete(target.spec.venueSymbol)
    return targets.flatMap(subscriptions).map((subscription) => JSON.stringify({ method, subscription }))
  }

  function follow(frame: WireBook): WireBook | null {
    const held = books.get(frame.coin)
    if (!frame.fast) {
      const fast = held?.fast ?? null
      books.set(frame.coin, { snapshot: frame, fast })
      return withFastTop(frame, fast)
    }
    if (!held || frame.time < held.snapshot.time) return null
    books.set(frame.coin, { snapshot: held.snapshot, fast: frame })
    return withFastTop(held.snapshot, frame)
  }

  return {
    id: 'hyperliquid',
    label: 'Hyperliquid',
    chain: 'Hyperliquid L1',
    url: `wss://${HOST[network]}/ws`,
    book: { protocol: 'snapshots' },
    keepalive: { everyMs: 30_000, frame: '{"method":"ping"}' },
    silenceMs: 60_000,

    fetchMarkets: (fetch, signal) => readHyperliquidMarkets(fetch, INFO, signal),
    fetchMarket: (base, fetch, signal) => readHyperliquidMarket(fetch, INFO, base, signal),

    subscribeFrames: (targets) => frames('subscribe', targets),
    unsubscribeFrames: (targets) => frames('unsubscribe', targets),

    parse(raw, symbols) {
      const frame = JSON.parse(raw) as Wire
      switch (frame.channel) {
        case 'subscriptionResponse':
        case 'pong':
          return []
        case 'l2Book': {
          const market = symbols(frame.data.coin)
          if (!market) return []
          if (!isBook(frame.data)) throw new VenueParseError('hyperliquid', market, raw)
          const shown = follow(frame.data)
          if (!shown) return []
          return [
            {
              kind: 'book-snapshot',
              market,
              bids: levels(shown.levels[0]),
              asks: levels(shown.levels[1]),
              time: shown.time,
            },
          ]
        }
        case 'trades': {
          const market = frame.data[0] && symbols(frame.data[0].coin)
          if (!market) return []
          if (!frame.data.every(isTrade)) throw new VenueParseError('hyperliquid', market, raw)
          const trades = frame.data.map((trade) => ({
            id: String(trade.tid),
            px: trade.px,
            qty: trade.sz,
            side: trade.side === 'B' ? ('buy' as const) : ('sell' as const),
            time: trade.time,
          }))
          return [{ kind: 'trades', market, trades }]
        }
        case 'candle': {
          const market = symbols(frame.data.s)
          if (!market) return []
          if (!isCandle(frame.data)) throw new VenueParseError('hyperliquid', market, raw)
          const { t, o, h, l, c, v, i } = frame.data
          return [{ kind: 'candle', market, interval: i, candles: [{ open: t, o, h, l, c, v }] }]
        }
        case 'error':
        default:
          throw new VenueParseError('hyperliquid', null, raw)
      }
    },

    async fetchStats(base, fetch, signal) {
      type Ctx = { funding: string; prevDayPx: string; dayNtlVlm: string; oraclePx: string; markPx: string }
      const [meta, ctxs] = await getJson<[{ universe: { name: string }[] }, Ctx[]]>(
        fetch,
        INFO,
        post({ type: 'metaAndAssetCtxs', dex: splitBase(base).dex }, signal),
      )
      const ctx = ctxs[meta.universe.findIndex((asset) => asset.name === base)]
      if (!ctx) throw new Error(`no ${base} on hyperliquid`)
      const prev = Number(ctx.prevDayPx)
      return {
        changePct: ((Number(ctx.markPx) - prev) / prev) * 100,
        volumeQuote: Number(ctx.dayNtlVlm),
        fundingRate: Number(ctx.funding),
        indexPrice: Number(ctx.oraclePx),
      }
    },

    async fetchCandles(base, interval, fetch, signal) {
      const endTime = Date.now()
      const req = { coin: base, interval, startTime: endTime - 500 * INTERVAL_MS[interval], endTime }
      const rows = await getJson<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>(
        fetch,
        INFO,
        post({ type: 'candleSnapshot', req }, signal),
      )
      return rows.map((row) => chartBar(row.t, row.o, row.h, row.l, row.c, row.v))
    },
  }
}
