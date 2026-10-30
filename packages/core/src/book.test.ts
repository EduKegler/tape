import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { bestAsk, bestBid, initialSync, stepBook, topLevels, visibleBook } from './book'
import type { BookInput, BookStep, Level } from './book'
import type { Px, Qty } from './fixed'

const lv = (px: number, qty: number): Level => [px as Px, qty as Qty]
const delta = (bids: Level[], asks: Level[], seq: [number, number] | null = null): BookInput => ({
  kind: 'delta',
  bids,
  asks,
  seq: seq && { from: seq[0], to: seq[1] },
  time: 1,
})
const snapshot = (bids: Level[], asks: Level[]): BookInput => ({ kind: 'snapshot', bids, asks, time: 1 })

function run(protocol: Parameters<typeof stepBook>[0], inputs: BookInput[]): BookStep[] {
  const steps: BookStep[] = []
  let sync = initialSync(protocol).sync
  for (const input of inputs) {
    const step = stepBook(protocol, sync, input)
    steps.push(step)
    sync = step.sync
  }
  return steps
}

describe('rest-snapshot-sequenced (Binance)', () => {
  it('asks for the snapshot only after the first diff is buffered', () => {
    expect(initialSync('rest-snapshot-sequenced').effect).toEqual({ kind: 'none' })
    const steps = run('rest-snapshot-sequenced', [delta([lv(100, 5)], [], [8, 9]), delta([lv(99, 3)], [], [10, 12])])
    expect(steps.map((s) => s.effect.kind)).toEqual(['fetch-snapshot', 'none'])
  })

  it('refetches when the snapshot predates the buffered diffs', () => {
    const steps = run('rest-snapshot-sequenced', [
      delta([lv(100, 5)], [], [20, 21]),
      { kind: 'rest-snapshot', epoch: 1, lastUpdateId: 10, bids: [lv(100, 1)], asks: [lv(101, 1)] },
      { kind: 'rest-snapshot', epoch: 2, lastUpdateId: 20, bids: [lv(100, 1)], asks: [lv(101, 1)] },
    ])
    expect(steps[1]!.effect).toEqual({ kind: 'fetch-snapshot', epoch: 2 })
    expect(steps[2]!.sync.phase).toBe('live')
    expect(topLevels(visibleBook(steps[2]!.sync)!.bids, 1)).toEqual([lv(100, 5)])
  })

  it('buffers diffs, drops the ones the snapshot covers, applies the rest', () => {
    const steps = run('rest-snapshot-sequenced', [
      delta([lv(100, 5)], [], [8, 9]),
      delta([lv(99, 3)], [], [10, 12]),
      { kind: 'rest-snapshot', epoch: 1, lastUpdateId: 10, bids: [lv(100, 1), lv(98, 2)], asks: [lv(101, 4)] },
      delta([lv(100, 0)], [lv(102, 1)], [13, 13]),
    ])
    const book = visibleBook(steps.at(-1)!.sync)!
    expect(topLevels(book.bids, 5)).toEqual([lv(99, 3), lv(98, 2)])
    expect(topLevels(book.asks, 5)).toEqual([lv(101, 4), lv(102, 1)])
    expect(steps.at(-1)!.sync.phase).toBe('live')
  })

  it('refetches once on a gap and keeps the old book on screen', () => {
    const steps = run('rest-snapshot-sequenced', [
      delta([lv(100, 2)], [], [11, 11]),
      { kind: 'rest-snapshot', epoch: 1, lastUpdateId: 10, bids: [lv(100, 1)], asks: [lv(101, 1)] },
      delta([lv(100, 3)], [], [14, 15]),
      delta([lv(100, 4)], [], [16, 16]),
    ])
    expect(steps[2]!.effect).toEqual({ kind: 'fetch-snapshot', epoch: 2 })
    expect(steps[3]!.effect).toEqual({ kind: 'none' })
    expect(steps[3]!.sync.phase).toBe('awaiting-snapshot')
    expect(steps[3]!.sync.phase === 'awaiting-snapshot' && steps[3]!.sync.buffer.length).toBe(2)
    expect(bestBid(visibleBook(steps[3]!.sync)!)).toBe(100)
  })

  it('after a reset waits for a diff, then asks for the snapshot under a new epoch', () => {
    const steps = run('rest-snapshot-sequenced', [
      delta([lv(100, 5)], [], [11, 11]),
      { kind: 'rest-snapshot', epoch: 1, lastUpdateId: 10, bids: [lv(100, 1)], asks: [lv(101, 1)] },
      { kind: 'reset', reason: 'corrupt' },
      delta([lv(100, 7)], [], [20, 21]),
    ])
    expect(steps[2]!.effect).toEqual({ kind: 'none' })
    expect(steps[2]!.sync.phase).toBe('awaiting-snapshot')
    expect(steps[3]!.effect).toEqual({ kind: 'fetch-snapshot', epoch: 2 })
  })

  it('ignores a snapshot from an older epoch', () => {
    const steps = run('rest-snapshot-sequenced', [
      delta([lv(100, 5)], [], [11, 11]),
      { kind: 'reset', reason: 'stopped' },
      { kind: 'rest-snapshot', epoch: 1, lastUpdateId: 10, bids: [lv(100, 1)], asks: [lv(101, 1)] },
    ])
    expect(steps[2]!.sync.phase).toBe('awaiting-snapshot')
    expect(steps[2]!.changed).toBe(false)
  })
})

describe('snapshot-then-deltas (dYdX)', () => {
  it('drops deltas until the in-band snapshot', () => {
    const steps = run('snapshot-then-deltas', [
      delta([lv(1, 1)], []),
      snapshot([lv(100, 1)], [lv(101, 1)]),
      delta([lv(99, 2)], []),
    ])
    expect(topLevels(visibleBook(steps[2]!.sync)!.bids, 5)).toEqual([lv(100, 1), lv(99, 2)])
  })

  it('never shows a crossed book: the fresher write evicts the stale side', () => {
    const steps = run('snapshot-then-deltas', [
      snapshot([lv(100, 1), lv(99, 1)], [lv(101, 1), lv(102, 1), lv(103, 1)]),
      delta([lv(102, 5)], []),
    ])
    const last = steps.at(-1)!
    const book = visibleBook(last.sync)!
    expect(bestBid(book)).toBe(102)
    expect(bestAsk(book)).toBe(103)
    expect(last.uncrossed).toBe(2)
  })

  it('drops the crossed levels on both sides of a crossed snapshot', () => {
    const steps = run('snapshot-then-deltas', [snapshot([lv(103, 1), lv(100, 1)], [lv(101, 1), lv(104, 1)])])
    const book = visibleBook(steps[0]!.sync)!
    expect(bestBid(book)).toBe(100)
    expect(bestAsk(book)).toBe(104)
  })

  it('asks the hub to resubscribe when the book is corrupt', () => {
    const steps = run('snapshot-then-deltas', [
      snapshot([lv(100, 1)], [lv(101, 1)]),
      { kind: 'reset', reason: 'corrupt' },
    ])
    expect(steps[1]!.effect).toEqual({ kind: 'resubscribe' })
  })

  it('leaves live with the last book on screen once the hub stops the stream, asking for nothing', () => {
    const steps = run('snapshot-then-deltas', [
      snapshot([lv(100, 1)], [lv(101, 1)]),
      { kind: 'reset', reason: 'stopped' },
    ])
    expect(steps[1]!.sync.phase).toBe('awaiting-snapshot')
    expect(steps[1]!.effect).toEqual({ kind: 'none' })
    expect(bestBid(visibleBook(steps[1]!.sync)!)).toBe(100)
  })
})

describe('snapshots (Hyperliquid)', () => {
  it('replaces the book on every message', () => {
    const steps = run('snapshots', [snapshot([lv(100, 1)], [lv(101, 1)]), snapshot([lv(99, 1)], [lv(100, 1)])])
    const book = visibleBook(steps[1]!.sync)!
    expect(topLevels(book.bids, 5)).toEqual([lv(99, 1)])
    expect(steps[1]!.changed).toBe(true)
  })
})

describe('book properties', () => {
  const level = fc
    .tuple(fc.integer({ min: 1, max: 30 }), fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 5 })))
    .map(([px, qty]) => lv(px, qty))
  const sides = fc.record({ bids: fc.array(level, { maxLength: 4 }), asks: fc.array(level, { maxLength: 4 }) })

  type Sides = { bids: Level[]; asks: Level[] }
  const sorted = (side: Map<number, number>, dir: 1 | -1) =>
    [...side].sort(([a], [b]) => dir * (a - b)).map(([px, qty]) => lv(px, qty))

  function plainModel(first: Sides, deltas: readonly Sides[]) {
    const bids = new Map<number, number>()
    const asks = new Map<number, number>()
    const write = (side: Map<number, number>, [px, qty]: Level) => (qty === 0 ? side.delete(px) : side.set(px, qty))
    const dropWhere = (side: Map<number, number>, out: (px: number) => boolean) => {
      for (const px of [...side.keys()]) if (out(px)) side.delete(px)
    }
    for (const l of first.bids) write(bids, l)
    for (const l of first.asks) write(asks, l)
    const bid = Math.max(...bids.keys())
    const ask = Math.min(...asks.keys())
    if (bid >= ask) {
      dropWhere(bids, (px) => px >= ask)
      dropWhere(asks, (px) => px <= bid)
    }
    for (const d of deltas) {
      for (const l of d.bids) {
        write(bids, l)
        if (l[1] > 0) dropWhere(asks, (px) => px <= l[0])
      }
      for (const l of d.asks) {
        write(asks, l)
        if (l[1] > 0) dropWhere(bids, (px) => px >= l[0])
      }
    }
    return { bids: sorted(bids, -1), asks: sorted(asks, 1) }
  }

  const feeds = {
    'snapshot-then-deltas': (first: Sides, deltas: readonly Sides[]): BookInput[] => [
      snapshot(first.bids, first.asks),
      ...deltas.map((d) => delta(d.bids, d.asks)),
    ],
    'rest-snapshot-sequenced': (first: Sides, deltas: readonly Sides[]): BookInput[] => [
      { kind: 'rest-snapshot', epoch: 1, lastUpdateId: 10, bids: first.bids, asks: first.asks },
      ...deltas.map((d, i) => delta(d.bids, d.asks, [11 + i, 11 + i])),
    ],
  } as const

  it('matches a plain map model and never crosses, whatever the snapshot and deltas', () => {
    const protocol = fc.constantFrom('snapshot-then-deltas' as const, 'rest-snapshot-sequenced' as const)
    fc.assert(
      fc.property(protocol, sides, fc.array(sides, { maxLength: 20 }), (venue, first, deltas) => {
        const steps = run(venue, feeds[venue](first, deltas))
        expect(steps.at(-1)!.sync.phase).toBe('live')
        const book = visibleBook(steps.at(-1)!.sync)!
        expect({ bids: topLevels(book.bids, 100), asks: topLevels(book.asks, 100) }).toEqual(plainModel(first, deltas))
        expect(bestBid(book) ?? -Infinity).toBeLessThan(bestAsk(book) ?? Infinity)
      }),
    )
  })
})
