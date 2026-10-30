import { DecimalError, formatPx, formatQty, notional, parsePx, parseQty } from '@tape/core/fixed'
import type { Px, Qty } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import { priceTick } from '@tape/core/market'
import { bytesToHex } from 'viem'
import { SKEW, scaleLegs, toTick } from './scale-order'
import type { Slice } from './scale-order'
import type { Bps, Capabilities, ClientOrderId, IntentFields, OrderIntent, Position, Side, Tif } from './types'

const intentOf = (fields: IntentFields, clientId = newClientId()) => ({ ...fields, clientId }) as OrderIntent

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

function belowMinimum(spec: MarketSpec, px: Px, size: Qty): string | undefined {
  if (spec.minNotional === undefined) return undefined
  return notional(px, size) < BigInt(spec.minNotional) * 10n ** BigInt(spec.scale.qty)
    ? `${formatPx(spec.minNotional, spec.scale)} ${spec.quote}`
    : undefined
}

export interface IntentDraft {
  readonly side: Side
  readonly kind: 'limit' | 'market' | 'scale'
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
  /** Scale order: the first and last leg price, how many legs, and the last leg's size over the first's. */
  readonly start: string
  readonly end: string
  readonly count: string
  readonly skew: string
}

export type DraftField = 'price' | 'size' | 'tif' | 'takeProfit' | 'stopLoss' | 'start' | 'end' | 'count' | 'skew'
type Errors = Partial<Record<DraftField, string>>
export type Built =
  { readonly ok: true; readonly intent: OrderIntent } | { readonly ok: false; readonly errors: Errors }

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

export function checkCount(value: string, max: number): string | undefined {
  const n = Number(value)
  return Number.isInteger(n) && n >= 2 && n <= max ? undefined : `From 2 to ${max} orders`
}

export function checkSkew(value: string): string | undefined {
  const n = Number(value)
  return value && n >= SKEW.min && n <= SKEW.max ? undefined : `Between ${SKEW.min} and ${SKEW.max}`
}

export type ScaleDraft = Pick<IntentDraft, 'side' | 'size' | 'start' | 'end' | 'count' | 'skew'>
export type BuiltScale =
  { readonly ok: true; readonly legs: readonly Slice[] } | { readonly ok: false; readonly errors: Errors }

/** The legs of a scale order, before the venue minimum. */
export function buildScale(spec: MarketSpec, draft: ScaleDraft, maxOrders: number): BuiltScale {
  const errors: Errors = {}
  const checks = {
    size: checkSize(spec, draft.size),
    start: checkPrice(spec, draft.start),
    end: checkPrice(spec, draft.end),
    count: checkCount(draft.count, maxOrders),
    skew: checkSkew(draft.skew),
  }
  for (const [field, issue] of Object.entries(checks)) if (issue) errors[field as DraftField] = issue
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const built = scaleLegs(
    spec,
    draft.side,
    {
      start: parsePx(draft.start, spec.scale),
      end: parsePx(draft.end, spec.scale),
      count: Number(draft.count),
      skew: Number(draft.skew),
    },
    parseQty(draft.size, spec.scale),
  )
  return built.ok ? built : { ok: false, errors: { [built.field]: built.message } }
}

function scaleSlices(spec: MarketSpec, draft: IntentDraft, caps: Capabilities, errors: Errors): readonly Slice[] {
  if (caps.scaleOrders === 0) {
    errors.count = 'Not offered on this venue'
    return []
  }
  const built = buildScale(spec, draft, caps.scaleOrders)
  if (!built.ok) {
    Object.assign(errors, built.errors)
    return []
  }
  const small = draft.reduceOnly ? undefined : built.legs.map((l) => belowMinimum(spec, l.px, l.size)).find(Boolean)
  if (small) errors.size = `Each order must be worth at least ${small}`
  return built.legs
}

export function buildIntent(spec: MarketSpec, draft: IntentDraft, caps: Capabilities): Built {
  const errors: Errors = {}
  const size = checkSize(spec, draft.size)
  if (size) errors.size = size
  if (draft.kind === 'limit') {
    const price = checkPrice(spec, draft.price)
    if (price) errors.price = price
  }
  if (draft.kind !== 'market' && !caps.tif.includes(draft.tif)) errors.tif = 'Not offered on this venue'
  const scaleTif = draft.kind === 'scale' && draft.tif !== 'ioc' ? draft.tif : null
  if (draft.kind === 'scale' && scaleTif === null) errors.tif = 'Not with a scale order'
  const trigger = (field: 'takeProfit' | 'stopLoss', value: string): Px | null => {
    if (!value) return null
    if (draft.kind === 'scale') {
      errors[field] = 'Not with a scale order'
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
  const slices = draft.kind === 'scale' ? scaleSlices(spec, draft, caps, errors) : []
  const reference = draft.kind === 'limit' ? entry : touchPx(draft.side === 'buy' ? draft.ask : draft.bid)
  if (draft.kind !== 'scale' && !errors.size && !draft.reduceOnly && reference) {
    const small = belowMinimum(spec, reference, parseQty(draft.size, spec.scale))
    if (small) errors.size = `Must be worth at least ${small}`
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const clientId = newClientId()
  const order =
    draft.kind === 'limit'
      ? { kind: 'limit' as const, px: parsePx(draft.price, spec.scale), tif: draft.tif }
      : scaleTif !== null
        ? {
            kind: 'scale' as const,
            tif: scaleTif,
            legs: slices.map((l, i) => ({ ...l, clientId: i === 0 ? clientId : newClientId() })),
          }
        : { kind: 'market' as const, slippage: draft.slippage }
  return {
    ok: true,
    intent: intentOf(
      {
        spec,
        side: draft.side,
        size: parseQty(draft.size, spec.scale),
        reduceOnly: draft.reduceOnly,
        order,
        triggers: { takeProfit, stopLoss },
      },
      clientId,
    ),
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
  const snapped = toTick(spec, side, moved)
  return Math.max(snapped, priceTick(spec, snapped)) as Px
}
