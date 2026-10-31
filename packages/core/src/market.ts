import { toDecimals, toPx } from './fixed'
import type { Base, Brand, MarketKey, VenueId } from './ids'
import type { Decimals, Px, Qty, Scale } from './fixed'

/**
 * Binance and dYdX publish a fixed tick. Hyperliquid allows 5 significant
 * figures capped at the market's price decimals, so its tick depends on price.
 */
export type TickRule = { readonly kind: 'fixed'; readonly tick: Px } | { readonly kind: 'sigfig'; readonly figures: 5 }

export type Quote = 'USDT' | 'USDC' | 'USD'

export interface MarketSpec {
  readonly key: MarketKey
  readonly venue: VenueId
  readonly base: Base
  readonly quote: Quote
  readonly kind: 'spot' | 'perp'
  readonly venueSymbol: string
  readonly scale: Scale
  readonly tick: TickRule
  readonly step: Qty
  /** The least an order may be worth, in quote units at the price scale. Absent where the venue sets none. */
  readonly minNotional?: Px
}

/** Markets a venue lists under one heading, in the venue's order. `name` is null for the venue's own markets. */
export interface MarketGroup {
  /** The Hyperliquid dex the markets trade on, `''` for the main dex and for every other venue. */
  readonly dex: string
  readonly name: string | null
  readonly markets: readonly MarketSpec[]
}

export function effectiveTick(spec: MarketSpec, ref: Px): Px {
  if (spec.tick.kind === 'fixed') return spec.tick.tick
  if (ref <= 0) return toPx(1)
  const integerDigits = Math.floor(Math.log10(ref / 10 ** spec.scale.px)) + 1
  const exponent = integerDigits - spec.tick.figures
  return toPx(Math.max(1, 10 ** (exponent + spec.scale.px)))
}

/** The step an order price must sit on. Hyperliquid also accepts any whole price, above 5 figures too. */
export function priceTick(spec: MarketSpec, px: Px): Px {
  return toPx(Math.min(effectiveTick(spec, px), 10 ** spec.scale.px))
}

/** A grouping increment in px units, a positive multiple of the effective tick. */
export type GroupStep = Brand<Px, 'GroupStep'>

function isGroupStep(units: Px): units is GroupStep {
  return units > 0
}

function toGroupStep(units: Px): GroupStep {
  if (!isGroupStep(units)) throw new RangeError(`group step ${units} is not positive`)
  return units
}

const MULTIPLES = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000] as const
const OPTION_COUNT = 6

function stepsAt(spec: MarketSpec, mid: Px): GroupStep[] {
  const tick = effectiveTick(spec, mid)
  return MULTIPLES.map((multiple) => toGroupStep(toPx(tick * multiple)))
}

/** The allowed step closest to `requested` (a decimal string from the URL), or the tick when it does not parse. */
export function snapGroup(spec: MarketSpec, mid: Px, requested: string): GroupStep {
  const steps = stepsAt(spec, mid).slice(0, OPTION_COUNT)
  const wanted = Number(requested) * 10 ** spec.scale.px
  return steps.reduce((best, step) => (Math.abs(step - wanted) < Math.abs(best - wanted) ? step : best))
}

export function groupOptions(spec: MarketSpec, mid: Px): readonly GroupStep[] {
  return stepsAt(spec, mid).slice(0, OPTION_COUNT)
}

/** Fraction digits a step needs: 10 shows 0, 0.5 shows 1. */
export function groupDecimals(spec: MarketSpec, step: Px): Decimals {
  let decimals = spec.scale.px as number
  let units = step as number
  while (decimals > 0 && units % 10 === 0) {
    units /= 10
    decimals -= 1
  }
  return toDecimals(decimals)
}

/** `side` is the aggressor, so a Binance m=true trade is a sell. */
export interface Trade {
  readonly id: string
  readonly px: Px
  readonly qty: Qty
  readonly side: 'buy' | 'sell'
  readonly time: number
}

/** `open` is the bar start in ms. */
export interface Candle {
  readonly open: number
  readonly o: Px
  readonly h: Px
  readonly l: Px
  readonly c: Px
  readonly v: Qty
}

export const TRADE_LIMIT = 80

/** Newest first, deduped by id: dYdX's subscribe snapshot overlaps the first updates after a resubscribe. */
export interface TradeTape {
  items: readonly Trade[]
  readonly seen: Set<string>
}

export function emptyTape(): TradeTape {
  return { items: [], seen: new Set() }
}

export function pushTrades(tape: TradeTape, trades: readonly Trade[]): boolean {
  const fresh = trades.filter((trade) => !tape.seen.has(trade.id))
  if (fresh.length === 0) return false
  for (const trade of fresh) tape.seen.add(trade.id)
  const items = [...fresh, ...tape.items].sort((left, right) => right.time - left.time).slice(0, TRADE_LIMIT)
  if (tape.seen.size > TRADE_LIMIT * 4) {
    tape.seen.clear()
    for (const trade of items) tape.seen.add(trade.id)
  }
  tape.items = items
  return true
}

export const CANDLE_LIMIT = 3

/** Keeps the last few bars by open time, replacing the forming bar in place. */
export function upsertCandle(bars: readonly Candle[], bar: Candle): readonly Candle[] {
  const last = bars.at(-1)
  if (last && bar.open < last.open) return bars
  const kept = last?.open === bar.open ? bars.slice(0, -1) : bars
  return [...kept, bar].slice(-CANDLE_LIMIT)
}
