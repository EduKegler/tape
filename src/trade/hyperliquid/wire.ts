import type { Address, Hex } from 'viem'

/**
 * Hyperliquid hashes the msgpack of the action, so key order is part of the signature. Every
 * builder here writes keys in the order the Python SDK does.
 */

export type Tif = 'Gtc' | 'Ioc' | 'Alo'
export type OrderType = { readonly limit: { readonly tif: Tif } } | { readonly trigger: { readonly isMarket: boolean; readonly triggerPx: string; readonly tpsl: 'tp' | 'sl' } }

export interface OrderWire {
  readonly a: number
  readonly b: boolean
  readonly p: string
  readonly s: string
  readonly r: boolean
  readonly t: OrderType
  readonly c?: Hex
}

/** `f` is the fee in tenths of a basis point. */
export interface Builder {
  readonly b: Address
  readonly f: number
}

export function orderWire(asset: number, isBuy: boolean, px: string, sz: string, reduceOnly: boolean, type: OrderType, cloid?: Hex): OrderWire {
  const t = 'limit' in type ? { limit: { tif: type.limit.tif } } : { trigger: { isMarket: type.trigger.isMarket, triggerPx: type.trigger.triggerPx, tpsl: type.trigger.tpsl } }
  return { a: asset, b: isBuy, p: px, s: sz, r: reduceOnly, t, ...(cloid ? { c: cloid } : {}) }
}

export function orderAction(orders: readonly OrderWire[], grouping: 'na' | 'normalTpsl' | 'positionTpsl', builder: Builder | null) {
  return { type: 'order', orders, grouping, ...(builder ? { builder: { b: builder.b.toLowerCase(), f: builder.f } } : {}) }
}

export function cancelAction(cancels: readonly { readonly asset: number; readonly oid: number }[]) {
  return { type: 'cancel', cancels: cancels.map((c) => ({ a: c.asset, o: c.oid })) }
}

export function leverageAction(asset: number, isCross: boolean, leverage: number) {
  return { type: 'updateLeverage', asset, isCross, leverage }
}
