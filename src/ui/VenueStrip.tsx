import { Link } from '@tanstack/react-router'
import { VENUE_IDS } from '@tape/core/ids'
import type { Base, VenueId } from '@tape/core/ids'
import { useFrame } from '#/client/hooks'
import type { CompareRow } from '#/core/topics'
import { VENUES } from '#/site'
import { useLifts, useWashing } from './wash'

const NO_ROWS: readonly CompareRow[] = []

export function VenueStrip({ base, current }: { base: Base; current: VenueId }) {
  const rows = useFrame({ kind: 'compare', base }, (frame) => frame?.rows ?? NO_ROWS)
  const byVenue = new Map(rows.map((row) => [row.venue, row]))
  const lifts = useLifts(rows)
  return (
    <nav
      aria-label="Venue"
      className="mx-2.5 mt-2.5 grid shrink-0 overflow-hidden rounded-lg bg-surface sm:h-11 sm:grid-cols-4"
    >
      {VENUE_IDS.map((venueId) => (
        <Tab
          key={venueId}
          venue={venueId}
          base={base}
          current={venueId === current}
          lifts={lifts[venueId] ?? 0}
          row={byVenue.get(venueId)}
        />
      ))}
    </nav>
  )
}

function Tab({
  venue,
  base,
  current,
  lifts,
  row,
}: {
  venue: VenueId
  base: Base
  current: boolean
  lifts: number
  row: CompareRow | undefined
}) {
  const lifting = useWashing(lifts)
  return (
    <Link
      to="/$venue/$base"
      params={{ venue, base }}
      search={(search) => search}
      aria-current={current ? 'page' : undefined}
      data-lifting={lifting || undefined}
      className="group relative flex min-w-0 items-center gap-2.5 border-ground px-4 py-2 text-level3 not-last:border-b hover:bg-raised aria-[current=page]:bg-raised aria-[current=page]:inset-shadow-selected sm:py-0 sm:not-last:border-r sm:not-last:border-b-0"
    >
      {lifts > 0 && <span key={lifts} aria-hidden className="pointer-events-none absolute inset-0 wash" />}
      <span className="relative flex min-w-0 flex-1 items-center gap-2.5">
        <span className="text-base font-semibold text-level1">{VENUES[venue].label}</span>
        <span className="truncate text-xs text-level3 group-data-lifting:text-level1">{VENUES[venue].chain}</span>
        <Lead row={row} />
      </span>
    </Link>
  )
}

function Lead({ row }: { row: CompareRow | undefined }) {
  if (!row) return null
  if (row.status === 'unlisted') return <span className="ml-auto shrink-0 text-xs text-level3">Not shown</span>
  if (row.status === 'syncing' && !row.mid) return null
  if (row.status !== 'live')
    return (
      <span className="ml-auto flex shrink-0 items-baseline gap-2">
        <span className="text-xs text-warn">Reconnecting</span>
        <Price value={row.mid} label="mid" dim />
      </span>
    )
  return (
    <span className="ml-auto flex shrink-0 items-baseline gap-2">
      {row.bestBid && <Best side="bid" value={row.bid} />}
      {row.bestAsk && <Best side="ask" value={row.ask} />}
      {!row.bestBid && !row.bestAsk && (
        <>
          <span className="text-xs text-level3 group-data-lifting:text-level1">mid</span>
          <Price value={row.mid} />
        </>
      )}
    </span>
  )
}

function Best({ side, value }: { side: 'bid' | 'ask'; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-xs text-level2 group-data-lifting:text-level1">
        <span aria-hidden className={side === 'bid' ? 'text-bid' : 'text-ask'}>
          ●{' '}
        </span>
        best {side}
      </span>
      <Price value={value} />
    </span>
  )
}

function Price({ value, label, dim = false }: { value: string; label?: string; dim?: boolean }) {
  return (
    <span className={`num text-base ${dim ? 'text-level3' : 'text-level1'}`}>
      {label && <span className="sr-only">{label} </span>}
      {value || '—'}
    </span>
  )
}
