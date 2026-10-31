import { memo } from 'react'
import { shallow } from '@tanstack/store'
import type { MarketKey } from '@tape/core/ids'
import { useFrame } from '#/client/hooks'
import { BOOK_ROWS, EMPTY_ROW } from '#/core/topics'
import type { BookFrame } from '#/core/topics'
import { Panel } from './Panel'
import { Button } from './primitives'
import { proposePrice } from './ticket-store'

type BookTopic = { kind: 'book'; market: MarketKey; group: string }

const BID_SLOTS = Array.from({ length: BOOK_ROWS }, (_, i) => i)
const ASK_SLOTS = [...BID_SLOTS].reverse()

export function OrderBook({
  market,
  group,
  onGroup,
}: {
  market: MarketKey
  group: string
  onGroup: (g: string) => void
}) {
  const topic: BookTopic = { kind: 'book', market, group }
  const head = useFrame(
    topic,
    (f) => ({ group: f?.group ?? group, options: f?.groupOptions.join('|') ?? '', status: f?.status ?? 'syncing' }),
    shallow,
  )
  return (
    <Panel
      title="Order book"
      aside={
        <label className="flex items-center gap-1.5 text-sm text-level3">
          Group
          <select
            value={head.group}
            onChange={(e) => onGroup(e.target.value)}
            className="num rounded-sm border border-rule bg-panel px-1 py-0.5 text-level2"
          >
            {(head.options ? head.options.split('|') : [head.group]).map((o) => (
              <option key={o} value={o.replaceAll(',', '')}>
                {o}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <div className="num flex h-full flex-col text-sm contain-strict" data-status={head.status}>
        <div className="grid h-6 shrink-0 grid-cols-3 items-center px-3 text-xs text-level3">
          <span>Price</span>
          <span className="text-right">Size</span>
          <span className="text-right">Total</span>
        </div>
        <div className="flex flex-1 flex-col">
          {ASK_SLOTS.map((i) => (
            <Row key={`a${i}`} topic={topic} side="asks" index={i} />
          ))}
        </div>
        <Spread topic={topic} />
        <div className="flex flex-1 flex-col">
          {BID_SLOTS.map((i) => (
            <Row key={`b${i}`} topic={topic} side="bids" index={i} />
          ))}
        </div>
      </div>
    </Panel>
  )
}

const Row = memo(function BookRow({ topic, side, index }: { topic: BookTopic; side: 'asks' | 'bids'; index: number }) {
  const row = useFrame(topic, (f: BookFrame | null) => f?.[side][index] ?? EMPTY_ROW, shallow)
  const ask = side === 'asks'
  return (
    <Button
      look="row"
      tabIndex={row.px ? 0 : -1}
      aria-hidden={!row.px}
      onClick={() => row.px && proposePrice(row.px)}
      className="relative grid min-h-5 w-full flex-1 grid-cols-3 items-center px-3"
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 right-0 w-full origin-right ${ask ? 'bg-ask-wash' : 'bg-bid-wash'}`}
        style={{ transform: `scaleX(${row.fill})` }}
      />
      <span className={`relative ${ask ? 'text-ask' : 'text-bid'}`}>{row.px}</span>
      <span className="relative text-right text-level1">{row.qty}</span>
      <span className="relative text-right text-level3">{row.cum}</span>
    </Button>
  )
})

function Spread({ topic }: { topic: BookTopic }) {
  const s = useFrame(
    topic,
    (f) => ({ mid: f?.mid ?? '', spread: f?.spread ?? '', bps: f?.spreadBps ?? '', status: f?.status ?? 'syncing' }),
    shallow,
  )
  return (
    <div className="flex h-8 shrink-0 items-center justify-between border-y border-rule px-3">
      <span className="text-md text-level1">{s.mid || '—'}</span>
      <span className="text-xs whitespace-nowrap text-level3">
        {s.status === 'live'
          ? `Spread ${s.spread} · ${s.bps === '0.00' ? '<0.01' : s.bps} bps`
          : s.status === 'stale'
            ? 'Reconnecting…'
            : 'Syncing…'}
      </span>
    </div>
  )
}
