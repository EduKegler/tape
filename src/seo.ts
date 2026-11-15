import { PINNED_BASES, VENUE_IDS } from '@tape/core/ids'
import type { Base, Network, VenueId } from '@tape/core/ids'

const marketPath = (venue: VenueId, base: Base): string => `/${venue}/${base}`

export const SITEMAP_PATHS: readonly string[] = VENUE_IDS.flatMap((venue) =>
  PINNED_BASES.map((base) => marketPath(venue, base)),
)

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
