declare const brand: unique symbol
export type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand }

export const VENUE_IDS = ['binance', 'hyperliquid', 'dydx', 'orderly'] as const
export type VenueId = (typeof VENUE_IDS)[number]

export const NETWORKS = ['mainnet', 'testnet'] as const
export type Network = (typeof NETWORKS)[number]

/**
 * A venue's own name for a market, such as `BTC`, `kPEPE` or Hyperliquid's HIP-3 `xyz:TSLA`.
 * Letters, digits and inner hyphens, with an optional `dex:` prefix. Case matters: Hyperliquid
 * lists `kPEPE`, and two HIP-3 dexes can differ only in case.
 */
export type Base = Brand<string, 'Base'>

const BASE = /^(?:[A-Za-z0-9]+:)?[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u
const BASE_MAX = 64

export function isBase(value: string): value is Base {
  return value.length <= BASE_MAX && BASE.test(value)
}

/** Throws TypeError on a name that is not a Base. */
export function toBase(value: string): Base {
  if (!isBase(value)) throw new TypeError(`bad base ${value}`)
  return value
}

export const PINNED_BASES: readonly Base[] = ['BTC', 'ETH', 'SOL'].map(toBase)

export type MarketKey = Brand<`${VenueId}:${string}`, 'MarketKey'>

export function marketKey(venue: VenueId, base: Base): MarketKey {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the one place a MarketKey is made, from a typed venue and base
  return `${venue}:${base}` as MarketKey
}

export function isVenueId(value: string): value is VenueId {
  return (VENUE_IDS as readonly string[]).includes(value)
}

export function parseMarketKey(key: string): MarketKey | null {
  const at = key.indexOf(':')
  const venue = key.slice(0, at)
  const base = key.slice(at + 1)
  return at > 0 && isVenueId(venue) && isBase(base) ? marketKey(venue, base) : null
}

export function splitMarketKey(key: MarketKey): { venue: VenueId; base: Base } {
  const at = key.indexOf(':')
  const venue = key.slice(0, at)
  if (!isVenueId(venue)) throw new TypeError(`bad market key ${key}`)
  return { venue, base: toBase(key.slice(at + 1)) }
}

/** Splits a Hyperliquid HIP-3 name such as `xyz:TSLA` into its dex and symbol. Any other name has dex `''`. */
export function splitBase(base: Base): { dex: string; symbol: string } {
  const at = base.indexOf(':')
  return { dex: base.slice(0, Math.max(0, at)), symbol: base.slice(at + 1) }
}

export const INTERVALS = ['1m', '5m', '15m', '1h'] as const
export type Interval = (typeof INTERVALS)[number]

export function isInterval(value: string): value is Interval {
  return (INTERVALS as readonly string[]).includes(value)
}

/** Throws TypeError on anything but an Interval. */
export function toInterval(value: string): Interval {
  if (!isInterval(value)) throw new TypeError(`bad interval ${value}`)
  return value
}

export type TabId = Brand<string, 'TabId'>

export function isTabId(value: string): value is TabId {
  return value.length > 0
}

/** Throws TypeError on an empty id. */
export function toTabId(value: string): TabId {
  if (!isTabId(value)) throw new TypeError('empty tab id')
  return value
}

export type StreamChannel = 'book' | 'trades' | 'candle'

/** One venue channel for one market: `binance:BTC:book`, `dydx:ETH:candle:1m`, `hyperliquid:xyz:TSLA:trades`. */
export type StreamKey = Brand<string, 'StreamKey'>

export function streamKey(market: MarketKey, channel: StreamChannel, interval?: Interval): StreamKey {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the one place a StreamKey is made, from a typed market, channel and interval
  return (channel === 'candle' ? `${market}:candle:${interval ?? '1m'}` : `${market}:${channel}`) as StreamKey
}

function streamMarket(key: StreamKey, parts: readonly string[]): MarketKey {
  const market = parseMarketKey(parts.join(':'))
  if (!market) throw new TypeError(`bad stream key ${key}`)
  return market
}

export function parseStreamKey(key: StreamKey): {
  market: MarketKey
  channel: StreamChannel
  interval: Interval | null
} {
  const parts = key.split(':')
  const last = parts.pop()!
  if (last === 'book' || last === 'trades') return { market: streamMarket(key, parts), channel: last, interval: null }
  parts.pop()
  return { market: streamMarket(key, parts), channel: 'candle', interval: toInterval(last) }
}
