import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519'
import { base58, base64url } from '@scure/base'
import { hexToBytes, stringToBytes } from 'viem'
import type { Hex } from 'viem'
import type { Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { recordedWrite } from '../fixtures'
import { buildIntent } from '../intent'
import { TradeFailure } from '../types'
import type { Bps, Eip712, KeySlot, OrderRef, StepId, StoredKey, VenueContext } from '../types'
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

  it('sends a market order as an IOC limit at the far touch moved by the slippage', async () => {
    // The example reply on Orderly's public orderbook query page.
    const book =
      '{"success":true,"data":{"symbol":"PERP_BTC_USDC","mid_price":"77338.35","spread":"1.70","asks":[{"price":"77339.20","quantity":"0.45"}],"bids":[{"price":"77337.50","quantity":"0.32"}],"ts":1714900000123},"ts":1779269143700}'
    // 1% past the far touch, then onto the 0.1 tick inside it: 77339.2 × 1.01 = 78112.592 down to 78112.5,
    // and 77337.5 × 0.99 = 76564.125 up to 76564.2.
    const cases = [
      ['buy', 'BUY', '78112.5'],
      ['sell', 'SELL', '76564.2'],
    ] as const
    for (const [side, wire, limit] of cases) {
      const { ctx, sent } = orderlyAt((s) => ({ body: s.url.endsWith('/v1/public/query') ? book : PLACED }))
      const intent = intentOf({ side, kind: 'market', price: '' })
      expect(await orderly.execute(ctx, { kind: 'place', intent })).toEqual({
        kind: 'placed',
        status: 'accepted',
        detail: 'Order 13',
      })
      expect(sent).toEqual([
        {
          method: 'POST',
          url: 'https://testnet-api.orderly.org/v1/public/query',
          body: '{"type":"orderbook","symbol":"PERP_BTC_USDC","max_level":1}',
        },
        {
          method: 'POST',
          url: 'https://testnet-api.orderly.org/v1/order',
          body: `{"symbol":"PERP_BTC_USDC","client_order_id":"${intent.clientId}","order_type":"IOC","order_price":${limit},"order_quantity":0.001,"side":"${wire}","reduce_only":false}`,
        },
      ])
    }
  })

  it('refuses a market order against an empty side of the book and sends no order', async () => {
    const { ctx, sent } = orderlyAt(() => ({
      body: '{"success":true,"data":{"symbol":"PERP_BTC_USDC","mid_price":null,"spread":null,"asks":[],"bids":[{"price":"77337.50","quantity":"0.32"}],"ts":1714900000123}}',
    }))
    expect(
      await failureOf(orderly.execute(ctx, { kind: 'place', intent: intentOf({ kind: 'market', price: '' }) })),
    ).toEqual({
      kind: 'invalid-order',
      detail: 'The book on this network is empty',
    })
    expect(sent.map((s) => s.url)).toEqual(['https://testnet-api.orderly.org/v1/public/query'])
  })

  it('refuses an intent carrying a take profit or stop loss and sends nothing', async () => {
    const { ctx, sent } = orderlyAt(() => ({ body: PLACED }))
    const exits = [
      { takeProfits: [{ px: 820_000 as Px, size: 100 as Qty }], stopLoss: null },
      { takeProfits: [], stopLoss: 790_000 as Px },
    ]
    for (const triggers of exits)
      expect(await failureOf(orderly.execute(ctx, { kind: 'place', intent: { ...intentOf({}), triggers } }))).toEqual({
        kind: 'unsupported',
        detail: 'Orderly takes no take profit or stop loss from Tape',
      })
    expect(sent).toEqual([])
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
      [
        400,
        -1101,
        'Risk exposure is too high. This may be caused by a large order size or low leverage. Check current exposure via the client info endpoint.',
        'insufficient-margin',
      ],
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

  it('classifies the refusals Orderly testnet sent by code and message', async () => {
    for (const [name, kind] of [
      ['insufficientMargin', 'insufficient-margin'],
      ['offTick', 'invalid-order'],
      ['offStep', 'invalid-order'],
      ['unregistered', 'needs-setup'],
      ['reduceOnly', 'rejected'],
      ['minimumValue', 'invalid-order'],
    ] as const) {
      const { status, response } = recordedWrite('orderly', name).exchanges[0]!
      const { ctx } = orderlyAt(() => ({ status, body: JSON.stringify(response) }))
      expect(await failureOf(orderly.execute(ctx, { kind: 'place', intent: intentOf({}) }))).toEqual({
        kind,
        detail: (response as { message: string }).message,
      })
    }
  })

  it("refuses an order off this network's tick or step before signing", async () => {
    const near: MarketSpec = { ...sol, venueSymbol: 'PERP_NEAR_USDC' }
    const { ctx, sent } = orderlyAt(
      () => ({ body: PLACED }),
      () => new Response('{"success":true,"data":{"symbol":"PERP_NEAR_USDC","quote_tick":0.05,"base_tick":0.2}}'),
    )
    const order = (fields: Record<string, string>) =>
      failureOf(
        orderly.execute(ctx, { kind: 'place', intent: intentOf({ price: '150', size: '0.4', ...fields }, near) }),
      )
    expect(await order({ size: '0.3' })).toEqual({
      kind: 'invalid-order',
      detail: 'Size 0.3: Size must be a multiple of 0.2 on this network',
    })
    expect(await order({ price: '150.01' })).toEqual({
      kind: 'invalid-order',
      detail: 'Price 150.01: Price must be a multiple of 0.05 on this network',
    })
    expect(await order({ kind: 'scale', start: '150', end: '150.01', count: '2' })).toEqual({
      kind: 'invalid-order',
      detail: 'Order 2 at 150.01: Price must be a multiple of 0.05 on this network',
    })
    expect(await order({ kind: 'scale', size: '0.6', start: '150', end: '150.05', count: '2' })).toEqual({
      kind: 'invalid-order',
      detail: 'Order 1 at 150: Size must be a multiple of 0.2 on this network',
    })
    expect(sent).toEqual([])
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
    expect(orderly.capabilities.leverage).toBe(true)
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

  it('marks a fill with no order a liquidation, and takes no PnL where Orderly has none', async () => {
    // The example row of the public trades query in Orderly's docs, with order_id and realized_pnl null as its
    // field table allows: no order on an orphaned or liquidation fill, no PnL on a fill older than 24 hours.
    const fill = {
      id: '987654321',
      order_id: null,
      symbol: 'PERP_ETH_USDC',
      side: 'BUY',
      executed_price: '2500.00',
      executed_quantity: '0.5',
      fee: '0.0005',
      fee_asset: 'USDC',
      is_maker: false,
      realized_pnl: null,
      executed_timestamp: 1714900000000,
    }
    const replies: Record<string, unknown> = {
      accountState: { accounts: [{ account_id: '0xabc' }] },
      trades: { rows: [fill], next_cursor: null },
      fundingPayments: { rows: [], next_cursor: null },
    }
    const fetch = (async (_url: string, init?: RequestInit) => {
      const { type } = JSON.parse(init?.body as string) as { type: string }
      return new Response(JSON.stringify({ success: true, data: replies[type] }))
    }) as typeof globalThis.fetch
    const { fills } = await orderly.history({
      network: 'mainnet',
      address: '0xf7069a2afa4c6e74917dfc6b0e29af57342f70a6',
      fetch,
    })
    expect(fills).toMatchObject([{ id: '987654321', liquidation: true, venuePnl: null, px: '2500', size: '0.5' }])
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

describe('orderly account', () => {
  // The example rows of GET /v1/positions, /v1/orders and /v1/trades in Orderly's OpenAPI spec, plus a closed
  // position, a long with no liquidation price, a market sell order and a sell fill.
  const positions = {
    total_collateral_value: 489865.71329,
    free_collateral: 450315.09115,
    rows: [
      {
        symbol: 'PERP_BTC_USDC',
        position_qty: -5,
        average_open_price: 27908.14386047,
        unsettled_pnl: 354.858492,
        est_liq_price: 117335.92899428,
      },
      { symbol: 'PERP_ETH_USDC', position_qty: 0, average_open_price: 0, unsettled_pnl: 0, est_liq_price: 0 },
      {
        symbol: 'PERP_SOL_USDC',
        position_qty: 2.5,
        average_open_price: 150.125,
        unsettled_pnl: -1.5,
        est_liq_price: 0,
      },
    ],
  }
  const orders = {
    rows: [
      {
        order_id: 78151,
        symbol: 'PERP_WOO_USDC',
        side: 'BUY',
        type: 'LIMIT',
        price: 0.67772,
        quantity: 20,
        reduce_only: false,
        created_time: 1653563963000,
      },
      {
        order_id: 78152,
        symbol: 'PERP_BTC_USDC',
        side: 'SELL',
        type: 'MARKET',
        price: null,
        quantity: 0.01,
        reduce_only: true,
        created_time: 1653563964000,
      },
    ],
  }
  const trades = {
    rows: [
      {
        id: 2,
        symbol: 'PERP_BTC_USDC',
        side: 'BUY',
        executed_price: 123,
        executed_quantity: 0.05,
        fee: 0.0001,
        executed_timestamp: 1567382401000,
      },
      {
        id: 3,
        symbol: 'PERP_BTC_USDC',
        side: 'SELL',
        executed_price: 124.5,
        executed_quantity: 0.05,
        fee: 0.0001,
        executed_timestamp: 1567382402000,
      },
    ],
  }
  const replies = (p: unknown, o: unknown, t: unknown) => (sent: Sent) => {
    const { pathname } = new URL(sent.url)
    const data = pathname === '/v1/positions' ? p : pathname === '/v1/orders' ? o : t
    return { body: JSON.stringify({ success: true, timestamp: 1702989203989, data }) }
  }

  it('reads positions, open orders and recent fills from the replies Orderly documents', async () => {
    const { ctx, sent } = orderlyAt(replies(positions, orders, trades))
    expect(await orderly.account(ctx)).toEqual({
      kind: 'live',
      snapshot: {
        equity: '489865.71329',
        available: '450315.09115',
        positions: [
          {
            symbol: 'PERP_BTC_USDC',
            side: 'short',
            size: '5',
            entry: '27908.14386047',
            unrealizedPnl: '354.858492',
            liquidation: '117335.92899428',
            leverage: null,
          },
          {
            symbol: 'PERP_SOL_USDC',
            side: 'long',
            size: '2.5',
            entry: '150.125',
            unrealizedPnl: '-1.5',
            liquidation: null,
            leverage: null,
          },
        ],
        orders: [
          {
            ref: 'PERP_WOO_USDC:78151',
            symbol: 'PERP_WOO_USDC',
            side: 'buy',
            kind: 'LIMIT',
            px: '0.67772',
            size: '20',
            reduceOnly: false,
            placedAt: 1653563963000,
            cancelable: true,
          },
          {
            ref: 'PERP_BTC_USDC:78152',
            symbol: 'PERP_BTC_USDC',
            side: 'sell',
            kind: 'MARKET',
            px: null,
            size: '0.01',
            reduceOnly: true,
            placedAt: 1653563964000,
            cancelable: true,
          },
        ],
        fills: [
          {
            id: '2',
            symbol: 'PERP_BTC_USDC',
            side: 'buy',
            px: '123',
            size: '0.05',
            fee: '0.0001',
            time: 1567382401000,
          },
          {
            id: '3',
            symbol: 'PERP_BTC_USDC',
            side: 'sell',
            px: '124.5',
            size: '0.05',
            fee: '0.0001',
            time: 1567382402000,
          },
        ],
      },
    })
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET https://testnet-api.orderly.org/v1/positions',
      'GET https://testnet-api.orderly.org/v1/orders?status=INCOMPLETE',
      'GET https://testnet-api.orderly.org/v1/trades?size=20',
    ])
  })

  it('calls an account with nothing in it empty, and one with any balance, position, order or fill live', async () => {
    const [position] = positions.rows
    const [order] = orders.rows
    const [fill] = trades.rows
    const flat = { total_collateral_value: 0, free_collateral: 0, rows: [positions.rows[1]] }
    const cases = [
      [flat, [], [], 'empty'],
      [{ ...flat, total_collateral_value: 10 }, [], [], 'live'],
      [{ ...flat, rows: [position] }, [], [], 'live'],
      [flat, [order], [], 'live'],
      [flat, [], [fill], 'live'],
    ] as const
    for (const [p, o, t, kind] of cases) {
      const { ctx } = orderlyAt(replies(p, { rows: o }, { rows: t }))
      expect((await orderly.account(ctx)).kind).toBe(kind)
    }
  })

  it('reads no account until this device holds a linked Orderly key', async () => {
    const { ctx, sent } = orderlyAt(replies(positions, orders, trades))
    const secret = `0x${'11'.repeat(32)}`
    for (const key of [
      null,
      { status: 'draft', public: {}, secret },
      { status: 'linked', public: {}, secret: null },
    ] as const)
      expect(await orderly.account({ ...ctx, keys: { ...ctx.keys, read: () => key } })).toEqual({ kind: 'unknown' })
    expect(sent).toEqual([])
  })
})

describe('orderly setup', () => {
  // The address and the account id Orderly gives it under the flipper broker, from the recorded accountState
  // in packages/trade/src/__fixtures__/history.orderly.json.
  const owner = '0xf7069a2afa4c6e74917dfc6b0e29af57342f70a6'
  const account = '0xd96bacbff940748d1215f933fc6c04d6798eb9fbd8926fe2388d02eb31003655'
  /** Orderly testnet's replies while a fresh wallet registered, added a key and read both back. */
  const [, nonceReply, registerReply, keyReply] = recordedWrite('orderly', 'enable').exchanges.map((e) => e.response)
  const keyRead = recordedWrite('orderly', 'stepsDone').exchanges[1]!.response as { data: Record<string, unknown> }
  const UNREGISTERED = JSON.stringify(recordedWrite('orderly', 'steps').exchanges[0]!.response)
  // Recorded from testnet-api.orderly.org and api.orderly.org on 2026-10-31.
  const REGISTERED = `{"success":true,"data":{"user_id":1476258,"account_id":"${account}"},"timestamp":1793452555211}`
  const NO_KEY = '{"success":false,"code":-1617,"message":"orderlyKey is not exist"}'
  const NONCE = JSON.stringify(nonceReply)
  const nonce = (nonceReply as { data: { registration_nonce: string } }).data.registration_nonce
  const keyUntil = (expiration: number) => JSON.stringify({ ...keyRead, data: { ...keyRead.data, expiration } })
  const REGISTER = JSON.stringify(registerReply)
  const KEY_ADDED = JSON.stringify(keyReply)
  const now = Date.UTC(2026, 9, 31, 12)
  const SIGNATURE: Hex = `0x${'ab'.repeat(65)}`
  const secret: Hex = `0x${'11'.repeat(32)}`
  const keyId = `ed25519:${base58.encode(ed25519.getPublicKey(hexToBytes(secret)))}`

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function slot(initial: StoredKey | null): KeySlot & { writes: StoredKey[] } {
    let key = initial
    const writes: StoredKey[] = []
    return {
      writes,
      read: () => key,
      write: (k) => {
        key = k
        writes.push(k)
      },
      clear: () => {
        key = null
      },
    }
  }

  function setup(replies: Record<string, string | Response>, key: StoredKey | null) {
    const { ctx, sent, headers } = orderlyAt(({ url }) => {
      const reply = replies[new URL(url).pathname]
      if (reply === undefined) throw new Error(`no reply for ${url}`)
      return typeof reply === 'string'
        ? { body: reply }
        : { status: reply.status, body: '<html>502 Bad Gateway</html>' }
    })
    const keys = slot(key)
    const flipper: VenueContext = {
      ...ctx,
      ref: { ...ctx.ref, owner },
      config: { ...ctx.config, orderly: { brokerId: { mainnet: null, testnet: 'flipper' } } },
      keys,
    }
    let chain = 1
    const signed: { typed: Eip712; slot: StoredKey['status'] | undefined }[] = []
    const wallet = {
      address: owner as `0x${string}`,
      chainId: async () => chain,
      switchChain: vi.fn(async (id: number) => {
        chain = id
      }),
      signTypedData: async (typed: Eip712) => {
        signed.push({ typed, slot: keys.read()?.status })
        return SIGNATURE
      },
    }
    return { ctx: flipper, sent, headers, keys, wallet, signed }
  }

  it('asks a new wallet to register and add a key, and a registered one only for a key missing or expired', async () => {
    const linked = { status: 'linked', public: { key: keyId }, secret } as const
    const cases = [
      [UNREGISTERED, NO_KEY, null, [false, false]],
      [REGISTERED, NO_KEY, null, [true, false]],
      [REGISTERED, NO_KEY, linked, [true, false]],
      [REGISTERED, keyUntil(1689086651947), linked, [true, false]],
      [REGISTERED, keyUntil(now + 86_400_000), linked, [true, true]],
    ] as const
    for (const [registered, key, stored, done] of cases) {
      const { ctx } = setup({ '/v1/get_account': registered, '/v1/get_orderly_key': key }, stored)
      expect(await orderly.steps(ctx)).toEqual([
        { id: 'register-account', label: 'Register an Orderly account', done: done[0] },
        { id: 'add-key', label: 'Add a trading key', done: done[1] },
      ])
    }
    const { ctx, sent } = setup({ '/v1/get_account': REGISTERED, '/v1/get_orderly_key': NO_KEY }, linked)
    await orderly.steps(ctx)
    expect(sent.map((s) => s.url)).toEqual([
      `https://testnet-api.orderly.org/v1/get_account?address=${owner}&broker_id=flipper`,
      `https://testnet-api.orderly.org/v1/get_orderly_key?account_id=${account}&orderly_key=${encodeURIComponent(keyId)}`,
    ])
    const down = setup({ '/v1/get_account': BAD_GATEWAY(), '/v1/get_orderly_key': BAD_GATEWAY() }, linked)
    expect(await failureOf(orderly.steps(down.ctx))).toMatchObject({ kind: 'unreachable' })
    const keyDown = setup({ '/v1/get_account': REGISTERED, '/v1/get_orderly_key': BAD_GATEWAY() }, linked)
    expect(await failureOf(orderly.steps(keyDown.ctx))).toMatchObject({ kind: 'unreachable' })
  })

  it('enables trading: registers, adds a read,trading key for 365 days, then links it', async () => {
    const { ctx, sent, headers, keys, wallet, signed } = setup(
      {
        '/v1/get_account': UNREGISTERED,
        '/v1/registration_nonce': NONCE,
        '/v1/register_account': REGISTER,
        '/v1/orderly_key': KEY_ADDED,
      },
      null,
    )
    const steps: StepId[] = []
    await orderly.enable(ctx, wallet, (step) => steps.push(step))
    expect(wallet.switchChain.mock.calls).toEqual([[421614]])
    expect(steps).toEqual(['register-account', 'add-key'])
    const [drafted, linked] = keys.writes
    const id = `ed25519:${base58.encode(ed25519.getPublicKey(hexToBytes((drafted?.secret ?? '0x') as Hex)))}`
    expect(keys.writes).toEqual([
      { status: 'draft', public: { key: id }, secret: drafted?.secret },
      { status: 'linked', public: { key: id }, secret: drafted?.secret },
    ])
    expect(linked?.secret).toMatch(/^0x[0-9a-f]{64}$/)
    const registration = { brokerId: 'flipper', chainId: 421614, timestamp: now, registrationNonce: nonce }
    const addKey = {
      brokerId: 'flipper',
      chainId: 421614,
      orderlyKey: id,
      scope: 'read,trading',
      timestamp: now,
      expiration: now + 365 * 86_400_000,
    }
    expect(signed.map((s) => [s.typed.primaryType, s.typed.message, s.slot])).toEqual([
      ['Registration', registration, undefined],
      ['AddOrderlyKey', addKey, 'draft'],
    ])
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET https://testnet-api.orderly.org/v1/get_account?address=${owner}&broker_id=flipper`,
      'GET https://testnet-api.orderly.org/v1/registration_nonce',
      'POST https://testnet-api.orderly.org/v1/register_account',
      'POST https://testnet-api.orderly.org/v1/orderly_key',
    ])
    expect(sent.slice(2).map((s) => JSON.parse(s.body ?? '') as unknown)).toEqual([
      { message: registration, signature: SIGNATURE, userAddress: owner },
      { message: addKey, signature: SIGNATURE, userAddress: owner },
    ])
    expect(headers.slice(2).map((h) => h['content-type'])).toEqual(['application/json', 'application/json'])
  })

  it('adds the key this device already holds to a registered account, and calls a lost reply unknown', async () => {
    const unlinked = { status: 'draft', public: { key: keyId }, secret } as const
    const { ctx, keys, wallet, signed } = setup(
      { '/v1/get_account': REGISTERED, '/v1/get_orderly_key': NO_KEY, '/v1/orderly_key': KEY_ADDED },
      unlinked,
    )
    await orderly.enable(ctx, wallet, () => {})
    expect(signed.map((s) => [s.typed.primaryType, (s.typed.message as { orderlyKey?: string }).orderlyKey])).toEqual([
      ['AddOrderlyKey', keyId],
    ])
    expect(keys.writes).toEqual([{ ...unlinked, status: 'linked' }])

    const lost = setup(
      { '/v1/get_account': REGISTERED, '/v1/get_orderly_key': NO_KEY, '/v1/orderly_key': BAD_GATEWAY() },
      unlinked,
    )
    expect(await failureOf(orderly.enable(lost.ctx, lost.wallet, () => {}))).toMatchObject({ kind: 'unknown-outcome' })
    expect(lost.keys.writes).toEqual([])
  })

  it('links a key Orderly already holds without asking the wallet to sign', async () => {
    const unlinked = { status: 'draft', public: { key: keyId }, secret } as const
    const { ctx, keys, wallet, signed } = setup(
      { '/v1/get_account': REGISTERED, '/v1/get_orderly_key': keyUntil(now + 86_400_000) },
      unlinked,
    )
    await orderly.enable(ctx, { ...wallet, chainId: async () => 421614 }, () => {})
    expect(signed).toEqual([])
    expect(wallet.switchChain).not.toHaveBeenCalled()
    expect(keys.writes).toEqual([{ ...unlinked, status: 'linked' }])
  })

  it('reports Orderly unavailable on a network with no broker id', () => {
    const config = { ...orderlyAt(() => ({ body: '' })).ctx.config, mainnet: true }
    expect(orderly.unavailable('mainnet', config)).toBe('No Orderly broker id is configured')
    expect(orderly.unavailable('testnet', config)).toBeNull()
  })
})
