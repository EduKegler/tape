import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { VenueId } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { searchMarkets } from '@tape/core/search'
import { marketsQuery } from './queries'
import { Search } from './primitives'

export function MarketSearch({ venue }: { venue: VenueId }) {
  const [query, setQuery] = useState('')
  const [opened, setOpened] = useState(false)
  const list = useQuery({ ...marketsQuery(venue), enabled: opened })
  const markets = list.data
  const groups = useMemo(
    () =>
      searchMarkets(markets ?? [], query).map((group) => ({ key: group.dex, label: group.name, items: group.markets })),
    [markets, query],
  )
  const navigate = useNavigate()
  return (
    <Search<MarketSpec>
      label="Search markets"
      value={query}
      groups={groups}
      empty={markets ? 'No market matches' : list.isError ? 'Could not load markets.' : 'Loading markets'}
      itemKey={(market) => market.base}
      renderItem={(market) => market.base}
      onChange={setQuery}
      onOpenChange={(open) => {
        if (!open) return
        setOpened(true)
        if (list.isError) void list.refetch()
      }}
      onPick={(market) =>
        void navigate({ to: '/$venue/$base', params: { venue, base: market.base }, search: (search) => search })
      }
    />
  )
}
