import type { TradeSession } from '#/trade/hooks'
import { Button } from './primitives'
import { TradeNote } from './TradeNote'

export function EnableTrading({ session }: { session: Extract<TradeSession, { status: 'setup' }> }) {
  const busy = session.progress !== null
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-rule p-2 text-sm">
      <ol className="flex flex-col gap-1">
        {(session.steps ?? []).map((step) => (
          <li key={step.id} className={`flex items-center gap-2 ${step.done ? 'text-level3' : 'text-level1'}`}>
            {step.done ? (
              <span aria-hidden className="w-2 text-level2">
                ✓
              </span>
            ) : (
              <span aria-hidden className="flex w-2 justify-center">
                <span
                  className={`inline-block size-1.5 rounded-sm ${step.id === session.progress ? 'bg-ink' : 'bg-level3'}`}
                />
              </span>
            )}
            {step.label}
            {step.done && <span className="sr-only">, done</span>}
          </li>
        ))}
        {!session.steps && <li className="text-level3">Checking the venue…</li>}
      </ol>
      <Button look="primary" size="lg" disabled={busy || !session.steps} onClick={session.enable}>
        {busy ? 'Confirm in your wallet…' : 'Enable trading'}
      </Button>
      <TradeNote error={session.error} />
    </div>
  )
}
