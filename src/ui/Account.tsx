import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSelector } from '@tanstack/react-store'
import type { Base, MarketKey, VenueId } from '@tape/core/ids'
import { closeIntent } from '@tape/trade/intent'
import { toBps } from '@tape/trade/types'
import type { AccountRef, Command, Fill, OpenOrder, Position } from '@tape/trade/types'
import { useFrame } from '#/client/hooks'
import { VENUES } from '#/site'
import { useAccountView, useTradeCommands, useTradeSession } from '#/trade/hooks'
import type { TradeSession } from '#/trade/hooks'
import { DepositButton } from './Deposit'
import { HistoryLink } from './HistoryLink'
import { Panel, Segmented } from './Panel'
import { ConfirmAction } from './ConfirmAction'
import { Button, InlineInput, NoData, Table } from './primitives'
import type { Column } from './primitives'
import { specsQuery } from './queries'
import { closeSlippageBps, SLIPPAGE_STEPS } from './ticket-store'
import { SiteReadOnly } from './Ticket'
import { OrderNote, ReadNote, TradeNote } from './TradeNote'

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
        <NoData>{message(session)}</NoData>
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
  const { view, error, isFetching, retry } = useAccountView(account)
  const { run, last, inFlight } = useTradeCommands(account)
  const specs = useQuery(specsQuery(account.venue))
  const slippage = useSelector(closeSlippageBps, (state) => state)
  const symbol = specs.data?.get(base)?.venueSymbol
  const snapshot = view?.kind === 'live' ? view.snapshot : null
  const held =
    /^\d+/.exec(snapshot?.positions.find((position) => position.symbol === symbol)?.leverage ?? '')?.[0] ?? null
  const busy = (command: Command) => inFlight.some((pending) => JSON.stringify(pending) === JSON.stringify(command))
  const [closeError, setCloseError] = useState<string | null>(null)
  const venue = VENUES[account.venue].label
  const specOf = (position: Position) =>
    [...(specs.data?.values() ?? [])].find((spec) => spec.venueSymbol === position.symbol)
  const close = (position: Position) => {
    const spec = specOf(position)
    const intent = spec ? closeIntent(spec, position, slippage) : null
    setCloseError(
      intent
        ? null
        : `${position.symbol} ${position.size} does not fit the size step Tape knows for it. Close it on the venue.`,
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
        {symbol && snapshot && snapshot.orders.some((order) => order.symbol === symbol) && (
          <ConfirmAction
            label={`Cancel all ${base}`}
            confirm="Confirm cancel all"
            keep="Keep orders"
            question={cancelAllQuestion(snapshot.orders.filter((order) => order.symbol === symbol).length, base, venue)}
            onConfirm={() => run({ kind: 'cancel-all', symbol })}
          />
        )}
        {leverage && symbol && (
          <LeverageControl
            key={held ?? ''}
            current={held ?? ''}
            onSet={(multiplier) => run({ kind: 'leverage', symbol, leverage: multiplier })}
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
          <div className="p-2 text-sm">
            <ReadNote what="the account" error={error} onRetry={retry} busy={isFetching} />
          </div>
        )}
        {!view && !error && <NoData>Loading account…</NoData>}
        {view?.kind === 'unknown' && <NoData>Enable trading to read this account.</NoData>}
        {view?.kind === 'empty' && <NoData>No account on this venue yet. Deposit to start.</NoData>}
        {closeError && (
          <div className="p-2">
            <TradeNote error={{ kind: 'invalid-order', detail: closeError }} />
          </div>
        )}
        {snapshot && tab === 'positions' && (
          <Positions
            rows={snapshot.positions}
            busy={last.pending}
            question={(position) =>
              `Close ${position.size} ${specOf(position)?.base ?? position.symbol} ${position.side} on ${venue}?`
            }
            market={(position) => specOf(position)?.key ?? null}
            onClose={close}
          />
        )}
        {snapshot && tab === 'orders' && (
          <Orders
            rows={snapshot.orders}
            busy={(order) => busy({ kind: 'cancel', order: order.ref })}
            onCancel={(order) => run({ kind: 'cancel', order: order.ref })}
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
  const leverage = Number(value)
  return value && !(Number.isInteger(leverage) && leverage >= LEVERAGE_RANGE.min && leverage <= LEVERAGE_RANGE.max)
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
      onSubmit={(event) => {
        event.preventDefault()
        if (value && !error) onSet(Number(value))
      }}
    >
      <label htmlFor={id}>Leverage</label>
      <InlineInput
        id={id}
        inputMode="numeric"
        autoComplete="off"
        placeholder="—"
        value={value}
        onChange={(event) => setValue(event.target.value.trim())}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className="w-10"
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

const side = (direction: keyof typeof SIDE_WORD) => (
  <span className={direction === 'long' || direction === 'buy' ? 'text-bid' : 'text-ask'}>{SIDE_WORD[direction]}</span>
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
    { header: 'Market', cell: (position) => position.symbol },
    { header: 'Side', cell: (position) => side(position.side) },
    { header: 'Size', cell: (position) => position.size },
    { header: 'Entry', cell: (position) => position.entry },
    { header: 'PnL', cell: (position) => position.unrealizedPnl },
    { header: 'Liq.', cell: (position) => position.liquidation ?? '—' },
    {
      header: '',
      cell: (position) => (
        <ConfirmAction
          label="Close"
          question={question(position)}
          confirm="Confirm close"
          keep="Keep position"
          disabled={busy}
          onConfirm={() => onClose(position)}
        >
          <CloseTerms position={position} market={market(position)} />
        </ConfirmAction>
      ),
    },
  ]
  return <Table rows={rows} rowKey={(position) => position.symbol} columns={columns} empty="No open positions." />
}

function CloseTerms({ position, market }: { position: Position; market: MarketKey | null }) {
  const slippage = useSelector(closeSlippageBps, (state) => state)
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
          onChange={(value) => closeSlippageBps.setState(() => toBps(Number(value)))}
          options={SLIPPAGE_STEPS.map((step) => ({ value: String(step), label: `${step / 100}%` }))}
        />
      </span>
    </>
  )
}

function ExpectedPrice({ market, sell }: { market: MarketKey; sell: boolean }) {
  const px = useFrame(
    { kind: 'book', market, group: '' },
    (frame) => (sell ? frame?.touch.bid : frame?.touch.ask) ?? null,
  )
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
    { header: 'Market', cell: (order) => order.symbol },
    { header: 'Side', cell: (order) => side(order.side) },
    { header: 'Type', cell: (order) => order.kind },
    { header: 'Price', cell: (order) => order.px ?? 'market' },
    { header: 'Size', cell: (order) => order.size },
    { header: 'Reduce', cell: (order) => (order.reduceOnly ? 'yes' : '') },
    {
      header: '',
      cell: (order) =>
        order.cancelable && (
          <Button look="quiet" disabled={busy(order)} onClick={() => onCancel(order)}>
            Cancel
          </Button>
        ),
    },
  ]
  return <Table rows={rows} rowKey={(order) => order.ref} columns={columns} empty="No open orders." />
}

function Fills({ rows }: { rows: readonly Fill[] }) {
  const columns: Column<Fill>[] = [
    { header: 'Market', cell: (fill) => fill.symbol },
    { header: 'Side', cell: (fill) => side(fill.side) },
    { header: 'Price', cell: (fill) => fill.px },
    { header: 'Size', cell: (fill) => fill.size },
    { header: 'Fee', cell: (fill) => fill.fee },
    { header: 'Time', cell: (fill) => new Date(fill.time).toLocaleTimeString('en-GB') },
  ]
  return <Table rows={rows} rowKey={(fill) => fill.id} columns={columns} empty="No fills yet." />
}
