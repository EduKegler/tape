import { queryOptions } from '@tanstack/react-query'
import type { Base, Interval, VenueId } from '@tape/core/ids'
import type { MarketGroup, MarketSpec } from '@tape/core/market'
import { VENUES } from '#/site'

export const marketsQuery = (venue: VenueId) =>
  queryOptions({
    queryKey: ['markets', venue],
    queryFn: ({ signal }) => VENUES[venue].fetchMarkets(fetch, signal),
    staleTime: Infinity,
  })

const byBase = (groups: readonly MarketGroup[]): ReadonlyMap<Base, MarketSpec> =>
  new Map(groups.flatMap((g) => g.markets.map((m) => [m.base, m] as const)))

export const specsQuery = (venue: VenueId) => queryOptions({ ...marketsQuery(venue), select: byBase })

export const marketQuery = (venue: VenueId, base: Base) =>
  queryOptions({
    queryKey: ['market', venue, base],
    queryFn: ({ signal }) => VENUES[venue].fetchMarket(base, fetch, signal),
    staleTime: Infinity,
  })

export const statsQuery = (venue: VenueId, base: Base) =>
  queryOptions({
    queryKey: ['stats', venue, base],
    queryFn: ({ signal }) => VENUES[venue].fetchStats(base, fetch, signal),
    refetchInterval: 15_000,
    staleTime: 10_000,
  })

export const candlesQuery = (venue: VenueId, base: Base, interval: Interval) =>
  queryOptions({
    queryKey: ['candles', venue, base, interval],
    queryFn: ({ signal }) => VENUES[venue].fetchCandles(base, interval, fetch, signal),
    staleTime: 60_000,
  })
