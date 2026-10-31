import { venues } from '@tape/venues/index'
import { env } from '#/env'

const config = env.parse(import.meta.env)

export const NETWORK = config.VITE_NETWORK
export const TESTNET_SITE = config.VITE_TESTNET_SITE ?? null
export const VENUES = venues(NETWORK)
