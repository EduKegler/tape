import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519'
import { base58, base64url } from '@scure/base'
import { hexToBytes, stringToBytes } from 'viem'
import type { Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { buildIntent } from '../intent'
import { TradeFailure } from '../types'
import type { Bps, OrderRef, VenueContext } from '../types'
import { orderly } from '.'

const perp: MarketSpec = {
  key: marketKey('orderly', 'BTC' as Base),
  venue: 'orderly',
  base: 'BTC' as Base,
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
  takeProfits: [],
  stopLoss: '',
  slippage: 100 as Bps,
  bid: '79990',
  ask: '80010',
  start: '',
  end: '',
  count: '',
  skew: '1',
  retracement: '',
  retracementUnit: 'pct',
  activation: '',
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

function orderlyAt(
  answer: (sent: Sent) => { status?: number; body: string },
  info: (url: string) => Response = () => new Response(INFO),
) {
  const sent: Sent[] = []
  const reads: string[] = []
  const headers: Record<string, string>[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes('/v1/public/info/')) {
      reads.push(url)
      return info(url)
    }
    const request = { method: init?.method ?? 'GET', url, body: init?.body as string | undefined }
    sent.push(request)
    headers.push({ ...(init?.headers as Record<string, string> | undefined) })
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
  return { ctx, sent, reads, headers }
}

function intentOf(fields: Partial<typeof draft> | Record<string, string>, spec = perp) {
  const built = buildIntent(spec, { ...draft, ...fields }, orderly.capabilities)
  if (!built.ok) throw new Error(JSON.stringify(built.errors))
  return built.intent
}

const failureOf = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (e: unknown) => (e instanceof TradeFailure ? e.error : e),
  )

const BAD_GATEWAY = () => new Response('<html>502 Bad Gateway</html>', { status: 502 })
const eth: MarketSpec = {
  ...perp,
  key: marketKey('orderly', 'ETH' as Base),
  base: 'ETH' as Base,
  venueSymbol: 'PERP_ETH_USDC',
  scale: { px: 2, qty: 4 },
}
const sol: MarketSpec = {
  ...perp,
  key: marketKey('orderly', 'SOL' as Base),
  base: 'SOL' as Base,
  venueSymbol: 'PERP_SOL_USDC',
  scale: { px: 3, qty: 2 },
}

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

  it('calls a batch reply without rows an unknown outcome, since the legs may be on the book', async () => {
    const intent = intentOf({ kind: 'scale', size: '0.002', start: '80000', end: '79000', count: '2' })
    const { ctx } = orderlyAt(() => ({ body: '{"success":true,"data":{}}' }))
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

describe('orderly refusals', () => {
  it("classifies Orderly's documented refusals by code and message", async () => {
    // Codes, statuses and descriptions on Orderly's error codes page.
    const cases = [
      [400, -1101, 'Insufficient margin after the operation.', 'insufficient-margin'],
      [400, -1103, 'Order price does not match the tick size.', 'invalid-order'],
      [400, -1104, 'Order quantity does not match the step size.', 'invalid-order'],
      [429, -1003, 'Rate limit exceeded.', 'rate-limited'],
    ] as const
    for (const [status, code, message, kind] of cases) {
      const { ctx } = orderlyAt(() => ({ status, body: JSON.stringify({ success: false, code, message }) }))
      expect(await failureOf(orderly.execute(ctx, { kind: 'place', intent: intentOf({}) }))).toEqual({
        kind,
        detail: message,
      })
    }
    const { ctx } = orderlyAt(() => ({ status: 429, body: 'Too Many Requests' }))
    expect(await failureOf(orderly.execute(ctx, { kind: 'place', intent: intentOf({}) }))).toEqual({
      kind: 'rate-limited',
      detail: 'Too Many Requests',
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

describe('orderly key', () => {
  it('asks for setup before signing when this device holds no Orderly key', async () => {
    const { ctx, sent } = orderlyAt(() => ({ body: PLACED }))
    const bare: VenueContext = { ...ctx, keys: { ...ctx.keys, read: () => null } }
    const commands = [
      { kind: 'place', intent: intentOf({}) },
      { kind: 'cancel', order: 'PERP_BTC_USDC:13' as OrderRef },
      { kind: 'cancel-all', symbol: 'PERP_BTC_USDC' },
      { kind: 'leverage', symbol: 'PERP_BTC_USDC', leverage: 5 },
    ] as const
    for (const command of commands)
      expect(await failureOf(orderly.execute(bare, command))).toEqual({
        kind: 'needs-setup',
        detail: 'Enable trading on this device first',
      })
    expect(await failureOf(orderly.lookup(bare, intentOf({})))).toMatchObject({ kind: 'needs-setup' })
    expect(sent).toEqual([])
  })
})

describe('orderly signing', () => {
  it("signs each request as the owner's Orderly account with this device's key", async () => {
    // The address and the account id Orderly gives it under the flipper broker, from the recorded accountState
    // in packages/trade/src/__fixtures__/history.orderly.json.
    const owner = '0xf7069a2afa4c6e74917dfc6b0e29af57342f70a6'
    const account = '0xd96bacbff940748d1215f933fc6c04d6798eb9fbd8926fe2388d02eb31003655'
    const { ctx, sent, headers } = orderlyAt(() => ({ body: PLACED }))
    const flipper: VenueContext = {
      ...ctx,
      ref: { ...ctx.ref, owner },
      config: { ...ctx.config, orderly: { brokerId: { mainnet: null, testnet: 'flipper' } } },
    }
    await orderly.execute(flipper, { kind: 'place', intent: intentOf({}) })
    await orderly.execute(flipper, { kind: 'cancel', order: 'PERP_BTC_USDC:13' as OrderRef })
    const pub = ed25519.getPublicKey(hexToBytes(`0x${'11'.repeat(32)}`))
    const types = ['application/json', 'application/x-www-form-urlencoded']
    expect(headers.map((h) => [h['orderly-account-id'], h['orderly-key'], h['content-type']])).toEqual(
      types.map((type) => [account, `ed25519:${base58.encode(pub)}`, type]),
    )
    sent.forEach(({ method, url, body }, i) => {
      const h = headers[i] ?? {}
      const { pathname, search } = new URL(url)
      const message = `${h['orderly-timestamp']}${method}${pathname}${search}${body ?? ''}`
      expect(ed25519.verify(base64url.decode(h['orderly-signature'] ?? ''), stringToBytes(message), pub)).toBe(true)
    })
  })
})

describe('orderly cancels', () => {
  it('cancels one order and all orders with the requests Orderly documents', async () => {
    const one = orderlyAt(() => ({
      body: '{"success":true,"timestamp":1702989203989,"data":{"status":"CANCEL_SENT"}}',
    }))
    expect(await orderly.execute(one.ctx, { kind: 'cancel', order: 'PERP_BTC_USDC:13' as OrderRef })).toEqual({
      kind: 'done',
      detail: 'Canceled',
    })
    expect(one.sent).toEqual([
      {
        method: 'DELETE',
        url: 'https://testnet-api.orderly.org/v1/order?order_id=13&symbol=PERP_BTC_USDC',
        body: undefined,
      },
    ])
    const all = orderlyAt(() => ({
      body: '{"success":true,"timestamp":1702989203989,"data":{"status":"CANCEL_ALL_SENT"}}',
    }))
    expect(await orderly.execute(all.ctx, { kind: 'cancel-all', symbol: 'PERP_BTC_USDC' })).toEqual({
      kind: 'done',
      detail: 'Canceled open PERP_BTC_USDC orders',
    })
    expect(all.sent).toEqual([
      { method: 'DELETE', url: 'https://testnet-api.orderly.org/v1/orders?symbol=PERP_BTC_USDC', body: undefined },
    ])
  })

  it('sets the leverage of the whole account with the request Orderly documents', async () => {
    // The example reply of POST /v1/client/leverage in Orderly's OpenAPI spec.
    const { ctx, sent } = orderlyAt(() => ({
      body: '{"success":true,"timestamp":1702989203989,"data":{"symbol":"PERP_BTC_USDC","margin_mode":"ISOLATED","leverage":19}}',
    }))
    expect(await orderly.execute(ctx, { kind: 'leverage', symbol: 'PERP_BTC_USDC', leverage: 5 })).toEqual({
      kind: 'done',
      detail: 'Account leverage 5x',
    })
    expect(sent).toEqual([
      { method: 'POST', url: 'https://testnet-api.orderly.org/v1/client/leverage', body: '{"leverage":5}' },
    ])
  })
})

describe('orderly reads', () => {
  it('calls a market rules read that fails unreachable, sends no order, and reads the rules again', async () => {
    // quote_tick and base_tick from the recorded api.orderly.org/v1/public/info frames for ETH and SOL.
    const rules: Record<string, string> = {
      PERP_ETH_USDC: '{"success":true,"data":{"symbol":"PERP_ETH_USDC","quote_tick":0.01,"base_tick":0.0001}}',
      PERP_SOL_USDC: '{"success":true,"data":{"symbol":"PERP_SOL_USDC","quote_tick":0.001,"base_tick":0.01}}',
    }
    let down = true
    const { ctx, sent, reads } = orderlyAt(
      () => ({ body: PLACED }),
      (url) => (down ? BAD_GATEWAY() : new Response(rules[url.split('/').at(-1) ?? ''])),
    )
    const order = { kind: 'place', intent: intentOf({ price: '2330.55', size: '0.01' }, eth) } as const
    expect(await failureOf(orderly.execute(ctx, order))).toMatchObject({ kind: 'unreachable' })
    expect(sent).toEqual([])
    down = false
    expect(await orderly.execute(ctx, order)).toMatchObject({ kind: 'placed' })
    await orderly.execute(ctx, { kind: 'place', intent: intentOf({ price: '150.125', size: '0.5' }, sol) })
    expect(reads).toEqual([
      'https://testnet-api.orderly.org/v1/public/info/PERP_ETH_USDC',
      'https://testnet-api.orderly.org/v1/public/info/PERP_ETH_USDC',
      'https://testnet-api.orderly.org/v1/public/info/PERP_SOL_USDC',
    ])
    expect(sent.map((s) => s.url)).toEqual([
      'https://testnet-api.orderly.org/v1/order',
      'https://testnet-api.orderly.org/v1/order',
    ])
  })

  it('fails a history read Orderly cannot answer instead of calling it empty', async () => {
    const down = [
      async () => BAD_GATEWAY(),
      async () => {
        throw new TypeError('Failed to fetch')
      },
    ]
    for (const fetch of down) {
      const read = orderly.history({ network: 'mainnet', address: '0xf7069a2afa4c6e74917dfc6b0e29af57342f70a6', fetch })
      expect(await failureOf(read)).toMatchObject({ kind: 'unreachable' })
    }
  })
})
