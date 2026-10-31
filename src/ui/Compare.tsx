import { useNavigate } from '@tanstack/react-router'
import type { Base, VenueId } from '@tape/core/ids'
import { useFrame } from '#/client/hooks'
import type { CompareRow } from '#/core/topics'
import { VENUES } from '#/site'
import { Panel, useRowKeys } from './Panel'
import { TopicStatus } from './PanelStatus'
import { Table } from './primitives'
import type { Column } from './primitives'

const listed = (row: CompareRow) => row.status !== 'unlisted'

function Quote({ value, best, side }: { value: string; best: boolean; side: 'bid' | 'ask' }) {
  if (!best) return value || '—'
  return (
    <span className={side === 'bid' ? 'text-bid' : 'text-ask'}>
      <span aria-hidden className="mr-1 text-xs">
        ●
      </span>
      <span className="sr-only">Best {side} </span>
      {value}
    </span>
  )
}

const columns: Column<CompareRow>[] = [
  { header: 'Venue', cell: (row) => VENUES[row.venue].label },
  {
    header: 'Bid',
    cell: (row) =>
      listed(row) ? (
        <Quote value={row.bid} best={row.bestBid} side="bid" />
      ) : (
        <span className="font-sans text-level3">Not shown</span>
      ),
  },
  { header: 'Ask', cell: (row) => listed(row) && <Quote value={row.ask} best={row.bestAsk} side="ask" /> },
  { header: 'Basis', cell: (row) => listed(row) && (row.basisBps || '—') },
]
const NO_ROWS: readonly CompareRow[] = []

export function Compare({ base, current }: { base: Base; current: VenueId }) {
  const rows = useFrame({ kind: 'compare', base }, (frame) => frame?.rows ?? NO_ROWS)
  const navigate = useNavigate()
  const keys = useRowKeys()
  return (
    <Panel
      title="Venues"
      status={<TopicStatus topic={{ kind: 'compare', base }} />}
      aside={<span className="text-xs text-level3">{base} · basis in bps</span>}
    >
      <div role="group" aria-label="Venue list" {...keys}>
        <Table
          rows={rows}
          rowKey={(row) => row.venue}
          columns={columns}
          isCurrent={(row) => row.venue === current}
          onRowClick={(row) =>
            listed(row)
            && void navigate({ to: '/$venue/$base', params: { venue: row.venue, base }, search: (search) => search })
          }
        />
      </div>
    </Panel>
  )
}
