import { memo } from 'react'
import { shallow } from '@tanstack/store'
import type { MarketKey } from '@tape/core/ids'
import { useFrame } from '#/client/hooks'
import { BOOK_ROWS, EMPTY_ROW } from '#/core/topics'
import type { BookFrame } from '#/core/topics'
import { Panel, useRowKeys } from './Panel'
import { TopicStatus } from './PanelStatus'
import { Button, Select } from './primitives'
import { SideMark } from './SideMark'
import { proposePrice } from './ticket-store'

type BookTopic = { kind: 'book'; market: MarketKey; group: string }

const BID_SLOTS = Array.from({ length: BOOK_ROWS }, (_, slot) => slot)
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
    (frame) => ({
      group: frame?.group ?? group,
      options: frame?.groupOptions.join('|') ?? '',
      status: frame?.status ?? 'syncing',
    }),
    shallow,
  )
  const keys = useRowKeys()
  return (
    <Panel
      title="Order book"
      status={<TopicStatus topic={topic} ageLimit />}
      aside={
        <label className="flex items-center">
          <span className="sr-only">Group</span>
          <Select size="sm" value={head.group} onChange={onGroup}>
            {(head.options ? head.options.split('|') : [head.group]).map((step) => (
              <option key={step} value={step.replaceAll(',', '')}>
                {step}
              </option>
            ))}
          </Select>
        </label>
      }
    >
      <div className="flex h-full flex-col text-sm contain-strict" data-status={head.status}>
        <div className="grid h-6 shrink-0 grid-cols-3 items-center px-3 text-xs text-level3">
          <span>Price</span>
          <span className="text-right">Size</span>
          <span className="text-right">Total</span>
        </div>
        <div role="group" aria-label="Price levels" {...keys} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col">
            {ASK_SLOTS.map((slot) => (
              <Row key={`a${slot}`} topic={topic} side="asks" index={slot} />
            ))}
          </div>
          <Spread topic={topic} />
          <div className="flex min-h-0 flex-1 flex-col">
            {BID_SLOTS.map((slot) => (
              <Row key={`b${slot}`} topic={topic} side="bids" index={slot} />
            ))}
          </div>
        </div>
      </div>
    </Panel>
  )
}

const Row = memo(function BookRow({ topic, side, index }: { topic: BookTopic; side: 'asks' | 'bids'; index: number }) {
  const row = useFrame(topic, (frame: BookFrame | null) => frame?.[side][index] ?? EMPTY_ROW, shallow)
  const ask = side === 'asks'
  return (
    <Button
      look="row"
      data-row
      tabIndex={-1}
      aria-hidden={!row.px}
      onClick={() => row.px && proposePrice(row.px)}
      className="num relative grid min-h-0 w-full flex-1 grid-cols-3 items-center px-3"
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 right-0 w-full origin-right ${ask ? 'bg-ask-wash' : 'bg-bid-wash'}`}
        style={{ transform: `scaleX(${row.fill})` }}
      />
      <span className={`relative ${ask ? 'text-ask' : 'text-bid'}`}>
        <span className="sr-only">{ask ? 'Ask' : 'Bid'} </span>
        {row.px}
      </span>
      <span className="relative text-right text-level1">
        <span className="sr-only">size </span>
        {row.qty}
      </span>
      <span className="relative text-right text-level2">
        <span className="sr-only">total </span>
        {row.cum}
      </span>
    </Button>
  )
})

function Spread({ topic }: { topic: BookTopic }) {
  const last = useFrame(
    { kind: 'trades', market: topic.market },
    (frame) => ({ px: frame?.last ?? '', side: frame?.lastSide ?? null }),
    shallow,
  )
  const summary = useFrame(
    topic,
    (frame) => ({
      mid: frame?.mid ?? '',
      spread: frame?.spread ?? '',
      bps: frame?.spreadBps ?? '',
      status: frame?.status ?? 'syncing',
    }),
    shallow,
  )
  return (
    <div className="mx-1 my-0.5 flex shrink-0 flex-col justify-center gap-1.5 rounded-md bg-inset p-2">
      <span
        className={`num flex items-center gap-1.5 text-xl leading-none font-semibold ${last.side === 'sell' ? 'text-ask' : last.side === 'buy' ? 'text-bid' : 'text-level1'}`}
      >
        {last.side && (
          <>
            <SideMark side={last.side} className="size-3.5" />
            <span className="sr-only">Last {last.side === 'buy' ? 'buy' : 'sell'} </span>
          </>
        )}
        {last.px || summary.mid || '—'}
      </span>
      <span className="text-xs whitespace-nowrap text-level3">
        <span>
          Mid <span className="num">{summary.mid || '—'}</span>
        </span>
        {summary.status === 'live' && (
          <>
            {' · '}
            <span>
              Spread <span className="num">{summary.spread}</span> ·{' '}
              <span className="num">{summary.bps === '0.00' ? '<0.01' : summary.bps}</span> bps
            </span>
          </>
        )}
      </span>
    </div>
  )
}
