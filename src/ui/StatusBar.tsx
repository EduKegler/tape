import { useHubStats } from '#/client/hooks'
import { SITE_READ_ONLY } from '#/trade/config'

export function StatusBar() {
  const stats = useHubStats()
  const offline = stats?.sockets === 0
  return (
    <footer
      className={`flex flex-wrap items-center gap-x-5 gap-y-1 bg-surface px-4 py-1.5 text-xs text-level3 lg:h-8 lg:flex-nowrap lg:py-0 lg:whitespace-nowrap ${offline ? 'border-t border-warn' : ''}`}
    >
      {stats ? (
        <>
          <span title="SharedWorker shares one socket per venue across tabs. Dedicated runs one hub per tab.">
            <span className="uppercase">Hub</span> <span className="num text-level2">{stats.mode}</span>
          </span>
          <span>
            <span className="uppercase">Tabs</span> <span className="num text-level2">{stats.tabs}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span>
              <span className="uppercase">Sockets</span>{' '}
              <span className={`num ${offline ? 'text-warn' : 'text-level2'}`}>{stats.sockets}</span>
            </span>
            <span aria-hidden className="flex gap-0.5">
              {Array.from({ length: stats.sockets }, (_, index) => (
                <span key={index} className="size-1.5 rounded-sm bg-level2" />
              ))}
            </span>
          </span>
          <span>
            <span className="uppercase">Streams</span> <span className="num text-level2">{stats.streams}</span>
          </span>
          <span>
            <span className="uppercase">In</span> <span className="num text-level2">{stats.messagesPerSecond}</span>{' '}
            msg/s
          </span>
          <span>
            <span className="uppercase">Out</span> <span className="num text-level2">{stats.framesPerSecond}</span>{' '}
            frames/s
          </span>
        </>
      ) : (
        <span>Starting hub…</span>
      )}
      <span aria-live="polite" className={`ml-auto min-w-0 truncate ${offline ? 'text-sm text-warn' : ''}`}>
        {offline
          ? 'Offline. No venue socket is open, so every price on screen is frozen. Tape keeps retrying.'
          : SITE_READ_ONLY
            ? 'Market data comes straight from the venues. Tape has no server in between.'
            : 'Orders are signed in your browser and sent straight to the venue. Tape has no server in between.'}
      </span>
      <a className="hover:text-level1" href="https://github.com/EduKegler/tape">
        Source
      </a>
    </footer>
  )
}
