import { createFileRoute, notFound } from '@tanstack/react-router'
import { z } from 'zod'
import { INTERVALS, isBase, isVenueId, marketKey } from '@tape/core/ids'
import type { Base, VenueId } from '@tape/core/ids'
import { NETWORK, VENUES } from '#/site'
import { CandleChart } from '#/ui/CandleChart'
import { Compare } from '#/ui/Compare'
import { DepthChart } from '#/ui/DepthChart'
import { Header } from '#/ui/Header'
import { OrderBook } from '#/ui/OrderBook'
import { StatusBar } from '#/ui/StatusBar'
import { Ticket } from '#/ui/Ticket'
import { Account } from '#/ui/Account'
import { Trades } from '#/ui/Trades'

const searchSchema = z.object({
  group: z.number().positive().optional().catch(undefined),
  interval: z.enum(INTERVALS).default('1m').catch('1m'),
})

export const Route = createFileRoute('/$venue/$base')({
  params: {
    parse: (p): { venue: VenueId; base: Base } => {
      if (!isVenueId(p.venue) || !isBase(p.base)) throw notFound()
      return { venue: p.venue, base: p.base }
    },
    stringify: (p) => p,
  },
  validateSearch: searchSchema,
  head: ({ params }) => ({
    meta: [
      { title: `${params.base} on ${VENUES[params.venue].label} · Tape${NETWORK === 'testnet' ? ' testnet' : ''}` },
    ],
  }),
  component: Market,
})

function Market() {
  const { venue, base } = Route.useParams()
  const search = Route.useSearch()
  const group = search.group === undefined ? '' : String(search.group)
  const navigate = Route.useNavigate()
  const market = marketKey(venue, base)
  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <Header venue={venue} base={base} />
      <main className="grid flex-1 gap-px p-px lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_20rem_17rem_22rem] lg:grid-rows-[minmax(0,1fr)_15rem_14rem]">
        <div className="h-80 lg:h-auto lg:min-h-0">
          <CandleChart
            venue={venue}
            base={base}
            interval={search.interval}
            onInterval={(i) => void navigate({ search: (s) => ({ ...s, interval: i }), replace: true })}
          />
        </div>
        <div className="h-[660px] lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:h-auto">
          <OrderBook
            market={market}
            group={group}
            onGroup={(g) => void navigate({ search: (s) => ({ ...s, group: Number(g) }), replace: true })}
          />
        </div>
        <div className="h-80 lg:col-start-3 lg:row-span-2 lg:row-start-1 lg:h-auto">
          <Trades market={market} />
        </div>
        <div className="lg:col-start-4 lg:row-start-1 lg:min-h-0 lg:overflow-y-auto">
          <Ticket venue={venue} base={base} group={group} />
        </div>
        <div className="h-52 lg:col-start-1 lg:row-start-2 lg:h-auto">
          <DepthChart market={market} />
        </div>
        <div className="lg:col-start-4 lg:row-span-2 lg:row-start-2">
          <Compare base={base} current={venue} />
        </div>
        <div className="h-72 lg:col-span-3 lg:col-start-1 lg:row-start-3 lg:h-auto lg:min-h-0">
          <Account venue={venue} base={base} />
        </div>
      </main>
      <StatusBar />
    </div>
  )
}
