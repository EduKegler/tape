import { useEffect, useState } from 'react'
import { splitMarketKey } from '@tape/core/ids'
import { useFrame, useFrameEffect, useHubStats } from '#/client/hooks'
import { topicKey } from '#/core/topics'
import type { Topic } from '#/core/topics'
import { VENUES } from '#/site'
import { STALE_AFTER_MS, panelState } from './panel-state'
import type { PanelState } from './panel-state'
import { Button } from './primitives'

function PanelStatus({ state, onRetry }: { state: PanelState; onRetry?: () => void }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2 text-xs/tight whitespace-nowrap">
      <span
        aria-live="polite"
        data-panel-state={state.data}
        data-connection={state.connection}
        className={state.data === 'stale' || state.data === 'error' ? 'text-warn' : 'text-level3'}
      >
        {state.text && (
          <span key={`${state.data} ${state.connection}`} className="motion-safe:animate-fade-in">
            {state.text}
          </span>
        )}
      </span>
      {state.data === 'error' && onRetry && (
        <Button look="link" onClick={onRetry}>
          Retry
        </Button>
      )}
    </span>
  )
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [ticking])
  return now
}

export function TopicStatus({
  topic,
  error = null,
  onRetry,
  ageLimit = false,
}: {
  topic: Topic
  error?: string | null
  onRetry?: () => void
  ageLimit?: boolean
}) {
  const key = topicKey(topic)
  const status = useFrame(topic, (f) => f?.status ?? null)
  const [live, setLive] = useState<{ key: string; at: number } | null>(null)
  useFrameEffect(topic, ({ liveAt: at }) => {
    if (at === null) return
    setLive((prev) => (prev?.key === key && at - prev.at < 1000 ? prev : { key, at }))
  })
  const liveAt = live?.key === key ? live.at : null
  const now = useNow(liveAt !== null && (ageLimit || status !== 'live'))
  const sockets = useHubStats()?.sockets ?? null
  const state = panelState({
    status,
    liveAt,
    now,
    sockets,
    error,
    source: topic.kind === 'compare' ? 'the venues' : VENUES[splitMarketKey(topic.market).venue].label,
    staleAfterMs: ageLimit ? STALE_AFTER_MS : null,
  })
  return <PanelStatus state={state} onRetry={onRetry} />
}
