import type { StreamKey } from '@tape/core/ids'

export type ConnState =
  | { readonly s: 'idle' }
  | { readonly s: 'connecting'; readonly attempt: number }
  | {
      readonly s: 'open'
      readonly subscribed: ReadonlySet<StreamKey>
      readonly lastKeepaliveAt: number
      readonly attempt: number
      readonly openedAt: number
      readonly holds: ReadonlyMap<StreamKey, Hold>
    }
  | { readonly s: 'backoff'; readonly attempt: number; readonly retryAt: number }

interface Hold {
  readonly until: number
  readonly count: number
}

export type ConnEvent =
  | { readonly e: 'tick' }
  | { readonly e: 'opened' }
  | { readonly e: 'closed' }
  | { readonly e: 'resubscribe'; readonly streams: readonly StreamKey[] }

export type ConnEffect =
  | { readonly fx: 'open' }
  | { readonly fx: 'close' }
  | { readonly fx: 'subscribe'; readonly streams: readonly StreamKey[] }
  | { readonly fx: 'unsubscribe'; readonly streams: readonly StreamKey[] }
  | { readonly fx: 'keepalive' }
  | { readonly fx: 'streams-stale'; readonly streams: readonly StreamKey[] }

export interface ConnPolicy {
  readonly silenceMs: number
  readonly keepaliveMs: number | null
}

export interface ConnInput {
  readonly desired: ReadonlySet<StreamKey>
  readonly now: number
  readonly lastMessageAt: number
  readonly rand: number
}

function backoffMs(attempt: number, rand: number): number {
  return Math.round(Math.min(15_000, 500 * 2 ** attempt) * (0.5 + rand / 2))
}

const STABLE_MS = 30_000
const HOLD_BASE_MS = 2_000
const HOLD_MAX_MS = 60_000

function holdMs(count: number): number {
  return Math.min(HOLD_MAX_MS, HOLD_BASE_MS * 2 ** count)
}

function deferRepeatResubscribes(previous: ReadonlyMap<StreamKey, Hold>, streams: readonly StreamKey[], at: number) {
  const holds = new Map(previous)
  const now: StreamKey[] = []
  const later: StreamKey[] = []
  for (const stream of streams) {
    const hold = holds.get(stream)
    if (hold && at < hold.until) later.push(stream)
    else now.push(stream)
    const count = hold?.count ?? 0
    holds.set(stream, { until: at + holdMs(count), count: count + 1 })
  }
  return { holds, now, later }
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
  const holds = new Map([...state.holds].filter(([, hold]) => input.now < hold.until + HOLD_MAX_MS))
  const held = (stream: StreamKey) => (holds.get(stream)?.until ?? 0) > input.now
  const wanted = [...input.desired].filter((stream) => state.subscribed.has(stream) || !held(stream))
  const add = wanted.filter((stream) => !state.subscribed.has(stream))
  const drop = [...state.subscribed].filter((stream) => !input.desired.has(stream))
  const out = [...effects]
  if (drop.length) out.push({ fx: 'unsubscribe', streams: drop })
  if (add.length) out.push({ fx: 'subscribe', streams: add })
  let lastKeepaliveAt = state.lastKeepaliveAt
  if (policy.keepaliveMs !== null && input.now - lastKeepaliveAt >= policy.keepaliveMs) {
    out.push({ fx: 'keepalive' })
    lastKeepaliveAt = input.now
  }
  return {
    state: { ...state, subscribed: new Set(wanted), lastKeepaliveAt, holds },
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
      if (state.s !== 'open') return { state, effects: [] }
      const streams = event.streams.filter((stream) => state.subscribed.has(stream))
      if (!streams.length) return { state, effects: [] }
      const { holds, now, later } = deferRepeatResubscribes(state.holds, streams, input.now)
      const subscribed = new Set([...state.subscribed].filter((stream) => !later.includes(stream)))
      const effects: ConnEffect[] = [{ fx: 'unsubscribe', streams }]
      if (now.length) effects.push({ fx: 'subscribe', streams: now })
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
