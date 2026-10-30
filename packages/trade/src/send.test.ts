import { describe, expect, it } from 'vitest'
import { post, send } from './send'
import type { Classify } from './send'
import type { TradeError } from './types'
import { TradeFailure } from './types'

const replying = (status: number, text: string) =>
  (async () => new Response(text, { status })) as unknown as typeof globalThis.fetch

const failure = (fetch: typeof globalThis.fetch, mutates: boolean, classify: Classify = () => null) =>
  send('orderly', fetch, 'https://x', { method: 'POST', mutates }, classify).then(
    () => null,
    (e: unknown): TradeError | null => (e instanceof TradeFailure ? e.error : null),
  )

describe('send', () => {
  it('calls a write that fails in flight or gets a 500 an unknown outcome, and a read unreachable', async () => {
    const timeout = (async () => {
      throw new Error('timeout')
    }) as unknown as typeof globalThis.fetch
    const unreadable = (async () => ({
      status: 200,
      text: () => Promise.reject(new Error('body aborted')),
    })) as unknown as typeof globalThis.fetch

    expect(await failure(timeout, true)).toEqual({ kind: 'unknown-outcome', detail: 'timeout' })
    expect(await failure(timeout, false)).toEqual({ kind: 'unreachable', detail: 'timeout' })
    expect(await failure(unreadable, true)).toEqual({ kind: 'unknown-outcome', detail: 'body aborted' })
    expect(await failure(unreadable, false)).toEqual({ kind: 'unreachable', detail: 'body aborted' })
    expect(
      await failure(replying(500, '{"success":false}'), true, () => ({ kind: 'rejected', detail: 'refused' })),
    ).toEqual({ kind: 'unknown-outcome', detail: '500 {"success":false}' })
  })

  it('reads a status the venue leaves unclassified as rate limited, unreachable or rejected', async () => {
    expect(await failure(replying(429, ''), false)).toEqual({ kind: 'rate-limited', detail: 'Too many requests' })
    expect(await failure(replying(429, 'slow down'), false)).toEqual({ kind: 'rate-limited', detail: 'slow down' })
    expect(await failure(replying(500, 'down'), false)).toEqual({ kind: 'unreachable', detail: '500 down' })
    expect(await failure(replying(503, 'busy'), false)).toEqual({ kind: 'unreachable', detail: '503 busy' })
    expect(await failure(replying(400, 'bad'), false)).toEqual({ kind: 'rejected', detail: '400 bad' })
    expect(await failure(replying(404, 'gone'), false)).toEqual({ kind: 'rejected', detail: '404 gone' })
    expect(
      await send('orderly', replying(200, '{"status":"ok"}'), 'https://x', { mutates: false }, () => null),
    ).toEqual({ status: 'ok' })
  })

  it('posts JSON as the venue APIs ask', () => {
    expect(post({ a: 1 })).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    })
  })
})
