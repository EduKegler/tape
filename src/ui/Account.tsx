import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSelector } from '@tanstack/react-store'
import type { Base, MarketKey, VenueId } from '@tape/core/ids'
import { closeIntent } from '@tape/trade/intent'
import type { AccountRef, Bps, Command, Fill, OpenOrder, Position } from '@tape/trade/types'
import { useFrame } from '#/client/hooks'
import { VENUES } from '#/site'
import { useAccountView, useTradeCommands, useTradeSession } from '#/trade/hooks'
import type { TradeSession } from '#/trade/hooks'
import { DepositButton } from './Deposit'
import { HistoryLink } from './HistoryLink'
import { Panel, Segmented } from './Panel'
import { ConfirmAction } from './ConfirmAction'
import { Button, Table } from './primitives'
import type { Column } from './primitives'
import { specsQuery } from './queries'
import { closeSlippageBps, SLIPPAGE_STEPS } from './ticket-store'
import { SiteReadOnly } from './Ticket'
import { OrderNote, TradeNote } from './TradeNote'

type Tab = 'positions' | 'orders' | 'fills'

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
            <span className="num text-xs text-level3">{ref.network}</span>
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
          forget={session.status === 'ready' ? session.forget : null}
        />
      ) : (
        <div className="p-3 text-sm text-level3">{message(session)}</div>
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

function AccountBody({
  account,
  base,
  leverage,
  forget,
}: {
  account: AccountRef
  base: Base
  leverage: boolean
  forget: (() => void) | null
}) {
  const [tab, setTab] = useState<Tab>('positions')
  const { view, error } = useAccountView(account)
  const { run, last, inFlight } = useTradeCommands(account)
  const specs = useQuery(specsQuery(account.venue))
  const slippage = useSelector(closeSlippageBps, (s) => s) as Bps
  const symbol = specs.data?.get(base)?.venueSymbol
  const snapshot = view?.kind === 'live' ? view.snapshot : null
  const held = /^\d+/.exec(snapshot?.positions.find((p) => p.symbol === symbol)?.leverage ?? '')?.[0] ?? null
  const busy = (c: Command) => inFlight.some((x) => JSON.stringify(x) === JSON.stringify(c))
  const [closeError, setCloseError] = useState<string | null>(null)
  const venue = VENUES[account.venue].label
  const specOf = (p: Position) => [...(specs.data?.values() ?? [])].find((s) => s.venueSymbol === p.symbol)
  const close = (p: Position) => {
    const spec = specOf(p)
    const intent = spec ? closeIntent(spec, p, slippage) : null
    setCloseError(
      intent ? null : `${p.symbol} ${p.size} does not fit the size step Tape knows for it. Close it on the venue.`,
    )
    if (intent) run({ kind: 'place', intent })
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-rule px-3 py-1.5 text-sm">
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
        {tab === 'fills' && <HistoryLink className="text-level3 hover:text-level1">Full history</HistoryLink>}
        {snapshot && (
          <span className="num text-level3">
            Equity <span className="text-lg text-level1">{snapshot.equity}</span> · Available{' '}
            <span className="text-level1">{snapshot.available}</span>
          </span>
        )}
        {symbol && snapshot && snapshot.orders.some((o) => o.symbol === symbol) && (
          <ConfirmAction
            label={`Cancel all ${base}`}
            confirm="Confirm cancel all"
            keep="Keep orders"
            question={cancelAllQuestion(snapshot.orders.filter((o) => o.symbol === symbol).length, base, venue)}
            onConfirm={() => run({ kind: 'cancel-all', symbol })}
          />
        )}
        {leverage && symbol && (
          <LeverageControl
            key={held ?? ''}
            current={held ?? ''}
            onSet={(n) => run({ kind: 'leverage', symbol, leverage: n })}
          />
        )}
        {forget && (
          <span className="ml-auto">
            <ConfirmAction
              label="Forget trading key"
              question={`Forget the trading key for ${venue} on this device?`}
              confirm="Forget key"
              keep="Keep key"
              onConfirm={forget}
            />
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="p-2">
            <TradeNote error={error} />
          </div>
        )}
        {!view && !error && <p className="p-3 text-sm text-level3">Loading account…</p>}
        {view?.kind === 'unknown' && <p className="p-3 text-sm text-level3">Enable trading to read this account.</p>}
        {view?.kind === 'empty' && (
          <p className="p-3 text-sm text-level3">No account on this venue yet. Deposit to start.</p>
        )}
        {closeError && (
          <div className="p-2">
            <TradeNote error={{ kind: 'invalid-order', detail: closeError }} />
          </div>
        )}
        {snapshot && tab === 'positions' && (
          <Positions
            rows={snapshot.positions}
            busy={last.pending}
            question={(p) => `Close ${p.size} ${specOf(p)?.base ?? p.symbol} ${p.side} on ${venue}?`}
            market={(p) => specOf(p)?.key ?? null}
            onClose={close}
          />
        )}
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
          <OrderNote error={last.error} outcome={last.outcome} />
        </div>
      )}
      {last.command?.kind === 'place' && last.command.intent.reduceOnly && (
        <div className="shrink-0 p-2">
          <OrderNote error={last.error} outcome={last.outcome} lookup={last.lookup} />
        </div>
      )}
    </div>
  )
}

function cancelAllQuestion(count: number, base: Base, venue: string) {
  return `Cancel ${count === 1 ? `1 ${base} order` : `all ${count} ${base} orders`} on ${venue}?`
}

const LEVERAGE_RANGE = { min: 1, max: 50 }

function leverageError(value: string): string | undefined {
  const n = Number(value)
  return value && !(Number.isInteger(n) && n >= LEVERAGE_RANGE.min && n <= LEVERAGE_RANGE.max)
    ? `Whole number from ${LEVERAGE_RANGE.min} to ${LEVERAGE_RANGE.max}`
    : undefined
}

function LeverageControl({ current, onSet }: { current: string; onSet: (n: number) => void }) {
  const [value, setValue] = useState(current)
  const error = leverageError(value)
  const id = useId()
  return (
    <form
      className="flex items-center gap-1.5 text-level3"
      onSubmit={(e) => {
        e.preventDefault()
        if (value && !error) onSet(Number(value))
      }}
    >
      <label htmlFor={id}>Leverage</label>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        placeholder="—"
        value={value}
        onChange={(e) => setValue(e.target.value.trim())}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className="num h-6 w-10 rounded-sm border border-edge bg-inset px-1 text-level1 outline-none focus:border-accent aria-invalid:border-warn"
      />
      {error && (
        <span id={`${id}-error`} className="border-l-2 border-warn pl-1.5 text-level1">
          {error}
        </span>
      )}
      <Button look="quiet" type="submit" disabled={!value || Boolean(error)}>
        Set
      </Button>
    </form>
  )
}

const SIDE_WORD = { long: 'Long', short: 'Short', buy: 'Buy', sell: 'Sell' } as const

const side = (s: keyof typeof SIDE_WORD) => (
  <span className={s === 'long' || s === 'buy' ? 'text-bid' : 'text-ask'}>{SIDE_WORD[s]}</span>
)

function Positions({
  rows,
  busy,
  question,
  market,
  onClose,
}: {
  rows: readonly Position[]
  busy: boolean
  question: (p: Position) => string
  market: (p: Position) => MarketKey | null
  onClose: (p: Position) => void
}) {
  const columns: Column<Position>[] = [
    { header: 'Market', cell: (p) => p.symbol },
    { header: 'Side', cell: (p) => side(p.side) },
    { header: 'Size', cell: (p) => p.size },
    { header: 'Entry', cell: (p) => p.entry },
    { header: 'PnL', cell: (p) => p.unrealizedPnl },
    { header: 'Liq.', cell: (p) => p.liquidation ?? '—' },
    {
      header: '',
      cell: (p) => (
        <ConfirmAction
          label="Close"
          question={question(p)}
          confirm="Confirm close"
          keep="Keep position"
          disabled={busy}
          onConfirm={() => onClose(p)}
        >
          <CloseTerms position={p} market={market(p)} />
        </ConfirmAction>
      ),
    },
  ]
  return <Table rows={rows} rowKey={(p) => p.symbol} columns={columns} empty="No open positions." />
}

function CloseTerms({ position, market }: { position: Position; market: MarketKey | null }) {
  const slippage = useSelector(closeSlippageBps, (s) => s)
  return (
    <>
      <span className="num text-level3">
        Size <span className="text-level1">{position.size.replace(/^-/, '')}</span> · Expected{' '}
        {market ? <ExpectedPrice market={market} sell={position.side === 'long'} /> : <span>—</span>}
      </span>
      <span className="flex items-center gap-2 text-level3">
        Slippage
        <Segmented
          label="Close slippage"
          value={String(slippage)}
          onChange={(v) => closeSlippageBps.setState(() => Number(v))}
          options={SLIPPAGE_STEPS.map((o) => ({ value: String(o), label: `${o / 100}%` }))}
        />
      </span>
    </>
  )
}

function ExpectedPrice({ market, sell }: { market: MarketKey; sell: boolean }) {
  const px = useFrame({ kind: 'book', market, group: '' }, (f) => (sell ? f?.touch.bid : f?.touch.ask) ?? null)
  return <span className="text-level1">{px ?? '—'}</span>
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
  const columns: Column<OpenOrder>[] = [
    { header: 'Market', cell: (o) => o.symbol },
    { header: 'Side', cell: (o) => side(o.side) },
    { header: 'Type', cell: (o) => o.kind },
    { header: 'Price', cell: (o) => o.px ?? 'market' },
    { header: 'Size', cell: (o) => o.size },
    { header: 'Reduce', cell: (o) => (o.reduceOnly ? 'yes' : '') },
    {
      header: '',
      cell: (o) =>
        o.cancelable && (
          <Button look="quiet" disabled={busy(o)} onClick={() => onCancel(o)}>
            Cancel
          </Button>
        ),
    },
  ]
  return <Table rows={rows} rowKey={(o) => o.ref} columns={columns} empty="No open orders." />
}

function Fills({ rows }: { rows: readonly Fill[] }) {
  const columns: Column<Fill>[] = [
    { header: 'Market', cell: (f) => f.symbol },
    { header: 'Side', cell: (f) => side(f.side) },
    { header: 'Price', cell: (f) => f.px },
    { header: 'Size', cell: (f) => f.size },
    { header: 'Fee', cell: (f) => f.fee },
    { header: 'Time', cell: (f) => new Date(f.time).toLocaleTimeString('en-GB') },
  ]
  return <Table rows={rows} rowKey={(f) => f.id} columns={columns} empty="No fills yet." />
}
