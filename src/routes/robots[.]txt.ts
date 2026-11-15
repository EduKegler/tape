import { createFileRoute } from '@tanstack/react-router'
import { NETWORK } from '#/site'
import { robots } from '#/seo'

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: ({ request }) =>
        new Response(robots(new URL(request.url).origin, NETWORK), {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    },
  },
})
