import type { TradeSession } from '#/trade/hooks'
import { Button } from './primitives'
import { TradeNote } from './TradeNote'

export function EnableTrading({ session }: { session: Extract<TradeSession, { status: 'setup' }> }) {
  const busy = session.progress !== null
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-rule p-2 text-sm">
      <ol className="flex flex-col gap-1">
        {(session.steps ?? []).map((s) => (
          <li key={s.id} className={`flex items-center gap-2 ${s.done ? 'text-level3 line-through' : 'text-level1'}`}>
            <span
              aria-hidden
              className={`inline-block size-1.5 rounded-sm ${s.id === session.progress ? 'bg-ink' : s.done ? 'bg-bid' : 'bg-level3'}`}
            />
            {s.label}
          </li>
        ))}
        {!session.steps && <li className="text-level3">Checking the venue…</li>}
      </ol>
      <Button look="outline-block" disabled={busy || !session.steps} onClick={session.enable}>
        {busy ? 'Confirm in your wallet…' : 'Enable trading'}
      </Button>
      <TradeNote error={session.error} />
    </div>
  )
}
