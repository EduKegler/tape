import type { BookProtocol, Seq } from '@tape/core/book'
import type { Base, Interval, MarketKey, StreamChannel, VenueId } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
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
  fetchSpecs: (fetch: typeof globalThis.fetch, signal?: AbortSignal) => Promise<ReadonlyMap<Base, MarketSpec>>
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

export async function getJson<T>(fetch: typeof globalThis.fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return (await response.json()) as T
}

export async function getExactJson<T>(fetch: typeof globalThis.fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return parseExactJson<T>(await response.text())
}

export function chartBar(open: number, o: string, h: string, l: string, c: string, v: string): ChartBar {
  return {
    time: Math.floor(open / 1000),
    open: Number(o),
    high: Number(h),
    low: Number(l),
    close: Number(c),
    volume: Number(v),
  }
}
