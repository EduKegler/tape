import { VENUE_IDS, marketKey, streamKey } from '@tape/core/ids'
import type { Base, Brand, Interval, MarketKey, StreamKey, VenueId } from '@tape/core/ids'

export const BOOK_ROWS = 14

export type Topic =
  | { readonly kind: 'book'; readonly market: MarketKey; readonly group: string }
  | { readonly kind: 'depth'; readonly market: MarketKey }
  | { readonly kind: 'trades'; readonly market: MarketKey }
  | { readonly kind: 'candle'; readonly market: MarketKey; readonly interval: Interval }
  | { readonly kind: 'compare'; readonly base: Base }

type TopicKind = Topic['kind']

export type TopicKey = Brand<string, 'TopicKey'>

function topicText(topic: Topic): string {
  switch (topic.kind) {
    case 'book':
      return `book|${topic.market}|${topic.group}`
    case 'candle':
      return `candle|${topic.market}|${topic.interval}`
    case 'compare':
      return `compare|${topic.base}`
    case 'depth':
    case 'trades':
      return `${topic.kind}|${topic.market}`
  }
}

export function topicKey(topic: Topic): TopicKey {
  return topicText(topic) as TopicKey
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
      return VENUE_IDS.flatMap((venue) => [
        streamKey(marketKey(venue, topic.base), 'book'),
        streamKey(marketKey(venue, topic.base), 'trades'),
      ])
  }
}

export function marketsFor(topic: Topic): readonly MarketKey[] {
  return topic.kind === 'compare' ? VENUE_IDS.map((venue) => marketKey(venue, topic.base)) : [topic.market]
}

export type FrameStatus = 'live' | 'syncing' | 'stale'

interface FrameBase {
  readonly key: TopicKey
  readonly version: number
  readonly status: FrameStatus
}

export interface BookRow {
  readonly px: string
  readonly qty: string
  readonly cum: string
  readonly fill: number
}

export const EMPTY_ROW: BookRow = { px: '', qty: '', cum: '', fill: 0 }

export interface BookFrame extends FrameBase {
  readonly kind: 'book'
  readonly group: string
  readonly groupOptions: readonly string[]
  readonly asks: readonly BookRow[]
  readonly bids: readonly BookRow[]
  readonly touch: { readonly bid: string; readonly ask: string }
  readonly mid: string
  readonly spread: string
  readonly spreadBps: string
}

export interface DepthSide {
  readonly px: Float64Array
  readonly cum: Float64Array
}

export interface DepthFrame extends FrameBase {
  readonly kind: 'depth'
  readonly bids: DepthSide
  readonly asks: DepthSide
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

interface ChartBarFrame {
  readonly time: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface CandleFrame extends FrameBase {
  readonly kind: 'candle'
  readonly bars: readonly ChartBarFrame[]
}

export interface CompareRow {
  readonly venue: VenueId
  readonly status: FrameStatus | 'unlisted'
  readonly bid: string
  readonly ask: string
  readonly mid: string
  readonly spreadBps: string
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

export function deriveStreams(
  wantSets: Iterable<ReadonlyMap<TopicKey, Topic>>,
  lastWanted: ReadonlyMap<StreamKey, number>,
  now: number,
): { readonly streams: ReadonlySet<StreamKey>; readonly lastWanted: ReadonlyMap<StreamKey, number> } {
  const streams = new Set<StreamKey>()
  const next = new Map<StreamKey, number>()
  for (const wants of wantSets)
    for (const topic of wants.values()) for (const stream of streamsFor(topic)) streams.add(stream)
  for (const stream of streams) next.set(stream, now)
  for (const [stream, at] of lastWanted) {
    if (!streams.has(stream) && now - at < LINGER_MS) {
      streams.add(stream)
      next.set(stream, at)
    }
  }
  return { streams, lastWanted: next }
}
