import { useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useConnection } from 'wagmi'
import { z } from 'zod'
import type { Address } from 'viem'
import { selectHistory, summarize, toCsv } from '@tape/trade/history'
import type { FundingPayment, RealizedFill, Totals } from '@tape/trade/history'
import { amount, format } from '@tape/trade/money'
import type { TradeVenueId } from '@tape/trade/types'
import { HISTORY_VENUES, historyQuery, useDydxAddress } from '#/trade/history'
import { NETWORK, VENUES } from '#/site'
import { Panel, Segmented } from './Panel'
import { TradeNote } from './TradeNote'

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

type HistorySearch = z.infer<typeof historySearch>

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
  const { address: connected } = useConnection()
  const wallet = (search.address ?? connected ?? null)?.toLowerCase() ?? null
  const owned = wallet !== null && wallet === connected?.toLowerCase() ? (wallet as Address) : null
  const derived = useDydxAddress(owned)
  const dydx = search.dydx ?? derived
  const addressOf = (venue: TradeVenueId) => (venue === 'dydx' ? dydx : wallet)
  const results = useQueries({ queries: HISTORY_VENUES.map((v) => historyQuery(v, addressOf(v))) })
  const selected = selectHistory(
    results.flatMap((r) => (r.data ? [r.data] : [])),
    {
      venue: search.venue === 'all' ? null : search.venue,
      market: search.market ?? null,
      from: search.from ?? null,
      to: search.to ?? null,
    },
  )
  const totals = summarize(selected.fills, selected.funding, (e) =>
    search.totals === 'venue' ? VENUES[e.venue].label : new Date(e.time).toISOString().slice(0, 7),
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
        <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-[12px]">
          <Addresses
            typed={{ wallet: search.address ?? '', dydx: search.dydx ?? '' }}
            fallback={{ wallet: connected?.toLowerCase() ?? null, dydx: derived }}
            onSubmit={(next) => set({ address: next.wallet || undefined, dydx: next.dydx || undefined })}
          />
          <ul className="flex flex-col gap-2" aria-label="Venues">
            {HISTORY_VENUES.map((venue, i) => (
              <VenueStatus
                key={venue}
                venue={venue}
                address={addressOf(venue)}
                result={results[i]!}
                onRefresh={() => void results[i]!.refetch()}
              />
            ))}
          </ul>
          <p className="text-[11px] leading-snug text-level3">
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
          <TotalsTable rows={[...totals, ...all]} first={search.totals === 'venue' ? 'Venue' : 'Month'} />
        </Panel>
        <Panel
          title="Fills and funding"
          aside={
            <button
              type="button"
              onClick={exportCsv}
              disabled={fills.length + payments.length === 0}
              className="rounded-full border border-rule px-2.5 py-0.5 text-[12px] text-level2 hover:text-level1 disabled:opacity-40"
            >
              Export CSV
            </button>
          }
        >
          <div className="flex h-full min-h-80 flex-col">
            <Filters search={search} markets={selected.markets} now={now} set={set} />
            <Rows fills={fills} payments={payments} />
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
      onSubmit={(e) => {
        e.preventDefault()
        if (walletOk && dydxOk) onSubmit(draft)
      }}
    >
      <label className="flex flex-col gap-1 text-level3">
        Wallet, for Hyperliquid and Orderly
        <input
          value={draft.wallet}
          onChange={(e) => setDraft({ ...draft, wallet: e.target.value.trim() })}
          placeholder={fallback.wallet ?? '0x…'}
          spellCheck={false}
          aria-invalid={!walletOk}
          className="num rounded-sm border border-rule bg-surface px-2 py-1 text-[11px] text-level1"
        />
      </label>
      <label className="flex flex-col gap-1 text-level3">
        dYdX address
        <input
          value={draft.dydx}
          onChange={(e) => setDraft({ ...draft, dydx: e.target.value.trim() })}
          placeholder={fallback.dydx ?? 'dydx1…'}
          spellCheck={false}
          aria-invalid={!dydxOk}
          className="num rounded-sm border border-rule bg-surface px-2 py-1 text-[11px] text-level1"
        />
      </label>
      <button
        type="submit"
        disabled={!walletOk || !dydxOk}
        className="self-start rounded-full border border-rule px-2.5 py-0.5 text-level2 hover:text-level1 disabled:opacity-40"
      >
        Read history
      </button>
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
  const h = result.data
  return (
    <li className="flex flex-col gap-1 border-t border-rule pt-2" data-history-venue={venue}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-level1">{label}</span>
        {address && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={result.isFetching}
            className="text-level3 hover:text-level1"
          >
            {result.isFetching ? 'Reading…' : 'Refresh'}
          </button>
        )}
      </div>
      {!address && (
        <p className="text-level3">
          {venue === 'dydx'
            ? 'Paste a dYdX address, or unlock dYdX in the order ticket.'
            : 'Connect a wallet or paste an address.'}
        </p>
      )}
      {address && <p className="num text-[11px] break-all text-level3">{address}</p>}
      {result.error && <TradeNote error={result.error.error} />}
      {h && (
        <p className="num text-level2">
          {h.fills.length} fills · {h.funding.length} funding payments
        </p>
      )}
      {h?.gaps.map((gap) => (
        <p key={gap} className="text-[11px] leading-snug text-level3">
          {gap}
        </p>
      ))}
    </li>
  )
}

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
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-rule px-3 py-1.5 text-[12px]">
      <Segmented
        label="Venue"
        value={search.venue}
        onChange={(venue) => set({ venue, market: undefined })}
        options={[{ value: 'all', label: 'All' }, ...HISTORY_VENUES.map((v) => ({ value: v, label: VENUES[v].label }))]}
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
          onChange={(e) => set({ market: e.target.value || undefined })}
          className="rounded-sm border border-rule bg-surface px-1 text-level1"
        >
          <option value="">All</option>
          {markets.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <div role="group" aria-label="Period" className="flex items-center gap-1 text-level3">
        {presets(now).map((p) => (
          <button
            key={p.label}
            type="button"
            aria-pressed={search.from === p.from && search.to === p.to}
            onClick={() => set({ from: p.from, to: p.to })}
            className={`rounded-full px-2 py-0.5 ${search.from === p.from && search.to === p.to ? 'bg-level1/12 text-level1' : 'hover:text-level2'}`}
          >
            {p.label}
          </button>
        ))}
        <input
          type="date"
          aria-label="From"
          value={search.from ?? ''}
          onChange={(e) => set({ from: e.target.value || undefined })}
          className="num rounded-sm border border-rule bg-surface px-1 text-level1"
        />
        <input
          type="date"
          aria-label="To"
          value={search.to ?? ''}
          onChange={(e) => set({ to: e.target.value || undefined })}
          className="num rounded-sm border border-rule bg-surface px-1 text-level1"
        />
      </div>
    </div>
  )
}

const TOTALS_HEIGHT = 'h-36'

function TotalsTable({ rows, first }: { rows: Totals[]; first: string }) {
  if (rows.length === 0)
    return <p className={`${TOTALS_HEIGHT} p-3 text-[12px] text-level3`}>Nothing in this period.</p>
  return (
    <div className={`${TOTALS_HEIGHT} overflow-y-auto`}>
      <table className="num w-full text-[11px]">
        <thead>
          <tr className="h-6 text-level3">
            <th className="pl-3 text-left font-normal">{first}</th>
            <th className="pr-3 text-right font-normal">Fills</th>
            <th className="pr-3 text-right font-normal">Realized PnL</th>
            <th className="pr-3 text-right font-normal">Fees</th>
            <th className="pr-3 text-right font-normal">Funding</th>
            <th className="pr-3 text-right font-normal">Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={`${t.group}:${t.asset}`} className="h-7 border-t border-rule text-level2">
              <td className="pl-3 font-sans text-level1">
                {t.group}
                {t.asset !== 'USDC' && <span className="text-level3"> · {t.asset}</span>}
              </td>
              <td className="pr-3 text-right">{t.fills}</td>
              <td className="pr-3 text-right">
                <Signed value={t.realized} />
              </td>
              <td className="pr-3 text-right">{money(t.fees)}</td>
              <td className="pr-3 text-right">
                <Signed value={t.funding} />
              </td>
              <td className="pr-3 text-right">
                <Signed value={t.net} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Signed({ value, exact = false }: { value: string; exact?: boolean }) {
  const shown = exact ? value : money(value)
  const tone = Number(value) > 0 ? 'text-bid' : Number(value) < 0 ? 'text-ask' : ''
  return <span className={tone}>{shown}</span>
}

const COLUMNS = 'grid-cols-[11rem_6rem_minmax(6rem,1fr)_4rem_4rem_1fr_1fr_1fr_1fr_1fr]'

function Rows({ fills, payments }: { fills: RealizedFill[]; payments: FundingPayment[] }) {
  const rows = [
    ...fills.map((fill): Row => ({ kind: 'fill', time: fill.time, fill })),
    ...payments.map((payment): Row => ({ kind: 'funding', time: payment.time, payment })),
  ].sort((a, b) => b.time - a.time)
  const scroller = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 12,
  })
  return (
    <div className="num flex min-h-0 flex-1 flex-col overflow-x-auto text-[11px]">
      <div role="row" className={`grid h-6 min-w-240 shrink-0 ${COLUMNS} items-center gap-2 px-3 text-level3`}>
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
        className="min-h-0 min-w-240 flex-1 overflow-y-auto"
      >
        {rows.length === 0 && <p className="px-3 py-2 font-sans text-[12px] text-level3">No fills or funding here.</p>}
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const r = rows[item.index]
            if (!r) return null
            const e = r.kind === 'fill' ? r.fill : r.payment
            return (
              <div
                key={item.key}
                role="row"
                className={`absolute inset-x-0 grid h-6 ${COLUMNS} items-center gap-2 border-t border-rule px-3 text-level2`}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <span role="cell" className="whitespace-nowrap">
                  {utcTime(r.time)}
                </span>
                <span role="cell" className="font-sans">
                  {VENUES[e.venue].label}
                </span>
                <span role="cell" className="truncate text-level1">
                  {e.symbol}
                </span>
                {r.kind === 'fill' ? <FillCells fill={r.fill} /> : <FundingCells payment={r.payment} />}
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
      <span role="cell" className="font-sans">
        {fill.liquidation ? 'Liquidation' : 'Fill'}
      </span>
      <span role="cell" className={fill.side === 'buy' ? 'text-bid' : 'text-ask'}>
        {fill.side}
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
      <span role="cell" className="font-sans">
        Funding
      </span>
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
