import type { CommandOutcome, OrderLookup, TradeError } from '@tape/trade/types'
import { describeError, orderResult } from './trade-errors'

export function TradeNote({ error }: { error: TradeError | null }) {
  if (!error) return null
  const { title, detail } = describeError(error)
  return (
    <div role="alert" data-trade-error={error.kind} className="border-l-2 border-warn pl-2 text-sm text-level1">
      <p>{title}</p>
      {detail && <p className="num mt-0.5 text-xs break-all text-level3">{detail}</p>}
    </div>
  )
}

type Lookup = { readonly result: OrderLookup | null; readonly error: TradeError | null }

export function OrderNote({
  error,
  outcome,
  lookup = null,
}: {
  error: TradeError | null
  outcome: CommandOutcome | null
  lookup?: Lookup | null
}) {
  if (error) {
    const { title, detail } = describeError(error)
    return (
      <div
        role="alert"
        data-trade-error={error.kind}
        className="flex flex-col gap-0.5 border-l-2 border-warn pl-2 text-sm text-level2"
      >
        {lookup && <LookupLine lookup={lookup} />}
        <p className={lookup ? undefined : 'font-medium text-level1'}>
          <span className="text-warn">{orderResult(error)}.</span> {title}
        </p>
        {detail && <p className="num text-xs break-all text-level3">{detail}</p>}
      </div>
    )
  }
  if (!outcome) return null
  return (
    <p
      role="status"
      aria-live="assertive"
      data-trade-outcome={outcome.kind}
      className="num border-l-2 border-level3 pl-2 text-sm text-level2"
    >
      {outcome.kind === 'placed' ? `Order ${outcome.status}. ` : ''}
      {outcome.detail}
    </p>
  )
}

function LookupLine({ lookup }: { lookup: Lookup }) {
  const blocks = !lookup.error && lookup.result?.kind !== 'absent'
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
      className={`num text-level1 ${blocks ? 'font-medium' : ''}`}
    >
      {text}
    </p>
  )
}
