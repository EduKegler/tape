import { describe, expect, it } from 'vitest'
import type { TradeConfig, TradeVenueId } from './types'
import { isTradeVenue } from './types'
import { TRADING } from './index'

const OFF = 'Mainnet trading is off in this build'
const VENUES = Object.values(TRADING)

const build = (mainnet: readonly TradeVenueId[]): TradeConfig => ({
  mainnet: new Set(mainnet),
  hyperliquid: { builder: null },
  dydx: { builder: null },
  orderly: { brokerId: { mainnet: 'tape', testnet: 'demo' } },
})

describe('mainnet guard', () => {
  it.each(VENUES)('keeps $label off mainnet unless the build turns mainnet trading on for it', (venue) => {
    const others = VENUES.filter((other) => other.id !== venue.id).map((other) => other.id)
    expect(venue.unavailable('mainnet', build([]))).toBe(OFF)
    expect(venue.unavailable('mainnet', build(others))).toBe(OFF)
    expect(venue.unavailable('mainnet', build([venue.id]))).toBeNull()
    expect(venue.unavailable('testnet', build([]))).toBeNull()
  })

  it.each(VENUES)('turns on no other venue when the build turns $label on', (venue) => {
    for (const other of VENUES.filter((candidate) => candidate.id !== venue.id))
      expect(other.unavailable('mainnet', build([venue.id]))).toBe(OFF)
  })
})

describe('trading venues', () => {
  it('trades on every venue but the read-only ones', () => {
    for (const venue of ['hyperliquid', 'dydx', 'orderly'] as const) expect(isTradeVenue(venue)).toBe(true)
    expect(isTradeVenue('binance')).toBe(false)
  })
})
