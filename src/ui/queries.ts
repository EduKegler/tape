import { queryOptions } from '@tanstack/react-query'
import type { Base, Interval, VenueId } from '@tape/core/ids'
import { VENUES } from '#/site'

export const specsQuery = (venue: VenueId) =>
  queryOptions({
    queryKey: ['specs', venue],
    queryFn: ({ signal }) => VENUES[venue].fetchSpecs(fetch, signal),
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
