import { Link } from '@tanstack/react-router'
import { VENUE_IDS } from '@tape/core/ids'
import type { Base, VenueId } from '@tape/core/ids'
import { useFrame } from '#/client/hooks'
import type { CompareRow } from '#/core/topics'
import { VENUES } from '#/site'

const NO_ROWS: readonly CompareRow[] = []

export function VenueStrip({ base, current }: { base: Base; current: VenueId }) {
  const rows = useFrame({ kind: 'compare', base }, (frame) => frame?.rows ?? NO_ROWS)
  const byVenue = new Map(rows.map((row) => [row.venue, row]))
  return (
    <nav
      aria-label="Venue"
      className="mx-2.5 mt-2.5 grid shrink-0 overflow-hidden rounded-lg bg-surface sm:h-11 sm:grid-cols-4"
    >
      {VENUE_IDS.map((venueId) => (
        <Link
          key={venueId}
          to="/$venue/$base"
          params={{ venue: venueId, base }}
          search={(search) => search}
          aria-current={venueId === current ? 'page' : undefined}
          className="relative flex min-w-0 items-center gap-2.5 border-ground px-4 py-2 text-level3 not-last:border-b hover:bg-raised aria-[current=page]:bg-raised aria-[current=page]:inset-shadow-selected sm:py-0 sm:not-last:border-r sm:not-last:border-b-0"
        >
          <span className="text-base font-semibold text-level1">{VENUES[venueId].label}</span>
          <span className="truncate text-xs text-level3">{VENUES[venueId].chain}</span>
          <Lead row={byVenue.get(venueId)} />
        </Link>
      ))}
    </nav>
  )
}

function Lead({ row }: { row: CompareRow | undefined }) {
  if (!row) return null
  if (row.status === 'unlisted') return <span className="ml-auto shrink-0 text-xs text-level3">Not shown</span>
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
          <span className="text-xs text-level3">mid</span>
          <Price value={row.mid} />
        </>
      )}
    </span>
  )
}

function Best({ side, value }: { side: 'bid' | 'ask'; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-xs text-level2">
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
