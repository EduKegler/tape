import { createFileRoute } from '@tanstack/react-router'
import { NETWORK } from '#/site'
import { SITEMAP_PATHS, sitemap } from '#/seo'

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: ({ request }) =>
        NETWORK === 'mainnet'
          ? new Response(sitemap(new URL(request.url).origin, SITEMAP_PATHS), {
              headers: { 'content-type': 'application/xml; charset=utf-8' },
            })
          : new Response(null, { status: 404 }),
    },
  },
})
