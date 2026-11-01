import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { shallow } from '@tanstack/store'
import { PINNED_BASES, marketKey } from '@tape/core/ids'
import type { Base, VenueId } from '@tape/core/ids'
import { useFrame } from '#/client/hooks'
import { NETWORK } from '#/site'
import { WalletButton } from '#/wallet/Wallet'
import { SIDE_MARK, formatCompact, formatPct } from './format'
import { HistoryLink } from './HistoryLink'
import { MarketSearch } from './MarketSearch'
import { TopicStatus } from './PanelStatus'
import { statsQuery } from './queries'

export function Header({ venue, base }: { venue: VenueId; base: Base }) {
  const bases = PINNED_BASES.includes(base) ? PINNED_BASES : [...PINNED_BASES, base]
  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-2 bg-surface px-4 py-1.5 xl:flex-nowrap">
      <Brand />
      <nav aria-label="Market" className="flex shrink-0 items-center gap-1">
        {bases.map((marketBase) => (
          <Link
            key={marketBase}
            to="/$venue/$base"
            params={{ venue, base: marketBase }}
            search={(search) => search}
            aria-current={marketBase === base ? 'page' : undefined}
            className="px-2.5 py-1 text-base text-level3 hover:text-level1 aria-[current=page]:text-level1 aria-[current=page]:inset-shadow-selected"
          >
            {marketBase}
          </Link>
        ))}
      </nav>
      <MarketSearch venue={venue} />
      <Ticker venue={venue} base={base} />
      <div className="ml-auto flex shrink-0 items-center gap-4">
        <HistoryLink className="text-base text-level3 hover:text-level1">History</HistoryLink>
        <WalletButton />
      </div>
    </header>
  )
}

export function Brand() {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2 text-level1">
      <svg role="img" aria-label="Tape" viewBox="0 0 95 32" className="h-5 w-auto">
        <path fill="currentColor" d={LOCKUP} />
      </svg>
      {NETWORK === 'testnet' && (
        <span className="rounded-sm bg-level1/12 px-2 py-0.5 text-xs text-level1">Testnet</span>
      )}
    </Link>
  )
}

function Ticker({ venue, base }: { venue: VenueId; base: Base }) {
  const topic = { kind: 'trades', market: marketKey(venue, base) } as const
  const last = useFrame(topic, (frame) => ({ px: frame?.last ?? '', side: frame?.lastSide ?? null }), shallow)
  const stats = useQuery(statsQuery(venue, base))
  const daily = stats.data
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <dl className="flex h-11.5 min-w-0 flex-wrap items-baseline gap-5 overflow-hidden text-sm">
        <div>
          <dt className="sr-only">Last price</dt>
          <dd
            className={`num text-xl leading-none ${last.side === 'sell' ? 'text-ask' : last.side === 'buy' ? 'text-bid' : 'text-level1'}`}
          >
            {last.side && (
              <>
                <span aria-hidden className="mr-1 text-base">
                  {SIDE_MARK[last.side]}
                </span>
                <span className="sr-only">{last.side === 'buy' ? 'Buy' : 'Sell'} </span>
              </>
            )}
            {last.px || '—'}
          </dd>
        </div>
        <Stat
          label="24h"
          value={daily ? formatPct(daily.changePct) : '—'}
          tone={daily ? (daily.changePct >= 0 ? 'text-bid' : 'text-ask') : ''}
        />
        <Stat label="Volume" value={daily ? formatCompact(daily.volumeQuote) : '—'} />
        {daily?.fundingRate != null && <Stat label="Funding 1h" value={formatPct(daily.fundingRate * 100, 4)} />}
        {daily?.indexPrice != null && <Stat label="Index" value={daily.indexPrice.toLocaleString('en-US')} />}
      </dl>
      <div className="shrink-0">
        <TopicStatus
          topic={topic}
          error={stats.isError ? 'Could not load 24h stats.' : null}
          onRetry={() => void stats.refetch()}
        />
      </div>
    </div>
  )
}

function Stat({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <dt className="text-xs text-level3">{label}</dt>
      <dd className={`num ${tone || 'text-level2'}`}>{value}</dd>
    </div>
  )
}

const LOCKUP =
  'M10,2h12c4.418,0 8,3.582 8,8l0,2.775c-0.764,-0.015 -1.494,-0.039 -2.23,-0.075c-1.513,-0.065 -3.052,-0.096 -4.47,-0.1l-0.3,0c-2,0 -2.12,-0.36 -3.24,-1.04c-1.057,-0.626 -2.987,-1.533 -4.46,-1.648l-0.3,-0.012c-3.5,0 -4.76,-0.81 -6.89,-1.96c-1.331,-0.722 -3.006,-1.46 -5.057,-1.909c1.379,-2.408 3.974,-4.031 6.947,-4.031zM30,22c0,4.418 -3.582,8 -8,8h-12c-2.753,0 -5.181,-1.391 -6.621,-3.508c3.832,-0.731 6.85,-2.336 9.251,-3.902c3.25,-2.13 5.37,-3.79 10.37,-3.79c1.5,0 2.85,0.12 4.48,0.2c0.782,0.034 1.628,0.082 2.52,0.122zM2,22v-3.82c2.529,-0.38 4.532,-1.195 6.09,-2c2.12,-1.1 3.41,-1.88 6.91,-1.88c1.5,0 1.37,0.36 2.49,1.04c0.285,0.169 0.649,0.358 1.066,0.547c-2.959,0.912 -5.469,2.577 -7.686,4.023c-2.602,1.705 -4.799,3.365 -8.65,3.96c-0.144,-0.6 -0.22,-1.226 -0.22,-1.87zM2,10c0,-0.446 0.036,-0.883 0.107,-1.309c1.894,0.405 3.067,1.177 4.533,1.969c0.841,0.456 1.78,0.966 2.825,1.415c-1.034,0.427 -1.965,0.911 -2.805,1.345c-1.489,0.772 -2.691,1.535 -4.66,1.921zM51.19 11.5L51.19 13.66L43.88 13.66L43.88 11.5ZM45.85 8.28L48.5 8.28L48.5 21.35Q48.5 22.16 48.85 22.54Q49.19 22.92 49.98 22.92Q50.18 22.92 50.52 22.87Q50.86 22.82 51.1 22.77L51.57 24.9Q51.15 25.04 50.66 25.11Q50.18 25.18 49.71 25.18Q47.87 25.18 46.86 24.23Q45.85 23.28 45.85 21.57ZM57.49 25.3Q56.21 25.3 55.17 24.82Q54.13 24.34 53.53 23.43Q52.92 22.51 52.92 21.18Q52.92 20.03 53.36 19.3Q53.8 18.56 54.56 18.12Q55.31 17.69 56.24 17.47Q57.16 17.26 58.11 17.15Q59.31 17 60.06 16.91Q60.81 16.82 61.16 16.61Q61.52 16.4 61.52 15.93L61.52 15.86Q61.52 15.09 61.23 14.58Q60.94 14.06 60.37 13.77Q59.79 13.49 58.94 13.49Q58.05 13.49 57.42 13.76Q56.79 14.03 56.39 14.45Q56 14.88 55.81 15.34L53.31 14.68Q53.77 13.48 54.63 12.74Q55.48 12 56.59 11.67Q57.7 11.33 58.89 11.33Q59.71 11.33 60.63 11.52Q61.54 11.71 62.35 12.22Q63.16 12.73 63.67 13.65Q64.18 14.56 64.18 16.04L64.18 25L61.6 25L61.6 23.15L61.47 23.15Q61.21 23.67 60.69 24.16Q60.17 24.66 59.38 24.98Q58.59 25.3 57.49 25.3ZM58.08 23.16Q59.17 23.16 59.94 22.74Q60.71 22.31 61.12 21.61Q61.53 20.91 61.53 20.13L61.53 18.4Q61.39 18.55 60.98 18.66Q60.58 18.78 60.06 18.87Q59.54 18.96 59.06 19.02Q58.57 19.08 58.26 19.12Q57.51 19.21 56.89 19.44Q56.27 19.67 55.9 20.09Q55.53 20.52 55.53 21.22Q55.53 21.86 55.86 22.29Q56.2 22.73 56.76 22.94Q57.33 23.16 58.08 23.16ZM67.5 30.04L67.5 11.5L70.09 11.5L70.09 13.69L70.3 13.69Q70.54 13.27 70.97 12.72Q71.4 12.16 72.17 11.74Q72.94 11.33 74.2 11.33Q75.82 11.33 77.09 12.15Q78.37 12.97 79.1 14.53Q79.84 16.08 79.84 18.28Q79.84 20.46 79.12 22.02Q78.39 23.58 77.12 24.42Q75.85 25.26 74.2 25.26Q72.98 25.26 72.2 24.84Q71.43 24.43 70.99 23.87Q70.54 23.32 70.3 22.88L70.16 22.88L70.16 30.04ZM73.61 23Q74.77 23 75.56 22.37Q76.34 21.75 76.73 20.67Q77.12 19.6 77.12 18.26Q77.12 16.93 76.73 15.87Q76.34 14.82 75.56 14.2Q74.78 13.59 73.61 13.59Q72.48 13.59 71.69 14.17Q70.91 14.76 70.51 15.8Q70.11 16.85 70.11 18.26Q70.11 19.66 70.51 20.73Q70.92 21.8 71.7 22.4Q72.49 23 73.61 23ZM88.36 25.27Q86.37 25.27 84.92 24.42Q83.47 23.56 82.69 22Q81.92 20.44 81.92 18.34Q81.92 16.27 82.68 14.68Q83.45 13.1 84.85 12.21Q86.25 11.33 88.13 11.33Q89.29 11.33 90.37 11.71Q91.44 12.09 92.3 12.9Q93.16 13.71 93.66 14.99Q94.16 16.28 94.16 18.11L94.16 19.05L83.4 19.05L83.4 17.07L92.79 17.07L91.55 17.73Q91.55 16.48 91.16 15.54Q90.78 14.59 90.02 14.06Q89.27 13.52 88.13 13.52Q87.01 13.52 86.21 14.07Q85.42 14.61 85 15.5Q84.58 16.39 84.58 17.44L84.58 18.79Q84.58 20.18 85.06 21.14Q85.54 22.1 86.39 22.59Q87.25 23.08 88.39 23.08Q89.14 23.08 89.74 22.86Q90.34 22.65 90.78 22.22Q91.22 21.8 91.45 21.17L93.95 21.76Q93.63 22.8 92.86 23.59Q92.09 24.39 90.95 24.83Q89.81 25.27 88.36 25.27Z'
