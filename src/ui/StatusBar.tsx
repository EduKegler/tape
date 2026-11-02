import { Link } from '@tanstack/react-router'
import type { VenueId } from '@tape/core/ids'
import { useHubStats } from '#/client/hooks'
import { sendsOrders } from '#/trade/config'

export function StatusBar({ venue }: { venue: VenueId }) {
  const stats = useHubStats()
  const offline = stats?.sockets === 0
  return (
    <footer
      className={`flex flex-wrap items-center gap-x-5 gap-y-1 bg-surface px-4 py-1.5 text-xs text-level3 lg:h-8 lg:flex-nowrap lg:py-0 lg:whitespace-nowrap ${offline ? 'border-t border-warn' : ''}`}
    >
      {stats ? (
        <>
          <span
            title="SharedWorker shares one socket per venue across tabs. Dedicated runs one hub per tab."
            className="flex items-center gap-1.5"
          >
            <span aria-hidden className={`size-1.5 rounded-sm ${offline ? 'bg-warn' : 'bg-live'}`} />
            <span className="tracking-wider uppercase">Hub</span>{' '}
            <span className="num font-medium text-level2">{stats.mode}</span>
          </span>
          <span>
            <span className="tracking-wider uppercase">Tabs</span>{' '}
            <span className="num font-medium text-level2">{stats.tabs}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span>
              <span className="tracking-wider uppercase">Sockets</span>{' '}
              <span className={`num font-medium ${offline ? 'text-warn' : 'text-level2'}`}>{stats.sockets}</span>
            </span>
            <span aria-hidden className="flex gap-0.5">
              {Array.from({ length: stats.sockets }, (_, index) => (
                <span key={index} className="size-1.5 rounded-sm bg-live" />
              ))}
            </span>
          </span>
          <span>
            <span className="tracking-wider uppercase">Streams</span>{' '}
            <span className="num font-medium text-level2">{stats.streams}</span>
          </span>
          <span>
            <span className="tracking-wider uppercase">In</span>{' '}
            <span className="num font-medium text-level2">{stats.messagesPerSecond}</span> msg/s
          </span>
          <span>
            <span className="tracking-wider uppercase">Out</span>{' '}
            <span className="num font-medium text-level2">{stats.framesPerSecond}</span> frames/s
          </span>
        </>
      ) : (
        <span>Starting hub…</span>
      )}
      <span aria-live="polite" className={`ml-auto min-w-0 truncate ${offline ? 'text-sm text-warn' : ''}`}>
        {offline
          ? 'Offline. No venue socket is open, so every price on screen is frozen. Tape keeps retrying.'
          : sendsOrders(venue)
            ? 'Orders are signed in your browser and sent straight to the venue. Tape has no server in between.'
            : 'Market data comes straight from the venues. Tape has no server in between.'}
      </span>
      <Link to="/terms" className="hover:text-level1">
        Terms
      </Link>
      <a className="hover:text-level1" href="https://github.com/EduKegler/tape">
        Source
      </a>
    </footer>
  )
}
