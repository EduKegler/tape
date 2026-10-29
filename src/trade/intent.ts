import { DecimalError, formatPx, formatQty, parsePx, parseQty } from '#/core/fixed'
import type { Px } from '#/core/fixed'
import type { MarketSpec } from '#/core/market'
import { priceTick } from '#/core/market'
import { bytesToHex } from 'viem'
import type { Bps, Capabilities, ClientOrderId, OrderIntent, Position, Side, Tif } from './types'

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

export interface IntentDraft {
  readonly side: Side
  readonly kind: 'limit' | 'market'
  readonly price: string
  readonly size: string
  readonly tif: Tif
  readonly reduceOnly: boolean
  readonly takeProfit: string
  readonly stopLoss: string
  readonly slippage: Bps
}

export type DraftField = 'price' | 'size' | 'tif' | 'takeProfit' | 'stopLoss'
export type Built = { readonly ok: true; readonly intent: OrderIntent } | { readonly ok: false; readonly errors: Partial<Record<DraftField, string>> }

/** The only door to an OrderIntent. Every check is integer math on Px and Qty. */
export function buildIntent(spec: MarketSpec, draft: IntentDraft, caps: Capabilities): Built {
  const errors: Partial<Record<DraftField, string>> = {}
  const size = checkSize(spec, draft.size)
  if (size) errors.size = size
  if (draft.kind === 'limit') {
    const price = checkPrice(spec, draft.price)
    if (price) errors.price = price
    if (!caps.tif.includes(draft.tif)) errors.tif = 'Not offered on this venue'
  }
  const trigger = (field: 'takeProfit' | 'stopLoss', value: string): Px | null => {
    if (!value) return null
    // A market order has no price to check the trigger side against, so a stray TP could fire at once.
    if (draft.kind === 'market') {
      errors[field] = 'Only with a limit order'
      return null
    }
    if (!caps.triggers) {
      errors[field] = 'Not offered on this venue'
      return null
    }
    const issue = checkPrice(spec, value)
    if (issue) {
      errors[field] = issue
      return null
    }
    return parsePx(value, spec.scale)
  }
  const takeProfit = trigger('takeProfit', draft.takeProfit)
  const stopLoss = trigger('stopLoss', draft.stopLoss)
  if (draft.kind === 'limit' && !errors.price) {
    const px = parsePx(draft.price, spec.scale)
    const above = draft.side === 'buy'
    if (takeProfit !== null && (above ? takeProfit <= px : takeProfit >= px)) errors.takeProfit = `Must be ${above ? 'above' : 'below'} the price`
    if (stopLoss !== null && (above ? stopLoss >= px : stopLoss <= px)) errors.stopLoss = `Must be ${above ? 'below' : 'above'} the price`
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const order = draft.kind === 'limit' ? { kind: 'limit' as const, px: parsePx(draft.price, spec.scale), tif: draft.tif } : { kind: 'market' as const, slippage: draft.slippage }
  return {
    ok: true,
    intent: { spec, side: draft.side, size: parseQty(draft.size, spec.scale), reduceOnly: draft.reduceOnly, clientId: newClientId(), order, triggers: { takeProfit, stopLoss } } as OrderIntent,
  }
}

/** A reduce-only market order for the whole position. Null when the size is off this market's step. */
export function closeIntent(spec: MarketSpec, position: Position, slippage: Bps): OrderIntent | null {
  const size = position.size.replace(/^-/, '')
  if (checkSize(spec, size)) return null
  return {
    spec, side: position.side === 'long' ? 'sell' : 'buy', size: parseQty(size, spec.scale), reduceOnly: true, clientId: newClientId(),
    order: { kind: 'market', slippage }, triggers: { takeProfit: null, stopLoss: null },
  } as OrderIntent
}

/** A fresh id per send: a retry with new nonce or block height would not dedup anyway. */
export function newClientId(): ClientOrderId {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16))) as ClientOrderId
}

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
