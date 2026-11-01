import type { CommandOutcome, OrderLookup, TradeError } from '@tape/trade/types'
import { Button } from './primitives'
import { ErrorMark } from './ErrorMark'
import { describeError, orderResult, readFailure } from './trade-errors'
import { useWashCount } from './wash'

export function TradeNote({ error }: { error: TradeError | null }) {
  if (!error) return null
  const { title, detail } = describeError(error)
  return (
    <div role="alert" data-trade-error={error.kind} className="flex gap-1.5 text-sm text-level1">
      <ErrorMark />
      <div className="min-w-0">
        <p>{title}</p>
        {detail && <p className="mt-0.5 text-xs break-all text-level3">{detail}</p>}
      </div>
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
  const washes = useWashCount(outcome, outcome?.kind === 'placed' && outcome.status === 'filled')
  if (error) {
    const { title, detail } = describeError(error)
    return (
      <div role="alert" data-trade-error={error.kind} className="flex gap-1.5 text-sm text-level2">
        <ErrorMark />
        <div className="flex min-w-0 flex-col gap-0.5">
          {lookup && <LookupLine lookup={lookup} />}
          <p className={lookup ? undefined : 'font-medium text-level1'}>
            <span className="text-err">{orderResult(error)}.</span> {title}
          </p>
          {detail && <p className="text-xs break-all text-level3">{detail}</p>}
        </div>
      </div>
    )
  }
  if (!outcome) return null
  return (
    <p
      role="status"
      aria-live="assertive"
      data-trade-outcome={outcome.kind}
      className="relative overflow-hidden rounded-md bg-raised px-2.5 py-2 text-sm font-medium text-level1 tabular-nums"
    >
      {washes > 0 && <span key={washes} aria-hidden className="pointer-events-none absolute inset-0 wash" />}
      <span className="relative">
        {outcome.kind === 'placed' ? `Order ${outcome.status}. ` : ''}
        {outcome.detail}
      </span>
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
      className={`text-level1 tabular-nums ${blocks ? 'font-medium' : ''}`}
    >
      {text}
    </p>
  )
}

export function ReadNote(props: { what: string; error: TradeError; onRetry: () => void; busy: boolean }) {
  return (
    <p role="alert" className="flex gap-1.5 text-level1">
      <ErrorMark />
      <span>
        Could not read {props.what}. {readFailure(props.error)}{' '}
        <Button look="link" onClick={props.onRetry} disabled={props.busy}>
          Retry
        </Button>
      </span>
    </p>
  )
}
