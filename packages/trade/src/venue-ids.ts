import type { VenueId } from '@tape/core/ids'

const READ_ONLY_VENUES = ['binance'] as const
export type TradeVenueId = Exclude<VenueId, (typeof READ_ONLY_VENUES)[number]>

export function isTradeVenue(venue: VenueId): venue is TradeVenueId {
  return !(READ_ONLY_VENUES as readonly VenueId[]).includes(venue)
}
