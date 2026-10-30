import { describe, expect, it } from 'vitest'
import type { TradeConfig } from './types'
import { TRADING } from './index'

const build = (mainnet: boolean): TradeConfig => ({
  mainnet,
  hyperliquid: { builder: null },
  dydx: { builder: null },
  orderly: { brokerId: { mainnet: 'tape', testnet: 'demo' } },
})

describe('mainnet guard', () => {
  it.each(Object.values(TRADING))('keeps $label off mainnet unless the build turns mainnet trading on', (venue) => {
    expect(venue.unavailable('mainnet', build(false))).toBe('Mainnet trading is off in this build')
    expect(venue.unavailable('mainnet', build(true))).toBeNull()
    expect(venue.unavailable('testnet', build(false))).toBeNull()
  })
})
