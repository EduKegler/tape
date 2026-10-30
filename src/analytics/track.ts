import { useEffect } from 'react'
import { useRouterState } from '@tanstack/react-router'
import type { VenueId } from '@tape/core/ids'
import type { Command, CommandOutcome, TradeError } from '@tape/trade/types'
import { pack } from './beacon'
import type { AppEvent, Batch } from './events'
import { createReporter } from './exception'

const FLUSH_MS = 5_000
const MAX_PATH = 200

/** A UUIDv7, which PostHog reads the session start from. Lives in memory, so a reload is a new session. */
export function uuidv7(now: number): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  for (let i = 0; i < 6; i++) b[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

let session: string | null = null
let queue: Batch['events'] = []
let timer: ReturnType<typeof setTimeout> | null = null

function flush() {
  if (timer) clearTimeout(timer)
  timer = null
  if (!session) return
  for (const body of pack(session, queue)) navigator.sendBeacon('/r1', body)
  queue = []
}

export function track(event: AppEvent) {
  if (typeof navigator === 'undefined' || !('sendBeacon' in navigator)) return
  if (!session) {
    session = uuidv7(Date.now())
    addEventListener('pagehide', flush)
    addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush())
  }
  queue.push([Date.now(), event])
  timer ??= setTimeout(flush, FLUSH_MS)
}

/** Search params never leave the page. The referrer leaves as its origin, and only when it is another web page. */
export function pageview(path: string, referrer: string, origin: string): AppEvent {
  const from = URL.canParse(referrer) ? new URL(referrer) : null
  const external = from && /^https?:$/.test(from.protocol) && from.origin !== origin
  return { event: '$pageview', path: path.slice(0, MAX_PATH), ...(external ? { referrer: from.origin } : {}) }
}

export function usePageViews() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => {
    track(pageview(path, session ? '' : document.referrer, location.origin))
  }, [path])
}

export const report = createReporter(track)

/** TanStack Router hands render errors to the route boundary and `defaultOnCatch`, not to `window`. */
export function useErrorReports() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => report(e.error, 'window', false)
    const onRejection = (e: PromiseRejectionEvent) => report(e.reason, 'promise', false)
    addEventListener('error', onError)
    addEventListener('unhandledrejection', onRejection)
    return () => {
      removeEventListener('error', onError)
      removeEventListener('unhandledrejection', onRejection)
    }
  }, [])
}

export function commandSent(venueId: VenueId, c: Command): AppEvent {
  if (c.kind !== 'place') return { event: 'command_sent', venue: venueId, command: c.kind }
  const { side, order, reduceOnly } = c.intent
  return {
    event: 'command_sent',
    venue: venueId,
    command: 'place',
    side,
    order: order.kind,
    ...(order.kind === 'limit' ? { tif: order.tif } : {}),
    reduce_only: reduceOnly,
  }
}

export function commandResult(
  venueId: VenueId,
  c: Command,
  outcome: { readonly ok: CommandOutcome } | { readonly failed: TradeError['kind'] },
): AppEvent {
  if ('failed' in outcome)
    return { event: 'command_result', venue: venueId, command: c.kind, result: 'failed', error: outcome.failed }
  const o = outcome.ok
  return o.kind === 'placed'
    ? { event: 'command_result', venue: venueId, command: c.kind, result: 'placed', status: o.status }
    : { event: 'command_result', venue: venueId, command: c.kind, result: 'done' }
}
