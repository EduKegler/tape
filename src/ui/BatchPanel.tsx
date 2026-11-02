import { useState } from 'react'
import type { ReactNode } from 'react'
import { useSelector } from '@tanstack/react-store'
import type { MarketSpec } from '@tape/core/market'
import { closeIntents } from '@tape/trade/close-all'
import type { CloseScope } from '@tape/trade/close-all'
import type { CloseExit } from '@tape/trade/intent'
import { pnlAt } from '@tape/trade/position'
import type { AccountRef, Capabilities, CloseRow, Position } from '@tape/trade/types'
import { useTradeCommands } from '#/trade/hooks'
import { Segmented } from './Panel'
import { AnchoredHead, Button } from './primitives'
import { ErrorMark } from './ErrorMark'
import { OrderNote } from './TradeNote'
import { formatSigned } from './format'
import { shownPrice, shownSize } from './manage'
import { closeSlippageBps } from './ticket-store'

const SIDE_WORD = { long: 'Long', short: 'Short' } as const
const side = (direction: keyof typeof SIDE_WORD) => (
  <span className={direction === 'long' ? 'text-bid' : 'text-ask'}>{SIDE_WORD[direction]}</span>
)
const tone = (value: number) => (value >= 0 ? 'text-bid' : 'text-ask')
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function Row({
  market,
  dim = false,
  below,
  children,
}: {
  market: string
  dim?: boolean
  below?: ReactNode
  children?: ReactNode
}) {
  return (
    <li className={`flex flex-col gap-1 border-b border-rule py-1 ${dim ? 'opacity-40' : ''}`}>
      <div className="flex min-h-5.5 items-center gap-3">
        <span className="w-12 shrink-0 text-sm font-medium text-level1">{market}</span>
        {children}
      </div>
      {below ? (
        <div className="flex gap-3">
          <span className="w-12 shrink-0" />
          {below}
        </div>
      ) : null}
    </li>
  )
}

const IN_SCOPE: Record<CloseScope, (position: Position) => boolean> = {
  all: () => true,
  profit: (position) => Number(position.unrealizedPnl) > 0,
  loss: (position) => Number(position.unrealizedPnl) < 0,
}

export function CloseAllPanel({
  account,
  venue,
  positions,
  specOf,
  caps,
  onDone,
}: {
  account: AccountRef
  venue: string
  positions: readonly Position[]
  specOf: (symbol: string) => MarketSpec | undefined
  caps: Capabilities
  onDone: () => void
}) {
  const { run, last, inFlight } = useTradeCommands(account)
  const slippage = useSelector(closeSlippageBps, (state) => state)
  const [scope, setScope] = useState<CloseScope>('all')
  const [how, setHow] = useState<'market' | 'mid'>('market')
  const busy = last.pending || inFlight.length > 0
  const exit: CloseExit = how === 'mid' ? { kind: 'mid' } : { kind: 'market', slippage }
  const report = last.command?.kind === 'close-all' && last.outcome?.kind === 'closed' ? last.outcome : null
  const base = (symbol: string) => specOf(symbol)?.base ?? symbol
  const size = (position: Position) => {
    const spec = specOf(position.symbol)
    return spec ? shownSize(spec, position.size) : position.size.replace(/^-/, '')
  }
  const [sent, setSent] = useState<readonly Position[]>([])
  const send = (chosen: readonly Position[]) => {
    const { intents } = closeIntents(chosen, specOf, 'all', exit)
    setSent(chosen)
    if (intents.length > 0) run({ kind: 'close-all', intents })
  }
  if (report) {
    const refused = report.rows.filter((row) => 'error' in row && row.error.kind !== 'unknown-outcome')
    const closed = report.rows.filter((row) => 'outcome' in row).length
    const retry = sent.filter((position) => refused.some((row) => row.symbol === position.symbol))
    return (
      <>
        <AnchoredHead>
          Closed {closed} of {report.rows.length} on {venue}
        </AnchoredHead>
        <ul className="px-3 pt-2.5 pb-3">
          {report.rows.map((row) => (
            <Row key={row.symbol} market={base(row.symbol)} below={refusal(row)}>
              <ReportLine
                row={row}
                venue={venue}
                position={sent.find((held) => held.symbol === row.symbol)}
                spec={specOf(row.symbol)}
              />
            </Row>
          ))}
        </ul>
        <div className="flex flex-col gap-2 px-3 pb-3">
          {retry.length > 0 ? (
            <Button look="primary" size="tall" className="w-full" disabled={busy} onClick={() => send(retry)}>
              {busy ? 'Sending…' : `Try ${retry.map((position) => base(position.symbol)).join(', ')} again`}
            </Button>
          ) : (
            <Button look="secondary-raised" size="tall" className="w-full" onClick={onDone}>
              Done
            </Button>
          )}
        </div>
      </>
    )
  }
  const chosen = positions.filter(IN_SCOPE[scope])
  const estimate = chosen.reduce((sum, position) => sum + Number(position.unrealizedPnl), 0)
  return (
    <>
      <AnchoredHead>Close positions on {venue}</AnchoredHead>
      <div className="flex flex-col gap-2.5 px-3 pt-2.5 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            pills="small"
            label="Which positions"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: `All ${positions.length}` },
              { value: 'profit', label: `In profit ${positions.filter(IN_SCOPE.profit).length}` },
              { value: 'loss', label: `In loss ${positions.filter(IN_SCOPE.loss).length}` },
            ]}
          />
          {caps.restingReduceOnly && (
            <Segmented
              pills="small"
              label="How to close"
              value={how}
              onChange={setHow}
              options={[
                { value: 'market', label: 'Market' },
                { value: 'mid', label: 'At mid' },
              ]}
            />
          )}
        </div>
        <ul>
          {positions.map((position) => {
            const pnl = Number(position.unrealizedPnl)
            return (
              <Row key={position.symbol} market={base(position.symbol)} dim={!IN_SCOPE[scope](position)}>
                <span className="flex-1 text-sm text-level2">
                  {side(position.side)} <span className="num">{size(position)}</span>
                </span>
                <span className={`num text-sm ${tone(pnl)}`}>{formatSigned(pnl)}</span>
              </Row>
            )
          })}
        </ul>
        <span className="text-xs text-level3">
          One order each, so a refusal leaves the others closed. Est. PnL{' '}
          <span className={`num ${tone(estimate)}`}>
            {formatSigned(estimate)} {specOf(positions[0]?.symbol ?? '')?.quote ?? ''}
          </span>
        </span>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <OrderNote error={last.error} outcome={null} />
        <Button
          look="primary"
          size="tall"
          className="w-full"
          disabled={chosen.length === 0 || busy}
          onClick={() => send(chosen)}
        >
          {busy ? 'Closing…' : `Close ${plural(chosen.length, 'position')} ${how === 'mid' ? 'at mid' : 'at market'}`}
        </Button>
      </div>
    </>
  )
}

function refusal(row: CloseRow) {
  if (!('error' in row) || row.error.kind === 'unknown-outcome') return null
  const words = 'detail' in row.error ? row.error.detail : 'The wallet refused to sign'
  return (
    <div className="flex flex-1 gap-1.5 text-sm">
      <ErrorMark className="mt-0.5 size-3.5 shrink-0" />
      <div className="flex flex-col">
        <span className="text-err">Refused</span>
        <q className="text-level1">{words}</q>
      </div>
    </div>
  )
}

function ReportLine({
  row,
  venue,
  position,
  spec,
}: {
  row: CloseRow
  venue: string
  position: Position | undefined
  spec: MarketSpec | undefined
}) {
  if ('error' in row) {
    if (row.error.kind === 'unknown-outcome')
      return (
        <span className="flex-1 text-sm text-level2">
          <span className="text-warn">No answer.</span> Read the positions before you close it again.
        </span>
      )
    return null
  }
  const { outcome } = row
  if (outcome.kind !== 'placed') return <span className="flex-1 text-sm text-level2">{outcome.detail}</span>
  const fill = outcome.fill
  if (!fill || !spec) {
    const word = outcome.status === 'resting' ? `Resting on ${venue}` : 'Sent'
    return <span className="flex-1 text-sm text-level2">{word}</span>
  }
  const realized = position
    ? pnlAt(position, Number(fill.price)) * (Number(fill.size) / Math.abs(Number(position.size)))
    : null
  return (
    <>
      <span className="flex-1 text-sm text-level2">
        Filled{' '}
        <span className="num">
          {shownSize(spec, fill.size)} {spec.base}
        </span>{' '}
        at <span className="num">{shownPrice(spec, Number(fill.price))}</span>
      </span>
      {realized !== null && <span className={`num text-sm ${tone(realized)}`}>{formatSigned(realized)}</span>}
    </>
  )
}
