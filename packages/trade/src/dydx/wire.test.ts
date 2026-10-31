import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Decimals, Px, Qty } from '@tape/core/fixed'
import { clientIdOf, quantums, subticks } from './wire'

// Params from indexer.dydx.trade/v4/perpetualMarkets.
const btc = {
  clobPairId: 0,
  atomicResolution: -10,
  quantumConversionExponent: -9,
  stepBaseQuantums: 1_000_000,
  subticksPerTick: 100_000,
}
const sol = {
  clobPairId: 5,
  atomicResolution: -7,
  quantumConversionExponent: -9,
  stepBaseQuantums: 1_000_000,
  subticksPerTick: 1_000_000,
}

describe('dydx wire integers', () => {
  it('turns one step and one tick into the market minimums', () => {
    expect(quantums(1 as Qty, { px: 0, qty: 4 }, btc)).toBe(1_000_000n)
    expect(subticks(1 as Px, { px: 0, qty: 4 }, btc)).toBe(100_000n)
    expect(quantums(1 as Qty, { px: 2, qty: 1 }, sol)).toBe(1_000_000n)
    expect(subticks(1 as Px, { px: 2, qty: 1 }, sol)).toBe(1_000_000n)
  })

  it('places 0.0123 BTC at 80,001 exactly', () => {
    expect(quantums(123 as Qty, { px: 0, qty: 4 }, btc)).toBe(123_000_000n)
    expect(subticks(80_001 as Px, { px: 0, qty: 4 }, btc)).toBe(8_000_100_000n)
  })

  it('refuses a size finer than the step', () => {
    expect(() => quantums(5 as Qty, { px: 2, qty: 2 }, { ...sol, stepBaseQuantums: 1_000_000 })).toThrow('quantums')
  })

  it('refuses a price finer than the tick', () => {
    expect(() => subticks(1 as Px, { px: 1, qty: 4 }, btc)).toThrow('subticks')
  })

  it('keeps the low 32 bits of the cloid as the client id', () => {
    expect(clientIdOf('0x000000000000000000000001ffffffff')).toBe(0xffff_ffff)
    expect(clientIdOf('0x00000000000000000000000000000007')).toBe(7)
  })
})

describe('dydx wire properties', () => {
  it("maps one step and one tick to the market's step quantums and tick subticks, for any market", () => {
    const decimals = fc.integer({ min: 0, max: 8 }).map((decimal) => decimal as Decimals)
    fc.assert(
      fc.property(decimals, decimals, decimals, decimals, (qty, finerQty, px, finerPx) => {
        // dYdX: stepSize = stepBaseQuantums * 10^atomicResolution, tickSize = subticksPerTick * 10^(qce - atomicResolution - 6).
        const atomicResolution = -(qty + finerQty)
        const market = {
          clobPairId: 0,
          atomicResolution,
          quantumConversionExponent: atomicResolution + 6 - px - finerPx,
          stepBaseQuantums: 10 ** finerQty,
          subticksPerTick: 10 ** finerPx,
        }
        expect(quantums(1 as Qty, { px, qty }, market)).toBe(BigInt(10 ** finerQty))
        expect(subticks(1 as Px, { px, qty }, market)).toBe(BigInt(10 ** finerPx))
      }),
    )
  })
})
