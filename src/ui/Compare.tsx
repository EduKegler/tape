import { useNavigate } from '@tanstack/react-router'
import type { Base, VenueId } from '@tape/core/ids'
import { useFrame } from '#/client/hooks'
import type { CompareRow } from '#/core/topics'
import { VENUES } from '#/site'
import { Panel } from './Panel'
import { Table } from './primitives'
import type { Column } from './primitives'

const columns: Column<CompareRow>[] = [
  { header: 'Venue', cell: (r) => VENUES[r.venue].label },
  { header: 'Bid', cell: (r) => <span className={r.bestBid ? 'text-bid' : ''}>{r.bid || '—'}</span> },
  { header: 'Ask', cell: (r) => <span className={r.bestAsk ? 'text-ask' : ''}>{r.ask || '—'}</span> },
  { header: 'Basis', cell: (r) => r.basisBps || '—' },
]
const NO_ROWS: CompareRow[] = []

export function Compare({ base, current }: { base: Base; current: VenueId }) {
  const rows = useFrame({ kind: 'compare', base }, (f) => (f?.rows as CompareRow[] | undefined) ?? NO_ROWS)
  const navigate = useNavigate()
  return (
    <Panel title="Venues" aside={<span className="text-xs text-level3">{base} · basis in bps</span>}>
      <Table
        rows={rows}
        rowKey={(r) => r.venue}
        columns={columns}
        isCurrent={(r) => r.venue === current}
        onRowClick={(r) => void navigate({ to: '/$venue/$base', params: { venue: r.venue, base }, search: (s) => s })}
      />
    </Panel>
  )
}
