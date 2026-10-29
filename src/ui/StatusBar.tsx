import { useHubStats } from '#/client/hooks'
import { SITE_READ_ONLY } from '#/trade/config'

/** The hub's own numbers, so the sharing claim can be checked by opening a second tab. */
export function StatusBar() {
  const stats = useHubStats()
  return (
    <footer className="num flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-rule px-4 py-1.5 text-[11px] text-level3">
      {stats ? (
        <>
          <span title="SharedWorker shares one socket per venue across tabs. Dedicated runs one hub per tab.">
            Hub <span className="text-level2">{stats.mode}</span>
          </span>
          <span>
            Tabs <span className="text-level2">{stats.tabs}</span>
          </span>
          <span>
            Sockets <span className="text-level2">{stats.sockets}</span>
          </span>
          <span>
            Streams <span className="text-level2">{stats.streams}</span>
          </span>
          <span>
            In <span className="text-level2">{stats.messagesPerSecond}</span> msg/s
          </span>
          <span>
            Out <span className="text-level2">{stats.framesPerSecond}</span> frames/s
          </span>
        </>
      ) : (
        <span>Starting hub…</span>
      )}
      <span className="ml-auto font-sans">
        {SITE_READ_ONLY
          ? 'Market data comes straight from the venues. Tape has no server in between.'
          : 'Orders are signed in your browser and sent straight to the venue. Tape has no server in between.'}
      </span>
      <a className="font-sans hover:text-level1" href="https://github.com/EduKegler/tape">
        Source
      </a>
    </footer>
  )
}
