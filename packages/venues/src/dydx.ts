import type { Base, Interval, MarketKey, Network } from '@tape/core/ids'
import { readDydxMarket, readDydxMarkets } from './markets'
import { VenueParseError, chartBar, getJson } from './types'
import type { RawCandle, RawLevel, RawTrade, StreamTarget, VenueAdapter, VenueEvent } from './types'
import { isPairs, isText } from './wire'

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

const isSnapshotSide = (side: unknown): side is WireSnapshotLevel[] =>
  Array.isArray(side) && side.every((l: Partial<WireSnapshotLevel> | null) => isText(l?.price) && isText(l.size))
const isTrade = (t: Partial<WireTrade> | null): t is WireTrade =>
  (t?.side === 'BUY' || t?.side === 'SELL') && [t.id, t.size, t.price, t.createdAt].every(isText)
const isCandle = (c: Partial<WireCandle> | null): c is WireCandle =>
  [c?.startedAt, c?.open, c?.high, c?.low, c?.close, c?.baseTokenVolume].every(isText)

function channelOf(target: StreamTarget): { channel: string; id: string } {
  const ticker = target.spec.venueSymbol
  if (target.channel === 'book') return { channel: 'v4_orderbook', id: ticker }
  if (target.channel === 'trades') return { channel: 'v4_trades', id: ticker }
  return { channel: 'v4_candles', id: `${ticker}/${RESOLUTION[target.interval ?? '1m']}` }
}

const trade = (t: WireTrade): RawTrade => ({
  id: t.id,
  px: t.price,
  qty: t.size,
  side: t.side === 'BUY' ? 'buy' : 'sell',
  time: Date.parse(t.createdAt),
})
const candle = (c: WireCandle): RawCandle => ({
  open: Date.parse(c.startedAt),
  o: c.open,
  h: c.high,
  l: c.low,
  c: c.close,
  v: c.baseTokenVolume,
})

function events(
  channel: Wire['channel'],
  market: MarketKey,
  interval: Interval | null,
  snapshot: boolean,
  contents: unknown,
): VenueEvent[] | null {
  if (typeof contents !== 'object' || contents === null) return null
  switch (channel) {
    case 'v4_orderbook': {
      const { bids = [], asks = [] } = contents as { bids?: unknown; asks?: unknown }
      if (snapshot) {
        if (!isSnapshotSide(bids) || !isSnapshotSide(asks)) return null
        const side = (l: WireSnapshotLevel[]): RawLevel[] => l.map((x) => [x.price, x.size] as const)
        return [{ kind: 'book-snapshot', market, bids: side(bids), asks: side(asks), time: Date.now() }]
      }
      if (!isPairs(bids) || !isPairs(asks)) return null
      const side = (l: RawLevel[]): RawLevel[] => l.map((x) => [x[0], x[1]] as const)
      return [{ kind: 'book-delta', market, bids: side(bids), asks: side(asks), seq: null, time: Date.now() }]
    }
    case 'v4_trades': {
      const { trades } = contents as { trades?: unknown }
      if (!Array.isArray(trades) || !trades.every(isTrade)) return null
      return trades.length ? [{ kind: 'trades', market, trades: trades.map(trade) }] : []
    }
    case 'v4_candles': {
      if (!interval) return []
      const c = contents as { candles?: unknown }
      const list = 'candles' in c ? c.candles : [c]
      if (!Array.isArray(list) || !list.every(isCandle)) return null
      const candles = list.map(candle).sort((a, b) => a.open - b.open)
      return candles.length ? [{ kind: 'candle', market, interval, candles }] : []
    }
    case undefined:
    default:
      return []
  }
}

const HOST: Record<Network, string> = { mainnet: 'indexer.dydx.trade', testnet: 'indexer.v4testnet.dydx.exchange' }

export function dydx(network: Network): VenueAdapter {
  const indexer = `https://${HOST[network]}/v4`
  return {
    id: 'dydx',
    label: 'dYdX',
    chain: 'dYdX Chain',
    url: `wss://${HOST[network]}/v4/ws`,
    book: { protocol: 'snapshot-then-deltas' },
    keepalive: null,
    silenceMs: 45_000,

    fetchMarkets: (fetch, signal) => readDydxMarkets(fetch, indexer, signal),
    fetchMarket: (base, fetch, signal) => readDydxMarket(fetch, indexer, base, signal),

    subscribeFrames: (targets) =>
      targets.map((t) => JSON.stringify({ type: 'subscribe', ...channelOf(t), batched: false })),
    unsubscribeFrames: (targets) => targets.map((t) => JSON.stringify({ type: 'unsubscribe', ...channelOf(t) })),

    parse(raw, symbols) {
      const m = JSON.parse(raw) as Wire
      if (m.type === 'connected' || m.type === 'unsubscribed') return []
      if (m.type === 'error' || !m.id) throw new VenueParseError('dydx', null, raw)
      const [ticker, resolution] = m.id.split('/') as [string, string | undefined]
      const market = symbols(ticker)
      if (!market) return []
      const interval = resolution ? (INTERVAL_OF[resolution] ?? null) : null
      const read = (contents: unknown, snapshot: boolean) => {
        const out = events(m.channel, market, interval, snapshot, contents)
        if (!out) throw new VenueParseError('dydx', market, raw)
        return out
      }
      if (m.type !== 'channel_batch_data') return read(m.contents, m.type === 'subscribed')
      if (!Array.isArray(m.contents)) throw new VenueParseError('dydx', market, raw)
      return m.contents.flatMap((c) => read(c, false))
    },

    async fetchStats(base, fetch, signal) {
      type Market = { oraclePrice: string; priceChange24H: string; volume24H: string; nextFundingRate: string }
      const ticker = tickerOf(base)
      const json = await getJson<{ markets: Record<string, Market> }>(
        fetch,
        `${indexer}/perpetualMarkets?ticker=${ticker}`,
        { signal: signal ?? null },
      )
      const m = json.markets[ticker]
      if (!m) throw new Error(`no ${ticker} on dydx`)
      const oracle = Number(m.oraclePrice)
      const change = Number(m.priceChange24H)
      return {
        changePct: (change / (oracle - change)) * 100,
        volumeQuote: Number(m.volume24H),
        fundingRate: Number(m.nextFundingRate),
        indexPrice: oracle,
      }
    },

    async fetchCandles(base, interval, fetch, signal) {
      const url = `${indexer}/candles/perpetualMarkets/${tickerOf(base)}?resolution=${RESOLUTION[interval]}&limit=500`
      const json = await getJson<{ candles: WireCandle[] }>(fetch, url, { signal: signal ?? null })
      return json.candles
        .map((c) => chartBar(Date.parse(c.startedAt), c.open, c.high, c.low, c.close, c.baseTokenVolume))
        .reverse()
    },
  }
}
