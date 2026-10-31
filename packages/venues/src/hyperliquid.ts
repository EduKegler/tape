import type { Interval, Network } from '@tape/core/ids'
import { readHyperliquidMarket, readHyperliquidMarkets } from './markets'
import { VenueParseError, chartBar, getJson } from './types'
import type { RawLevel, StreamTarget, VenueAdapter } from './types'

const HOST: Record<Network, string> = { mainnet: 'api.hyperliquid.xyz', testnet: 'api.hyperliquid-testnet.xyz' }
const INTERVAL_MS: Record<Interval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 }

interface WireLevel {
  px: string
  sz: string
}
type Wire =
  | { channel: 'l2Book'; data: { coin: string; time: number; levels: [WireLevel[], WireLevel[]] } }
  | { channel: 'trades'; data: { coin: string; side: 'B' | 'A'; px: string; sz: string; time: number; tid: number }[] }
  | {
      channel: 'candle'
      data: { t: number; s: string; i: Interval; o: string; c: string; h: string; l: string; v: string }
    }
  | { channel: 'subscriptionResponse' | 'pong' | 'error'; data: unknown }

const levels = (side: WireLevel[]): RawLevel[] => side.map((l) => [l.px, l.sz] as const)

function subscription(target: StreamTarget) {
  const coin = target.spec.venueSymbol
  if (target.channel === 'book') return { type: 'l2Book', coin }
  if (target.channel === 'trades') return { type: 'trades', coin }
  return { type: 'candle', coin, interval: target.interval ?? '1m' }
}

const post = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  signal: signal ?? null,
})

export function hyperliquid(network: Network): VenueAdapter {
  const INFO = `https://${HOST[network]}/info`
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

    subscribeFrames: (targets) =>
      targets.map((t) => JSON.stringify({ method: 'subscribe', subscription: subscription(t) })),
    unsubscribeFrames: (targets) =>
      targets.map((t) => JSON.stringify({ method: 'unsubscribe', subscription: subscription(t) })),

    parse(raw, symbols) {
      const m = JSON.parse(raw) as Wire
      switch (m.channel) {
        case 'subscriptionResponse':
        case 'pong':
          return []
        case 'l2Book': {
          const market = symbols(m.data.coin)
          if (!market) return []
          return [
            {
              kind: 'book-snapshot',
              market,
              bids: levels(m.data.levels[0]),
              asks: levels(m.data.levels[1]),
              time: m.data.time,
            },
          ]
        }
        case 'trades': {
          const market = m.data[0] && symbols(m.data[0].coin)
          if (!market) return []
          const trades = m.data.map((t) => ({
            id: String(t.tid),
            px: t.px,
            qty: t.sz,
            side: t.side === 'B' ? ('buy' as const) : ('sell' as const),
            time: t.time,
          }))
          return [{ kind: 'trades', market, trades }]
        }
        case 'candle': {
          const market = symbols(m.data.s)
          if (!market) return []
          const { t, o, h, l, c, v, i } = m.data
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
        post({ type: 'metaAndAssetCtxs' }, signal),
      )
      const ctx = ctxs[meta.universe.findIndex((u) => u.name === base)]
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
      return rows.map((r) => chartBar(r.t, r.o, r.h, r.l, r.c, r.v))
    },
  }
}
