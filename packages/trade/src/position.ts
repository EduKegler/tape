import { parseQty, toQty } from '@tape/core/fixed'
import type { Px, Qty } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import { capitalized } from './protect'
import { toTick } from './scale-order'
import type { OpenOrder, Position } from './types'

const direction = (position: Pick<Position, 'side'>) => (position.side === 'long' ? 1 : -1)
const held = (position: Pick<Position, 'size'>) => Math.abs(Number(position.size))

/** The leverage number of a position's "20x cross", null where the venue sends none. */
export function leverageOf(position: Pick<Position, 'leverage'>): number | null {
  const match = /^(\d+(?:\.\d+)?)x/.exec(position.leverage ?? '')
  return match ? Number(match[1]) : null
}

/** What closing the whole position at `price` earns, in the quote. */
export const pnlAt = (position: Pick<Position, 'side' | 'size' | 'entry'>, price: number) =>
  (price - Number(position.entry)) * held(position) * direction(position)

/** The margin the position opened with, its notional at entry over the leverage. Null without a leverage. */
export function marginOf(position: Pick<Position, 'size' | 'entry' | 'leverage'>): number | null {
  const leverage = leverageOf(position)
  return leverage ? (held(position) * Number(position.entry)) / leverage : null
}

/** A profit as a percent of the opening margin, as Hyperliquid's returnOnEquity counts it. */
export function roeOf(position: Pick<Position, 'size' | 'entry' | 'leverage'>, pnl: number): number | null {
  const margin = marginOf(position)
  return margin ? (pnl / margin) * 100 : null
}

/**
 * The price at which the position returns `percent` on its opening margin, on the tick on the
 * passive side of the order that closes it. Null without a leverage, or when that price is not
 * above zero.
 */
export function priceForRoe(
  spec: Pick<MarketSpec, 'scale' | 'tick'>,
  position: Pick<Position, 'side' | 'size' | 'entry' | 'leverage'>,
  percent: number,
): Px | null {
  const margin = marginOf(position)
  if (!margin) return null
  const price = Number(position.entry) + ((percent / 100) * margin * direction(position)) / held(position)
  if (price <= 0) return null
  const snapped = toTick(spec, position.side === 'long' ? 'sell' : 'buy', price * 10 ** spec.scale.px)
  return snapped > 0 ? snapped : null
}

/** A stop at or beyond the liquidation price never fires before the venue liquidates. */
export function checkStopLoss(position: Pick<Position, 'side' | 'liquidation'>, price: Px, decimals: number) {
  if (position.liquidation === null) return undefined
  const liquidation = Number(position.liquidation)
  const stop = price / 10 ** decimals
  const past = position.side === 'long' ? stop <= liquidation : stop >= liquidation
  return past ? `Past liquidation at ${position.liquidation}` : undefined
}

/** `percent` of the position, floored to the market's step. 100 is the whole size, on the step or not. */
export function closeShare(
  spec: Pick<MarketSpec, 'scale' | 'step'>,
  position: Pick<Position, 'size'>,
  percent: number,
) {
  const whole = parseQty(position.size.replace(/^-/, ''), spec.scale)
  if (percent >= 100) return whole
  return toQty(Math.floor((whole * percent) / 100 / spec.step) * spec.step)
}

/** What stays open after closing `size`. */
export const keptAfter = (spec: Pick<MarketSpec, 'scale'>, position: Pick<Position, 'size'>, size: Qty) =>
  toQty(Math.max(0, parseQty(position.size.replace(/^-/, ''), spec.scale) - size))

/**
 * An order Tape can move: a take profit or stop loss, through a protect, or a plain resting limit,
 * which every venue replaces in place or cancels and places again.
 */
export const isMovable = (order: Pick<OpenOrder, 'kind' | 'px' | 'exit'>) =>
  order.exit !== null || (order.px !== null && /^(?:limit|post_only)$/i.test(order.kind))

/** A venue's order type in sentence case: "Stop Market" and "STOP_MARKET" both read "Stop market". */
export const orderKindLabel = (kind: string) => capitalized(kind.replaceAll('_', ' ').toLowerCase())
