import { describe, expect, it } from 'vitest'
import type { Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { buildIntent } from '../intent'
import { TradeFailure } from '../types'
import type { Bps, VenueContext } from '../types'
import { orderly } from '.'

const perp: MarketSpec = {
  key: marketKey('orderly', 'BTC'),
  venue: 'orderly',
  base: 'BTC',
  quote: 'USDC',
  kind: 'perp',
  venueSymbol: 'PERP_BTC_USDC',
  scale: { px: 1, qty: 5 },
  tick: { kind: 'fixed', tick: 1 as Px },
  step: 1 as Qty,
}
const draft = {
  side: 'buy',
  kind: 'limit',
  price: '80000',
  size: '0.001',
  tif: 'gtc',
  reduceOnly: false,
  takeProfit: '',
  stopLoss: '',
  slippage: 100 as Bps,
  bid: '79990',
  ask: '80010',
  start: '',
  end: '',
  count: '',
  skew: '1',
} as const

const INFO = '{"success":true,"data":{"quote_tick":0.1,"base_tick":0.00001}}'
// The example reply on Orderly's POST /v1/order page.
const PLACED =
  '{"success":true,"timestamp":1702989203989,"data":{"order_id":13,"client_order_id":"testclientid","order_type":"LIMIT","order_price":100.12,"order_quantity":0.987654,"error_message":"none"}}'

interface Sent {
  readonly method: string
  readonly url: string
  readonly body: string | undefined
}

function orderlyAt(answer: (sent: Sent) => { status?: number; body: string }) {
  const sent: Sent[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes('/v1/public/info/')) return new Response(INFO)
    const request = { method: init?.method ?? 'GET', url, body: init?.body as string | undefined }
    sent.push(request)
    const reply = answer(request)
    return new Response(reply.body, { status: reply.status ?? 200 })
  }) as typeof globalThis.fetch
  const ctx: VenueContext = {
    ref: { venue: 'orderly', network: 'testnet', owner: '0x9f3c2b1a0e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b' },
    config: {
      mainnet: false,
      hyperliquid: { builder: null },
      dydx: { builder: null },
      orderly: { brokerId: { mainnet: null, testnet: 'demo' } },
    },
    keys: {
      read: () => ({ status: 'linked', public: {}, secret: `0x${'11'.repeat(32)}` }),
      write: () => {},
      clear: () => {},
    },
    fetch,
  }
  return { ctx, sent }
}

function intentOf(fields: Partial<typeof draft> | Record<string, string>) {
  const built = buildIntent(perp, { ...draft, ...fields }, orderly.capabilities)
  if (!built.ok) throw new Error(JSON.stringify(built.errors))
  return built.intent
}

const failureOf = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (e: unknown) => (e instanceof TradeFailure ? e.error : e),
  )

describe('orderly orders', () => {
  it('sends a single order with the side, type, price and size the user chose', async () => {
    const cases = [
      [{}, 'LIMIT', '"order_price":80000,', 'BUY', 'resting'],
      [{ side: 'sell', kind: 'market', price: '' }, 'MARKET', '', 'SELL', 'accepted'],
      [{ tif: 'ioc' }, 'IOC', '"order_price":80000,', 'BUY', 'accepted'],
      [{ side: 'sell', tif: 'post-only', price: '80020' }, 'POST_ONLY', '"order_price":80020,', 'SELL', 'resting'],
    ] as const
    for (const [fields, type, price, side, status] of cases) {
      const { ctx, sent } = orderlyAt(() => ({ body: PLACED }))
      const intent = intentOf(fields)
      expect(await orderly.execute(ctx, { kind: 'place', intent })).toEqual({
        kind: 'placed',
        status,
        detail: 'Order 13',
      })
      expect(sent).toEqual([
        {
          method: 'POST',
          url: 'https://testnet-api.orderly.org/v1/order',
          body: `{"symbol":"PERP_BTC_USDC","client_order_id":"${intent.clientId}","order_type":"${type}",${price}"order_quantity":0.001,"side":"${side}","reduce_only":false}`,
        },
      ])
    }
  })

  it('sends every leg of a sell scale order as SELL', async () => {
    const { ctx, sent } = orderlyAt(() => ({
      body: '{"success":true,"data":{"rows":[{"order_id":1,"error_message":"none"},{"order_id":2,"error_message":"none"}]}}',
    }))
    const intent = intentOf({ side: 'sell', kind: 'scale', size: '0.002', start: '80000', end: '81000', count: '2' })
    expect(await orderly.execute(ctx, { kind: 'place', intent })).toMatchObject({ kind: 'placed' })
    expect(sent[0]?.body?.match(/"side":"\w+"/g)).toEqual(['"side":"SELL"', '"side":"SELL"'])
  })

  it('calls an empty batch reply an unknown outcome', async () => {
    const intent = intentOf({ kind: 'scale', size: '0.002', start: '80000', end: '79000', count: '2' })
    const { ctx } = orderlyAt(() => ({ body: '{"success":true,"data":{"rows":[]}}' }))
    expect(await failureOf(orderly.execute(ctx, { kind: 'place', intent }))).toMatchObject({ kind: 'unknown-outcome' })
  })

  it('calls a scale order whose every leg was refused a refusal, and names a leg refused without a reason', async () => {
    const intent = intentOf({ kind: 'scale', size: '0.002', start: '80000', end: '79000', count: '2' })
    // -1103's description on Orderly's error codes page.
    const tick = 'Order price does not match the tick size.'
    const refused = orderlyAt(() => ({
      body: JSON.stringify({
        success: true,
        data: {
          rows: [
            { order_id: null, error_message: tick },
            { order_id: null, error_message: tick },
          ],
        },
      }),
    }))
    expect(await failureOf(orderly.execute(refused.ctx, { kind: 'place', intent }))).toEqual({
      kind: 'invalid-order',
      detail: tick,
    })
    const silent = orderlyAt(() => ({
      body: '{"success":true,"data":{"rows":[{"order_id":1,"error_message":"none"},{"order_id":null,"error_message":null}]}}',
    }))
    expect(await orderly.execute(silent.ctx, { kind: 'place', intent })).toEqual({
      kind: 'placed',
      status: 'resting',
      detail: '1 of 2 orders placed. Order 2 not placed: Refused without a reason',
    })
  })
})

describe('orderly lookup', () => {
  it('keeps a refused key needs-setup on lookup even when its message names an order', async () => {
    const { ctx } = orderlyAt(() => ({
      status: 401,
      body: '{"success":false,"code":-1002,"message":"Orderly key not found"}',
    }))
    expect(await failureOf(orderly.lookup(ctx, intentOf({})))).toMatchObject({ kind: 'needs-setup' })
  })

  it('asks Orderly for each leg by client order id', async () => {
    const { ctx, sent } = orderlyAt(() => ({ body: '{"success":true,"data":{"status":"NEW"}}' }))
    const intent = intentOf({ kind: 'scale', size: '0.002', start: '80000', end: '79000', count: '2' })
    if (intent.order.kind !== 'scale') throw new Error('scale')
    await orderly.lookup(ctx, intent)
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(
      intent.order.legs.map((l) => `GET https://testnet-api.orderly.org/v1/client/order/${l.clientId}`),
    )
  })
})
