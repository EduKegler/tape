import type { CommandOutcome, OrderLookup, TradeError } from '@tape/trade/types'
import { describeError } from './trade-errors'

export function TradeNote({
  error,
  outcome,
  lookup,
}: {
  error: TradeError | null
  outcome?: CommandOutcome | null
  lookup?: Lookup | null
}) {
  if (error) {
    const { title, detail } = describeError(error)
    return (
      <div
        role="alert"
        data-trade-error={error.kind}
        className="rounded-sm border border-ask/40 p-2 text-[12px] text-level2"
      >
        <p className="text-ask">{title}</p>
        {detail && <p className="num mt-1 text-[11px] break-all text-level3">{detail}</p>}
        {lookup && <LookupLine lookup={lookup} />}
      </div>
    )
  }
  if (outcome) {
    return (
      <p
        role="status"
        data-trade-outcome={outcome.kind}
        className="num rounded-sm border border-rule p-2 text-[12px] text-level2"
      >
        {outcome.kind === 'placed' ? `Order ${outcome.status}. ` : ''}
        {outcome.detail}
      </p>
    )
  }
  return null
}

type Lookup = { readonly result: OrderLookup | null; readonly error: TradeError | null }

function LookupLine({ lookup }: { lookup: Lookup }) {
  const text = lookup.error
    ? `Could not ask the venue about this order. ${describeError(lookup.error).title}`
    : !lookup.result
      ? 'Asking the venue for this order…'
      : lookup.result.kind === 'found'
        ? `The venue has this order. ${lookup.result.detail}. Do not send it again.`
        : `The venue does not show this order. ${lookup.result.detail}`
  return (
    <p
      data-order-lookup={lookup.error ? 'error' : (lookup.result?.kind ?? 'pending')}
      className="num mt-2 border-t border-rule pt-2 text-[11px] text-level2"
    >
      {text}
    </p>
  )
}
