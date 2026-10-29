import { describe, expect, it } from 'vitest'
import { ingest, readEnv } from './ingest'
import { commandResult, commandSent, pageview, uuidv7 } from './track'
import type { Batch } from './events'
import type { Command, OrderIntent } from '@tape/trade/types'

const SITE = 'https://tape.kegler.dev'
const ENV = { POSTHOG_KEY: 'phc_test', POSTHOG_HOST: 'https://eu.i.posthog.com' }

function beacon(body: unknown, headers: Record<string, string> = { origin: SITE }) {
  return new Request(`${SITE}/r1`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

type Sent = {
  readonly api_key: string
  readonly batch: readonly { event: string; timestamp: string; properties: Record<string, unknown> }[]
}

function recorder() {
  const sent: { url: string; body: Sent }[] = []
  const send: typeof fetch = async (url, init) => {
    sent.push({
      url: url instanceof Request ? url.url : url.toString(),
      body: JSON.parse(init?.body as string) as Sent,
    })
    return new Response('{"status":1}')
  }
  return { sent, send }
}

const session = uuidv7(Date.now())
const now = Date.now()

describe('analytics ingest', () => {
  it('forwards a pageview as an anonymous PostHog event tagged with the network', async () => {
    const { sent, send } = recorder()
    const batch: Batch = {
      session,
      events: [[now, { event: '$pageview', path: '/hyperliquid/BTC', referrer: 'https://x.com' }]],
    }
    const res = await ingest(
      beacon(batch, { origin: SITE, 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }),
      'mainnet',
      ENV,
      send,
    )
    expect(res.status).toBe(204)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://eu.i.posthog.com/batch/')
    expect(sent[0]!.body).toEqual({
      api_key: 'phc_test',
      batch: [
        {
          event: '$pageview',
          timestamp: new Date(now).toISOString(),
          properties: {
            $current_url: `${SITE}/hyperliquid/BTC`,
            $pathname: '/hyperliquid/BTC',
            $host: 'tape.kegler.dev',
            $referrer: 'https://x.com',
            $referring_domain: 'x.com',
            distinct_id: session,
            $session_id: session,
            $process_person_profile: false,
            network: 'mainnet',
            $ip: '203.0.113.7',
          },
        },
      ],
    })
  })

  it('keeps the funnel properties of a placed order', async () => {
    const { sent, send } = recorder()
    const batch: Batch = {
      session,
      events: [
        [
          now,
          {
            event: 'command_sent',
            venue: 'dydx',
            command: 'place',
            side: 'buy',
            order: 'limit',
            tif: 'gtc',
            reduce_only: false,
          },
        ],
        [now + 1, { event: 'command_result', venue: 'dydx', command: 'place', result: 'placed', status: 'resting' }],
      ],
    }
    await ingest(beacon(batch), 'testnet', ENV, send)
    const events = sent[0]!.body.batch
    expect(events.map((e) => e.event)).toEqual(['command_sent', 'command_result'])
    expect(events[1]!.properties).toMatchObject({
      venue: 'dydx',
      result: 'placed',
      status: 'resting',
      network: 'testnet',
    })
  })

  it('uses the server clock when the page clock is far off', async () => {
    const { sent, send } = recorder()
    const batch: Batch = { session, events: [[now - 86_400_000, { event: 'trading_enabled', venue: 'orderly' }]] }
    await ingest(beacon(batch), 'mainnet', ENV, send)
    expect(Date.parse(sent[0]!.body.batch[0]!.timestamp)).toBeGreaterThanOrEqual(now)
  })

  it.each([
    ['an event outside the catalog', { session, events: [[now, { event: 'balance', amount: 1 }]] }],
    [
      'a property outside the catalog',
      { session, events: [[now, { event: 'trading_enabled', venue: 'dydx', owner: '0xabc' }]] },
    ],
    [
      'a session that is not a UUIDv7',
      { session: crypto.randomUUID(), events: [[now, { event: 'trading_enabled', venue: 'dydx' }]] },
    ],
    ['an empty batch', { session, events: [] }],
    ['malformed JSON', '{'],
  ])('rejects %s and sends nothing', async (_, body) => {
    const { sent, send } = recorder()
    const res = await ingest(beacon(body), 'mainnet', ENV, send)
    expect(res.status).toBe(400)
    expect(sent).toHaveLength(0)
  })

  it.each([
    ['a link from an Android app', 'android-app://com.google.android.gm/', undefined],
    ['a local file', 'file:///Users/me/notes.html', undefined],
    ['this site', `${SITE}/dydx/ETH`, undefined],
    ['another site', 'https://x.com/someone/status/1?ref=abc', 'https://x.com'],
  ])('sends the pageview the page builds after %s', async (_, referrer, expected) => {
    const { sent, send } = recorder()
    const batch: Batch = { session, events: [[now, pageview('/hyperliquid/BTC', referrer, SITE)]] }
    expect((await ingest(beacon(batch), 'mainnet', ENV, send)).status).toBe(204)
    expect(sent[0]!.body.batch[0]!.properties.$referrer).toBe(expected)
  })

  it('accepts a pageview for any path the page can be on', async () => {
    const batch: Batch = { session, events: [[now, pageview(`/${'x'.repeat(500)}`, '', SITE)]] }
    expect((await ingest(beacon(batch), 'mainnet', ENV, recorder().send)).status).toBe(204)
  })

  it('accepts every command event the hooks build', async () => {
    const intent = {
      side: 'sell',
      reduceOnly: true,
      order: { kind: 'market', slippage: 50 },
    } as unknown as OrderIntent
    const commands: Command[] = [
      { kind: 'place', intent },
      { kind: 'cancel-all', symbol: 'BTC' },
    ]
    const events = commands.flatMap((c): Batch['events'] => [
      [now, commandSent('hyperliquid', c)],
      [now, commandResult('hyperliquid', c, { ok: { kind: 'placed', status: 'filled', detail: 'x' } })],
      [now, commandResult('hyperliquid', c, { ok: { kind: 'done', detail: 'x' } })],
      [now, commandResult('hyperliquid', c, { failed: 'rate-limited' })],
    ])
    const { sent, send } = recorder()
    expect((await ingest(beacon({ session, events }), 'mainnet', ENV, send)).status).toBe(204)
    expect(sent[0]!.body.batch[0]!.properties).toMatchObject({ side: 'sell', order: 'market', reduce_only: true })
    expect(sent[0]!.body.batch[0]!.properties).not.toHaveProperty('tif')
  })

  it('rejects a beacon with no origin', async () => {
    const batch: Batch = { session, events: [[now, { event: 'trading_enabled', venue: 'dydx' }]] }
    expect((await ingest(beacon(batch, {}), 'mainnet', ENV, recorder().send)).status).toBe(403)
  })

  it('rejects a body too large to be a beacon', async () => {
    const res = await ingest(beacon('x'.repeat(40_000)), 'mainnet', ENV, recorder().send)
    expect(res.status).toBe(413)
  })

  it('reads a blank env variable as unset', () => {
    const before = { ...process.env }
    process.env.POSTHOG_KEY = ''
    process.env.POSTHOG_HOST = ''
    try {
      expect(readEnv()).toEqual({ POSTHOG_KEY: undefined, POSTHOG_HOST: 'https://eu.i.posthog.com' })
    } finally {
      process.env = before
    }
  })

  it('rejects a beacon from another origin', async () => {
    const { sent, send } = recorder()
    const batch: Batch = { session, events: [[now, { event: 'trading_enabled', venue: 'dydx' }]] }
    const res = await ingest(beacon(batch, { origin: 'https://evil.example' }), 'mainnet', ENV, send)
    expect(res.status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  it('accepts and drops everything when no PostHog key is set', async () => {
    const { sent, send } = recorder()
    const batch: Batch = { session, events: [[now, { event: 'trading_enabled', venue: 'dydx' }]] }
    const res = await ingest(beacon(batch), 'mainnet', { POSTHOG_HOST: ENV.POSTHOG_HOST }, send)
    expect(res.status).toBe(204)
    expect(sent).toHaveLength(0)
  })

  it('answers the page even when PostHog is down', async () => {
    const batch: Batch = { session, events: [[now, { event: 'trading_enabled', venue: 'dydx' }]] }
    const res = await ingest(beacon(batch), 'mainnet', ENV, () => Promise.reject(new Error('down')))
    expect(res.status).toBe(204)
  })
})
