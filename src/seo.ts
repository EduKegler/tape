import { PINNED_BASES, VENUE_IDS } from '@tape/core/ids'
import type { Base, Network, VenueId } from '@tape/core/ids'

type Tag = Readonly<Record<string, string>>

export const SITE_DESCRIPTION =
  'Live order books, trades and depth from Binance, Hyperliquid, dYdX and Orderly on one screen, with orders signed in your browser.'

const marketPath = (venue: VenueId, base: Base): string => `/${venue}/${base}`

export const SITEMAP_PATHS: readonly string[] = VENUE_IDS.flatMap((venue) =>
  PINNED_BASES.map((base) => marketPath(venue, base)),
)

type MarketPage = {
  readonly venue: VenueId
  readonly venueLabel: string
  readonly base: Base
  readonly network: Network
  readonly site: string | undefined
}

export function marketHead({ venue, venueLabel, base, network, site }: MarketPage) {
  const title = `${base} on ${venueLabel} · Live order book · Tape${network === 'testnet' ? ' testnet' : ''}`
  const description = `Live ${base} order book, trades, depth and candles on ${venueLabel}, beside the best bid and ask on the other venues.`
  const url = site ? new URL(marketPath(venue, base), site).href : undefined
  const meta: Tag[] = [
    { title },
    { name: 'description', content: description },
    { property: 'og:type', content: 'website' },
    { property: 'og:site_name', content: 'Tape' },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    ...(url ? [{ property: 'og:url', content: url }] : []),
    { name: 'twitter:card', content: 'summary' },
    ...(network === 'testnet' ? [{ name: 'robots', content: 'noindex' }] : []),
  ]
  const links: Tag[] = url ? [{ rel: 'canonical', href: url }] : []
  return { meta, links }
}

export function sitemap(origin: string, paths: readonly string[]): string {
  const urls = paths.map((path) => `  <url><loc>${new URL(path, origin).href}</loc></url>`)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n')
}

export function robots(origin: string, network: Network): string {
  const lines = ['User-agent: *', 'Allow: /']
  if (network === 'mainnet') lines.push('', `Sitemap: ${new URL('/sitemap.xml', origin).href}`)
  return `${lines.join('\n')}\n`
}
