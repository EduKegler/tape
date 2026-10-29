import { z } from 'zod'
import type { Address } from 'viem'
import type { TradeConfig } from '@tape/trade/types'
import { NETWORK } from '#/site'

const ORDERLY_PUBLIC_TESTNET_BROKER = 'demo'

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((a) => a.toLowerCase() as Address)
const env = z.object({
  VITE_TRADE_MAINNET: z.enum(['0', '1']).default('0'),
  VITE_HL_BUILDER_ADDRESS: address.optional(),
  VITE_HL_BUILDER_FEE_TENTHS_BP: z.coerce.number().int().min(1).max(100).default(10),
  VITE_DYDX_BUILDER_ADDRESS: z
    .string()
    .regex(/^dydx1[0-9a-z]{38}$/)
    .optional(),
  VITE_DYDX_BUILDER_FEE_PPM: z.coerce.number().int().min(1).max(10_000).default(100),
  VITE_ORDERLY_BROKER_ID: z.string().min(1).optional(),
  VITE_ORDERLY_BROKER_ID_TESTNET: z.string().min(1).default(ORDERLY_PUBLIC_TESTNET_BROKER),
})

function toConfig(e: z.infer<typeof env>): TradeConfig {
  return {
    mainnet: e.VITE_TRADE_MAINNET === '1',
    hyperliquid: {
      builder: e.VITE_HL_BUILDER_ADDRESS ? { b: e.VITE_HL_BUILDER_ADDRESS, f: e.VITE_HL_BUILDER_FEE_TENTHS_BP } : null,
    },
    dydx: {
      builder: e.VITE_DYDX_BUILDER_ADDRESS
        ? { builderAddress: e.VITE_DYDX_BUILDER_ADDRESS, feePpm: e.VITE_DYDX_BUILDER_FEE_PPM }
        : null,
    },
    orderly: { brokerId: { mainnet: e.VITE_ORDERLY_BROKER_ID ?? null, testnet: e.VITE_ORDERLY_BROKER_ID_TESTNET } },
  }
}

export const TRADE_CONFIG: TradeConfig = toConfig(env.parse(import.meta.env))

export const SITE_READ_ONLY = NETWORK === 'mainnet' && !TRADE_CONFIG.mainnet
