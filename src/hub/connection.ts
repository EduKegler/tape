import type { StreamKey } from '@tape/core/ids'

/**
 * One venue socket as a pure state machine. The hub feeds it events and runs the effects.
 * `desired` comes in on every step and is never stored: the connection only remembers what the
 * venue was told, and every step moves that toward `desired`, so running a step twice sends nothing.
 */
export type ConnState =
  | { readonly s: 'idle' }
  | { readonly s: 'connecting'; readonly attempt: number }
  | {
      readonly s: 'open'
      readonly subscribed: ReadonlySet<StreamKey>
      readonly lastMessageAt: number
      readonly lastKeepaliveAt: number
      /** Carried from connecting, so a venue that accepts and drops at once still backs off. */
      readonly attempt: number
      readonly openedAt: number
      /** Streams resubscribed recently. A held stream stays unsubscribed until `until`. */
      readonly holds: ReadonlyMap<StreamKey, Hold>
    }
  | { readonly s: 'backoff'; readonly attempt: number; readonly retryAt: number }

export interface Hold {
  readonly until: number
  readonly count: number
}

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

/** A connection that lived this long was healthy, so the next failure starts the backoff over. */
export const STABLE_MS = 30_000
const HOLD_BASE_MS = 2_000
const HOLD_MAX_MS = 60_000

function holdMs(count: number): number {
  return Math.min(HOLD_MAX_MS, HOLD_BASE_MS * 2 ** count)
}

type OpenState = Extract<ConnState, { s: 'open' }>

function lost(state: OpenState, now: number, rand: number): ConnState {
  const attempt = now - state.openedAt >= STABLE_MS ? 0 : state.attempt + 1
  return { s: 'backoff', attempt, retryAt: now + backoffMs(attempt, rand) }
}

type Step = { readonly state: ConnState; readonly effects: readonly ConnEffect[] }

function reconcile(state: OpenState, input: ConnInput, policy: ConnPolicy, effects: ConnEffect[]): Step {
  if (input.desired.size === 0) return { state: { s: 'idle' }, effects: [...effects, { fx: 'close' }] }
  if (input.now - input.lastMessageAt > policy.silenceMs) {
    const stale = [...state.subscribed]
    return {
      state: lost(state, input.now, input.rand),
      effects: [
        ...effects,
        { fx: 'close' },
        ...(stale.length ? [{ fx: 'streams-stale', streams: stale } as const] : []),
      ],
    }
  }
  const holds = new Map([...state.holds].filter(([, h]) => input.now < h.until + HOLD_MAX_MS))
  const held = (s: StreamKey) => (holds.get(s)?.until ?? 0) > input.now
  const wanted = [...input.desired].filter((s) => state.subscribed.has(s) || !held(s))
  const add = wanted.filter((s) => !state.subscribed.has(s))
  const drop = [...state.subscribed].filter((s) => !input.desired.has(s))
  const out = [...effects]
  if (drop.length) out.push({ fx: 'unsubscribe', streams: drop })
  if (add.length) out.push({ fx: 'subscribe', streams: add }, { fx: 'streams-reset', streams: add })
  let lastKeepaliveAt = state.lastKeepaliveAt
  if (policy.keepaliveMs !== null && input.now - lastKeepaliveAt >= policy.keepaliveMs) {
    out.push({ fx: 'keepalive' })
    lastKeepaliveAt = input.now
  }
  return {
    state: { ...state, subscribed: new Set(wanted), lastMessageAt: input.lastMessageAt, lastKeepaliveAt, holds },
    effects: out,
  }
}

export function stepConnection(state: ConnState, event: ConnEvent, input: ConnInput, policy: ConnPolicy): Step {
  switch (event.e) {
    case 'opened':
      if (state.s !== 'connecting') return { state, effects: [] }
      return reconcile(
        {
          s: 'open',
          subscribed: new Set(),
          lastMessageAt: input.now,
          lastKeepaliveAt: input.now,
          attempt: state.attempt,
          openedAt: input.now,
          holds: new Map(),
        },
        { ...input, lastMessageAt: input.now },
        policy,
        [],
      )
    case 'closed': {
      if (state.s === 'open') {
        const stale = [...state.subscribed]
        return {
          state: lost(state, input.now, input.rand),
          effects: stale.length ? [{ fx: 'streams-stale', streams: stale }] : [],
        }
      }
      if (state.s === 'connecting') {
        const attempt = state.attempt + 1
        return { state: { s: 'backoff', attempt, retryAt: input.now + backoffMs(attempt, input.rand) }, effects: [] }
      }
      return { state, effects: [] }
    }
    case 'resubscribe': {
      // The first resubscribe is immediate. A stream that goes bad again inside its hold waits
      // out a doubling hold unsubscribed, so a book that can never parse cannot spin the socket.
      if (state.s !== 'open') return { state, effects: [] }
      const streams = event.streams.filter((s) => state.subscribed.has(s))
      if (!streams.length) return { state, effects: [] }
      const holds = new Map(state.holds)
      const now: StreamKey[] = []
      const later: StreamKey[] = []
      for (const s of streams) {
        const hold = holds.get(s)
        if (hold && input.now < hold.until) {
          later.push(s)
          holds.set(s, { until: input.now + holdMs(hold.count), count: hold.count + 1 })
        } else {
          now.push(s)
          holds.set(s, { until: input.now + holdMs(hold?.count ?? 0), count: (hold?.count ?? 0) + 1 })
        }
      }
      const subscribed = new Set([...state.subscribed].filter((s) => !later.includes(s)))
      const effects: ConnEffect[] = [{ fx: 'unsubscribe', streams }]
      if (now.length) effects.push({ fx: 'subscribe', streams: now }, { fx: 'streams-reset', streams: now })
      return { state: { ...state, subscribed, holds }, effects }
    }
    case 'tick':
      switch (state.s) {
        case 'idle':
          return input.desired.size
            ? { state: { s: 'connecting', attempt: 0 }, effects: [{ fx: 'open' }] }
            : { state, effects: [] }
        case 'connecting':
          return { state, effects: [] }
        case 'backoff':
          if (!input.desired.size) return { state: { s: 'idle' }, effects: [] }
          return input.now >= state.retryAt
            ? { state: { s: 'connecting', attempt: state.attempt }, effects: [{ fx: 'open' }] }
            : { state, effects: [] }
        case 'open':
          return reconcile(state, input, policy, [])
      }
  }
}
