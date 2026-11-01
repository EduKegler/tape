import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { shallow } from '@tanstack/store'
import type { MarketKey } from '@tape/core/ids'
import { useFrame } from '#/client/hooks'
import type { TradeRow } from '#/core/topics'
import { SIDE_MARK, formatClock } from './format'
import { Panel, useRowKeys } from './Panel'
import { TopicStatus } from './PanelStatus'
import { Button } from './primitives'
import { proposePrice } from './ticket-store'

const ROW = 20
const NO_ROWS: readonly TradeRow[] = []

export function Trades({ market }: { market: MarketKey }) {
  const topic = { kind: 'trades', market } as const
  const { rows, live } = useFrame(
    topic,
    (frame) => ({ rows: frame?.rows ?? NO_ROWS, live: frame?.status === 'live' }),
    shallow,
  )
  const scroller = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 8,
    getItemKey: (index) => rows[index]?.id ?? index,
  })
  const keys = useRowKeys()
  return (
    <Panel title="Trades" status={<TopicStatus topic={topic} />}>
      <div className="flex h-full flex-col text-sm">
        <div className="grid h-6 shrink-0 grid-cols-[1fr_1fr_auto] items-center gap-2 px-3 text-xs text-level3">
          <span>Price</span>
          <span className="text-right">Size</span>
          <span className="w-16 text-right">Time</span>
        </div>
        <div ref={scroller} role="group" aria-label="Trade list" {...keys} className="min-h-0 flex-1 overflow-y-auto">
          {live && rows.length === 0 && <p className="px-3 py-2 text-level3">No trades yet.</p>}
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((item) => {
              const trade = rows[item.index]
              if (!trade) return null
              return (
                <Button
                  key={item.key}
                  look="row"
                  data-row
                  tabIndex={-1}
                  onClick={() => proposePrice(trade.px)}
                  className="num absolute inset-x-0 grid h-5 grid-cols-[1fr_1fr_auto] items-center gap-2 px-3"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <span className={trade.side === 'buy' ? 'text-bid' : 'text-ask'}>
                    <span aria-hidden className="mr-1 text-xs">
                      {SIDE_MARK[trade.side]}
                    </span>
                    <span className="sr-only">{trade.side === 'buy' ? 'Buy' : 'Sell'} </span>
                    {trade.px}
                  </span>
                  <span className="text-right text-level1">
                    <span className="sr-only">size </span>
                    {trade.qty}
                  </span>
                  <span className="w-16 text-right text-level3">
                    <span className="sr-only">at </span>
                    {formatClock(trade.time)}
                  </span>
                </Button>
              )
            })}
          </div>
        </div>
      </div>
    </Panel>
  )
}
