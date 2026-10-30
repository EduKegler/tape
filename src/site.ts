import { venues } from '@tape/venues/index'
import { env } from '#/env'

const e = env.parse(import.meta.env)

export const NETWORK = e.VITE_NETWORK
export const TESTNET_SITE = e.VITE_TESTNET_SITE ?? null
export const VENUES = venues(NETWORK)
