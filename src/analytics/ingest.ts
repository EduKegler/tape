import { z } from 'zod'
import type { Network } from '@tape/core/ids'
import { MAX_BODY } from './beacon'
import { Batch } from './events'
import type { AppEvent } from './events'
import type { ExceptionEvent } from './exception'

const MAX_SKEW_MS = 60 * 60_000

const Env = z.object({
  POSTHOG_KEY: z.string().min(1).optional(),
  POSTHOG_HOST: z.url().default('https://eu.i.posthog.com'),
  VISITOR_SALT: z.string().min(1).optional(),
})
type Env = z.infer<typeof Env>

/** An empty variable means unset, so a blank value in the dashboard does not fail every beacon. */
export const readEnv = (): Env =>
  Env.parse({
    POSTHOG_KEY: process.env.POSTHOG_KEY || undefined,
    POSTHOG_HOST: process.env.POSTHOG_HOST || undefined,
    VISITOR_SALT: process.env.VISITOR_SALT || undefined,
  })

const encoder = new TextEncoder()

async function dailyVisitor(salt: string, ip: string, userAgent: string, now: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const day = new Date(now).toISOString().slice(0, 10)
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${day}\n${ip}\n${userAgent}`))
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

type PageviewEvent = Extract<AppEvent, { event: '$pageview' }>

const MAX_USER_AGENT = 512

type Context = {
  readonly network: Network
  readonly origin: string
  readonly ip: string | null
  readonly userAgent: string | null
  readonly visitor: string | null
  readonly now: number
}

/** PostHog's exception shape. `web:javascript` frames with a chunk id resolve against the uploaded source maps. */
function exception({ type, value, handled, source, frames }: Omit<ExceptionEvent, 'event'>, origin: string) {
  return {
    $exception_list: [
      {
        type,
        value,
        mechanism: { handled, synthetic: false },
        stacktrace: {
          type: 'raw',
          frames: frames.map((frame) => ({
            platform: 'web:javascript',
            filename: frame.file,
            function: frame.fn,
            lineno: frame.line,
            colno: frame.col,
            ...(frame.chunk ? { chunk_id: frame.chunk } : {}),
            in_app: new URL(frame.file).origin === origin,
          })),
        },
      },
    ],
    exception_source: source,
  }
}

function pageProperties({ path, referrer, ...campaign }: Omit<PageviewEvent, 'event'>, origin: string) {
  return {
    $current_url: origin + path,
    $pathname: path,
    $host: new URL(origin).host,
    ...(referrer ? { $referrer: referrer, $referring_domain: new URL(referrer).host } : {}),
    ...campaign,
  }
}

/** The body for PostHog's batch endpoint. Every event is anonymous, so no person profile is made. */
function toPostHog(batch: Batch, key: string, ctx: Context) {
  return {
    api_key: key,
    batch: batch.events.map(([at, { event, ...props }]) => {
      const page =
        'path' in props ? pageProperties(props, ctx.origin) : 'frames' in props ? exception(props, ctx.origin) : props
      return {
        event,
        timestamp: new Date(Math.abs(at - ctx.now) > MAX_SKEW_MS ? ctx.now : at).toISOString(),
        properties: {
          ...page,
          distinct_id: ctx.visitor ?? batch.session,
          $session_id: batch.session,
          $process_person_profile: false,
          network: ctx.network,
          ...(ctx.ip ? { $ip: ctx.ip } : {}),
          ...(ctx.userAgent ? { $raw_user_agent: ctx.userAgent } : {}),
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
  // Cloudflare appends to the X-Forwarded-For a client sends, and puts only the visitor in CF-Connecting-IP.
  const ip = request.headers.get('cf-connecting-ip') || null
  const userAgent = request.headers.get('user-agent')?.slice(0, MAX_USER_AGENT) || null
  const now = Date.now()
  const visitor = env.VISITOR_SALT && ip ? await dailyVisitor(env.VISITOR_SALT, ip, userAgent ?? '', now) : null
  const body = toPostHog(batch.data, env.POSTHOG_KEY, { network, origin, ip, userAgent, visitor, now })
  await send(new URL('/batch/', env.POSTHOG_HOST), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => undefined)
  return new Response(null, { status: 204 })
}
