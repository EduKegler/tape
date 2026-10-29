import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table'
import { useNavigate } from '@tanstack/react-router'
import { useFrame } from '#/client/hooks'
import type { Base, VenueId } from '@tape/core/ids'
import type { CompareRow } from '#/core/topics'
import { VENUES } from '@tape/venues/index'
import { Panel } from './Panel'

const features = tableFeatures({})
const helper = createColumnHelper<typeof features, CompareRow>()
const columns = helper.columns([
  helper.accessor('venue', { header: 'Venue', cell: (c) => VENUES[c.getValue()].label }),
  helper.accessor('bid', { header: 'Bid', cell: (c) => <span className={c.row.original.bestBid ? 'text-bid' : ''}>{c.getValue() || '—'}</span> }),
  helper.accessor('ask', { header: 'Ask', cell: (c) => <span className={c.row.original.bestAsk ? 'text-ask' : ''}>{c.getValue() || '—'}</span> }),
  helper.accessor('basisBps', { header: 'Basis', cell: (c) => c.getValue() || '—' }),
])
const NO_ROWS: CompareRow[] = []

/** The same base asset on every venue. Best bid and ask are flagged from exact rescaled integers. */
export function Compare({ base, current }: { base: Base; current: VenueId }) {
  const rows = useFrame({ kind: 'compare', base }, (f) => (f?.rows as CompareRow[] | undefined) ?? NO_ROWS)
  const table = useTable({ features, columns, data: rows })
  const navigate = useNavigate()
  return (
    <Panel title="Venues" aside={<span className="text-[11px] text-level3">{base} · basis in bps</span>}>
      <table className="num w-full text-[11px]">
        <thead>
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id} className="h-6 text-[11px] text-level3">
              {g.headers.map((h, i) => (
                <th key={h.id} className={`font-normal ${i === 0 ? 'pl-3 text-left' : 'pr-3 text-right'}`}>
                  <table.FlexRender header={h} />
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((r) => (
            <tr
              key={r.id}
              onClick={() => void navigate({ to: '/$venue/$base', params: { venue: r.original.venue, base }, search: (s) => s })}
              className={`h-7 cursor-pointer border-t border-rule hover:bg-level1/5 ${r.original.venue === current ? 'text-level1' : 'text-level2'}`}
            >
              {r.getAllCells().map((c, i) => (
                <td key={c.id} className={i === 0 ? 'pl-3 font-sans' : 'pr-3 text-right'}>
                  <table.FlexRender cell={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}
