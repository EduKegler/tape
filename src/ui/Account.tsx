import { useState } from 'react'
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table'
import type { ColumnDef, RowData } from '@tanstack/react-table'
import { useQuery } from '@tanstack/react-query'
import { useSelector } from '@tanstack/react-store'
import type { Base, VenueId } from '@tape/core/ids'
import { closeIntent } from '@tape/trade/intent'
import type { AccountRef, Bps, Command, Fill, OpenOrder, Position } from '@tape/trade/types'
import { useAccountView, useTradeCommands, useTradeSession } from '#/trade/hooks'
import type { TradeSession } from '#/trade/hooks'
import { DepositButton } from './Deposit'
import { Panel, Segmented } from './Panel'
import { specsQuery } from './queries'
import { slippageBps } from './ticket-store'
import { SiteReadOnly } from './Ticket'
import { TradeNote } from './TradeNote'

type Tab = 'positions' | 'orders' | 'fills'
const features = tableFeatures({})

export function Account({ venue, base }: { venue: VenueId; base: Base }) {
  const session = useTradeSession(venue)
  const ref = session.status === 'ready' || session.status === 'setup' ? session.ref : null
  return (
    <Panel
      title="Account"
      aside={
        ref ? (
          <span className="flex items-center gap-2">
            <DepositButton account={ref} />
            <span className="num text-[11px] text-level3">{ref.network}</span>
          </span>
        ) : null
      }
    >
      {ref ? (
        <AccountBody
          key={`${ref.venue}:${ref.network}:${ref.owner}`}
          account={ref}
          base={base}
          leverage={session.status === 'ready' && session.capabilities.leverage}
        />
      ) : (
        <div className="p-3 text-[12px] text-level3">{message(session)}</div>
      )}
    </Panel>
  )
}

function message(session: TradeSession) {
  if (session.status === 'read-only')
    return session.cause === 'site-reads-only' ? <SiteReadOnly /> : 'This venue is read only in Tape.'
  if (session.status === 'disconnected') return 'Connect a wallet to see positions and orders.'
  return 'Trading is not available here.'
}

function AccountBody({ account, base, leverage }: { account: AccountRef; base: Base; leverage: boolean }) {
  const [tab, setTab] = useState<Tab>('positions')
  const { view, error } = useAccountView(account)
  const { run, last, inFlight } = useTradeCommands(account)
  const specs = useQuery(specsQuery(account.venue))
  const slippage = useSelector(slippageBps, (s) => s) as Bps
  const symbol = specs.data?.get(base)?.venueSymbol
  const snapshot = view?.kind === 'live' ? view.snapshot : null
  const busy = (c: Command) => inFlight.some((x) => JSON.stringify(x) === JSON.stringify(c))
  const [closeError, setCloseError] = useState<string | null>(null)
  const close = (p: Position) => {
    const spec = [...(specs.data?.values() ?? [])].find((s) => s.venueSymbol === p.symbol)
    const intent = spec ? closeIntent(spec, p, slippage) : null
    setCloseError(
      intent ? null : `${p.symbol} ${p.size} does not fit the size step Tape knows for it. Close it on the venue.`,
    )
    if (intent) run({ kind: 'place', intent })
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-rule px-3 py-1.5 text-[12px]">
        <Segmented
          label="Account view"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'positions', label: `Positions${snapshot ? ` ${snapshot.positions.length}` : ''}` },
            { value: 'orders', label: `Orders${snapshot ? ` ${snapshot.orders.length}` : ''}` },
            { value: 'fills', label: 'Fills' },
          ]}
        />
        {snapshot && (
          <span className="num text-level3">
            Equity <span className="text-level1">{snapshot.equity}</span> · Available{' '}
            <span className="text-level1">{snapshot.available}</span>
          </span>
        )}
        {symbol && snapshot && snapshot.orders.some((o) => o.symbol === symbol) && (
          <button
            type="button"
            onClick={() => run({ kind: 'cancel-all', symbol })}
            className="text-level3 hover:text-ask"
          >
            Cancel all {base}
          </button>
        )}
        {leverage && symbol && <LeverageControl onSet={(n) => run({ kind: 'leverage', symbol, leverage: n })} />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="p-2">
            <TradeNote error={error} />
          </div>
        )}
        {!view && !error && <p className="p-3 text-[12px] text-level3">Loading account…</p>}
        {view?.kind === 'unknown' && (
          <p className="p-3 text-[12px] text-level3">Enable trading to read this account.</p>
        )}
        {view?.kind === 'empty' && (
          <p className="p-3 text-[12px] text-level3">No account on this venue yet. Deposit to start.</p>
        )}
        {closeError && (
          <div className="p-2">
            <TradeNote error={{ kind: 'invalid-order', detail: closeError }} />
          </div>
        )}
        {snapshot && tab === 'positions' && <Positions rows={snapshot.positions} busy={last.pending} onClose={close} />}
        {snapshot && tab === 'orders' && (
          <Orders
            rows={snapshot.orders}
            busy={(o) => busy({ kind: 'cancel', order: o.ref })}
            onCancel={(o) => run({ kind: 'cancel', order: o.ref })}
          />
        )}
        {snapshot && tab === 'fills' && <Fills rows={snapshot.fills} />}
      </div>
      {last.command && last.command.kind !== 'place' && (
        <div className="shrink-0 p-2">
          <TradeNote error={last.error} outcome={last.outcome} />
        </div>
      )}
      {last.command?.kind === 'place' && last.command.intent.reduceOnly && (
        <div className="shrink-0 p-2">
          <TradeNote error={last.error} outcome={last.outcome} lookup={last.lookup} />
        </div>
      )}
    </div>
  )
}

function LeverageControl({ onSet }: { onSet: (n: number) => void }) {
  const [value, setValue] = useState('5')
  const n = Number(value)
  return (
    <form
      className="flex items-center gap-1 text-level3"
      onSubmit={(e) => {
        e.preventDefault()
        if (Number.isInteger(n) && n >= 1 && n <= 50) onSet(n)
      }}
    >
      <label htmlFor="leverage">Leverage</label>
      <input
        id="leverage"
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value.trim())}
        className="num w-10 rounded-sm border border-rule bg-surface px-1 text-level1"
      />
      <button type="submit" className="hover:text-level1">
        Set
      </button>
    </form>
  )
}

function Table<T extends RowData>({
  rows,
  columns,
  empty,
}: {
  rows: T[]
  columns: ColumnDef<typeof features, T>[]
  empty: string
}) {
  const table = useTable({ features, columns, data: rows })
  if (rows.length === 0) return <p className="p-3 text-[12px] text-level3">{empty}</p>
  return (
    <table className="num w-full text-[11px]">
      <thead>
        {table.getHeaderGroups().map((g) => (
          <tr key={g.id} className="h-6 text-level3">
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
          <tr key={r.id} className="h-7 border-t border-rule text-level2">
            {r.getAllCells().map((c, i) => (
              <td key={c.id} className={i === 0 ? 'pl-3 font-sans text-level1' : 'pr-3 text-right'}>
                <table.FlexRender cell={c} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const side = (s: 'long' | 'short' | 'buy' | 'sell') => (
  <span className={s === 'long' || s === 'buy' ? 'text-bid' : 'text-ask'}>{s}</span>
)

function Positions({
  rows,
  busy,
  onClose,
}: {
  rows: readonly Position[]
  busy: boolean
  onClose: (p: Position) => void
}) {
  const h = createColumnHelper<typeof features, Position>()
  const columns = h.columns([
    h.accessor('symbol', { header: 'Market' }),
    h.accessor('side', { header: 'Side', cell: (c) => side(c.getValue()) }),
    h.accessor('size', { header: 'Size' }),
    h.accessor('entry', { header: 'Entry' }),
    h.accessor('unrealizedPnl', { header: 'PnL' }),
    h.accessor('liquidation', { header: 'Liq.', cell: (c) => c.getValue() ?? '—' }),
    h.display({
      id: 'close',
      header: '',
      cell: (c) => (
        <button
          type="button"
          disabled={busy}
          onClick={() => onClose(c.row.original)}
          className="text-level3 hover:text-ask disabled:opacity-40"
        >
          Close
        </button>
      ),
    }),
  ])
  return <Table rows={[...rows]} columns={columns} empty="No open positions." />
}

function Orders({
  rows,
  busy,
  onCancel,
}: {
  rows: readonly OpenOrder[]
  busy: (o: OpenOrder) => boolean
  onCancel: (o: OpenOrder) => void
}) {
  const h = createColumnHelper<typeof features, OpenOrder>()
  const columns = h.columns([
    h.accessor('symbol', { header: 'Market' }),
    h.accessor('side', { header: 'Side', cell: (c) => side(c.getValue()) }),
    h.accessor('kind', { header: 'Type' }),
    h.accessor('px', { header: 'Price', cell: (c) => c.getValue() ?? 'market' }),
    h.accessor('size', { header: 'Size' }),
    h.accessor('reduceOnly', { header: 'Reduce', cell: (c) => (c.getValue() ? 'yes' : '') }),
    h.display({
      id: 'cancel',
      header: '',
      cell: (c) => (
        <button
          type="button"
          disabled={busy(c.row.original)}
          onClick={() => onCancel(c.row.original)}
          className="text-level3 hover:text-ask disabled:opacity-40"
        >
          Cancel
        </button>
      ),
    }),
  ])
  return <Table rows={[...rows]} columns={columns} empty="No open orders." />
}

function Fills({ rows }: { rows: readonly Fill[] }) {
  const h = createColumnHelper<typeof features, Fill>()
  const columns = h.columns([
    h.accessor('symbol', { header: 'Market' }),
    h.accessor('side', { header: 'Side', cell: (c) => side(c.getValue()) }),
    h.accessor('px', { header: 'Price' }),
    h.accessor('size', { header: 'Size' }),
    h.accessor('fee', { header: 'Fee' }),
    h.accessor('time', { header: 'Time', cell: (c) => new Date(c.getValue()).toLocaleTimeString('en-GB') }),
  ])
  return <Table rows={[...rows]} columns={columns} empty="No fills yet." />
}
