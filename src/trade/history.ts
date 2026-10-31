import { useSyncExternalStore } from 'react'
import { queryOptions, skipToken } from '@tanstack/react-query'
import type { Address } from 'viem'
import { keysOf } from '@tape/core/record'
import { TRADING } from '@tape/trade'
import type { VenueHistory } from '@tape/trade/history'
import type { TradeFailure, TradeVenueId } from '@tape/trade/types'
import { NETWORK } from '#/site'
import { guard } from './hooks'
import { keySlot, subscribeVault } from './vault'

export const HISTORY_VENUES = keysOf(TRADING)

const HISTORY_STALE_MS = 5 * 60_000

export const historyQuery = (venue: TradeVenueId, address: string | null) =>
  queryOptions<VenueHistory, TradeFailure>({
    queryKey: ['history', venue, NETWORK, address],
    queryFn: address
      ? () =>
          guard(venue, () =>
            TRADING[venue].history({ network: NETWORK, address, fetch: (input, init) => fetch(input, init) }),
          )
      : skipToken,
    staleTime: HISTORY_STALE_MS,
    retry: 1,
  })

export function useDydxAddress(owner: Address | null): string | null {
  return useSyncExternalStore(
    subscribeVault,
    () =>
      owner
        ? (keySlot({ venue: 'dydx', network: NETWORK, owner }, TRADING.dydx.secrets).read()?.public.address ?? null)
        : null,
    () => null,
  )
}
