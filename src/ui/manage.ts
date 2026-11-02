import type { MarketSpec } from '@tape/core/market'
import { nearestTick, priceDecimals } from '@tape/trade/position'
import { positionLegs } from '@tape/trade/protect'
import type { Capabilities, OpenOrder, OrderExit, Position } from '@tape/trade/types'
import { useFrame } from '#/client/hooks'
import { groupThousands } from './format'

export type Touch = { readonly bid: number; readonly ask: number; readonly mid: number }

const sameTouch = (left: Touch | null, right: Touch | null) =>
  left?.bid === right?.bid && left?.ask === right?.ask && left?.mid === right?.mid

/** The best bid, best ask and mid of a market, null until its book arrives. */
export function useTouch(spec: Pick<MarketSpec, 'key'>): Touch | null {
  return useFrame(
    { kind: 'book', market: spec.key, group: '' },
    (frame) => {
      const bid = typed(frame?.touch.bid ?? '')
      const ask = typed(frame?.touch.ask ?? '')
      return bid > 0 && ask > 0 ? { bid, ask, mid: (bid + ask) / 2 } : null
    },
    sameTouch,
  )
}

/** A price on the market's tick, as the field holds it: plain, at the tick's decimals. */
export function plainPrice(spec: Pick<MarketSpec, 'scale' | 'tick'>, price: number): string {
  const px = nearestTick(spec, price)
  return (px / 10 ** spec.scale.px).toFixed(priceDecimals(spec, px))
}

/** A price as Tape shows it, grouped and at the decimals its tick leaves. */
export const shownPrice = (spec: Pick<MarketSpec, 'scale' | 'tick'>, price: number) =>
  groupThousands(plainPrice(spec, price).replace(/^-/, ''))

/** A position or order size without its sign, at the decimals the market's step allows. */
export const shownSize = (spec: Pick<MarketSpec, 'scale'>, size: string) =>
  groupThousands(Math.abs(Number(size)).toFixed(spec.scale.qty))

/** What an order closes: a whole-position exit carries no size of its own, so it closes what is held. */
export const ordered = (order: OpenOrder, positions: readonly Position[]) =>
  order.exit?.whole ? (positions.find((held) => held.symbol === order.symbol)?.size ?? order.size) : order.size

/** The resting take profit or stop loss that stands for the position, if any. */
export function armedLeg(
  orders: readonly OpenOrder[],
  symbol: string,
  kind: OrderExit['kind'],
  caps: Pick<Capabilities, 'wholeExits'>,
): OpenOrder | undefined {
  const [ref] = positionLegs(orders, symbol, kind, caps)
  return orders.find((order) => order.ref === ref && order.px !== null)
}

/** A number typed into a field, or NaN for an empty or unreadable one. */
export const typed = (text: string) => (text.trim() === '' ? Number.NaN : Number(text.replaceAll(',', '')))
