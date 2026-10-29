import type { CommandOutcome, TradeError } from '@tape/trade/types'
import { describeError } from './trade-errors'

/** The venue's own words always show, so a rejection can be read and quoted. */
export function TradeNote({ error, outcome }: { error: TradeError | null; outcome?: CommandOutcome | null }) {
  if (error) {
    const { title, detail } = describeError(error)
    return (
      <div role="alert" data-trade-error={error.kind} className="rounded border border-ask/40 p-2 text-[12px] text-level2">
        <p className="text-ask">{title}</p>
        {detail && <p className="num mt-1 break-all text-[11px] text-level3">{detail}</p>}
      </div>
    )
  }
  if (outcome) {
    return (
      <p role="status" data-trade-outcome={outcome.kind} className="num rounded border border-rule p-2 text-[12px] text-level2">
        {outcome.kind === 'placed' ? `Order ${outcome.status}. ` : ''}
        {outcome.detail}
      </p>
    )
  }
  return null
}
