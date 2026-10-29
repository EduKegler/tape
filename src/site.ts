import { z } from 'zod'
import { NETWORKS } from '@tape/core/ids'
import { venues } from '@tape/venues/index'

// The CSP forbids eval, and zod would otherwise probe it before every first object parse.
z.config({ jitless: true })

const env = z.object({
  VITE_NETWORK: z.enum(NETWORKS).default('mainnet'),
  VITE_TESTNET_SITE: z.url().optional(),
})

const e = env.parse(import.meta.env)

export const NETWORK = e.VITE_NETWORK
export const TESTNET_SITE = e.VITE_TESTNET_SITE ?? null
export const VENUES = venues(NETWORK)
