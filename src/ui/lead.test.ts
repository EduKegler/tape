import { describe, expect, it } from 'vitest'
import type { VenueId } from '@tape/core/ids'
import type { CompareRow } from '#/core/topics'
import { NO_LIFTS, takeLifts } from './lead'

const row = (venue: VenueId, best: { bid?: boolean; ask?: boolean } = {}, status: CompareRow['status'] = 'live') =>
  ({
    venue,
    status,
    bid: '100',
    ask: '101',
    mid: '100.5',
    spreadBps: '99.50',
    basisBps: '0',
    last: '100',
    bestBid: best.bid ?? false,
    bestAsk: best.ask ?? false,
  }) satisfies CompareRow

const start = takeLifts(NO_LIFTS, [row('binance', { bid: true }), row('hyperliquid', { ask: true })], 0).state

describe('venue tab lifts', () => {
  it('lifts nobody on the first frame, when nothing changed hands', () => {
    expect(takeLifts(NO_LIFTS, [row('binance', { bid: true })], 0).lifted).toEqual([])
  })

  it('lifts the venue that newly takes the best bid', () => {
    const next = takeLifts(start, [row('binance'), row('hyperliquid', { bid: true, ask: true })], 5000)
    expect(next.lifted).toEqual(['hyperliquid'])
  })

  it('does not lift a venue that keeps the best price it already held', () => {
    const next = takeLifts(start, [row('binance', { bid: true }), row('hyperliquid', { ask: true })], 5000)
    expect(next.lifted).toEqual([])
  })

  it('lifts a venue at most once every 2 seconds', () => {
    const taken = takeLifts(start, [row('binance', { bid: true, ask: true }), row('hyperliquid')], 5000)
    const lost = takeLifts(taken.state, [row('binance'), row('hyperliquid', { bid: true, ask: true })], 5500)
    const retaken = takeLifts(lost.state, [row('binance', { ask: true }), row('hyperliquid', { bid: true })], 6999)
    const later = takeLifts(retaken.state, [row('binance', { bid: true }), row('hyperliquid', { ask: true })], 7000)
    expect([taken.lifted, retaken.lifted, later.lifted]).toEqual([['binance'], [], ['binance']])
  })

  it('does not lift a venue that just came live holding a best price', () => {
    const next = takeLifts(
      start,
      [row('binance', { bid: true }), row('hyperliquid', { ask: true }), row('orderly', { bid: true })],
      5000,
    )
    expect(next.lifted).toEqual([])
  })

  it('does not lift a venue that is not live', () => {
    const next = takeLifts(start, [row('binance'), row('hyperliquid'), row('dydx', { bid: true }, 'stale')], 5000)
    expect(next.lifted).toEqual([])
  })
})
