import { useId, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Base, VenueId } from '@tape/core/ids'
import { isMovable, leverageOf, orderKindLabel, pnlAt, roeOf } from '@tape/trade/position'
import type { AccountRef, Capabilities, Command, Fill, OpenOrder, OrderRef, Position } from '@tape/trade/types'
import { VENUES } from '#/site'
import { useAccountView, useTradeCommands, useTradeSession } from '#/trade/hooks'
import type { TradeSession } from '#/trade/hooks'
import { DepositButton } from './Deposit'
import { HistoryLink } from './HistoryLink'
import { MovePanel } from './MovePanel'
import { Panel, Segmented } from './Panel'
import { ConfirmAction } from './ConfirmAction'
import { PositionPanel } from './PositionPanel'
import type { PositionTab } from './PositionPanel'
import { Anchored, AnchoredHead, Button, InlineInput, NoData, Table } from './primitives'
import type { Column } from './primitives'
import { specsQuery } from './queries'
import { domainOf } from './ruler-layout'
import { SiteReadOnly } from './Ticket'
import { OrderNote, ReadNote } from './TradeNote'
import { ErrorMark } from './ErrorMark'
import { formatAgo, formatPct, formatSigned, groupThousands } from './format'
import { armedLeg, ordered, shownPrice, shownSize } from './manage'
import { useChangedKeys } from './wash'
import { WithdrawButton } from './Withdraw'

type Tab = 'positions' | 'orders' | 'fills'

const grouped = (value: string) => (/^\d+(?:\.\d+)?$/.test(value) ? groupThousands(value) : value)

export function Account({ venue, base }: { venue: VenueId; base: Base }) {
  const session = useTradeSession(venue)
  const ref = session.status === 'ready' || session.status === 'setup' ? session.ref : null
  return (
    <Panel title="Account" bare={Boolean(ref)}>
      {ref ? (
        <AccountBody
          key={`${ref.venue}:${ref.network}:${ref.owner}`}
          account={ref}
          base={base}
          leverage={session.status === 'ready' && session.capabilities.leverage}
          forget={session.status === 'ready' ? session.forget : null}
          capabilities={session.status === 'ready' ? session.capabilities : null}
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

type Open =
  | { readonly kind: 'position'; readonly symbol: string; readonly tab: PositionTab; readonly from: 'tpsl' | 'close' }
  | { readonly kind: 'order'; readonly ref: OrderRef }
  | null

function AccountBody({
  account,
  base,
  leverage,
  forget,
  capabilities,
}: {
  account: AccountRef
  base: Base
  leverage: boolean
  forget: (() => void) | null
  capabilities: Capabilities | null
}) {
  const [tab, setTab] = useState<Tab>('positions')
  const [open, setOpen] = useState<Open>(null)
  const { view, error, isFetching, retry } = useAccountView(account)
  const { run, last, inFlight } = useTradeCommands(account)
  const specs = useQuery(specsQuery(account.venue))
  const symbol = specs.data?.get(base)?.venueSymbol
  const snapshot = view?.kind === 'live' ? view.snapshot : null
  const holding = snapshot?.positions.find((position) => position.symbol === symbol)
  const held = holding ? (leverageOf(holding)?.toString() ?? null) : null
  const busy = (command: Command) => inFlight.some((pending) => JSON.stringify(pending) === JSON.stringify(command))
  const venue = VENUES[account.venue].label
  const specOf = (venueSymbol: string) =>
    [...(specs.data?.values() ?? [])].find((spec) => spec.venueSymbol === venueSymbol)
  const price = (venueSymbol: string, value: string) => {
    const spec = specOf(venueSymbol)
    return spec ? shownPrice(spec, Number(value)) : grouped(value)
  }
  const size = (venueSymbol: string, value: string) => {
    const spec = specOf(venueSymbol)
    return spec ? shownSize(spec, value) : value.replace(/^-/, '')
  }
  const toggle = (next: Exclude<Open, null>) => (opening: boolean) => setOpen(opening ? next : null)
  const caps = capabilities
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-5 border-b border-rule px-3 text-sm">
        <Segmented
          tabs="roomy"
          label="Account view"
          value={tab}
          onChange={(next) => {
            setOpen(null)
            setTab(next)
          }}
          options={[
            { value: 'positions', label: `Positions${snapshot ? ` ${snapshot.positions.length}` : ''}` },
            { value: 'orders', label: `Orders${snapshot ? ` ${snapshot.orders.length}` : ''}` },
            { value: 'fills', label: 'Fills' },
          ]}
        />
        {tab === 'fills' && <HistoryLink className="text-level3 hover:text-level1">Full history</HistoryLink>}
        <span className="ml-auto flex flex-wrap items-center gap-3">
          {snapshot && (
            <span className="text-level3">
              Equity <span className="num font-medium text-level1">{grouped(snapshot.equity)}</span> · Available{' '}
              <span className="num font-medium text-level1">{grouped(snapshot.available)}</span>
            </span>
          )}
          {symbol && snapshot && snapshot.orders.some((order) => order.symbol === symbol) && (
            <ConfirmAction
              label={`Cancel all ${base}`}
              confirm="Confirm cancel all"
              keep="Keep orders"
              question={cancelAllQuestion(
                snapshot.orders.filter((order) => order.symbol === symbol).length,
                base,
                venue,
              )}
              onConfirm={() => run({ kind: 'cancel-all', symbol })}
              look="outline"
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
            <ConfirmAction
              label="Forget trading key"
              question={`Forget the trading key for ${venue} on this device?`}
              confirm="Forget key"
              keep="Keep key"
              onConfirm={forget}
            />
          )}
          <DepositButton account={account} />
          {snapshot && <WithdrawButton account={account} available={snapshot.available} />}
        </span>
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
        {snapshot && tab === 'positions' && (
          <Positions
            rows={snapshot.positions}
            orders={snapshot.orders}
            price={price}
            size={size}
            caps={caps}
            unit={(position) => specOf(position.symbol)?.base ?? ''}
            current={open?.kind === 'position' ? open.symbol : null}
            manage={(position, from) => {
              const spec = specOf(position.symbol)
              const key = { kind: 'position', symbol: position.symbol, from } as const
              const shown = open?.kind === 'position' && open.symbol === position.symbol ? open.tab : null
              return {
                open: open?.kind === 'position' && open.symbol === position.symbol && open.from === from,
                onOpenChange: (opening: boolean) =>
                  setOpen(opening ? { ...key, tab: from === 'close' ? 'close' : 'protect' } : null),
                panel:
                  spec && caps ? (
                    <>
                      <AnchoredHead>
                        {spec.base} {side(position.side)}{' '}
                        <span className="font-normal text-level3">{shownSize(spec, position.size)} · PnL</span>{' '}
                        <span className="num">{formatSigned(Number(position.unrealizedPnl))}</span>
                      </AnchoredHead>
                      <PositionPanel
                        account={account}
                        venue={venue}
                        position={position}
                        spec={spec}
                        caps={caps}
                        orders={snapshot.orders}
                        tab={shown ?? (from === 'close' ? 'close' : 'protect')}
                        onTab={(next) => setOpen({ ...key, tab: next })}
                      />
                    </>
                  ) : null,
              }
            }}
          />
        )}
        {snapshot && tab === 'orders' && (
          <Orders
            rows={snapshot.orders}
            price={price}
            size={(order) => size(order.symbol, ordered(order, snapshot.positions))}
            current={open?.kind === 'order' ? open.ref : null}
            busy={(order) => busy({ kind: 'cancel', order: order.ref })}
            onCancel={(order) => run({ kind: 'cancel', order: order.ref })}
            move={(order) => {
              const spec = specOf(order.symbol)
              const position = snapshot.positions.find((other) => other.symbol === order.symbol) ?? null
              return {
                open: open?.kind === 'order' && open.ref === order.ref,
                onOpenChange: toggle({ kind: 'order', ref: order.ref }),
                panel:
                  spec && caps ? (
                    <>
                      <AnchoredHead>
                        Move {spec.base} {side(order.side)}{' '}
                        <span className="font-normal text-level3">{orderKindLabel(order.kind).toLowerCase()}</span>
                      </AnchoredHead>
                      <MovePanel
                        account={account}
                        venue={venue}
                        order={order}
                        position={position}
                        spec={spec}
                        caps={caps}
                        orders={snapshot.orders}
                      />
                    </>
                  ) : null,
              }
            }}
          />
        )}
        {snapshot && tab === 'fills' && <Fills rows={snapshot.fills} />}
      </div>
      {last.command && (
        <div className="shrink-0 p-2">
          <OrderNote error={last.error} outcome={last.outcome} />
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
        <span id={`${id}-error`} className="flex items-center gap-1 text-level1">
          <ErrorMark className="size-3.5 shrink-0" />
          {error}
        </span>
      )}
      <Button look="secondary" size="sm" type="submit" disabled={!value || Boolean(error)}>
        Set
      </Button>
    </form>
  )
}

const SIDE_WORD = { long: 'Long', short: 'Short', buy: 'Buy', sell: 'Sell' } as const

const side = (direction: keyof typeof SIDE_WORD) => (
  <span className={direction === 'long' || direction === 'buy' ? 'text-bid' : 'text-ask'}>{SIDE_WORD[direction]}</span>
)

type Managed = { open: boolean; onOpenChange: (open: boolean) => void; panel: ReactNode }

function Positions({
  rows,
  orders,
  price,
  size,
  caps,
  unit,
  current,
  manage,
}: {
  rows: readonly Position[]
  orders: readonly OpenOrder[]
  price: (symbol: string, value: string) => string
  size: (symbol: string, value: string) => string
  caps: Capabilities | null
  unit: (p: Position) => string
  current: string | null
  manage: (p: Position, from: 'tpsl' | 'close') => Managed
}) {
  const washing = useChangedKeys(rows, positionKey, positionSize)
  const trigger = (position: Position, from: 'tpsl' | 'close', button: ReactElement) => {
    const managed = manage(position, from)
    return managed.panel ? (
      <Anchored open={managed.open} onOpenChange={managed.onOpenChange} trigger={button}>
        {managed.panel}
      </Anchored>
    ) : (
      button
    )
  }
  const columns: Column<Position>[] = [
    { header: 'Market', cell: (position) => position.symbol },
    { header: 'Side', cell: (position) => side(position.side), words: true },
    { header: 'Size', cell: (position) => `${size(position.symbol, position.size)} ${unit(position)}`.trim() },
    { header: 'Entry', cell: (position) => price(position.symbol, position.entry) },
    { header: 'Mark', cell: (position) => (position.mark ? price(position.symbol, position.mark) : '—') },
    { header: 'PnL', cell: (position) => formatSigned(Number(position.unrealizedPnl)) },
    {
      header: 'ROE',
      cell: (position) => {
        const roe = roeOf(position, Number(position.unrealizedPnl))
        return roe === null ? '—' : formatPct(roe)
      },
    },
    { header: 'Liq.', cell: (position) => (position.liquidation ? price(position.symbol, position.liquidation) : '—') },
    {
      header: 'TP / SL',
      left: true,
      cell: (position) => {
        const tp = caps && armedLeg(orders, position.symbol, 'tp', caps)
        const sl = caps && armedLeg(orders, position.symbol, 'sl', caps)
        const text = (leg: OpenOrder | null | undefined) => (leg?.px ? price(position.symbol, leg.px) : '—')
        return trigger(
          position,
          'tpsl',
          <Button
            look="row"
            className="-ml-1.5 flex h-6 items-center gap-2 rounded-sm px-1.5 aria-expanded:bg-option-hover"
          >
            <MiniRuler position={position} tp={tp?.px ?? null} sl={sl?.px ?? null} />
            {tp || sl ? (
              <span className="num text-level1">
                <span className="sr-only">{position.symbol} take profit and stop loss </span>
                {text(tp)} / {text(sl)}
              </span>
            ) : (
              <span className="text-level3 in-aria-expanded:text-level2">
                Add TP/SL<span className="sr-only"> to {position.symbol}</span>
              </span>
            )}
          </Button>,
        )
      },
    },
    {
      header: '',
      words: true,
      cell: (position) =>
        trigger(
          position,
          'close',
          <Button look="secondary" size="sm">
            Close
          </Button>,
        ),
    },
  ]
  return (
    <Table
      rows={rows}
      rowKey={positionKey}
      columns={columns}
      empty="No open positions."
      rowClass={(position) =>
        `${washing.has(positionKey(position)) ? 'wash' : ''} ${current === position.symbol ? 'bg-raised text-level1' : ''}`
      }
    />
  )
}

const positionKey = (position: Position) => position.symbol
const positionSize = (position: Position) => `${position.side} ${position.size}`

const MINI = { width: 64, inset: 3 } as const

function MiniRuler({ position, tp, sl }: { position: Position; tp: string | null; sl: string | null }) {
  const now = Number(position.mark ?? position.entry)
  const entry = Number(position.entry)
  const legs = [tp, sl].flatMap((leg) => (leg === null ? [] : [Number(leg)]))
  const [low, high] = domainOf(now, [entry, ...legs], null)
  const toX = (price: number) =>
    MINI.inset + Math.min(1, Math.max(0, (price - low) / (high - low))) * (MINI.width - MINI.inset * 2)
  return (
    <svg aria-hidden width={MINI.width} height={14} viewBox={`0 0 ${MINI.width} 14`} className="shrink-0">
      <rect x={0.5} y={5} width={MINI.width - 1} height={4} rx={2} className="fill-inset stroke-edge" />
      {legs.map((price) => (
        <rect
          key={price}
          x={Math.min(toX(entry), toX(price))}
          y={5}
          width={Math.abs(toX(price) - toX(entry))}
          height={4}
          className={pnlAt(position, price) >= 0 ? 'fill-bid/55' : 'fill-ask/55'}
        />
      ))}
      <line x1={toX(entry)} x2={toX(entry)} y1={2} y2={12} className="stroke-level3" />
      <circle cx={toX(now)} cy={7} r={2.5} className="fill-level1" />
    </svg>
  )
}

function Orders({
  rows,
  price,
  size,
  current,
  busy,
  onCancel,
  move,
}: {
  rows: readonly OpenOrder[]
  price: (symbol: string, value: string) => string
  size: (o: OpenOrder) => string
  current: OrderRef | null
  busy: (o: OpenOrder) => boolean
  onCancel: (o: OpenOrder) => void
  move: (o: OpenOrder) => Managed
}) {
  const [now] = useState(() => Date.now())
  const columns: Column<OpenOrder>[] = [
    { header: 'Market', cell: (order) => order.symbol },
    { header: 'Side', cell: (order) => side(order.side), words: true },
    { header: 'Type', cell: (order) => orderKindLabel(order.kind), words: true, left: true },
    {
      header: 'Price',
      cell: (order) =>
        order.px === null ? (
          'market'
        ) : (
          <>
            {price(order.symbol, order.px)}
            {order.exit !== null && <span className="text-level3"> trigger</span>}
          </>
        ),
    },
    { header: 'Size', cell: size },
    { header: 'Reduce', cell: (order) => (order.reduceOnly ? 'yes' : ''), words: true },
    {
      header: 'Placed',
      cell: (order) => <span className="text-level3">{order.placedAt ? formatAgo(order.placedAt, now) : '—'}</span>,
    },
    {
      header: '',
      words: true,
      cell: (order) => {
        const managed = move(order)
        const moveButton = (
          <Button look="secondary" size="sm">
            Move
          </Button>
        )
        return (
          <span className="inline-flex items-center gap-2.5">
            {isMovable(order) && managed.panel ? (
              <Anchored open={managed.open} onOpenChange={managed.onOpenChange} trigger={moveButton}>
                {managed.panel}
              </Anchored>
            ) : null}
            {order.cancelable && (
              <Button look="quiet" disabled={busy(order)} onClick={() => onCancel(order)}>
                Cancel
              </Button>
            )}
          </span>
        )
      },
    },
  ]
  return (
    <Table
      rows={rows}
      rowKey={(order) => order.ref}
      columns={columns}
      empty="No open orders."
      rowClass={(order) => (current === order.ref ? 'bg-raised text-level1' : '')}
    />
  )
}

function Fills({ rows }: { rows: readonly Fill[] }) {
  const columns: Column<Fill>[] = [
    { header: 'Market', cell: (fill) => fill.symbol },
    { header: 'Side', cell: (fill) => side(fill.side), words: true },
    { header: 'Price', cell: (fill) => fill.px },
    { header: 'Size', cell: (fill) => fill.size },
    { header: 'Fee', cell: (fill) => fill.fee },
    { header: 'Time', cell: (fill) => new Date(fill.time).toLocaleTimeString('en-GB') },
  ]
  return <Table rows={rows} rowKey={(fill) => fill.id} columns={columns} empty="No fills yet." />
}
