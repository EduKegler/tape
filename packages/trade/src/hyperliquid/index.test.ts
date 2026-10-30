import { describe, expect, it } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { buildIntent } from '../intent'

import type { Bps, Command, KeySlot, StoredKey, VenueContext } from '../types'
import { hyperliquid } from '.'

const owner = '0x9f3c2b1a0e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b'
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
