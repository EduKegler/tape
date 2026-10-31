import type { FrameStatus } from '#/core/topics'

type DataState = 'live' | 'stale' | 'empty' | 'error'
type Connection = 'connected' | 'reconnecting' | 'down'

export interface PanelState {
  readonly data: DataState
  readonly connection: Connection
  readonly text: string | null
}

export const STALE_AFTER_MS = 15_000

function ageText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 120 ? `${seconds} s old` : `${Math.round(seconds / 60)} min old`
}

const CONNECTION_WORD: Record<Connection, string> = {
  connected: 'No updates',
  reconnecting: 'Reconnecting',
  down: 'Offline',
}

export function panelState({
  status,
  liveAt,
  now,
  sockets,
  error,
  source,
  staleAfterMs,
}: {
  status: FrameStatus | null
  liveAt: number | null
  now: number
  sockets: number | null
  error: string | null
  source: string
  staleAfterMs: number | null
}): PanelState {
  const connection: Connection =
    status === 'stale' && sockets === 0
      ? 'down'
      : status === 'stale' || (status === 'syncing' && liveAt !== null)
        ? 'reconnecting'
        : 'connected'
  if (error) return { data: 'error', connection, text: error }
  if (liveAt === null)
    return { data: 'empty', connection, text: connection === 'connected' ? 'Loading…' : `Waiting for ${source}` }
  const quiet = staleAfterMs !== null && now - liveAt > staleAfterMs
  if (connection === 'connected' && !quiet) return { data: 'live', connection, text: null }
  return { data: 'stale', connection, text: `${CONNECTION_WORD[connection]} · ${ageText(now - liveAt)}` }
}
