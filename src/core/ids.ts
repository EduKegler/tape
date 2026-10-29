declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]: B }

export const VENUE_IDS = ['binance', 'hyperliquid', 'dydx'] as const
export type VenueId = (typeof VENUE_IDS)[number]

export const BASES = ['BTC', 'ETH', 'SOL'] as const
export type Base = (typeof BASES)[number]

export type MarketKey = Brand<`${VenueId}:${Base}`, 'MarketKey'>

export function marketKey(venue: VenueId, base: Base): MarketKey {
  return `${venue}:${base}` as MarketKey
}

export function isVenueId(value: string): value is VenueId {
  return (VENUE_IDS as readonly string[]).includes(value)
}

export function isBase(value: string): value is Base {
  return (BASES as readonly string[]).includes(value)
}

export function parseMarketKey(venue: string, base: string): MarketKey | null {
  const upper = base.toUpperCase()
  return isVenueId(venue) && isBase(upper) ? marketKey(venue, upper) : null
}

export function splitMarketKey(key: MarketKey): { venue: VenueId; base: Base } {
  const [venue, base] = key.split(':') as [VenueId, Base]
  return { venue, base }
}

export const INTERVALS = ['1m', '5m', '15m', '1h'] as const
export type Interval = (typeof INTERVALS)[number]

export function isInterval(value: string): value is Interval {
  return (INTERVALS as readonly string[]).includes(value)
}

export type TabId = Brand<string, 'TabId'>
export type TopicKey = Brand<string, 'TopicKey'>

export type StreamChannel = 'book' | 'trades' | 'candle'

/** One venue channel for one market: `binance:BTC:book`, `dydx:ETH:candle:1m`. */
export type StreamKey = Brand<string, 'StreamKey'>

export function streamKey(market: MarketKey, channel: StreamChannel, interval?: Interval): StreamKey {
  return (channel === 'candle' ? `${market}:candle:${interval ?? '1m'}` : `${market}:${channel}`) as StreamKey
}

export function parseStreamKey(key: StreamKey): { market: MarketKey; channel: StreamChannel; interval: Interval | null } {
  const [venue, base, channel, interval] = key.split(':') as [VenueId, Base, StreamChannel, Interval | undefined]
  return { market: marketKey(venue, base), channel, interval: interval ?? null }
}
