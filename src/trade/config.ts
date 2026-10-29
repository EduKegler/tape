import { z } from 'zod'
import type { Address } from 'viem'

/**
 * Operator revenue settings from public VITE_ env, parsed once. A malformed value throws at
 * import, so a bad deploy fails in dev and not on a user's order.
 */
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase() as Address)
const env = z.object({
  VITE_TRADE_MAINNET: z.enum(['0', '1']).default('0'),
  /** Fee in tenths of a basis point, at most 100 on perps. */
  VITE_HL_BUILDER_ADDRESS: address.optional(),
  VITE_HL_BUILDER_FEE: z.coerce.number().int().min(1).max(100).default(10),
  VITE_DYDX_BUILDER_ADDRESS: z.string().regex(/^dydx1[0-9a-z]{38}$/).optional(),
  VITE_DYDX_BUILDER_FEE_PPM: z.coerce.number().int().min(1).max(10_000).default(100),
  VITE_ORDERLY_BROKER_ID: z.string().min(1).optional(),
  /** `demo` is Orderly's public example broker on testnet. */
  VITE_ORDERLY_BROKER_ID_TESTNET: z.string().min(1).default('demo'),
})

export type TradeConfig = ReturnType<typeof toConfig>

function toConfig(e: z.infer<typeof env>) {
  return {
    mainnet: e.VITE_TRADE_MAINNET === '1',
    hyperliquid: { builder: e.VITE_HL_BUILDER_ADDRESS ? { b: e.VITE_HL_BUILDER_ADDRESS, f: e.VITE_HL_BUILDER_FEE } : null },
    dydx: { builder: e.VITE_DYDX_BUILDER_ADDRESS ? { builderAddress: e.VITE_DYDX_BUILDER_ADDRESS, feePpm: e.VITE_DYDX_BUILDER_FEE_PPM } : null },
    orderly: { brokerId: { mainnet: e.VITE_ORDERLY_BROKER_ID ?? null, testnet: e.VITE_ORDERLY_BROKER_ID_TESTNET } },
  } as const
}

export const TRADE_CONFIG = toConfig(env.parse(import.meta.env))
