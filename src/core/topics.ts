import { VENUE_IDS, marketKey, streamKey } from '@tape/core/ids'
import type { Base, Interval, MarketKey, StreamKey, TopicKey, VenueId } from '@tape/core/ids'

/**
 * A Topic is a view a component wants, not a venue channel. Two tabs on the same view
 * share one TopicKey, so the hub projects it once per flush.
 */
export const BOOK_ROWS = 14

export type Topic =
  | { readonly kind: 'book'; readonly market: MarketKey; readonly group: string }
  | { readonly kind: 'depth'; readonly market: MarketKey }
  | { readonly kind: 'trades'; readonly market: MarketKey }
  | { readonly kind: 'candle'; readonly market: MarketKey; readonly interval: Interval }
  | { readonly kind: 'compare'; readonly base: Base }

type TopicKind = Topic['kind']

export function topicKey(topic: Topic): TopicKey {
  switch (topic.kind) {
    case 'book':
      return `book|${topic.market}|${topic.group}` as TopicKey
    case 'candle':
      return `candle|${topic.market}|${topic.interval}` as TopicKey
    case 'compare':
      return `compare|${topic.base}` as TopicKey
    default:
      return `${topic.kind}|${topic.market}` as TopicKey
  }
}

function streamsFor(topic: Topic): readonly StreamKey[] {
  switch (topic.kind) {
    case 'book':
    case 'depth':
      return [streamKey(topic.market, 'book')]
    case 'trades':
      return [streamKey(topic.market, 'trades')]
    case 'candle':
      return [streamKey(topic.market, 'candle', topic.interval)]
    case 'compare':
      return VENUE_IDS.flatMap((v) => [
        streamKey(marketKey(v, topic.base), 'book'),
        streamKey(marketKey(v, topic.base), 'trades'),
      ])
  }
}

export function marketsFor(topic: Topic): readonly MarketKey[] {
  return topic.kind === 'compare' ? VENUE_IDS.map((v) => marketKey(v, topic.base)) : [topic.market]
}

/** live: in sync. syncing: waiting for rules or a resync, last levels on screen. stale: socket down. */
export type FrameStatus = 'live' | 'syncing' | 'stale'

interface FrameBase {
  readonly key: TopicKey
  readonly version: number
  readonly status: FrameStatus
  /** Venue event time of the newest input, ms. */
  readonly venueTime: number
}

export interface BookRow {
  readonly px: string
  readonly qty: string
  readonly cum: string
  /** cum / max cum over both sides, 0..1. Drives scaleX. */
  readonly fill: number
}

export const EMPTY_ROW: BookRow = { px: '', qty: '', cum: '', fill: 0 }

export interface BookFrame extends FrameBase {
  readonly kind: 'book'
  readonly group: string
  readonly groupOptions: readonly string[]
  /** Exactly BOOK_ROWS each. Asks best LAST so the ladder reads down toward the spread. */
  readonly asks: readonly BookRow[]
  readonly bids: readonly BookRow[]
  /** Exact best bid and ask, never grouped, so the ticket proposes a price that is on the book. */
  readonly bid: string
  readonly ask: string
  readonly mid: string
  readonly spread: string
  readonly spreadBps: string
  readonly uncrossed: number
}

export interface DepthFrame extends FrameBase {
  readonly kind: 'depth'
  /** Interleaved [px, cum, px, cum, ...] from the mid outward, display floats. */
  readonly bids: Float64Array
  readonly asks: Float64Array
  readonly mid: number
}

export interface TradeRow {
  readonly id: string
  readonly px: string
  readonly qty: string
  readonly side: 'buy' | 'sell'
  readonly time: number
}

export interface TradesFrame extends FrameBase {
  readonly kind: 'trades'
  readonly rows: readonly TradeRow[]
  readonly last: string
  readonly lastSide: 'buy' | 'sell' | null
}

export interface ChartBarFrame {
  readonly time: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface CandleFrame extends FrameBase {
  readonly kind: 'candle'
  /** The last few bars, oldest first. series.update() each in order is idempotent. */
  readonly bars: readonly ChartBarFrame[]
}

export interface CompareRow {
  readonly venue: VenueId
  readonly status: FrameStatus
  readonly bid: string
  readonly ask: string
  readonly mid: string
  readonly spreadBps: string
  /** This venue's mid against the median mid across venues, in bps. */
  readonly basisBps: string
  readonly last: string
  readonly bestBid: boolean
  readonly bestAsk: boolean
}

export interface CompareFrame extends FrameBase {
  readonly kind: 'compare'
  readonly rows: readonly CompareRow[]
}

interface FrameByKind {
  book: BookFrame
  depth: DepthFrame
  trades: TradesFrame
  candle: CandleFrame
  compare: CompareFrame
}

export type Frame = FrameByKind[TopicKind]
export type FrameOf<T extends Topic> = FrameByKind[T['kind']]

const LINGER_MS = 10_000

/**
 * Ref counting as a derivation over every live tab's want set. A stream stays up while some tab
 * wants it and for LINGER_MS after the last one lets go, so BTC to ETH to BTC skips a resync.
 * Nobody increments a counter, so a tab that dies without a word cannot leak one.
 */
export function deriveStreams(
  wantSets: Iterable<ReadonlyMap<TopicKey, Topic>>,
  lastWanted: ReadonlyMap<StreamKey, number>,
  now: number,
): { readonly streams: ReadonlySet<StreamKey>; readonly lastWanted: ReadonlyMap<StreamKey, number> } {
  const streams = new Set<StreamKey>()
  const next = new Map<StreamKey, number>()
  for (const wants of wantSets) for (const topic of wants.values()) for (const s of streamsFor(topic)) streams.add(s)
  for (const s of streams) next.set(s, now)
  for (const [s, at] of lastWanted) {
    if (!streams.has(s) && now - at < LINGER_MS) {
      streams.add(s)
      next.set(s, at)
    }
  }
  return { streams, lastWanted: next }
}
