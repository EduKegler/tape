import type { VenueId } from '@tape/core/ids'
import { binance } from './binance'
import { dydx } from './dydx'
import { hyperliquid } from './hyperliquid'
import { orderly } from './orderly'
import type { VenueAdapter } from './types'

export const VENUES: Readonly<Record<VenueId, VenueAdapter>> = { binance, hyperliquid, dydx, orderly }
