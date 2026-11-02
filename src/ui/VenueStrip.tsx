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
      className="mx-2.5 mt-2.5 grid shrink-0 overflow-hidden rounded-lg bg-surface sm:flex sm:h-13.5 wide:h-14.75"
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
      <p className="hidden shrink-0 items-center gap-1 px-5 text-xs text-level3 wide:flex">
        <span aria-hidden className="text-bid">
          ●
        </span>
        <span aria-hidden className="text-ask">
          ●
        </span>{' '}
        best across venues
      </p>
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
      className="group relative flex min-w-0 items-center gap-2.5 border-rule px-4 py-2 text-level3 not-last:border-b hover:bg-raised aria-[current=page]:bg-raised aria-[current=page]:inset-shadow-selected sm:flex-1 sm:py-0 sm:not-last:border-r sm:not-last:border-b-0"
    >
      {lifts > 0 && <span key={lifts} aria-hidden className="pointer-events-none absolute inset-0 wash" />}
      <span className="relative flex min-w-0 flex-1 items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 leading-none">
          <span className="text-base font-semibold text-level1">{VENUES[venue].label}</span>
          <span className="truncate text-xs text-level3 group-data-lifting:text-level1">{VENUES[venue].chain}</span>
        </span>
        <Quotes row={row} />
      </span>
    </Link>
  )
}

function Quotes({ row }: { row: CompareRow | undefined }) {
  if (!row) return null
  if (row.status === 'unlisted') return <span className="shrink-0 text-xs text-level3">Not shown</span>
  if (row.status === 'syncing' && !row.mid) return null
  const live = row.status === 'live'
  const value = `num text-base font-medium ${live ? 'text-level1' : 'text-level3'}`
  if (!live)
    return (
      <span className="flex shrink-0 flex-col items-end gap-1.5 leading-none">
        <span className="flex items-center gap-1.5 text-xs font-medium text-warn">
          <span aria-hidden className="size-1.5 rounded-sm bg-warn" />
          Reconnecting
        </span>
        <span className="flex gap-3">
          <span className={`w-21 text-right ${value}`}>
            <span className="sr-only">bid </span>
            {row.bid || '—'}
          </span>
          <span className={`w-21 text-right ${value}`}>
            <span className="sr-only">ask </span>
            {row.ask || '—'}
          </span>
          <span className={`w-14 text-right ${value}`}>
            <span className="sr-only">basis </span>
            {row.basisBps || '—'}
          </span>
        </span>
      </span>
    )
  return (
    <span className="flex shrink-0 gap-3 leading-none">
      <Quote label="Bid" value={row.bid} best={row.bestBid && 'bid'} className={`w-21 ${value}`} />
      <Quote label="Ask" value={row.ask} best={row.bestAsk && 'ask'} className={`w-21 ${value}`} />
      <Quote label="Basis" value={row.basisBps} best={false} className={`w-14 ${value}`} />
    </span>
  )
}

function Quote({
  label,
  value,
  best,
  className,
}: {
  label: string
  value: string
  best: 'bid' | 'ask' | false
  className: string
}) {
  return (
    <span className="flex flex-col items-end gap-1.5">
      <span className="flex items-center gap-1 text-xs text-level3 group-data-lifting:text-level1">
        {best && (
          <span aria-hidden className={best === 'bid' ? 'text-bid' : 'text-ask'}>
            ●
          </span>
        )}
        {best ? <span className="sr-only">best </span> : null}
        {label}
      </span>
      <span className={`text-right ${className}`}>{value || '—'}</span>
    </span>
  )
}
