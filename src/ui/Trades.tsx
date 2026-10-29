import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useFrame } from '#/client/hooks'
import type { MarketKey } from '@tape/core/ids'
import type { TradeRow } from '#/core/topics'
import { formatClock } from './format'
import { Panel } from './Panel'
import { proposePrice } from './ticket-store'

const ROW = 20
const NO_ROWS: readonly TradeRow[] = []

export function Trades({ market }: { market: MarketKey }) {
  const rows = useFrame({ kind: 'trades', market }, (f) => f?.rows ?? NO_ROWS)
  const scroller = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 8, getItemKey: (i) => rows[i]?.id ?? i })
  return (
    <Panel title="Trades">
      <div className="num flex h-full flex-col text-[12px]">
        <div className="grid h-6 shrink-0 grid-cols-[1fr_1fr_auto] items-center gap-2 px-3 text-[11px] text-level3">
          <span>Price</span>
          <span className="text-right">Size</span>
          <span className="w-16 text-right">Time</span>
        </div>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 && <p className="px-3 py-2 text-level3">Waiting for trades…</p>}
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((item) => {
              const t = rows[item.index]
              if (!t) return null
              return (
                <button
                  type="button"
                  key={item.key}
                  onClick={() => proposePrice(t.px)}
                  className="absolute inset-x-0 grid h-5 grid-cols-[1fr_1fr_auto] items-center gap-2 px-3 text-left hover:bg-level1/5"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <span className={t.side === 'buy' ? 'text-bid' : 'text-ask'}>{t.px}</span>
                  <span className="text-right text-level1">{t.qty}</span>
                  <span className="w-16 text-right text-level3">{formatClock(t.time)}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </Panel>
  )
}
