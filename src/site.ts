import { z } from 'zod'
import { NETWORKS } from '@tape/core/ids'
import { venues } from '@tape/venues/index'

/** Each deployment is one network end to end: market data, trading and the account panel. */
const env = z.object({
  VITE_NETWORK: z.enum(NETWORKS).default('mainnet'),
  VITE_TESTNET_SITE: z.url().optional(),
})

const e = env.parse(import.meta.env)

export const NETWORK = e.VITE_NETWORK
export const TESTNET_SITE = e.VITE_TESTNET_SITE ?? null
export const VENUES = venues(NETWORK)
