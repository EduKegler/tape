import { describe, expect, it } from 'vitest'
import { hyperliquidWithdraw } from './hyperliquid/withdraw'
import { toDecimal } from './types'
import { usdcFloor, withdrawIssues } from './withdraw'

describe('withdrawIssues', () => {
  it('asks for more than the 1 USDC fee Hyperliquid keeps', () => {
    expect(withdrawIssues(hyperliquidWithdraw, 1_000_000n, null)).toEqual([{ kind: 'not-above-fee', fee: 1_000_000n }])
    expect(withdrawIssues(hyperliquidWithdraw, 1_000_001n, null)).toEqual([])
  })

  it('stops an amount over what the venue lets go', () => {
    expect(withdrawIssues(hyperliquidWithdraw, 5_000_001n, 5_000_000n)).toEqual([
      { kind: 'over-available', available: 5_000_000n },
    ])
    expect(withdrawIssues(hyperliquidWithdraw, 5_000_000n, 5_000_000n)).toEqual([])
  })

  it('names both when an amount fails both', () => {
    expect(withdrawIssues(hyperliquidWithdraw, 1_000_000n, 500_000n)).toEqual([
      { kind: 'not-above-fee', fee: 1_000_000n },
      { kind: 'over-available', available: 500_000n },
    ])
  })
})

describe('usdcFloor', () => {
  it('reads a venue balance in USDC base units, cut down to 6 places', () => {
    expect(usdcFloor(toDecimal('905.68749'))).toBe(905_687_490n)
    expect(usdcFloor(toDecimal('12'))).toBe(12_000_000n)
    expect(usdcFloor(toDecimal('1.1234569'))).toBe(1_123_456n)
    expect(usdcFloor(toDecimal('0.0000009'))).toBe(0n)
  })

  it('holds nothing to withdraw in a negative balance', () => {
    expect(usdcFloor(toDecimal('-3.5'))).toBe(0n)
  })
})
