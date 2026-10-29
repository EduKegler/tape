import type { StreamKey } from '#/core/ids'

/**
 * One venue socket as a pure state machine. The hub feeds it events and runs the effects.
 * `desired` comes in on every step and is never stored: the connection only remembers what the
 * venue was told, and every step moves that toward `desired`, so running a step twice sends nothing.
 */
export type ConnState =
  | { readonly s: 'idle' }
  | { readonly s: 'connecting'; readonly attempt: number }
  | { readonly s: 'open'; readonly subscribed: ReadonlySet<StreamKey>; readonly lastMessageAt: number; readonly lastKeepaliveAt: number }
  | { readonly s: 'backoff'; readonly attempt: number; readonly retryAt: number }

export type ConnEvent =
  | { readonly e: 'tick' }
  | { readonly e: 'opened' }
  | { readonly e: 'closed' }
  /** The book behind these streams cannot be trusted. Ask the venue to send them again. */
  | { readonly e: 'resubscribe'; readonly streams: readonly StreamKey[] }

export type ConnEffect =
  | { readonly fx: 'open' }
  | { readonly fx: 'close' }
  | { readonly fx: 'subscribe'; readonly streams: readonly StreamKey[] }
  | { readonly fx: 'unsubscribe'; readonly streams: readonly StreamKey[] }
  | { readonly fx: 'keepalive' }
  /** Just subscribed. Each book starts a new epoch. */
  | { readonly fx: 'streams-reset'; readonly streams: readonly StreamKey[] }
  /** Socket lost. These streams keep their last state on screen, marked stale. */
  | { readonly fx: 'streams-stale'; readonly streams: readonly StreamKey[] }

export interface ConnPolicy {
  readonly silenceMs: number
  readonly keepaliveMs: number | null
}

export interface ConnInput {
  readonly desired: ReadonlySet<StreamKey>
  readonly now: number
  /** Last inbound message, tracked by the hub so messages need no step. */
  readonly lastMessageAt: number
  readonly rand: number
}

export function backoffMs(attempt: number, rand: number): number {
  return Math.round(Math.min(15_000, 500 * 2 ** attempt) * (0.5 + rand / 2))
}

type Step = { readonly state: ConnState; readonly effects: readonly ConnEffect[] }

function reconcile(state: Extract<ConnState, { s: 'open' }>, input: ConnInput, policy: ConnPolicy, effects: ConnEffect[]): Step {
  if (input.desired.size === 0) return { state: { s: 'idle' }, effects: [...effects, { fx: 'close' }] }
  if (input.now - input.lastMessageAt > policy.silenceMs) {
    const stale = [...state.subscribed]
    return { state: { s: 'backoff', attempt: 0, retryAt: input.now }, effects: [...effects, { fx: 'close' }, ...(stale.length ? [{ fx: 'streams-stale', streams: stale } as const] : [])] }
  }
  const add = [...input.desired].filter((s) => !state.subscribed.has(s))
  const drop = [...state.subscribed].filter((s) => !input.desired.has(s))
  const out = [...effects]
  if (drop.length) out.push({ fx: 'unsubscribe', streams: drop })
  if (add.length) out.push({ fx: 'subscribe', streams: add }, { fx: 'streams-reset', streams: add })
  let lastKeepaliveAt = state.lastKeepaliveAt
  if (policy.keepaliveMs !== null && input.now - lastKeepaliveAt >= policy.keepaliveMs) {
    out.push({ fx: 'keepalive' })
    lastKeepaliveAt = input.now
  }
  return { state: { s: 'open', subscribed: new Set(input.desired), lastMessageAt: input.lastMessageAt, lastKeepaliveAt }, effects: out }
}

export function stepConnection(state: ConnState, event: ConnEvent, input: ConnInput, policy: ConnPolicy): Step {
  switch (event.e) {
    case 'opened':
      if (state.s !== 'connecting') return { state, effects: [] }
      return reconcile({ s: 'open', subscribed: new Set(), lastMessageAt: input.now, lastKeepaliveAt: input.now }, { ...input, lastMessageAt: input.now }, policy, [])
    case 'closed': {
      if (state.s === 'open') {
        const stale = [...state.subscribed]
        return { state: { s: 'backoff', attempt: 0, retryAt: input.now + backoffMs(0, input.rand) }, effects: stale.length ? [{ fx: 'streams-stale', streams: stale }] : [] }
      }
      if (state.s === 'connecting') {
        const attempt = state.attempt + 1
        return { state: { s: 'backoff', attempt, retryAt: input.now + backoffMs(attempt, input.rand) }, effects: [] }
      }
      return { state, effects: [] }
    }
    case 'resubscribe': {
      if (state.s !== 'open') return { state, effects: [] }
      const streams = event.streams.filter((s) => state.subscribed.has(s))
      if (!streams.length) return { state, effects: [] }
      return { state, effects: [{ fx: 'unsubscribe', streams }, { fx: 'subscribe', streams }, { fx: 'streams-reset', streams }] }
    }
    case 'tick':
      switch (state.s) {
        case 'idle':
          return input.desired.size ? { state: { s: 'connecting', attempt: 0 }, effects: [{ fx: 'open' }] } : { state, effects: [] }
        case 'connecting':
          return { state, effects: [] }
        case 'backoff':
          if (!input.desired.size) return { state: { s: 'idle' }, effects: [] }
          return input.now >= state.retryAt ? { state: { s: 'connecting', attempt: state.attempt }, effects: [{ fx: 'open' }] } : { state, effects: [] }
        case 'open':
          return reconcile(state, input, policy, [])
      }
  }
}
