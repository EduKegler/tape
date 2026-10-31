import type { BookProtocol, Seq } from '@tape/core/book'
import type { Base, Interval, MarketKey, StreamChannel, VenueId } from '@tape/core/ids'
import type { MarketGroup, MarketSpec } from '@tape/core/market'
import { parseExactJson } from '@tape/core/json'

export interface VenueAdapter {
  readonly id: VenueId
  readonly label: string
  readonly chain: string
  readonly url: string
  readonly book: BookSource
  /** App-level keepalive (Hyperliquid wants a ping). Protocol pings are the browser's job. */
  readonly keepalive: { readonly everyMs: number; readonly frame: string } | null
  /** No message for this long on an open socket means it is dead. */
  readonly silenceMs: number
  /** Every market the venue lists today, in its own groups and order. */
  fetchMarkets: (fetch: typeof globalThis.fetch, signal?: AbortSignal) => Promise<readonly MarketGroup[]>
  /** One market's rules, read without the venue's whole list, or null when the venue does not list it or Tape leaves it out. */
  fetchMarket: (base: Base, fetch: typeof globalThis.fetch, signal?: AbortSignal) => Promise<MarketSpec | null>
  subscribeFrames: (targets: readonly StreamTarget[]) => readonly string[]
  unsubscribeFrames: (targets: readonly StreamTarget[]) => readonly string[]
  /** One wire message to zero or more events. Acks map to []. Malformed known messages throw VenueParseError. */
  parse: (raw: string, symbols: SymbolLookup) => readonly VenueEvent[]
  /** 24h numbers, display only. */
  fetchStats: (base: Base, fetch: typeof globalThis.fetch, signal?: AbortSignal) => Promise<MarketStats>
  fetchCandles: (
    base: Base,
    interval: Interval,
    fetch: typeof globalThis.fetch,
    signal?: AbortSignal,
  ) => Promise<readonly ChartBar[]>
}

export type BookSource =
  | { readonly protocol: Exclude<BookProtocol, 'rest-snapshot-sequenced'> }
  | {
      readonly protocol: 'rest-snapshot-sequenced'
      fetchSnapshot: (spec: MarketSpec, fetch: typeof globalThis.fetch, signal?: AbortSignal) => Promise<RawSnapshot>
    }

export interface RawSnapshot {
  readonly lastUpdateId: number
  readonly bids: readonly RawLevel[]
  readonly asks: readonly RawLevel[]
}

export interface StreamTarget {
  readonly spec: MarketSpec
  readonly channel: StreamChannel
  readonly interval: Interval | null
}

export type SymbolLookup = (venueSymbol: string) => MarketKey | null

export type RawLevel = readonly [px: string, qty: string]

export interface RawTrade {
  readonly id: string
  readonly px: string
  readonly qty: string
  readonly side: 'buy' | 'sell'
  readonly time: number
}

export interface RawCandle {
  readonly open: number
  readonly o: string
  readonly h: string
  readonly l: string
  readonly c: string
  readonly v: string
}

export type VenueEvent =
  | {
      readonly kind: 'book-snapshot'
      readonly market: MarketKey
      readonly bids: readonly RawLevel[]
      readonly asks: readonly RawLevel[]
      readonly time: number
    }
  | {
      readonly kind: 'book-delta'
      readonly market: MarketKey
      readonly bids: readonly RawLevel[]
      readonly asks: readonly RawLevel[]
      readonly seq: Seq | null
      readonly time: number
    }
  | { readonly kind: 'trades'; readonly market: MarketKey; readonly trades: readonly RawTrade[] }
  | {
      readonly kind: 'candle'
      readonly market: MarketKey
      readonly interval: Interval
      readonly candles: readonly RawCandle[]
    }

/** Header numbers. `fundingRate` is per hour as a fraction, null on spot. */
export interface MarketStats {
  readonly changePct: number
  readonly volumeQuote: number
  readonly fundingRate: number | null
  readonly indexPrice: number | null
}

/** lightweight-charts bar. `time` in UTC seconds. */
export interface ChartBar {
  readonly time: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export class VenueParseError extends Error {
  constructor(
    readonly venue: VenueId,
    readonly market: MarketKey | null,
    raw: string,
  ) {
    super(`unparseable ${venue} message: ${raw.slice(0, 120)}`)
  }
}

/** Tells a venue reply Tape can read as T from one it cannot. */
export type ReplyGuard<T> = (reply: unknown) => reply is T

/** The reply as T, or an Error naming the URL when `isReply` cannot read it. */
export function readReply<T>(url: string, reply: unknown, isReply: ReplyGuard<T>): T {
  if (!isReply(reply)) throw new Error(`unreadable reply from ${url}`)
  return reply
}

/** GETs JSON read by `isReply`. A failed status or a reply it cannot read throws. */
export async function getJson<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  isReply: ReplyGuard<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return readReply(url, await response.json(), isReply)
}

/** As getJson, with every JSON number kept as its source text. */
export async function getExactJson<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  isReply: ReplyGuard<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return readReply(url, parseExactJson(await response.text()), isReply)
}

export function chartBar(
  openTime: number,
  open: string,
  high: string,
  low: string,
  close: string,
  volume: string,
): ChartBar {
  return {
    time: Math.floor(openTime / 1000),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  }
}
