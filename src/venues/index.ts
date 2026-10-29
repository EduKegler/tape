import type { VenueId } from '#/core/ids'
import { binance } from './binance'
import { dydx } from './dydx'
import { hyperliquid } from './hyperliquid'
import type { VenueAdapter } from './types'

export const VENUES: Readonly<Record<VenueId, VenueAdapter>> = { binance, hyperliquid, dydx }
