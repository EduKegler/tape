import { BASES, marketKey } from '@tape/core/ids'
import type { Base, Interval, MarketKey } from '@tape/core/ids'
import { decimalsOf, parsePx, parseQty } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import { VenueParseError, chartBar, getJson } from './types'
import type { RawCandle, RawLevel, RawTrade, StreamTarget, VenueAdapter, VenueEvent } from './types'

const INDEXER = 'https://indexer.dydx.trade/v4'
const RESOLUTION: Record<Interval, string> = { '1m': '1MIN', '5m': '5MINS', '15m': '15MINS', '1h': '1HOUR' }
const INTERVAL_OF = Object.fromEntries(Object.entries(RESOLUTION).map(([k, v]) => [v, k])) as Record<string, Interval>
const tickerOf = (base: Base) => `${base}-USD`

interface WireCandle {
  startedAt: string
  open: string
  high: string
  low: string
  close: string
  baseTokenVolume: string
}
interface WireTrade {
  id: string
  side: 'BUY' | 'SELL'
  size: string
  price: string
  createdAt: string
}
interface Wire {
  type: 'connected' | 'subscribed' | 'unsubscribed' | 'channel_data' | 'channel_batch_data' | 'error'
  channel?: 'v4_orderbook' | 'v4_trades' | 'v4_candles'
  id?: string
  contents?: unknown
}

type WireSnapshotLevel = { price: string; size: string }
type WireDeltaLevel = [string, string, ...unknown[]]

function channelOf(target: StreamTarget): { channel: string; id: string } {
  const ticker = target.spec.venueSymbol
  if (target.channel === 'book') return { channel: 'v4_orderbook', id: ticker }
  if (target.channel === 'trades') return { channel: 'v4_trades', id: ticker }
  return { channel: 'v4_candles', id: `${ticker}/${RESOLUTION[target.interval ?? '1m']}` }
}

const trade = (t: WireTrade): RawTrade => ({ id: t.id, px: t.price, qty: t.size, side: t.side === 'BUY' ? 'buy' : 'sell', time: Date.parse(t.createdAt) })
const candle = (c: WireCandle): RawCandle => ({ open: Date.parse(c.startedAt), o: c.open, h: c.high, l: c.low, c: c.close, v: c.baseTokenVolume })

function events(channel: Wire['channel'], market: MarketKey, interval: Interval | null, snapshot: boolean, contents: unknown): VenueEvent[] {
  switch (channel) {
    case 'v4_orderbook': {
      if (snapshot) {
        const c = contents as { bids?: WireSnapshotLevel[]; asks?: WireSnapshotLevel[] }
        const side = (l: WireSnapshotLevel[] = []): RawLevel[] => l.map((x) => [x.price, x.size] as const)
        return [{ kind: 'book-snapshot', market, bids: side(c.bids), asks: side(c.asks), time: Date.now() }]
      }
      const c = contents as { bids?: WireDeltaLevel[]; asks?: WireDeltaLevel[] }
      const side = (l: WireDeltaLevel[] = []): RawLevel[] => l.map((x) => [x[0], x[1]] as const)
      return [{ kind: 'book-delta', market, bids: side(c.bids), asks: side(c.asks), seq: null, time: Date.now() }]
    }
    case 'v4_trades': {
      const trades = ((contents as { trades?: WireTrade[] }).trades ?? []).map(trade)
      return trades.length ? [{ kind: 'trades', market, trades }] : []
    }
    case 'v4_candles': {
      if (!interval) return []
      const c = contents as { candles?: WireCandle[] } & Partial<WireCandle>
      const list = c.candles ?? (c.startedAt ? [c as WireCandle] : [])
      const candles = list.map(candle).sort((a, b) => a.open - b.open)
      return candles.length ? [{ kind: 'candle', market, interval, candles }] : []
    }
    default:
      return []
  }
}

export const dydx: VenueAdapter = {
  id: 'dydx',
  label: 'dYdX',
  chain: 'dYdX Chain',
  url: 'wss://indexer.dydx.trade/v4/ws',
  book: { protocol: 'snapshot-then-deltas' },
  keepalive: null,
  silenceMs: 45_000,

  async fetchSpecs(fetch, signal) {
    const specs = new Map<Base, MarketSpec>()
    await Promise.all(
      BASES.map(async (base) => {
        const ticker = tickerOf(base)
        const json = await getJson<{ markets: Record<string, { tickSize: string; stepSize: string; status: string }> }>(
          fetch, `${INDEXER}/perpetualMarkets?ticker=${ticker}`, { signal: signal ?? null })
        const m = json.markets[ticker]
        if (!m || m.status !== 'ACTIVE') return
        const scale = { px: decimalsOf(m.tickSize), qty: decimalsOf(m.stepSize) }
        specs.set(base, {
          key: marketKey('dydx', base), venue: 'dydx', base, quote: 'USD', kind: 'perp', venueSymbol: ticker,
          scale, tick: { kind: 'fixed', tick: parsePx(m.tickSize, scale) }, step: parseQty(m.stepSize, scale),
        })
      }),
    )
    return specs
  },

  subscribeFrames: (targets) => targets.map((t) => JSON.stringify({ type: 'subscribe', ...channelOf(t), batched: false })),
  unsubscribeFrames: (targets) => targets.map((t) => JSON.stringify({ type: 'unsubscribe', ...channelOf(t) })),

  parse(raw, symbols) {
    const m = JSON.parse(raw) as Wire
    if (m.type === 'connected' || m.type === 'unsubscribed') return []
    if (m.type === 'error' || !m.id) throw new VenueParseError('dydx', null, raw)
    const [ticker, resolution] = m.id.split('/') as [string, string | undefined]
    const market = symbols(ticker)
    if (!market) return []
    const interval = resolution ? (INTERVAL_OF[resolution] ?? null) : null
    if (m.type === 'channel_batch_data') {
      return (m.contents as unknown[]).flatMap((c) => events(m.channel, market, interval, false, c))
    }
    return events(m.channel, market, interval, m.type === 'subscribed', m.contents)
  },

  async fetchStats(base, fetch, signal) {
    type Market = { oraclePrice: string; priceChange24H: string; volume24H: string; nextFundingRate: string }
    const ticker = tickerOf(base)
    const json = await getJson<{ markets: Record<string, Market> }>(fetch, `${INDEXER}/perpetualMarkets?ticker=${ticker}`, { signal: signal ?? null })
    const m = json.markets[ticker]
    if (!m) throw new Error(`no ${ticker} on dydx`)
    const oracle = Number(m.oraclePrice)
    const change = Number(m.priceChange24H)
    return { changePct: (change / (oracle - change)) * 100, volumeQuote: Number(m.volume24H), fundingRate: Number(m.nextFundingRate), indexPrice: oracle }
  },

  async fetchCandles(base, interval, fetch, signal) {
    const url = `${INDEXER}/candles/perpetualMarkets/${tickerOf(base)}?resolution=${RESOLUTION[interval]}&limit=500`
    const json = await getJson<{ candles: WireCandle[] }>(fetch, url, { signal: signal ?? null })
    return json.candles.map((c) => chartBar(Date.parse(c.startedAt), c.open, c.high, c.low, c.close, c.baseTokenVolume)).reverse()
  },
}
