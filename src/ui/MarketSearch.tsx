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
  const markets = useQuery({ ...marketsQuery(venue), enabled: opened }).data
  const groups = useMemo(
    () => searchMarkets(markets ?? [], query).map((g) => ({ key: g.dex, label: g.name, items: g.markets })),
    [markets, query],
  )
  const navigate = useNavigate()
  return (
    <Search<MarketSpec>
      label="Search markets"
      value={query}
      groups={groups}
      empty={markets ? 'No market matches' : 'Loading markets'}
      itemKey={(m) => m.base}
      renderItem={(m) => m.base}
      onChange={setQuery}
      onOpenChange={(open) => open && setOpened(true)}
      onPick={(m) => void navigate({ to: '/$venue/$base', params: { venue, base: m.base }, search: (s) => s })}
    />
  )
}
