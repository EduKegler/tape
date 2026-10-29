import type { Px, Qty } from './fixed'

/**
 * How a venue keeps its book in sync.
 * - snapshots: every message is the full book (Hyperliquid l2Book).
 * - snapshot-then-deltas: in-band snapshot on subscribe, then unsequenced deltas (dYdX).
 * - rest-snapshot-sequenced: sequenced deltas anchored to a REST snapshot (Binance).
 */
export type BookProtocol = 'snapshots' | 'snapshot-then-deltas' | 'rest-snapshot-sequenced'

export type Side = 'bid' | 'ask'

/** qty 0 removes the level. */
export type Level = readonly [px: Px, qty: Qty]

export interface Seq {
  readonly from: number
  readonly to: number
}

/** Best-first prices (bids descending, asks ascending), strictly sorted, every price with qty > 0. */
export interface BookSide {
  readonly side: Side
  readonly prices: Px[]
  readonly qty: Map<Px, Qty>
}

/** Owned by one market in the hub and mutated in place. */
export interface Book {
  readonly bids: BookSide
  readonly asks: BookSide
  lastSeq: number | null
  time: number
}

export interface SequencedDelta {
  readonly bids: readonly Level[]
  readonly asks: readonly Level[]
  readonly seq: Seq
  readonly time: number
}

export type BookSync =
  | {
      readonly phase: 'awaiting-snapshot'
      readonly epoch: number
      readonly buffer: readonly SequencedDelta[]
      /** The last good book stays on screen while a resync runs. */
      readonly previous: Book | null
    }
  | { readonly phase: 'live'; readonly epoch: number; readonly book: Book }

export type BookInput =
  | {
      readonly kind: 'snapshot'
      readonly bids: readonly Level[]
      readonly asks: readonly Level[]
      readonly time: number
    }
  | {
      readonly kind: 'delta'
      readonly bids: readonly Level[]
      readonly asks: readonly Level[]
      readonly seq: Seq | null
      readonly time: number
    }
  /** A REST result carries the epoch that asked for it, so a late one is dropped. */
  | {
      readonly kind: 'rest-snapshot'
      readonly epoch: number
      readonly lastUpdateId: number
      readonly bids: readonly Level[]
      readonly asks: readonly Level[]
    }
  /** `subscribed`: the venue just (re)sent the stream. `corrupt`: the hub could not trust a message. */
  | { readonly kind: 'reset'; readonly reason: 'subscribed' | 'corrupt' }

export type BookEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'fetch-snapshot'; readonly epoch: number }
  /** In-band protocols only heal through a fresh subscribe. */
  | { readonly kind: 'resubscribe' }

export interface BookStep {
  readonly sync: BookSync
  readonly effect: BookEffect
  readonly uncrossed: number
  readonly changed: boolean
}

const NONE: BookEffect = { kind: 'none' }

function emptySide(side: Side): BookSide {
  return { side, prices: [], qty: new Map() }
}

function emptyBook(): Book {
  return { bids: emptySide('bid'), asks: emptySide('ask'), lastSeq: null, time: 0 }
}

const better = (side: Side, a: number, b: number) => (side === 'bid' ? a > b : a < b)

function seek(side: BookSide, px: Px): number {
  let lo = 0
  let hi = side.prices.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (better(side.side, side.prices[mid] as number, px)) lo = mid + 1
    else hi = mid
  }
  return lo
}

function write(side: BookSide, px: Px, qty: Qty): void {
  const at = seek(side, px)
  const exists = side.prices[at] === px
  if (qty === 0) {
    if (exists) {
      side.prices.splice(at, 1)
      side.qty.delete(px)
    }
    return
  }
  if (!exists) side.prices.splice(at, 0, px)
  side.qty.set(px, qty)
}

function evictThrough(side: BookSide, px: Px): number {
  let count = 0
  while (side.prices.length > 0) {
    const best = side.prices[0] as Px
    if (side.side === 'ask' ? best > px : best < px) break
    side.prices.shift()
    side.qty.delete(best)
    count++
  }
  return count
}

function applyDeltaEvictingCrossed(book: Book, bids: readonly Level[], asks: readonly Level[], time: number): number {
  let uncrossed = 0
  for (const [px, qty] of bids) {
    write(book.bids, px, qty)
    if (qty > 0) uncrossed += evictThrough(book.asks, px)
  }
  for (const [px, qty] of asks) {
    write(book.asks, px, qty)
    if (qty > 0) uncrossed += evictThrough(book.bids, px)
  }
  book.time = time
  return uncrossed
}

function snapshotDroppingCrossed(
  bids: readonly Level[],
  asks: readonly Level[],
  time: number,
): { book: Book; uncrossed: number } {
  const book = emptyBook()
  for (const [px, qty] of bids) write(book.bids, px, qty)
  for (const [px, qty] of asks) write(book.asks, px, qty)
  book.time = time
  const bid = bestBid(book)
  const ask = bestAsk(book)
  if (bid === null || ask === null || bid < ask) return { book, uncrossed: 0 }
  return { book, uncrossed: evictThrough(book.bids, ask) + evictThrough(book.asks, bid) }
}

export function initialSync(_protocol: BookProtocol): BookStep {
  return {
    sync: { phase: 'awaiting-snapshot', epoch: 1, buffer: [], previous: null },
    effect: NONE,
    uncrossed: 0,
    changed: false,
  }
}

/**
 * The REST protocol asks for its snapshot only once a diff is buffered, as Binance documents, so the
 * snapshot can never predate the stream it anchors.
 */
function awaiting(
  protocol: BookProtocol,
  epoch: number,
  previous: Book | null,
  reason: 'subscribed' | 'corrupt',
  buffer: readonly SequencedDelta[] = [],
): BookStep {
  const effect: BookEffect =
    protocol === 'rest-snapshot-sequenced'
      ? buffer.length > 0
        ? { kind: 'fetch-snapshot', epoch }
        : NONE
      : protocol === 'snapshot-then-deltas' && reason === 'corrupt'
        ? { kind: 'resubscribe' }
        : NONE
  return { sync: { phase: 'awaiting-snapshot', epoch, buffer, previous }, effect, uncrossed: 0, changed: false }
}

const unchanged = (sync: BookSync): BookStep => ({ sync, effect: NONE, uncrossed: 0, changed: false })

/**
 * Binance's two rules (U <= lastUpdateId + 1 <= u for the first diff, U == prev u + 1 after) fold into
 * one check against lastSeq: drop to <= lastSeq, apply from <= lastSeq + 1, anything else is a gap.
 */
export function stepBook(protocol: BookProtocol, sync: BookSync, input: BookInput): BookStep {
  if (input.kind === 'reset') return awaiting(protocol, sync.epoch + 1, visibleBook(sync), input.reason)

  switch (protocol) {
    case 'snapshots':
    case 'snapshot-then-deltas': {
      if (input.kind === 'snapshot') {
        const { book, uncrossed } = snapshotDroppingCrossed(input.bids, input.asks, input.time)
        return { sync: { phase: 'live', epoch: sync.epoch, book }, effect: NONE, uncrossed, changed: true }
      }
      if (input.kind !== 'delta' || sync.phase !== 'live' || protocol === 'snapshots') return unchanged(sync)
      const uncrossed = applyDeltaEvictingCrossed(sync.book, input.bids, input.asks, input.time)
      return { sync, effect: NONE, uncrossed, changed: true }
    }
    case 'rest-snapshot-sequenced': {
      if (input.kind === 'snapshot') return unchanged(sync)
      if (input.kind === 'rest-snapshot') {
        if (sync.phase !== 'awaiting-snapshot' || input.epoch !== sync.epoch) return unchanged(sync)
        const { book, uncrossed } = snapshotDroppingCrossed(input.bids, input.asks, 0)
        book.lastSeq = input.lastUpdateId
        let step: BookStep = {
          sync: { phase: 'live', epoch: sync.epoch, book },
          effect: NONE,
          uncrossed,
          changed: true,
        }
        for (const [i, d] of sync.buffer.entries()) {
          step = merge(step, stepBook(protocol, step.sync, { kind: 'delta', ...d }))
          if (step.sync.phase !== 'live') {
            const rest = sync.buffer.slice(i)
            return {
              ...step,
              sync: { phase: 'awaiting-snapshot', epoch: step.sync.epoch, buffer: rest, previous: step.sync.previous },
            }
          }
        }
        return step
      }
      if (!input.seq) return unchanged(sync)
      const diff: SequencedDelta = { bids: input.bids, asks: input.asks, seq: input.seq, time: input.time }
      if (sync.phase === 'awaiting-snapshot') {
        const buffer = [...sync.buffer, diff]
        const effect: BookEffect = sync.buffer.length === 0 ? { kind: 'fetch-snapshot', epoch: sync.epoch } : NONE
        return { sync: { ...sync, buffer }, effect, uncrossed: 0, changed: false }
      }
      const last = sync.book.lastSeq ?? 0
      if (input.seq.to <= last) return unchanged(sync)
      if (input.seq.from > last + 1) return awaiting(protocol, sync.epoch + 1, sync.book, 'corrupt', [diff])
      const uncrossed = applyDeltaEvictingCrossed(sync.book, input.bids, input.asks, input.time)
      sync.book.lastSeq = input.seq.to
      return { sync, effect: NONE, uncrossed, changed: true }
    }
  }
}

function merge(a: BookStep, b: BookStep): BookStep {
  return {
    sync: b.sync,
    effect: b.effect.kind === 'none' ? a.effect : b.effect,
    uncrossed: a.uncrossed + b.uncrossed,
    changed: a.changed || b.changed,
  }
}

export function bestBid(book: Book): Px | null {
  return book.bids.prices[0] ?? null
}

export function bestAsk(book: Book): Px | null {
  return book.asks.prices[0] ?? null
}

export function topLevels(side: BookSide, n: number): Level[] {
  return side.prices.slice(0, n).map((px) => [px, side.qty.get(px) as Qty] as const)
}

export function visibleBook(sync: BookSync): Book | null {
  return sync.phase === 'live' ? sync.book : sync.previous
}
