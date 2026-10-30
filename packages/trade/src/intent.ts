import { DecimalError, formatPx, formatQty, notional, parsePx, parseQty } from '@tape/core/fixed'
import type { Px, Qty } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import { priceTick } from '@tape/core/market'
import { bytesToHex } from 'viem'
import type { Bps, Capabilities, ClientOrderId, IntentFields, OrderIntent, Position, Side, Tif } from './types'

const intentOf = (fields: IntentFields) => ({ ...fields, clientId: newClientId() }) as OrderIntent

export function checkPrice(spec: MarketSpec, value: string): string | undefined {
  if (!value) return 'Enter a price'
  try {
    const px = parsePx(value, spec.scale)
    if (px <= 0) return 'Price must be above zero'
    const tick = priceTick(spec, px)
    if (px % tick !== 0) return `Price must be a multiple of ${formatPx(tick, spec.scale)}`
  } catch (e) {
    if (e instanceof DecimalError)
      return e.reason === 'precision' ? `At most ${spec.scale.px} decimals` : 'Not a number'
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
    if (e instanceof DecimalError)
      return e.reason === 'precision' ? `At most ${spec.scale.qty} decimals` : 'Not a number'
    throw e
  }
  return undefined
}

export function checkNotional(spec: MarketSpec, px: Px, size: Qty): string | undefined {
  if (spec.minNotional === undefined) return undefined
  return notional(px, size) < BigInt(spec.minNotional) * 10n ** BigInt(spec.scale.qty)
    ? `Must be worth at least ${formatPx(spec.minNotional, spec.scale)} ${spec.quote}`
    : undefined
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
  /** The touch on screen, empty while the book has no side. */
  readonly bid: string
  readonly ask: string
}

export type DraftField = 'price' | 'size' | 'tif' | 'takeProfit' | 'stopLoss'
export type Built =
  | { readonly ok: true; readonly intent: OrderIntent }
  | { readonly ok: false; readonly errors: Partial<Record<DraftField, string>> }

export interface ExitReference {
  /** Null for a market order. */
  readonly px: Px | null
  readonly bid: Px | null
  readonly ask: Px | null
}

/** Take profit beyond the order price, or the far touch for a market order. Stop loss short of the order price and the near touch. */
export function checkExits(
  side: Side,
  entry: ExitReference,
  exits: { readonly takeProfit: Px | null; readonly stopLoss: Px | null },
): Partial<Record<'takeProfit' | 'stopLoss', string>> {
  const errors: Partial<Record<'takeProfit' | 'stopLoss', string>> = {}
  const buy = side === 'buy'
  const near = buy ? entry.bid : entry.ask
  const far = buy ? entry.ask : entry.bid
  const beyond = (a: Px, b: Px) => (buy ? a > b : a < b)
  const nearName = buy ? 'the bid' : 'the ask'
  const farName = buy ? 'the ask' : 'the bid'
  const { takeProfit, stopLoss } = exits
  if (takeProfit !== null) {
    const against = entry.px ?? far
    if (against === null) errors.takeProfit = 'No price on the book yet'
    else if (!beyond(takeProfit, against))
      errors.takeProfit = `Must be ${buy ? 'above' : 'below'} ${entry.px === null ? farName : 'the price'}`
  }
  if (stopLoss !== null) {
    if (entry.px === null && near === null) errors.stopLoss = 'No price on the book yet'
    else if (entry.px !== null && !beyond(entry.px, stopLoss))
      errors.stopLoss = `Must be ${buy ? 'below' : 'above'} the price`
    else if (near !== null && !beyond(near, stopLoss))
      errors.stopLoss = `Must be ${buy ? 'below' : 'above'} ${nearName}`
  }
  return errors
}

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
  const touchPx = (value: string) => {
    try {
      return value ? parsePx(value, spec.scale) : null
    } catch {
      return null
    }
  }
  const entry = draft.kind === 'limit' ? (errors.price ? undefined : parsePx(draft.price, spec.scale)) : null
  if (entry !== undefined && (takeProfit !== null || stopLoss !== null))
    Object.assign(
      errors,
      checkExits(draft.side, { px: entry, bid: touchPx(draft.bid), ask: touchPx(draft.ask) }, { takeProfit, stopLoss }),
    )
  const reference = draft.kind === 'limit' ? entry : touchPx(draft.side === 'buy' ? draft.ask : draft.bid)
  if (!errors.size && !draft.reduceOnly && reference) {
    const small = checkNotional(spec, reference, parseQty(draft.size, spec.scale))
    if (small) errors.size = small
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const order =
    draft.kind === 'limit'
      ? { kind: 'limit' as const, px: parsePx(draft.price, spec.scale), tif: draft.tif }
      : { kind: 'market' as const, slippage: draft.slippage }
  return {
    ok: true,
    intent: intentOf({
      spec,
      side: draft.side,
      size: parseQty(draft.size, spec.scale),
      reduceOnly: draft.reduceOnly,
      order,
      triggers: { takeProfit, stopLoss },
    }),
  }
}

/** A reduce-only market order for the whole position. Null when the size is off this market's step. */
export function closeIntent(spec: MarketSpec, position: Position, slippage: Bps): OrderIntent | null {
  const size = position.size.replace(/^-/, '')
  if (checkSize(spec, size)) return null
  return intentOf({
    spec,
    side: position.side === 'long' ? 'sell' : 'buy',
    size: parseQty(size, spec.scale),
    reduceOnly: true,
    order: { kind: 'market', slippage },
    triggers: { takeProfit: null, stopLoss: null },
  })
}

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
