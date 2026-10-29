import { createFileRoute } from '@tanstack/react-router'
import { ingest, readEnv } from '#/analytics/ingest'
import { NETWORK } from '#/site'

/** Analytics beacons. The path names nothing, so blocklists that match "track" or "analytics" pass it. */
export const Route = createFileRoute('/r1')({
  server: {
    handlers: {
      POST: ({ request }) => ingest(request, NETWORK, readEnv(), fetch),
    },
  },
})
