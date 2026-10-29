import type { TradeSession } from '#/trade/hooks'
import { TradeNote } from './TradeNote'

export function EnableTrading({ session }: { session: Extract<TradeSession, { status: 'setup' }> }) {
  const busy = session.progress !== null
  return (
    <div className="flex flex-col gap-2 rounded border border-rule p-2 text-[12px]">
      <ol className="flex flex-col gap-1">
        {(session.steps ?? []).map((s) => (
          <li key={s.id} className={`flex items-center gap-2 ${s.done ? 'text-level3 line-through' : 'text-level1'}`}>
            <span aria-hidden className={`inline-block size-1.5 rounded-full ${s.id === session.progress ? 'bg-ink' : s.done ? 'bg-bid' : 'bg-level3'}`} />
            {s.label}
          </li>
        ))}
        {!session.steps && <li className="text-level3">Checking the venue…</li>}
      </ol>
      <button type="button" disabled={busy || !session.steps} onClick={session.enable} className="rounded-full border border-ink py-1.5 text-[13px] text-level1 disabled:opacity-40">
        {busy ? 'Confirm in your wallet…' : 'Enable trading'}
      </button>
      <TradeNote error={session.error} />
    </div>
  )
}
