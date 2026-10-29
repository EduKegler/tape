import { describe, expect, it } from 'vitest'
import { hashTypedData, recoverAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import { plainDecimal } from '#/core/fixed'
import type { Qty } from '#/core/fixed'
import { marketKey } from '#/core/ids'
import type { MarketSpec } from '#/core/market'
import { ONBOARDING } from './dydx/client'
import { actionHash, l1TypedData } from './hyperliquid/sign'
import { typedDataDigest } from './typed-data'
import { TRADING } from './index'
import { buildIntent, closeIntent } from './intent'
import type { Bps, KeySlot, StoredKey, VenueContext } from './types'
import { TradeFailure } from './types'
import { domainTypes } from './wallet'

const btc: MarketSpec = {
  key: marketKey('hyperliquid', 'BTC'), venue: 'hyperliquid', base: 'BTC', quote: 'USDC', kind: 'perp', venueSymbol: 'BTC',
  scale: { px: 1, qty: 5 }, tick: { kind: 'sigfig', figures: 5 }, step: 1 as Qty,
}
const caps = TRADING.hyperliquid.capabilities
const draft = { side: 'buy', kind: 'limit', price: '80000', size: '0.001', tif: 'gtc', reduceOnly: false, takeProfit: '', stopLoss: '', slippage: 100 as Bps } as const

function memorySlot(initial: StoredKey | null = null): KeySlot {
  let key = initial
  return { read: () => key, write: (k) => void (key = k), clear: () => void (key = null) }
}

/** A venue that answers by request body, and records what was sent. */
function venue(answer: (url: string, body: Record<string, unknown>) => unknown) {
  const sent: { url: string; body: Record<string, unknown> }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    sent.push({ url, body })
    return new Response(JSON.stringify(answer(url, body)))
  }) as typeof globalThis.fetch
  return { fetch, sent }
}

describe('order intent', () => {
  it('builds a limit intent and refuses take profit on the wrong side', () => {
    const ok = buildIntent(btc, draft, caps)
    expect(ok.ok && ok.intent.order).toEqual({ kind: 'limit', px: 800_000, tif: 'gtc' })
    const bad = buildIntent(btc, { ...draft, takeProfit: '79000' }, caps)
    expect(!bad.ok && bad.errors.takeProfit).toBe('Must be above the price')
  })

  it('gives every build a fresh client id', () => {
    const a = buildIntent(btc, draft, caps)
    const b = buildIntent(btc, draft, caps)
    expect(a.ok && b.ok && a.intent.clientId !== b.intent.clientId).toBe(true)
  })

  it('closes a short with a reduce-only market buy of the whole size', () => {
    const intent = closeIntent(btc, { symbol: 'BTC', side: 'short', size: '0.0123' as never, entry: '1' as never, unrealizedPnl: '0' as never, liquidation: null, leverage: null }, 100 as Bps)
    expect(intent && { side: intent.side, size: intent.size, reduceOnly: intent.reduceOnly, kind: intent.order.kind }).toEqual({ side: 'buy', size: 1230, reduceOnly: true, kind: 'market' })
  })
})

describe('exact numbers', () => {
  it('expands JSON exponents without a float', () => {
    expect(plainDecimal('1e-7')).toBe('0.0000001')
    expect(plainDecimal('-2.5E+3')).toBe('-2500')
    expect(plainDecimal('100.50')).toBe('100.5')
  })
})

describe('wallet typed data', () => {
  it('lists only the domain fields the dYdX onboarding has, so the derived key matches dYdX', () => {
    expect(domainTypes(ONBOARDING.domain)).toEqual([{ name: 'name', type: 'string' }])
    expect(domainTypes({ name: 'Orderly', version: '1', chainId: 1, verifyingContract: '0x' })).toHaveLength(4)
  })

  it('hashes Hyperliquid typed data as viem does with the derived domain', () => {
    const data = l1TypedData('0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908', 'Testnet')
    expect(typedDataDigest(data)).toBe(hashTypedData(data as Parameters<typeof hashTypedData>[0]))
  })
})

describe('hyperliquid module', () => {
  const owner = '0x9f3c2b1a0e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b' as Address
  const agentKey = generatePrivateKey()
  const agent = privateKeyToAccount(agentKey).address
  const testnetMeta = { universe: [{ name: 'SOL', szDecimals: 2 }, { name: 'X', szDecimals: 0 }, { name: 'Y', szDecimals: 0 }, { name: 'BTC', szDecimals: 5 }] }

  it('signs the order with the agent for the testnet asset id', async () => {
    const { fetch, sent } = venue((url, body) =>
      url.endsWith('/info') ? (body.type === 'meta' ? testnetMeta : null) : { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 7 } }] } } },
    )
    const ctx: VenueContext = { ref: { venue: 'hyperliquid', network: 'testnet', owner }, keys: memorySlot({ status: 'draft', public: { agent }, secret: agentKey }), fetch }
    const built = buildIntent(btc, draft, caps)
    if (!built.ok) throw new Error('intent')
    const outcome = await TRADING.hyperliquid.execute(ctx, { kind: 'place', intent: built.intent })
    expect(outcome).toEqual({ kind: 'placed', status: 'resting', detail: 'Resting as order 7' })
    const post = sent.find((s) => s.url.endsWith('/exchange'))!
    const action = post.body.action as { orders: { a: number; p: string; s: string; c: string }[] }
    expect(action.orders[0]).toMatchObject({ a: 3, p: '80000', s: '0.001', c: built.intent.clientId })
    const signature = post.body.signature as { r: Hex; s: Hex; v: number }
    const digest = typedDataDigest(l1TypedData(actionHash(action, null, post.body.nonce as number, null), 'Testnet'))
    expect(await recoverAddress({ hash: digest, signature: { r: signature.r, s: signature.s, v: BigInt(signature.v) } })).toBe(agent)
  })

  it('turns an unknown API wallet into needs-setup with the venue words', async () => {
    const { fetch } = venue((url, body) => (url.endsWith('/info') ? (body.type === 'meta' ? testnetMeta : null) : { status: 'err', response: `User or API Wallet ${agent} does not exist.` }))
    const ctx: VenueContext = { ref: { venue: 'hyperliquid', network: 'testnet', owner }, keys: memorySlot({ status: 'draft', public: { agent }, secret: agentKey }), fetch }
    const built = buildIntent(btc, { ...draft, price: '80001' }, caps)
    if (!built.ok) throw new Error('intent')
    const error = await TRADING.hyperliquid.execute(ctx, { kind: 'place', intent: built.intent }).catch((e: unknown) => e)
    expect(error instanceof TradeFailure && error.error).toEqual({ kind: 'needs-setup', detail: `User or API Wallet ${agent} does not exist.` })
  })

  it('refuses a price the testnet rules reject instead of rounding it', async () => {
    const { fetch } = venue((url, body) => (url.endsWith('/info') && body.type === 'meta' ? { universe: [{ name: 'BTC', szDecimals: 5 }] } : null))
    const ctx: VenueContext = { ref: { venue: 'hyperliquid', network: 'testnet', owner }, keys: memorySlot({ status: 'draft', public: { agent }, secret: agentKey }), fetch }
    const built = buildIntent({ ...btc, scale: { px: 2, qty: 5 }, tick: { kind: 'fixed', tick: 1 } as MarketSpec['tick'] }, { ...draft, price: '80000.25' }, caps)
    if (!built.ok) throw new Error('intent')
    const error = await TRADING.hyperliquid.execute(ctx, { kind: 'place', intent: built.intent }).catch((e: unknown) => e)
    expect(error instanceof TradeFailure && error.error.kind).toBe('invalid-order')
  })

  it('reads positions, orders and fills by address in the venue shapes', async () => {
    const { fetch } = venue((_url, body) => {
      if (body.type === 'meta') return testnetMeta
      if (body.type === 'clearinghouseState') return { marginSummary: { accountValue: '1008.5' }, withdrawable: '900.25', assetPositions: [{ position: { coin: 'BTC', szi: '-0.01', entryPx: '80100.0', unrealizedPnl: '-1.5', liquidationPx: '95000.0', leverage: { type: 'cross', value: 5 } } }] }
      if (body.type === 'frontendOpenOrders') return [{ coin: 'BTC', side: 'B', limitPx: '70000.0', sz: '0.001', oid: 589008353129, timestamp: 1793248070251, orderType: 'Limit', reduceOnly: false, isTrigger: false, triggerPx: '0.0' }]
      if (body.type === 'userFills') return [{ coin: 'BTC', px: '80100.0', sz: '0.01', side: 'A', time: 1793248071468, fee: '0.36', tid: 151386843995060 }]
      return null
    })
    const view = await TRADING.hyperliquid.account({ ref: { venue: 'hyperliquid', network: 'testnet', owner }, keys: memorySlot(), fetch })
    if (view.kind !== 'live') throw new Error(view.kind)
    expect(view.snapshot.positions[0]).toMatchObject({ symbol: 'BTC', side: 'short', size: '0.01', leverage: '5x cross' })
    expect(view.snapshot.orders[0]).toMatchObject({ ref: '3:589008353129', side: 'buy', px: '70000.0' })
    expect(view.snapshot.fills[0]).toMatchObject({ id: '151386843995060', side: 'sell' })
  })

  it('writes the agent as draft before the wallet signs, and keeps it when the venue says deposit first', async () => {
    const { fetch } = venue((url, body) => (url.endsWith('/info') ? (body.type === 'extraAgents' ? [] : null) : { status: 'err', response: `Must deposit before performing actions. User: ${owner}` }))
    const keys = memorySlot()
    const ctx: VenueContext = { ref: { venue: 'hyperliquid', network: 'testnet', owner }, keys, fetch }
    const wallet = { address: owner, chainId: async () => 421614, switchChain: async () => {}, signTypedData: async () => `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as Hex }
    const error = await TRADING.hyperliquid.enable(ctx, wallet, () => {}).catch((e: unknown) => e)
    expect(error instanceof TradeFailure && error.error.kind).toBe('no-account')
    expect(keys.read()).toMatchObject({ status: 'draft', public: { agent: expect.stringMatching(/^0x/) } })
  })
})
