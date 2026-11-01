import { createFileRoute, notFound } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { INTERVALS, isBase, isVenueId, marketKey } from '@tape/core/ids'
import type { Base, VenueId } from '@tape/core/ids'
import { NETWORK, VENUES } from '#/site'
import { CandleChart } from '#/ui/CandleChart'
import { Compare } from '#/ui/Compare'
import { DepthChart } from '#/ui/DepthChart'
import { Header } from '#/ui/Header'
import { OrderBook } from '#/ui/OrderBook'
import { marketQuery } from '#/ui/queries'
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
    parse: (params): { venue: VenueId; base: Base } => {
      if (!isVenueId(params.venue) || !isBase(params.base)) throw notFound()
      return { venue: params.venue, base: params.base }
    },
    stringify: (params) => params,
  },
  validateSearch: searchSchema,
  head: ({ params }) => marketHead(params),
  component: Market,
})

function marketHead({ venue, base }: Record<'venue' | 'base', string>) {
  if (!isVenueId(venue) || !isBase(base)) return {}
  return { meta: [{ title: `${base} on ${VENUES[venue].label} · Tape${NETWORK === 'testnet' ? ' testnet' : ''}` }] }
}

function Market() {
  const { venue, base } = Route.useParams()
  const search = Route.useSearch()
  const group = search.group === undefined ? '' : String(search.group)
  const navigate = Route.useNavigate()
  const market = marketKey(venue, base)
  const unlisted = useQuery(marketQuery(venue, base)).data === null
  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <Header venue={venue} base={base} />
      {unlisted ? (
        <Unlisted venue={venue} base={base} />
      ) : (
        <main className="grid flex-1 gap-2.5 p-2.5 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_20rem_17rem_22rem] lg:grid-rows-[minmax(0,1fr)_9rem_fit-content(13rem)]">
          <div className="rounded-lg lg:col-start-4 lg:row-span-2 lg:row-start-1 lg:min-h-0 lg:overflow-y-auto">
            <Ticket venue={venue} base={base} group={group} />
          </div>
          <div className="h-72 lg:col-span-3 lg:col-start-1 lg:row-start-3 lg:h-auto lg:min-h-0">
            <Account venue={venue} base={base} />
          </div>
          <div className="h-80 lg:col-start-1 lg:row-start-1 lg:h-auto lg:min-h-0">
            <CandleChart
              venue={venue}
              base={base}
              interval={search.interval}
              onInterval={(interval) =>
                void navigate({ search: (current) => ({ ...current, interval }), replace: true })
              }
            />
          </div>
          <div className="h-[660px] lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:h-auto lg:min-h-0">
            <OrderBook
              market={market}
              group={group}
              onGroup={(picked) =>
                void navigate({ search: (current) => ({ ...current, group: Number(picked) }), replace: true })
              }
            />
          </div>
          <div className="h-80 lg:col-start-3 lg:row-span-2 lg:row-start-1 lg:h-auto lg:min-h-0">
            <Trades market={market} />
          </div>
          <div className="h-52 lg:col-start-1 lg:row-start-2 lg:h-auto lg:min-h-0">
            <DepthChart market={market} />
          </div>
          <div className="lg:col-start-4 lg:row-start-3 lg:min-h-0">
            <Compare base={base} current={venue} />
          </div>
        </main>
      )}
      <StatusBar />
    </div>
  )
}

function Unlisted({ venue, base }: { venue: VenueId; base: Base }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-lg text-level1">
        Tape does not show {base} on {VENUES[venue].label}
      </h1>
      <p className="text-sm text-level3">
        {VENUES[venue].label} does not list it, or Tape leaves it out. Pick another market or venue in the header.
      </p>
    </main>
  )
}
