import { z } from 'zod'
import { NETWORKS } from '@tape/core/ids'

// The CSP forbids eval, and zod would otherwise probe it before every first object parse.
z.config({ jitless: true })

export const env = z.object({
  VITE_NETWORK: z.enum(NETWORKS).default('mainnet'),
  VITE_TESTNET_SITE: z.url().optional(),
})
