import { createFileRoute } from '@tanstack/react-router'
import { useFrame, useHubStats } from '#/client/hooks'
import { marketKey } from '#/core/ids'

export const Route = createFileRoute('/')({ component: Probe })

function Probe() {
  const stats = useHubStats()
  const mid = useFrame({ kind: 'book', market: marketKey('binance', 'BTC'), group: '1' }, (f) => f?.mid ?? '')
  const compare = useFrame({ kind: 'compare', base: 'BTC' }, (f) => f?.rows.map((r) => `${r.venue} ${r.status} ${r.bid}/${r.ask}`).join(' | ') ?? '')
  return (
    <main className="p-6 num">
      <p data-testid="stats">{stats ? `${stats.mode} tabs=${stats.tabs} sockets=${stats.sockets} streams=${stats.streams} msg/s=${stats.messagesPerSecond} frames/s=${stats.framesPerSecond}` : 'connecting'}</p>
      <p data-testid="mid">mid={mid}</p>
      <p data-testid="compare">{compare}</p>
    </main>
  )
}
