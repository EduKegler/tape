import { describe, expect, it } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import type { Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { buildIntent } from '../intent'
import { TradeFailure } from '../types'
import type { Bps, Command, KeySlot, OrderRef, StoredKey, VenueContext } from '../types'
import { hyperliquid } from '.'

const owner: Address = '0x9f3c2b1a0e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b'
const agentKey = generatePrivateKey()
const agent = privateKeyToAccount(agentKey).address
const testnetMeta = {
  universe: [
    { name: 'SOL', szDecimals: 2 },
    { name: 'X', szDecimals: 0 },
    { name: 'Y', szDecimals: 0 },
    { name: 'BTC', szDecimals: 5 },
  ],
}
const btc: MarketSpec = {
  key: marketKey('hyperliquid', 'BTC'),
  venue: 'hyperliquid',
  base: 'BTC',
  quote: 'USDC',
  kind: 'perp',
  venueSymbol: 'BTC',
  scale: { px: 1, qty: 5 },
  tick: { kind: 'sigfig', figures: 5 },
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
}

function place(over: Partial<typeof draft>): Command {
  const built = buildIntent(btc, { ...draft, ...over } as Parameters<typeof buildIntent>[1], hyperliquid.capabilities)
  if (!built.ok) throw new Error(JSON.stringify(built))
  return { kind: 'place', intent: built.intent }
}

function memorySlot(initial: StoredKey | null): KeySlot {
  let key = initial
  return { read: () => key, write: (k) => void (key = k), clear: () => void (key = null) }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const statuses = (list: unknown[]) => json({ status: 'ok', response: { type: 'order', data: { statuses: list } } })

interface Sent {
  url: string
  body: Record<string, unknown>
}

function venue(exchange: () => Response | Promise<Response>, openOrders: unknown[] = []) {
  const sent: Sent[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>
    sent.push({ url, body })
    if (url.endsWith('/exchange')) return exchange()
    if (body.type === 'meta') return json(testnetMeta)
    if (body.type === 'l2Book') return json({ levels: [[{ px: '79990' }], [{ px: '80010' }]] })
    if (body.type === 'frontendOpenOrders') return json(openOrders)
    if (body.type === 'extraAgents') return json([])
    return json(null)
  }) as typeof globalThis.fetch
  const ctx: VenueContext = {
    ref: { venue: 'hyperliquid', network: 'testnet', owner },
    config: {
      mainnet: false,
      hyperliquid: { builder: null },
      dydx: { builder: null },
      orderly: { brokerId: { mainnet: null, testnet: 'demo' } },
    },
    keys: memorySlot({ status: 'linked', public: { agent }, secret: agentKey }),
    fetch,
  }
  const posts = () => sent.filter((s) => s.url.endsWith('/exchange'))
  return { ctx, posts }
}

const wiresOf = (post: Sent | undefined) => {
  const action = post?.body.action as { grouping: string; orders: { b: boolean; p: string; r: boolean; t: unknown }[] }
  return { grouping: action.grouping, orders: action.orders.map((o) => [o.b, o.p, o.r, o.t]) }
}

const failureOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof TradeFailure ? e.error : e),
  )

describe('hyperliquid sells', () => {
  // Exchange endpoint docs: b is isBuy.
  it('sends a sell as b false, with its take profit and stop loss as buys bounded above the trigger', async () => {
    const market = venue(() =>
      statuses([{ filled: { totalSz: '0.001', avgPx: '79990' } }, 'waitingForTrigger', 'waitingForTrigger']),
    )
    await hyperliquid.execute(
      market.ctx,
      place({ side: 'sell', kind: 'market', price: '', takeProfit: '78000', stopLoss: '82000' }),
    )
    expect(wiresOf(market.posts()[0])).toEqual({
      grouping: 'normalTpsl',
      orders: [
        [false, '79191', false, { limit: { tif: 'Ioc' } }],
        [true, '85800', true, { trigger: { isMarket: true, triggerPx: '78000', tpsl: 'tp' } }],
        [true, '90200', true, { trigger: { isMarket: true, triggerPx: '82000', tpsl: 'sl' } }],
      ],
    })

    const limit = venue(() => statuses([{ resting: { oid: 9 } }]))
    expect(await hyperliquid.execute(limit.ctx, place({ side: 'sell', price: '80100' }))).toEqual({
      kind: 'placed',
      status: 'resting',
      detail: 'Resting as order 9',
    })
    expect(wiresOf(limit.posts()[0])).toEqual({
      grouping: 'na',
      orders: [[false, '80100', false, { limit: { tif: 'Gtc' } }]],
    })
  })
})

describe('hyperliquid writes without a readable reply', () => {
  it('calls a 5xx, a dropped connection or a reply it cannot parse on a write an unknown outcome', async () => {
    const replies: (() => Response | Promise<Response>)[] = [
      () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      () => Promise.reject(new TypeError('fetch failed')),
      () => new Response('<html>502 Bad Gateway</html>', { status: 200 }),
      () => json({ status: 'ok', response: { type: 'order' } }),
    ]
    for (const reply of replies) {
      const { ctx } = venue(reply)
      expect(await failureOf(hyperliquid.execute(ctx, place({})))).toMatchObject({ kind: 'unknown-outcome' })
    }
  })

  it('calls a 5xx on the agent approval an unknown outcome, since the wallet signed it', async () => {
    const { ctx } = venue(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    const wallet = {
      address: owner,
      chainId: async () => 421614,
      switchChain: async () => {},
      signTypedData: async () => `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as const,
    }
    const keys = memorySlot(null)
    expect(await failureOf(hyperliquid.enable({ ...ctx, keys }, wallet, () => {}))).toMatchObject({
      kind: 'unknown-outcome',
    })
  })
})

describe('hyperliquid refusals', () => {
  // Texts from the Hyperliquid error responses docs, and the deposit reply the enable test in trade.test.ts uses.
  it('refuses an order Hyperliquid refuses in its own status, by the venue words', async () => {
    for (const [text, kind] of [
      ['Insufficient margin to place order.', 'insufficient-margin'],
      ['Order must have minimum value of $10.', 'invalid-order'],
      ['Price must be divisible by tick size.', 'invalid-order'],
      [`Must deposit before performing actions. User: ${owner}`, 'no-account'],
      ['Reduce only order would increase position.', 'rejected'],
    ] as const) {
      const { ctx } = venue(() => statuses([{ error: text }]))
      expect(await failureOf(hyperliquid.execute(ctx, place({})))).toEqual({ kind, detail: text })
    }
  })

  it('refuses a scale order when Hyperliquid refuses every leg', async () => {
    const { ctx } = venue(() =>
      statuses([
        { error: 'Insufficient margin to place order.' },
        { error: 'Insufficient margin to place order.' },
        { error: 'Insufficient margin to place order.' },
      ]),
    )
    const scale = place({ kind: 'scale', tif: 'post-only', size: '0.003', start: '80000', end: '79000', count: '3' })
    expect(await failureOf(hyperliquid.execute(ctx, scale))).toEqual({
      kind: 'insufficient-margin',
      detail: 'Insufficient margin to place order.',
    })
  })
})

describe('hyperliquid cancels', () => {
  const cancel: Command = { kind: 'cancel', order: '3:42' as OrderRef }
  // The cancel action shape, `success` and the text for an order that is gone are from the exchange endpoint docs.
  const gone = 'Order was never placed, already canceled, or filled.'

  it('cancels an order Hyperliquid already filled without an error, but not one it refuses', async () => {
    for (const reply of [['success'], [{ error: gone }]]) {
      const { ctx, posts } = venue(() => statuses(reply))
      expect(await hyperliquid.execute(ctx, cancel)).toEqual({ kind: 'done', detail: 'Canceled 1' })
      expect(posts()[0]?.body.action).toEqual({ type: 'cancel', cancels: [{ a: 3, o: 42 }] })
    }
    const { ctx } = venue(() => statuses([{ error: 'Cancel refused for a reason Tape does not know' }]))
    expect(await failureOf(hyperliquid.execute(ctx, cancel))).toEqual({
      kind: 'rejected',
      detail: 'Cancel refused for a reason Tape does not know',
    })
  })

  it('cancels every open order of the market and nothing when none is open', async () => {
    const order = (coin: string, oid: number) => ({ coin, side: 'B', limitPx: '70000.0', sz: '0.001', oid })
    const open = venue(() => statuses(['success', 'success']), [order('BTC', 11), order('SOL', 12), order('BTC', 13)])
    expect(await hyperliquid.execute(open.ctx, { kind: 'cancel-all', symbol: 'BTC' })).toEqual({
      kind: 'done',
      detail: 'Canceled 2',
    })
    expect(open.posts()[0]?.body.action).toEqual({
      type: 'cancel',
      cancels: [
        { a: 3, o: 11 },
        { a: 3, o: 13 },
      ],
    })

    const none = venue(() => statuses([]), [order('SOL', 12)])
    expect(await hyperliquid.execute(none.ctx, { kind: 'cancel-all', symbol: 'BTC' })).toEqual({
      kind: 'done',
      detail: 'Nothing to cancel',
    })
    expect(none.posts()).toEqual([])
  })
})
