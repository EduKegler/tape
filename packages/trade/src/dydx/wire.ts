import type { Px, Qty, Scale } from '@tape/core/fixed'

/**
 * dYdX orders carry integers, not decimals: quantums of base and subticks of price, scaled by
 * the market's atomic resolution and quantum conversion exponent. USDC has 6 decimals on chain.
 */
export interface ClobMarket {
  readonly clobPairId: number
  readonly atomicResolution: number
  readonly quantumConversionExponent: number
  readonly stepBaseQuantums: number
  readonly subticksPerTick: number
}

const QUOTE_ATOMIC_RESOLUTION = -6

function power(exponent: number, what: string): bigint {
  if (exponent < 0) throw new Error(`dYdX ${what} needs finer units than the market scale`)
  return 10n ** BigInt(exponent)
}

export function quantums(qty: Qty, scale: Scale, m: ClobMarket): bigint {
  const q = BigInt(qty) * power(-m.atomicResolution - scale.qty, 'size')
  if (q % BigInt(m.stepBaseQuantums) !== 0n) throw new Error(`size is not a multiple of ${m.stepBaseQuantums} quantums`)
  return q
}

export function subticks(px: Px, scale: Scale, m: ClobMarket): bigint {
  const s = BigInt(px) * power(m.atomicResolution - QUOTE_ATOMIC_RESOLUTION - m.quantumConversionExponent - scale.px, 'price')
  if (s % BigInt(m.subticksPerTick) !== 0n) throw new Error(`price is not a multiple of ${m.subticksPerTick} subticks`)
  return s
}

/** dYdX client ids are uint32. The low 32 bits of a 128-bit cloid keep retries idempotent. */
export function clientIdOf(cloid: `0x${string}`): number {
  return Number(BigInt(cloid) & 0xffff_ffffn)
}

export const LONG_TERM_SECONDS = 28 * 24 * 60 * 60
