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

export function quantums(qty: Qty, scale: Scale, market: ClobMarket): bigint {
  const units = BigInt(qty) * power(-market.atomicResolution - scale.qty, 'size')
  if (units % BigInt(market.stepBaseQuantums) !== 0n)
    throw new Error(`size is not a multiple of ${market.stepBaseQuantums} quantums`)
  return units
}

export function subticks(px: Px, scale: Scale, market: ClobMarket): bigint {
  const units =
    BigInt(px)
    * power(market.atomicResolution - QUOTE_ATOMIC_RESOLUTION - market.quantumConversionExponent - scale.px, 'price')
  if (units % BigInt(market.subticksPerTick) !== 0n)
    throw new Error(`price is not a multiple of ${market.subticksPerTick} subticks`)
  return units
}

/** dYdX client ids are uint32. The low 32 bits of a 128-bit cloid keep retries idempotent. */
export function clientIdOf(cloid: `0x${string}`): number {
  return Number(BigInt(cloid) & 0xffff_ffffn)
}

export const LONG_TERM_SECONDS = 28 * 24 * 60 * 60
