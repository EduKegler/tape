import type { Network, VenueId } from '@tape/core/ids'
import { binance } from './binance'
import { dydx } from './dydx'
import { hyperliquid } from './hyperliquid'
import { orderly } from './orderly'
import type { VenueAdapter } from './types'

export const venues = (network: Network): Readonly<Record<VenueId, VenueAdapter>> => ({
  binance: binance(network),
  hyperliquid: hyperliquid(network),
  dydx: dydx(network),
  orderly: orderly(network),
})
