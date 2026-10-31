import type { Base, Interval, MarketKey, Network } from '@tape/core/ids'
import { isRecord } from '@tape/core/json'
import { isDydxMarkets, readDydxMarket, readDydxMarkets } from './markets'
import { VenueParseError, chartBar, getJson } from './types'
import type { RawCandle, RawLevel, RawTrade, StreamTarget, VenueAdapter, VenueEvent } from './types'
import { isPairs, isText } from './wire'

const RESOLUTION: Record<Interval, string> = { '1m': '1MIN', '5m': '5MINS', '15m': '15MINS', '1h': '1HOUR' }
const INTERVAL_OF = Object.fromEntries(
  Object.entries(RESOLUTION).map(([interval, resolution]) => [resolution, interval]),
) as Record<string, Interval>
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

type WireSnapshotLevel = { price: string; size: string }

const isSnapshotSide = (side: unknown): side is WireSnapshotLevel[] =>
  Array.isArray(side)
  && side.every((level: Partial<WireSnapshotLevel> | null) => isText(level?.price) && isText(level.size))
const isTrade = (wire: unknown): wire is WireTrade =>
  isRecord(wire)
  && (wire.side === 'BUY' || wire.side === 'SELL')
  && [wire.id, wire.size, wire.price, wire.createdAt].every(isText)
const isCandle = (wire: unknown): wire is WireCandle =>
  isRecord(wire) && [wire.startedAt, wire.open, wire.high, wire.low, wire.close, wire.baseTokenVolume].every(isText)
const isCandles = (reply: unknown): reply is { candles: WireCandle[] } =>
  isRecord(reply) && Array.isArray(reply.candles) && reply.candles.every(isCandle)
const isStats = (
  market: unknown,
): market is { oraclePrice: string; priceChange24H: string; volume24H: string; nextFundingRate: string } =>
  isRecord(market)
  && [market.oraclePrice, market.priceChange24H, market.volume24H, market.nextFundingRate].every(isText)

function channelOf(target: StreamTarget): { channel: string; id: string } {
  const ticker = target.spec.venueSymbol
  if (target.channel === 'book') return { channel: 'v4_orderbook', id: ticker }
  if (target.channel === 'trades') return { channel: 'v4_trades', id: ticker }
  return { channel: 'v4_candles', id: `${ticker}/${RESOLUTION[target.interval ?? '1m']}` }
}

const trade = (wire: WireTrade): RawTrade => ({
  id: wire.id,
  px: wire.price,
  qty: wire.size,
  side: wire.side === 'BUY' ? 'buy' : 'sell',
  time: Date.parse(wire.createdAt),
})
const candle = (wire: WireCandle): RawCandle => ({
  open: Date.parse(wire.startedAt),
  o: wire.open,
  h: wire.high,
  l: wire.low,
  c: wire.close,
  v: wire.baseTokenVolume,
})

function events(
  channel: unknown,
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
        const side = (levels: WireSnapshotLevel[]): RawLevel[] =>
          levels.map((level) => [level.price, level.size] as const)
        return [{ kind: 'book-snapshot', market, bids: side(bids), asks: side(asks), time: Date.now() }]
      }
      if (!isPairs(bids) || !isPairs(asks)) return null
      const side = (levels: RawLevel[]): RawLevel[] => levels.map((level) => [level[0], level[1]] as const)
      return [{ kind: 'book-delta', market, bids: side(bids), asks: side(asks), seq: null, time: Date.now() }]
    }
    case 'v4_trades': {
      const { trades } = contents as { trades?: unknown }
      if (!Array.isArray(trades) || !trades.every(isTrade)) return null
      return trades.length ? [{ kind: 'trades', market, trades: trades.map(trade) }] : []
    }
    case 'v4_candles': {
      if (!interval) return []
      const body = contents as { candles?: unknown }
      const list = 'candles' in body ? body.candles : [body]
      if (!Array.isArray(list) || !list.every(isCandle)) return null
      const candles = list.map(candle).sort((left, right) => left.open - right.open)
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
      targets.map((target) => JSON.stringify({ type: 'subscribe', ...channelOf(target), batched: false })),
    unsubscribeFrames: (targets) =>
      targets.map((target) => JSON.stringify({ type: 'unsubscribe', ...channelOf(target) })),

    parse(raw, symbols) {
      const frame: unknown = JSON.parse(raw)
      if (!isRecord(frame)) throw new VenueParseError('dydx', null, raw)
      if (frame.type === 'connected' || frame.type === 'unsubscribed') return []
      if (frame.type === 'error' || !isText(frame.id) || !frame.id) throw new VenueParseError('dydx', null, raw)
      const [ticker, resolution] = frame.id.split('/') as [string, string | undefined]
      const market = symbols(ticker)
      if (!market) return []
      const interval = resolution ? (INTERVAL_OF[resolution] ?? null) : null
      const read = (contents: unknown, snapshot: boolean) => {
        const out = events(frame.channel, market, interval, snapshot, contents)
        if (!out) throw new VenueParseError('dydx', market, raw)
        return out
      }
      if (frame.type !== 'channel_batch_data') return read(frame.contents, frame.type === 'subscribed')
      if (!Array.isArray(frame.contents)) throw new VenueParseError('dydx', market, raw)
      return frame.contents.flatMap((item) => read(item, false))
    },

    async fetchStats(base, fetch, signal) {
      const ticker = tickerOf(base)
      const json = await getJson(fetch, `${indexer}/perpetualMarkets?ticker=${ticker}`, isDydxMarkets, {
        signal: signal ?? null,
      })
      const market = json.markets[ticker]
      if (!market) throw new Error(`no ${ticker} on dydx`)
      if (!isStats(market)) throw new Error(`unreadable ${ticker} stats from dydx`)
      const oracle = Number(market.oraclePrice)
      const change = Number(market.priceChange24H)
      return {
        changePct: (change / (oracle - change)) * 100,
        volumeQuote: Number(market.volume24H),
        fundingRate: Number(market.nextFundingRate),
        indexPrice: oracle,
      }
    },

    async fetchCandles(base, interval, fetch, signal) {
      const url = `${indexer}/candles/perpetualMarkets/${tickerOf(base)}?resolution=${RESOLUTION[interval]}&limit=500`
      const json = await getJson(fetch, url, isCandles, { signal: signal ?? null })
      return json.candles
        .map((wire) =>
          chartBar(Date.parse(wire.startedAt), wire.open, wire.high, wire.low, wire.close, wire.baseTokenVolume),
        )
        .reverse()
    },
  }
}
