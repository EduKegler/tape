import { useEffect, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useConnection } from 'wagmi'
import { z } from 'zod'
import type { Address } from 'viem'
import { selectHistory, summarize, toCsv } from '@tape/trade/history'
import type { FundingPayment, RealizedFill, Totals } from '@tape/trade/history'
import { amount, format } from '@tape/trade/money'
import type { TradeError, TradeVenueId } from '@tape/trade/types'
import { HISTORY_VENUES, historyQuery, useDydxAddress } from '#/trade/history'
import { NETWORK, VENUES } from '#/site'
import { lastHistorySearch } from './HistoryLink'
import { Panel, Segmented } from './Panel'
import { Button, Table } from './primitives'
import type { Column } from './primitives'

const WALLET = /^0x[0-9a-fA-F]{40}$/
const DYDX_ADDRESS = /^dydx1[0-9a-z]{38}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

export const historySearch = z.object({
  address: z.string().regex(WALLET).optional().catch(undefined),
  dydx: z.string().regex(DYDX_ADDRESS).optional().catch(undefined),
  venue: z
    .enum(['all', ...HISTORY_VENUES])
    .default('all')
    .catch('all'),
  market: z.string().min(1).optional().catch(undefined),
  from: z.string().regex(DAY).optional().catch(undefined),
  to: z.string().regex(DAY).optional().catch(undefined),
  kind: z.enum(['all', 'fills', 'funding']).default('all').catch('all'),
  totals: z.enum(['venue', 'month']).default('venue').catch('venue'),
})

export type HistorySearch = z.infer<typeof historySearch>

type Row =
  | { readonly kind: 'fill'; readonly time: number; readonly fill: RealizedFill }
  | { readonly kind: 'funding'; readonly time: number; readonly payment: FundingPayment }

const ROW = 24
const DAY_MS = 86_400_000

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const utcTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const money = (value: string) => format(amount(value), 2)

function presets(now: number): { label: string; from?: string; to?: string }[] {
  const year = new Date(now).getUTCFullYear()
  return [
    { label: '30d', from: utcDay(now - 29 * DAY_MS) },
    { label: '90d', from: utcDay(now - 89 * DAY_MS) },
    { label: 'YTD', from: `${year}-01-01` },
    { label: String(year - 1), from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
    { label: 'All' },
  ]
}

export function History({ search, onSearch }: { search: HistorySearch; onSearch: (next: HistorySearch) => void }) {
  const [now] = useState(() => Date.now())
  useEffect(() => lastHistorySearch.setState(() => search), [search])
  const { address: connected } = useConnection()
  const wallet = (search.address ?? connected ?? null)?.toLowerCase() ?? null
  const owned = wallet !== null && wallet === connected?.toLowerCase() ? (wallet as Address) : null
  const derived = useDydxAddress(owned)
  const dydx = search.dydx ?? derived
  const addressOf = (venue: TradeVenueId) => (venue === 'dydx' ? dydx : wallet)
  const results = useQueries({ queries: HISTORY_VENUES.map((venue) => historyQuery(venue, addressOf(venue))) })
  const selected = selectHistory(
    results.flatMap((result) => (result.data ? [result.data] : [])),
    {
      venue: search.venue === 'all' ? null : search.venue,
      market: search.market ?? null,
      from: search.from ?? null,
      to: search.to ?? null,
    },
  )
  const failed = HISTORY_VENUES.filter((_, index) => results[index]!.error).map((venue) => VENUES[venue].label)
  const unread = failed.length > 0 ? new Intl.ListFormat('en').format(failed) : null
  const totals = summarize(selected.fills, selected.funding, (entry) =>
    search.totals === 'venue' ? VENUES[entry.venue].label : new Date(entry.time).toISOString().slice(0, 7),
  )
  const all = search.totals === 'venue' ? summarize(selected.fills, selected.funding, () => 'All venues') : []
  const fills = search.kind === 'funding' ? [] : selected.fills
  const payments = search.kind === 'fills' ? [] : selected.funding
  const set = (patch: Partial<HistorySearch>) => onSearch({ ...search, ...patch })
  const exportCsv = () => {
    const blob = new Blob([toCsv(fills, payments, NETWORK)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `tape-history-${NETWORK}-${search.from ?? 'start'}-${search.to ?? utcDay(now)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <main className="grid flex-1 gap-px p-px lg:min-h-0 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <Panel title="Accounts">
        <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm">
          <Addresses
            typed={{ wallet: search.address ?? '', dydx: search.dydx ?? '' }}
            fallback={{ wallet: connected?.toLowerCase() ?? null, dydx: derived }}
            onSubmit={(next) => set({ address: next.wallet || undefined, dydx: next.dydx || undefined })}
          />
          <ul className="flex flex-col gap-2" aria-label="Venues">
            {HISTORY_VENUES.map((venue, index) => (
              <VenueStatus
                key={venue}
                venue={venue}
                address={addressOf(venue)}
                result={results[index]!}
                onRefresh={() => void results[index]!.refetch()}
              />
            ))}
          </ul>
          <p className="text-xs/snug text-level3">
            History is read from each venue&apos;s public API with no key. Realized PnL is before fees and funding, and
            net is realized minus fees plus funding. Days are UTC.
          </p>
        </div>
      </Panel>
      <div className="grid gap-px lg:min-h-0 lg:grid-rows-[auto_minmax(0,1fr)]">
        <Panel
          title="Totals"
          aside={
            <Segmented
              label="Totals by"
              value={search.totals}
              onChange={(by) => set({ totals: by })}
              options={[
                { value: 'venue', label: 'By venue' },
                { value: 'month', label: 'By month' },
              ]}
            />
          }
        >
          {unread && (
            <p className="mx-3 my-1.5 border-l-2 border-warn pl-2 text-sm text-level1">
              Could not read {unread}. These totals leave {failed.length > 1 ? 'them' : 'it'} out.
            </p>
          )}
          <TotalsTable
            rows={[...totals, ...all]}
            first={search.totals === 'venue' ? 'Venue' : 'Month'}
            empty={unread ? `No totals to show. ${unread} could not be read.` : 'Nothing in this period.'}
          />
        </Panel>
        <Panel
          title="Fills and funding"
          aside={
            <Button look="secondary" size="sm" onClick={exportCsv} disabled={fills.length + payments.length === 0}>
              Export CSV
            </Button>
          }
        >
          <div className="flex h-full min-h-80 flex-col">
            <Filters search={search} markets={selected.markets} now={now} set={set} />
            <Rows
              fills={fills}
              payments={payments}
              empty={unread ? `Nothing to show. ${unread} could not be read.` : 'No fills or funding in this period.'}
            />
          </div>
        </Panel>
      </div>
    </main>
  )
}

function Addresses({
  typed,
  fallback,
  onSubmit,
}: {
  typed: { wallet: string; dydx: string }
  fallback: { wallet: string | null; dydx: string | null }
  onSubmit: (next: { wallet: string; dydx: string }) => void
}) {
  const [draft, setDraft] = useState(typed)
  const walletOk = draft.wallet === '' || WALLET.test(draft.wallet)
  const dydxOk = draft.dydx === '' || DYDX_ADDRESS.test(draft.dydx)
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (walletOk && dydxOk) onSubmit(draft)
      }}
    >
      <label className="flex flex-col gap-1 text-level3">
        Wallet, for Hyperliquid and Orderly
        <input
          value={draft.wallet}
          onChange={(event) => setDraft({ ...draft, wallet: event.target.value.trim() })}
          placeholder={fallback.wallet ?? '0x…'}
          spellCheck={false}
          aria-invalid={!walletOk}
          className="num h-7 rounded-sm border border-edge bg-inset px-2 text-sm text-level1"
        />
      </label>
      <label className="flex flex-col gap-1 text-level3">
        dYdX address
        <input
          value={draft.dydx}
          onChange={(event) => setDraft({ ...draft, dydx: event.target.value.trim() })}
          placeholder={fallback.dydx ?? 'dydx1…'}
          spellCheck={false}
          aria-invalid={!dydxOk}
          className="num h-7 rounded-sm border border-edge bg-inset px-2 text-sm text-level1"
        />
      </label>
      <Button look="primary" size="sm" type="submit" disabled={!walletOk || !dydxOk} className="self-start">
        Read history
      </Button>
    </form>
  )
}

function VenueStatus({
  venue,
  address,
  result,
  onRefresh,
}: {
  venue: TradeVenueId
  address: string | null
  result: ReturnType<typeof useQueries<ReturnType<typeof historyQuery>[]>>[number]
  onRefresh: () => void
}) {
  const label = VENUES[venue].label
  const history = result.data
  return (
    <li className="flex flex-col gap-1 border-t border-rule pt-2" data-history-venue={venue}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-level1">{label}</span>
        {address && (
          <Button look="quiet" onClick={onRefresh} disabled={result.isFetching}>
            {result.isFetching ? 'Reading…' : 'Refresh'}
          </Button>
        )}
      </div>
      {!address && (
        <p className="text-level3">
          {venue === 'dydx'
            ? 'Paste a dYdX address, or unlock dYdX in the order ticket.'
            : 'Connect a wallet or paste an address.'}
        </p>
      )}
      {address && <p className="num text-xs break-all text-level3">{address}</p>}
      {result.error && (
        <p role="alert" className="border-l-2 border-warn pl-2 text-level1">
          Could not read {label} history. {readFailure(result.error.error)}{' '}
          <Button
            look="quiet"
            onClick={onRefresh}
            disabled={result.isFetching}
            className="underline underline-offset-2"
          >
            Retry
          </Button>
        </p>
      )}
      {history && (
        <p className="num text-level2">
          {history.fills.length} fills · {history.funding.length} funding payments
        </p>
      )}
      {history?.gaps.map((gap) => (
        <p key={gap} className="text-xs/snug text-level3">
          {gap}
        </p>
      ))}
    </li>
  )
}

const READ_FAILURES: Partial<Record<TradeError['kind'], string>> = {
  unreachable: 'The venue did not answer.',
  'rate-limited': 'The venue is limiting requests. Retry in a few seconds.',
  rejected: 'The venue refused the request.',
}

const readFailure = (error: TradeError) => READ_FAILURES[error.kind] ?? 'Tape could not read the answer.'

function Filters({
  search,
  markets,
  now,
  set,
}: {
  search: HistorySearch
  markets: string[]
  now: number
  set: (patch: Partial<HistorySearch>) => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-rule px-3 py-1.5 text-sm">
      <Segmented
        label="Venue"
        value={search.venue}
        onChange={(venue) => set({ venue, market: undefined })}
        options={[
          { value: 'all', label: 'All' },
          ...HISTORY_VENUES.map((venue) => ({ value: venue, label: VENUES[venue].label })),
        ]}
      />
      <Segmented
        label="Type"
        value={search.kind}
        onChange={(kind) => set({ kind })}
        options={[
          { value: 'all', label: 'All' },
          { value: 'fills', label: 'Fills' },
          { value: 'funding', label: 'Funding' },
        ]}
      />
      <label className="flex items-center gap-1 text-level3">
        Market
        <select
          value={search.market ?? ''}
          onChange={(event) => set({ market: event.target.value || undefined })}
          className="h-6 rounded-sm border border-edge bg-inset px-1 text-level1"
        >
          <option value="">All</option>
          {markets.map((market) => (
            <option key={market} value={market}>
              {market}
            </option>
          ))}
        </select>
      </label>
      <div role="group" aria-label="Period" className="flex items-center gap-1 text-level3">
        {presets(now).map((preset) => (
          <Button
            key={preset.label}
            look="toggle"
            aria-pressed={search.from === preset.from && search.to === preset.to}
            onClick={() => set({ from: preset.from, to: preset.to })}
          >
            {preset.label}
          </Button>
        ))}
        <input
          type="date"
          aria-label="From"
          value={search.from ?? ''}
          onChange={(event) => set({ from: event.target.value || undefined })}
          className="num h-6 rounded-sm border border-edge bg-inset px-1 text-level1"
        />
        <input
          type="date"
          aria-label="To"
          value={search.to ?? ''}
          onChange={(event) => set({ to: event.target.value || undefined })}
          className="num h-6 rounded-sm border border-edge bg-inset px-1 text-level1"
        />
      </div>
    </div>
  )
}

const TOTALS_HEIGHT = 'h-36'

function TotalsTable({ rows, first, empty }: { rows: Totals[]; first: string; empty: string }) {
  if (rows.length === 0) return <p className={`${TOTALS_HEIGHT} p-3 text-sm text-level3`}>{empty}</p>
  const columns: Column<Totals>[] = [
    {
      header: first,
      cell: (total) => (
        <>
          {total.group}
          {total.asset !== 'USDC' && <span className="text-level3"> · {total.asset}</span>}
        </>
      ),
    },
    { header: 'Fills', cell: (total) => total.fills },
    { header: 'Realized PnL', cell: (total) => <Signed value={total.realized} /> },
    { header: 'Fees', cell: (total) => money(total.fees) },
    { header: 'Funding', cell: (total) => <Signed value={total.funding} /> },
    { header: 'Net', cell: (total) => <Signed value={total.net} /> },
  ]
  return (
    <div className={`${TOTALS_HEIGHT} overflow-y-auto`}>
      <Table rows={rows} rowKey={(total) => `${total.group}:${total.asset}`} columns={columns} />
    </div>
  )
}

function Signed({ value, exact = false }: { value: string; exact?: boolean }) {
  const shown = exact ? value : money(value)
  return <span className={Number(value) === 0 ? 'text-level3' : 'text-level1'}>{shown}</span>
}

const COLUMNS = 'grid-cols-[11rem_6rem_minmax(6rem,1fr)_4rem_4rem_1fr_1fr_1fr_1fr_1fr]'

function Rows({ fills, payments, empty }: { fills: RealizedFill[]; payments: FundingPayment[]; empty: string }) {
  const rows = [
    ...fills.map((fill): Row => ({ kind: 'fill', time: fill.time, fill })),
    ...payments.map((payment): Row => ({ kind: 'funding', time: payment.time, payment })),
  ].sort((left, right) => right.time - left.time)
  const scroller = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 12,
  })
  return (
    <div
      role="table"
      aria-label="Fills and funding"
      aria-rowcount={rows.length + 1}
      className="num flex min-h-0 flex-1 flex-col overflow-x-auto text-sm"
    >
      <div
        role="row"
        aria-rowindex={1}
        className={`grid h-6 min-w-240 shrink-0 ${COLUMNS} items-center gap-2 px-3 text-xs text-level3`}
      >
        <span role="columnheader">Time (UTC)</span>
        <span role="columnheader">Venue</span>
        <span role="columnheader">Market</span>
        <span role="columnheader">Type</span>
        <span role="columnheader">Side</span>
        <span role="columnheader" className="text-right">
          Size
        </span>
        <span role="columnheader" className="text-right">
          Price
        </span>
        <span role="columnheader" className="text-right">
          Fee
        </span>
        <span role="columnheader" className="text-right">
          Realized PnL
        </span>
        <span role="columnheader" className="text-right">
          Funding
        </span>
      </div>
      <div
        ref={scroller}
        role="rowgroup"
        aria-label="History rows"
        // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex -- axe's scrollable-region-focusable: the keyboard scrolls the rows from here
        tabIndex={0}
        className="min-h-0 min-w-240 flex-1 overflow-y-auto"
      >
        {rows.length === 0 && (
          <div role="row">
            <span role="cell" className="block px-3 py-2 text-sm text-level3">
              {empty}
            </span>
          </div>
        )}
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index]
            if (!row) return null
            const entry = row.kind === 'fill' ? row.fill : row.payment
            return (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 2}
                className={`absolute inset-x-0 grid h-6 ${COLUMNS} items-center gap-2 border-t border-rule px-3 text-level2`}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <span role="cell" className="whitespace-nowrap">
                  {utcTime(row.time)}
                </span>
                <span role="cell">{VENUES[entry.venue].label}</span>
                <span role="cell" className="truncate text-level1">
                  {entry.symbol}
                </span>
                {row.kind === 'fill' ? <FillCells fill={row.fill} /> : <FundingCells payment={row.payment} />}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function FillCells({ fill }: { fill: RealizedFill }) {
  return (
    <>
      <span role="cell">{fill.liquidation ? 'Liquidation' : 'Fill'}</span>
      <span role="cell" className={fill.side === 'buy' ? 'text-bid' : 'text-ask'}>
        {fill.side === 'buy' ? 'Buy' : 'Sell'}
      </span>
      <span role="cell" className="text-right">
        {fill.size}
      </span>
      <span role="cell" className="text-right">
        {fill.px}
      </span>
      <span role="cell" className="text-right">
        {fill.fee}
      </span>
      <span
        role="cell"
        className="text-right"
        title={fill.pnlSource === 'computed' ? 'Computed by Tape' : `As ${VENUES[fill.venue].label} reports it`}
      >
        <Signed value={fill.pnl} exact />
        {fill.pnlSource === 'computed' && <span className="text-level3">*</span>}
      </span>
      <span role="cell" />
    </>
  )
}

function FundingCells({ payment }: { payment: FundingPayment }) {
  return (
    <>
      <span role="cell">Funding</span>
      <span role="cell" />
      <span role="cell" className="text-right">
        {payment.position ?? ''}
      </span>
      <span role="cell" />
      <span role="cell" />
      <span role="cell" />
      <span role="cell" className="text-right">
        <Signed value={payment.amount} exact />
      </span>
    </>
  )
}
