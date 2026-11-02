import type { VenueId } from '@tape/core/ids'
import { isTradeVenue } from '@tape/trade/venue-ids'
import { NETWORK } from '#/site'
import { parseTradeConfig } from './env'

export const TRADE_CONFIG = parseTradeConfig(import.meta.env)

export const sendsOrders = (venue: VenueId): boolean =>
  isTradeVenue(venue) && (NETWORK === 'testnet' || TRADE_CONFIG.mainnet.has(venue))
