import { z } from 'zod'
import type { Network } from '@tape/core/ids'
import { Batch } from './events'

const MAX_BODY = 32_000
const MAX_SKEW_MS = 60 * 60_000

const Env = z.object({
  POSTHOG_KEY: z.string().min(1).optional(),
  POSTHOG_HOST: z.url().default('https://eu.i.posthog.com'),
})
type Env = z.infer<typeof Env>

/** An empty variable means unset, so a blank value in the dashboard does not fail every beacon. */
export const readEnv = (): Env =>
  Env.parse({ POSTHOG_KEY: process.env.POSTHOG_KEY || undefined, POSTHOG_HOST: process.env.POSTHOG_HOST || undefined })

type Context = { readonly network: Network; readonly origin: string; readonly ip: string | null; readonly now: number }

/** The body for PostHog's batch endpoint. Every event is anonymous and keyed by the page load, so no person profile is made. */
function toPostHog(batch: Batch, key: string, ctx: Context) {
  const host = new URL(ctx.origin).host
  return {
    api_key: key,
    batch: batch.events.map(([at, { event, ...props }]) => {
      const page =
        'path' in props
          ? {
              $current_url: ctx.origin + props.path,
              $pathname: props.path,
              $host: host,
              ...(props.referrer ? { $referrer: props.referrer, $referring_domain: new URL(props.referrer).host } : {}),
            }
          : props
      return {
        event,
        timestamp: new Date(Math.abs(at - ctx.now) > MAX_SKEW_MS ? ctx.now : at).toISOString(),
        properties: {
          ...page,
          distinct_id: batch.session,
          $session_id: batch.session,
          $process_person_profile: false,
          network: ctx.network,
          ...(ctx.ip ? { $ip: ctx.ip } : {}),
        },
      }
    }),
  }
}

/** Takes a beacon from this site's own pages and forwards it. The page never learns the key or PostHog's host. */
export async function ingest(request: Request, network: Network, env: Env, send: typeof fetch): Promise<Response> {
  const origin = new URL(request.url).origin
  if (request.headers.get('origin') !== origin) return new Response(null, { status: 403 })
  const text = await request.text()
  if (text.length > MAX_BODY) return new Response(null, { status: 413 })
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return new Response(null, { status: 400 })
  }
  const batch = Batch.safeParse(raw)
  if (!batch.success) return new Response(null, { status: 400 })
  if (!env.POSTHOG_KEY) return new Response(null, { status: 204 })
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
  const body = toPostHog(batch.data, env.POSTHOG_KEY, { network, origin, ip, now: Date.now() })
  await send(new URL('/batch/', env.POSTHOG_HOST), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => undefined)
  return new Response(null, { status: 204 })
}
