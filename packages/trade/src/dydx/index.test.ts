import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { buildIntent } from '../intent'
import type { IntentDraft } from '../intent'
import { TradeFailure } from '../types'
import type { Bps, Eip712, OrderRef, StepId, StoredKey, VenueContext } from '../types'
import { dydx } from '.'

const chain = vi.hoisted(() => {
  const state: { reply: unknown } = { reply: undefined }
  const answer = async (..._args: unknown[]) => {
    if (state.reply instanceof Error) throw state.reply
    return state.reply
  }
  const deriveKey = vi.fn(async (signature: string) => ({ mnemonic: `words of ${signature}`, address: 'dydx1derived' }))
  return Object.assign(state, { placeOrder: vi.fn(answer), cancelOrder: vi.fn(answer), deriveKey })
})

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // SHORT_BLOCK_FORWARD in build/esm/src/clients/constants.js of v4-client-js 3.6.0.
  sdk: async () => ({ SubaccountInfo: { forLocalWallet: () => ({}) }, SHORT_BLOCK_FORWARD: 15 }),
  deriveKey: chain.deriveKey,
  walletOf: async () => ({ address: 'dydx1test' }),
  validatorOf: async () => ({
    get: { latestBlockHeight: async () => 1 },
    post: { placeOrder: chain.placeOrder, cancelOrder: chain.cancelOrder },
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

// BTC-USD params from the recorded indexer.dydx.trade/v4/perpetualMarkets frame.
const markets = {
  markets: {
    'BTC-USD': {
      clobPairId: '0',
      atomicResolution: -10,
      quantumConversionExponent: -9,
      stepBaseQuantums: 1_000_000,
      subticksPerTick: 100_000,
      tickSize: '1',
      stepSize: '0.0001',
    },
  },
}
const btc: MarketSpec = {
  key: marketKey('dydx', 'BTC' as Base),
  venue: 'dydx',
  base: 'BTC' as Base,
  quote: 'USD',
  kind: 'perp',
  venueSymbol: 'BTC-USD',
  scale: { px: 0, qty: 4 },
  tick: { kind: 'fixed', tick: 1 } as MarketSpec['tick'],
  step: 1 as Qty,
}
const ctx: VenueContext = {
  ref: { venue: 'dydx', network: 'testnet', owner: '0x9f3c2b1a0e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b' },
  config: {
    mainnet: false,
    hyperliquid: { builder: null },
    dydx: { builder: null },
    orderly: { brokerId: { mainnet: null, testnet: 'demo' } },
  },
  keys: {
    read: () => ({ status: 'linked', public: { address: 'dydx1test' }, secret: 'mnemonic' }),
    write: () => {},
    clear: () => {},
  },
  fetch: async () => new Response(JSON.stringify(markets)),
}
const draft: IntentDraft = {
  side: 'buy',
  kind: 'limit',
  price: '80000',
  size: '0.001',
  tif: 'gtc',
  reduceOnly: false,
  takeProfits: [],
  stopLoss: '',
  slippage: 100 as Bps,
  bid: '',
  ask: '',
  start: '',
  end: '',
  count: '',
  skew: '1',
  retracement: '',
  retracementUnit: 'pct',
  activation: '',
}
function intentOf(spec: MarketSpec, changes: Partial<IntentDraft> = {}) {
  const built = buildIntent(spec, { ...draft, ...changes }, dydx.capabilities)
  if (!built.ok) throw new Error('intent')
  return built.intent
}
const place = { kind: 'place', intent: intentOf(btc) } as const
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof TradeFailure ? e.error : e),
  )
function indexer(answer: (url: string) => unknown) {
  const urls: string[] = []
  const fetch = (async (url: string) => {
    urls.push(url)
    const reply = answer(url)
    return reply instanceof Response ? reply : new Response(JSON.stringify(reply))
  }) as typeof globalThis.fetch
  return { urls, ctx: { ...ctx, fetch } }
}
const locked: VenueContext = { ...ctx, keys: { ...ctx.keys, read: () => null } }
const wire = (call: unknown[] | undefined) => ({
  side: call?.[3],
  quantums: String(call?.[4]),
  subticks: String(call?.[5]),
  tif: call?.[6],
  flags: call?.[7],
  goodTilBlock: call?.[9],
  goodTilBlockTime: call?.[10],
})
// The TimeoutError v4-client-js's tendermintClient throws when the transaction is not seen on chain in time.
const TIMEOUT =
  'Transaction with hash [AB] was submitted but was not yet found on the chain. You might want to check later. Query timed out after 60 seconds.'

describe('dydx broadcast', () => {
  it('reports the hash of a long-term order the chain committed', async () => {
    // IndexedTx, as v4-client-js returns it for a long-term order: the hash as upper-case hex.
    chain.reply = { height: 1, hash: 'A1B2C3', code: 0, rawLog: '' }
    expect(await dydx.execute(ctx, place)).toEqual({ kind: 'placed', status: 'resting', detail: 'Broadcast A1B2C3' })
  })

  it('calls a broadcast reply without a hash an unknown outcome, since the order may be on chain', async () => {
    for (const reply of [undefined, { height: 1, code: 0, rawLog: '' }, { code: 0, log: '', hash: new Uint8Array() }]) {
      chain.reply = reply
      const error = await dydx.execute(ctx, place).catch((e: unknown) => e)
      expect(error instanceof TradeFailure && error.error.kind).toBe('unknown-outcome')
    }
  })

  it('calls a cancel reply without a hash an unknown outcome, not a done cancel', async () => {
    chain.reply = { height: 1, code: 0, rawLog: '' }
    const error = await dydx
      .execute(ctx, { kind: 'cancel', order: 'BTC-USD:7:64:0' as OrderRef })
      .catch((e: unknown) => e)
    expect(error instanceof TradeFailure && error.error.kind).toBe('unknown-outcome')
  })

  it('calls a short-term cancel done when the chain already holds a cancel for the order', async () => {
    // ErrMemClobCancelAlreadyExists, code 9 in x/clob/types/errors.go of dydxprotocol/v4-chain.
    chain.reply = {
      code: 9,
      log: 'A cancel already exists in the memclob for this order with a greater than or equal GoodTilBlock',
      hash: 'A1B2C3',
    }
    expect(await dydx.execute(ctx, { kind: 'cancel', order: 'BTC-USD:7:0:0' as OrderRef })).toEqual({
      kind: 'done',
      detail: 'Cancel broadcast',
    })
  })

  it('calls a thrown broadcast timeout an unknown outcome and a refused transaction not placed', async () => {
    // Messages and codes registered in x/clob/types/errors.go of dydxprotocol/v4-chain.
    const margin = 'Stateful order collateralization check failed'
    const cases: [unknown, unknown][] = [
      [new Error(TIMEOUT), { kind: 'unknown-outcome', detail: TIMEOUT }],
      [new Error(margin), { kind: 'insufficient-margin', detail: margin }],
      [new Error('Invalid order quantums'), { kind: 'invalid-order', detail: 'Invalid order quantums' }],
      [
        { code: 3007, log: margin, hash: 'A1' },
        { kind: 'insufficient-margin', detail: margin },
      ],
      [
        { code: 3001, log: 'Invalid order goodTilBlockTime', hash: 'A1' },
        { kind: 'rejected', detail: 'Invalid order goodTilBlockTime' },
      ],
    ]
    for (const [reply, error] of cases) {
      chain.reply = reply
      expect(await failure(dydx.execute(ctx, place))).toEqual(error)
    }
  })

  it('calls a cancel the client throws for an order already removed done, and a thrown timeout unknown', async () => {
    // ErrStatefulOrderCancellationFailedForAlreadyRemovedOrder, code 3010 in x/clob/types/errors.go of dydxprotocol/v4-chain.
    chain.reply = new Error('Stateful order cancellation failed because the order was already removed from state')
    const cancel = { kind: 'cancel', order: 'BTC-USD:7:64:0' as OrderRef } as const
    expect(await dydx.execute(ctx, cancel)).toEqual({ kind: 'done', detail: 'Cancel broadcast' })
    chain.reply = new Error(TIMEOUT)
    expect(await failure(dydx.execute(ctx, cancel))).toEqual({ kind: 'unknown-outcome', detail: TIMEOUT })
  })

  it('calls cancelling a stateful order the chain no longer holds done', async () => {
    // ErrStatefulOrderDoesNotExist, code 3006 in x/clob/types/errors.go of dydxprotocol/v4-chain.
    chain.reply = { code: 3006, log: 'Stateful order does not exist', hash: 'A1' }
    expect(await dydx.execute(ctx, { kind: 'cancel', order: 'BTC-USD:7:64:0' as OrderRef })).toEqual({
      kind: 'done',
      detail: 'Cancel broadcast',
    })
  })
})

describe('dydx key and lookup', () => {
  it('tells a dYdX order missing from the indexer apart from a missing key', async () => {
    chain.reply = { code: 0, hash: 'A1' }
    for (const command of [place, { kind: 'cancel', order: 'BTC-USD:7:64:0' as OrderRef } as const])
      expect(await failure(dydx.execute(locked, command))).toMatchObject({ kind: 'needs-setup' })
    expect(await failure(dydx.lookup(locked, place.intent))).toMatchObject({ kind: 'needs-setup' })
    expect(chain.placeOrder).not.toHaveBeenCalled()

    const at = (status: number, body: unknown) => indexer(() => new Response(JSON.stringify(body), { status })).ctx
    expect(await dydx.lookup(at(404, {}), place.intent)).toEqual({
      kind: 'absent',
      detail: 'The dYdX indexer has no account for this address',
    })
    expect(await dydx.lookup(at(200, [{ clientId: '1', status: 'OPEN' }]), place.intent)).toMatchObject({
      kind: 'absent',
    })
    expect(await failure(dydx.lookup(at(502, 'Bad Gateway'), place.intent))).toMatchObject({ kind: 'unreachable' })
  })

  it('asks the dYdX testnet indexer about a testnet order', async () => {
    const { urls, ctx: testnet } = indexer(() => [])
    await dydx.lookup(testnet, place.intent)
    // IndexerApiHost.TESTNET in v4-client-js.
    expect(urls[0]?.startsWith('https://indexer.v4testnet.dydx.exchange/v4/orders?')).toBe(true)
  })
})

// ETH-USD and SOL-USD params from the recorded indexer.dydx.trade/v4/perpetualMarkets frames.
const ethMarkets = {
  markets: {
    'ETH-USD': {
      clobPairId: '1',
      atomicResolution: -9,
      quantumConversionExponent: -9,
      stepBaseQuantums: 1_000_000,
      subticksPerTick: 100_000,
      tickSize: '0.1',
      stepSize: '0.001',
    },
  },
}
const solMarkets = {
  markets: {
    'SOL-USD': {
      clobPairId: '5',
      atomicResolution: -7,
      quantumConversionExponent: -9,
      stepBaseQuantums: 1_000_000,
      subticksPerTick: 1_000_000,
      tickSize: '0.01',
      stepSize: '0.1',
    },
  },
}
const eth: MarketSpec = {
  ...btc,
  key: marketKey('dydx', 'ETH' as Base),
  base: 'ETH' as Base,
  venueSymbol: 'ETH-USD',
  scale: { px: 1, qty: 3 },
}
const sol: MarketSpec = {
  ...btc,
  key: marketKey('dydx', 'SOL' as Base),
  base: 'SOL' as Base,
  venueSymbol: 'SOL-USD',
  scale: { px: 2, qty: 1 },
}

describe('dydx markets', () => {
  it('places an ETH order on the ETH market after a BTC order on the same network', async () => {
    const { urls, ctx: both } = indexer((url) =>
      url.endsWith('ticker=ETH-USD') ? ethMarkets : url.endsWith('ticker=BTC-USD') ? markets : { markets: {} },
    )
    chain.reply = { code: 0, hash: 'A1' }
    await dydx.execute(both, place)
    await dydx.execute(both, { kind: 'place', intent: intentOf(eth, { price: '2330.5', size: '0.01' }) })
    expect(chain.placeOrder.mock.calls.map((call) => call[2])).toEqual([0, 1])
    expect(urls).toContain('https://indexer.v4testnet.dydx.exchange/v4/perpetualMarkets?ticker=ETH-USD')

    const doge = intentOf({ ...btc, venueSymbol: 'DOGE-USD' })
    expect(await failure(dydx.execute(both, { kind: 'place', intent: doge }))).toEqual({
      kind: 'invalid-order',
      detail: 'DOGE-USD is not listed on dYdX testnet',
    })
  })

  it('reads the market again after a failed read', async () => {
    let down = true
    const { ctx: flaky } = indexer(() => (down ? new Response('Bad Gateway', { status: 502 }) : solMarkets))
    const order = { kind: 'place', intent: intentOf(sol, { price: '100.87', size: '0.1' }) } as const
    chain.reply = { code: 0, hash: 'A1' }
    expect(await failure(dydx.execute(flaky, order))).toMatchObject({ kind: 'unreachable' })
    down = false
    expect(await dydx.execute(flaky, order)).toMatchObject({ kind: 'placed' })
  })
})

describe('dydx short-term orders', () => {
  const { ctx: booked } = indexer((url) =>
    url.includes('/orderbooks/')
      ? { bids: [{ price: '80000', size: '1' }], asks: [{ price: '80200', size: '1' }] }
      : markets,
  )

  it('places a market order as a short-term IOC at the far touch moved by the slippage', async () => {
    chain.reply = { code: 0, hash: 'A1' }
    const buy = intentOf(btc, { kind: 'market', slippage: 50 as Bps })
    expect(await dydx.execute(booked, { kind: 'place', intent: buy })).toEqual({
      kind: 'placed',
      status: 'accepted',
      detail: 'Broadcast A1',
    })
    const sell = intentOf(btc, { kind: 'market', side: 'sell', slippage: 50 as Bps })
    await dydx.execute(booked, { kind: 'place', intent: sell })
    const short = { quantums: '10000000', tif: 1, flags: 0, goodTilBlock: 16, goodTilBlockTime: undefined }
    expect(chain.placeOrder.mock.calls.map(wire)).toEqual([
      { ...short, side: 1, subticks: '8060100000' },
      { ...short, side: 2, subticks: '7960000000' },
    ])
  })

  it('refuses a market order into an empty book, and sends a limit IOC short-term too', async () => {
    const { ctx: empty } = indexer((url) => (url.includes('/orderbooks/') ? { bids: [], asks: [] } : markets))
    expect(await failure(dydx.execute(empty, { kind: 'place', intent: intentOf(btc, { kind: 'market' }) }))).toEqual({
      kind: 'invalid-order',
      detail: 'The book on this network is empty',
    })
    chain.reply = { code: 0, hash: 'A1' }
    expect(await dydx.execute(ctx, { kind: 'place', intent: intentOf(btc, { tif: 'ioc' }) })).toMatchObject({
      status: 'accepted',
    })
    expect(wire(chain.placeOrder.mock.calls[0])).toMatchObject({ tif: 1, flags: 0, goodTilBlock: 16 })
  })
})

describe('dydx contract', () => {
  it('refuses a stop loss on a dYdX ticket, since place sends no trigger orders', () => {
    expect(buildIntent(btc, { ...draft, stopLoss: '79000' }, dydx.capabilities)).toMatchObject({
      ok: false,
      errors: { stopLoss: 'Not offered on this venue' },
    })
    expect(buildIntent(btc, { ...draft, tif: 'ioc' }, dydx.capabilities).ok).toBe(true)
  })

  it('refuses an intent carrying a take profit or stop loss and broadcasts nothing', async () => {
    const { urls, ctx: watched } = indexer(() => markets)
    const exits = [
      { takeProfits: [{ px: 820_000 as Px, size: 100 as Qty }], stopLoss: null },
      { takeProfits: [], stopLoss: 790_000 as Px },
    ]
    for (const triggers of exits)
      expect(await failure(dydx.execute(watched, { kind: 'place', intent: { ...intentOf(btc), triggers } }))).toEqual({
        kind: 'unsupported',
        detail: 'dYdX takes no take profit or stop loss from Tape',
      })
    expect(chain.placeOrder).not.toHaveBeenCalled()
    expect(urls).toEqual([])
  })

  it('keeps the dYdX mnemonic in the tab, out of storage', () => {
    expect(dydx.secrets).toBe('tab')
  })
})

describe('dydx expiry', () => {
  const now = Date.UTC(2026, 9, 30, 12) / 1000
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now * 1000 + 500)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends a long-term order good for 28 days', async () => {
    chain.reply = { code: 0, hash: 'A1' }
    await dydx.execute(ctx, place)
    expect(wire(chain.placeOrder.mock.calls[0])).toMatchObject({
      flags: 64,
      goodTilBlock: undefined,
      goodTilBlockTime: now + 28 * 86_400,
    })
  })

  it('sends a long-term cancel good for a while within the stateful window, and a short-term one by block', async () => {
    chain.reply = { code: 0, hash: 'A1' }
    await dydx.execute(ctx, { kind: 'cancel', order: 'BTC-USD:7:64:0' as OrderRef })
    await dydx.execute(ctx, { kind: 'cancel', order: 'BTC-USD:7:0:0' as OrderRef })
    const [long, short] = chain.cancelOrder.mock.calls.map((call) => call.slice(1))
    expect(long?.slice(0, 4)).toEqual([7, 64, 0, undefined])
    // StatefulOrderTimeWindow, 95 days, in x/clob/types/constants.go of dydxprotocol/v4-chain.
    expect(long?.[4]).toBeGreaterThan(now)
    expect(long?.[4]).toBeLessThanOrEqual(now + 95 * 86_400)
    expect(short).toEqual([7, 0, 0, 16, undefined])
  })
})

describe('dydx checks before signing', () => {
  it("refuses a size or price off this network's step or tick before signing", async () => {
    const frame = ethMarkets.markets['ETH-USD']
    const coarse = {
      markets: {
        'ETH-USD': {
          ...frame,
          tickSize: '0.5',
          subticksPerTick: 500_000,
          stepSize: '0.01',
          stepBaseQuantums: 10_000_000,
        },
      },
    }
    const { ctx: other } = indexer(() => coarse)
    const on = { ...other, ref: { ...other.ref, network: 'mainnet' as const } }
    const order = (changes: Partial<IntentDraft>) =>
      failure(dydx.execute(on, { kind: 'place', intent: intentOf(eth, { price: '2330.5', size: '0.01', ...changes }) }))
    expect(await order({ size: '0.005' })).toMatchObject({
      kind: 'invalid-order',
      detail: expect.stringMatching(/^Size 0\.005: /),
    })
    expect(await order({ price: '2330.3' })).toMatchObject({
      kind: 'invalid-order',
      detail: expect.stringMatching(/^Price 2330\.3: /),
    })
    expect(chain.placeOrder).not.toHaveBeenCalled()
  })
})

describe('dydx cancel all', () => {
  it('cancels every open dYdX order on the market and only that market', async () => {
    const order = { side: 'BUY', size: '0.001', price: '79000', type: 'LIMIT', reduceOnly: false }
    const { urls, ctx: open } = indexer(() => [
      { ...order, id: 'a', clientId: '11', clobPairId: '0', ticker: 'BTC-USD', orderFlags: '64' },
      { ...order, id: 'b', clientId: '12', clobPairId: '1', ticker: 'ETH-USD', orderFlags: '64' },
      { ...order, id: 'c', clientId: '13', clobPairId: '0', ticker: 'BTC-USD', orderFlags: '0', goodTilBlock: '30' },
    ])
    chain.reply = { code: 0, hash: 'A1' }
    expect(await dydx.execute(open, { kind: 'cancel-all', symbol: 'BTC-USD' })).toEqual({
      kind: 'done',
      detail: 'Canceled 2',
    })
    expect(chain.cancelOrder.mock.calls.map((call) => call.slice(1, 4))).toEqual([
      [11, 64, 0],
      [13, 0, 0],
    ])
    expect(urls[0]).toContain('status=OPEN,BEST_EFFORT_OPENED,UNTRIGGERED')
    expect(await failure(dydx.execute(locked, { kind: 'cancel-all', symbol: 'BTC-USD' }))).toMatchObject({
      kind: 'needs-setup',
    })
  })
})

describe('dydx builder fee', () => {
  it('passes the configured builder fee to dYdX', async () => {
    const builder = { builderAddress: 'dydx1builder', feePpm: 10 }
    chain.reply = { code: 0, hash: 'A1' }
    await dydx.execute({ ...ctx, config: { ...ctx.config, dydx: { builder } } }, place)
    expect(chain.placeOrder.mock.calls[0]?.[15]).toEqual(builder)
  })
})

describe('dydx account', () => {
  // The SubaccountResponseObject, OrderResponseObject and FillResponseObject fields in the indexer's
  // api-documentation.md in dydxprotocol/v4-chain. The indexer passes the position size through signed:
  // getUnrealizedPnl in indexer/packages/postgres takes size times oracle minus entry, so a short is negative.
  const sub = {
    subaccount: {
      address: 'dydx1test',
      subaccountNumber: 0,
      equity: '1500.25',
      freeCollateral: '1200.5',
      openPerpetualPositions: {
        'BTC-USD': {
          market: 'BTC-USD',
          status: 'OPEN',
          side: 'SHORT',
          size: '-0.002',
          entryPrice: '80000',
          unrealizedPnl: '3.5',
        },
        'ETH-USD': {
          market: 'ETH-USD',
          status: 'OPEN',
          side: 'LONG',
          size: '0.5',
          entryPrice: '2330.5',
          unrealizedPnl: '-1.25',
        },
      },
    },
  }
  const orders = [
    {
      id: 'a',
      clientId: '11',
      clobPairId: '0',
      ticker: 'BTC-USD',
      side: 'SELL',
      size: '0.001',
      price: '81000',
      type: 'LIMIT',
      reduceOnly: true,
      orderFlags: '64',
      updatedAt: '2026-10-30T12:00:00.000Z',
    },
    {
      id: 'b',
      clientId: '12',
      clobPairId: '1',
      ticker: 'ETH-USD',
      side: 'BUY',
      size: '0.01',
      price: '2300',
      type: 'LIMIT',
      reduceOnly: false,
      orderFlags: '0',
    },
  ]
  const fills = {
    fills: [
      {
        id: 'f1',
        market: 'BTC-USD',
        side: 'SELL',
        price: '80000',
        size: '0.002',
        fee: '0.08',
        createdAt: '2026-10-30T11:00:00.000Z',
      },
      {
        id: 'f2',
        market: 'ETH-USD',
        side: 'BUY',
        price: '2330.5',
        size: '0.5',
        fee: '0.58',
        createdAt: '2026-10-30T11:30:00.000Z',
      },
    ],
  }
  const replies = (url: string) =>
    url.includes('/addresses/') ? sub : url.includes('/orders?') ? orders : url.includes('/fills?') ? fills : null

  it('shows a dYdX short position as short with an unsigned size, and open orders with refs that cancel', async () => {
    const { urls, ctx: live } = indexer(replies)
    expect(await dydx.account(live)).toEqual({
      kind: 'live',
      snapshot: {
        equity: '1500.25',
        available: '1200.5',
        positions: [
          {
            symbol: 'BTC-USD',
            side: 'short',
            size: '0.002',
            entry: '80000',
            unrealizedPnl: '3.5',
            liquidation: null,
            leverage: null,
          },
          {
            symbol: 'ETH-USD',
            side: 'long',
            size: '0.5',
            entry: '2330.5',
            unrealizedPnl: '-1.25',
            liquidation: null,
            leverage: null,
          },
        ],
        orders: [
          {
            ref: 'BTC-USD:11:64:0',
            symbol: 'BTC-USD',
            side: 'sell',
            kind: 'LIMIT',
            px: '81000',
            size: '0.001',
            reduceOnly: true,
            placedAt: Date.UTC(2026, 9, 30, 12),
          },
          {
            ref: 'ETH-USD:12:0:1',
            symbol: 'ETH-USD',
            side: 'buy',
            kind: 'LIMIT',
            px: '2300',
            size: '0.01',
            reduceOnly: false,
            placedAt: 0,
          },
        ],
        fills: [
          {
            id: 'f1',
            symbol: 'BTC-USD',
            side: 'sell',
            px: '80000',
            size: '0.002',
            fee: '0.08',
            time: Date.UTC(2026, 9, 30, 11),
          },
          {
            id: 'f2',
            symbol: 'ETH-USD',
            side: 'buy',
            px: '2330.5',
            size: '0.5',
            fee: '0.58',
            time: Date.UTC(2026, 9, 30, 11, 30),
          },
        ],
      },
    })
    expect(urls).toEqual([
      'https://indexer.v4testnet.dydx.exchange/v4/addresses/dydx1test/subaccountNumber/0',
      'https://indexer.v4testnet.dydx.exchange/v4/orders?address=dydx1test&subaccountNumber=0&status=OPEN,BEST_EFFORT_OPENED,UNTRIGGERED&limit=50',
      'https://indexer.v4testnet.dydx.exchange/v4/fills?address=dydx1test&subaccountNumber=0&limit=20',
    ])
  })

  it('calls an address the indexer has no subaccount for empty, a failed read unreachable, and no key unknown', async () => {
    // Recorded from indexer.v4testnet.dydx.exchange on 2026-10-31.
    const missing = {
      errors: [{ msg: 'No subaccount found with address dydx1test and subaccountNumber 0' }],
    }
    const { ctx: none } = indexer(() => new Response(JSON.stringify(missing), { status: 404 }))
    expect(await dydx.account(none)).toEqual({ kind: 'empty' })
    const { ctx: down } = indexer(() => new Response('Bad Gateway', { status: 502 }))
    expect(await failure(dydx.account(down))).toMatchObject({ kind: 'unreachable' })
    const { urls, ctx: open } = indexer(replies)
    expect(await dydx.account({ ...open, keys: locked.keys })).toEqual({ kind: 'unknown' })
    expect(urls).toEqual([])
  })
})

describe('dydx setup', () => {
  const SIGNATURE = `0x${'ab'.repeat(65)}` as const

  function tab(initial: StoredKey | null) {
    let key = initial
    const writes: StoredKey[] = []
    return {
      writes,
      read: () => key,
      write: (k: StoredKey) => {
        key = k
        writes.push(k)
      },
      clear: () => {
        key = null
      },
    }
  }

  function wallet(chainId: number) {
    let active = chainId
    const signed: Eip712[] = []
    return {
      signed,
      address: ctx.ref.owner,
      chainId: async () => active,
      switchChain: vi.fn(async (id: number) => {
        active = id
      }),
      signTypedData: async (typed: Eip712) => {
        signed.push(typed)
        return SIGNATURE
      },
    }
  }

  it('asks a tab without the dYdX key to unlock it, and a tab holding it for nothing', async () => {
    const step = (done: boolean) => [{ id: 'derive-key', label: 'Unlock your dYdX key in this tab', done }]
    expect(await dydx.steps(locked)).toEqual(step(false))
    expect(await dydx.steps(ctx)).toEqual(step(true))
  })

  it('derives the dYdX key on the Sepolia onboarding chain for a testnet account, and keeps it linked in the tab', async () => {
    const keys = tab(null)
    const signer = wallet(1)
    const steps: StepId[] = []
    await dydx.enable({ ...ctx, keys }, signer, (s) => steps.push(s))
    expect(steps).toEqual(['derive-key'])
    // ethereumChainId of the testnet in v4-web's public/configs/v1/env.json.
    expect(signer.switchChain.mock.calls).toEqual([[11_155_111]])
    expect(signer.signed.map((s) => [s.primaryType, s.domain, s.message])).toEqual([
      ['dYdX', { name: 'dYdX Chain', chainId: 11_155_111 }, { action: 'dYdX Chain Onboarding' }],
    ])
    expect(chain.deriveKey.mock.calls).toEqual([[SIGNATURE]])
    expect(keys.writes).toEqual([
      { status: 'linked', public: { address: 'dydx1derived' }, secret: `words of ${SIGNATURE}` },
    ])
  })

  it('signs nothing for a tab that already holds the dYdX key, and stays on the chain the wallet is on', async () => {
    const keys = tab({ status: 'linked', public: { address: 'dydx1test' }, secret: 'mnemonic' })
    const signer = wallet(11_155_111)
    await dydx.enable({ ...ctx, keys }, signer, () => {})
    expect(signer.signed).toEqual([])
    expect(keys.writes).toEqual([])
    const fresh = tab(null)
    await dydx.enable({ ...ctx, keys: fresh }, signer, () => {})
    expect(signer.switchChain).not.toHaveBeenCalled()
    expect(fresh.writes).toHaveLength(1)
  })
})

describe('dydx history', () => {
  it('fails a history read the indexer cannot answer instead of calling it empty', async () => {
    const down = [
      async () => new Response('Bad Gateway', { status: 502 }),
      async () => {
        throw new TypeError('Failed to fetch')
      },
    ]
    for (const fetch of down)
      expect(await failure(dydx.history({ network: 'testnet', address: 'dydx1test', fetch }))).toMatchObject({
        kind: 'unreachable',
      })
  })
})

describe('dydx account sequence', () => {
  it('signs two long-term cancels one after the other', async () => {
    const events: string[] = []
    let release = () => {}
    chain.cancelOrder.mockImplementationOnce(async () => {
      events.push('first signs')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      events.push('first done')
      return { code: 0, hash: 'A1' }
    })
    chain.cancelOrder.mockImplementationOnce(async () => {
      events.push('second signs')
      return { code: 0, hash: 'A2' }
    })
    const first = dydx.execute(ctx, { kind: 'cancel', order: 'BTC-USD:7:64:0' as OrderRef })
    const second = dydx.execute(ctx, { kind: 'cancel', order: 'BTC-USD:8:64:0' as OrderRef })
    await vi.waitFor(() => expect(events).toEqual(['first signs']))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).toEqual(['first signs'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['first signs', 'first done', 'second signs'])
  })
})
