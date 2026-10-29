import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { shallow } from '@tanstack/store'
import { useFrame } from '#/client/hooks'
import { BASES, VENUE_IDS, marketKey } from '#/core/ids'
import type { Base, VenueId } from '#/core/ids'
import { VENUES } from '#/venues/index'
import { WalletButton } from '#/wallet/Wallet'
import { formatCompact, formatPct } from './format'
import { statsQuery } from './queries'

export function Header({ venue, base }: { venue: VenueId; base: Base }) {
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule px-4 py-2">
      <Link to="/" className="font-display text-[22px] leading-none text-level1">Tape</Link>
      <nav aria-label="Market" className="flex items-center gap-1">
        {BASES.map((b) => (
          <Link
            key={b}
            to="/$venue/$base"
            params={{ venue, base: b }}
            search={(s) => s}
            className="rounded-full px-2.5 py-1 text-[13px] text-level3 hover:text-level1"
            activeProps={{ className: 'bg-level1/12 text-level1', 'aria-current': 'page' }}
          >
            {b}
          </Link>
        ))}
      </nav>
      <nav aria-label="Venue" className="flex items-center gap-1">
        {VENUE_IDS.map((v) => (
          <Link
            key={v}
            to="/$venue/$base"
            params={{ venue: v, base }}
            search={(s) => s}
            className="flex flex-col rounded px-2 py-0.5 leading-tight text-level3 hover:text-level1"
            activeProps={{ className: 'bg-level1/8 text-level1', 'aria-current': 'page' }}
          >
            <span className="text-[13px]">{VENUES[v].label}</span>
            <span className="text-[10px] text-level3">{VENUES[v].chain}</span>
          </Link>
        ))}
      </nav>
      <Ticker venue={venue} base={base} />
      <div className="ml-auto">
        <WalletButton />
      </div>
    </header>
  )
}

function Ticker({ venue, base }: { venue: VenueId; base: Base }) {
  const last = useFrame({ kind: 'trades', market: marketKey(venue, base) }, (f) => ({ px: f?.last ?? '', side: f?.lastSide ?? null }), shallow)
  const stats = useQuery(statsQuery(venue, base))
  const s = stats.data
  return (
    <dl className="num flex items-baseline gap-5 text-[12px]">
      <div>
        <dt className="sr-only">Last price</dt>
        <dd className={`text-[16px] ${last.side === 'sell' ? 'text-ask' : last.side === 'buy' ? 'text-bid' : 'text-level1'}`}>{last.px || '—'}</dd>
      </div>
      <Stat label="24h" value={s ? formatPct(s.changePct) : '—'} tone={s ? (s.changePct >= 0 ? 'text-bid' : 'text-ask') : ''} />
      <Stat label="Volume" value={s ? formatCompact(s.volumeQuote) : '—'} />
      {s?.fundingRate != null && <Stat label="Funding 1h" value={formatPct(s.fundingRate * 100, 4)} />}
      {s?.indexPrice != null && <Stat label="Index" value={s.indexPrice.toLocaleString('en-US')} />}
    </dl>
  )
}

function Stat({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <dt className="font-sans text-[10px] text-level3">{label}</dt>
      <dd className={tone || 'text-level2'}>{value}</dd>
    </div>
  )
}
