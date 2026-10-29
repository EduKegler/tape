import { DecimalError, formatPx, formatQty, parsePx, parseQty } from '#/core/fixed'
import type { Px } from '#/core/fixed'
import type { MarketSpec } from '#/core/market'
import { priceTick } from '#/core/market'

/** Validation is exact: a price must sit on the tick and a size on the step, checked in integers. */
export function checkPrice(spec: MarketSpec, value: string): string | undefined {
  if (!value) return 'Enter a price'
  try {
    const px = parsePx(value, spec.scale)
    if (px <= 0) return 'Price must be above zero'
    const tick = priceTick(spec, px)
    if (px % tick !== 0) return `Price must be a multiple of ${formatPx(tick, spec.scale)}`
  } catch (e) {
    if (e instanceof DecimalError) return e.reason === 'precision' ? `At most ${spec.scale.px} decimals` : 'Not a number'
    throw e
  }
  return undefined
}

export function checkSize(spec: MarketSpec, value: string): string | undefined {
  if (!value) return 'Enter a size'
  try {
    const qty = parseQty(value, spec.scale)
    if (qty < spec.step) return `Minimum is ${formatQty(spec.step, spec.scale)}`
    if (qty % spec.step !== 0) return `Size must be a multiple of ${formatQty(spec.step, spec.scale)}`
  } catch (e) {
    if (e instanceof DecimalError) return e.reason === 'precision' ? `At most ${spec.scale.qty} decimals` : 'Not a number'
    throw e
  }
  return undefined
}

export type Side = 'buy' | 'sell'

/**
 * The limit a taking order carries: the far touch moved by the slippage, then onto the tick on
 * the side that keeps it inside the slippage. All three venues send a market order as an IOC limit.
 */
export function worstPrice(spec: MarketSpec, side: Side, far: Px, slippageBps: number): Px {
  const moved = side === 'buy' ? (far * (10_000 + slippageBps)) / 10_000 : (far * (10_000 - slippageBps)) / 10_000
  const rough = side === 'buy' ? Math.floor(moved) : Math.ceil(moved)
  const tick = priceTick(spec, rough as Px)
  const snapped = side === 'buy' ? Math.floor(rough / tick) * tick : Math.ceil(rough / tick) * tick
  return Math.max(snapped, tick) as Px
}
