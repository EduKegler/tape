import { useHubStats } from '#/client/hooks'
import { SITE_READ_ONLY } from '#/trade/config'

export function StatusBar() {
  const stats = useHubStats()
  const offline = stats?.sockets === 0
  return (
    <footer
      className={`flex flex-wrap items-center gap-x-5 gap-y-1 border-t px-4 py-1.5 text-xs text-level3 lg:h-8 lg:flex-nowrap lg:py-0 lg:whitespace-nowrap ${offline ? 'border-warn' : 'border-rule'}`}
    >
      {stats ? (
        <>
          <span title="SharedWorker shares one socket per venue across tabs. Dedicated runs one hub per tab.">
            Hub <span className="num text-level2">{stats.mode}</span>
          </span>
          <span>
            Tabs <span className="num text-level2">{stats.tabs}</span>
          </span>
          <span>
            Sockets <span className={`num ${offline ? 'text-warn' : 'text-level2'}`}>{stats.sockets}</span>
          </span>
          <span>
            Streams <span className="num text-level2">{stats.streams}</span>
          </span>
          <span>
            In <span className="num text-level2">{stats.messagesPerSecond}</span> msg/s
          </span>
          <span>
            Out <span className="num text-level2">{stats.framesPerSecond}</span> frames/s
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
