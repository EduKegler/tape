import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePx } from '@tape/core/fixed'
import type { Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { recordedWrite } from '../fixtures'
import { buildIntent, closeIntent, closeTif, newClientId } from '../intent'
import type { IntentDraft } from '../intent'
import { TradeFailure, sentOrders, toDecimal } from '../types'
import type { Bps, Command, Eip712, ExitEdit, OrderIntent, OrderRef, StepId, StoredKey, VenueContext } from '../types'
import { clientIdOf } from './wire'
import { dydx } from '.'

const sentOf = (intent: OrderIntent) => sentOrders({ kind: 'place', intent })!

const chain = vi.hoisted(() => {
  const state: { reply: unknown; sent: unknown[] } = { reply: undefined, sent: [] }
  const answer = async (..._args: unknown[]) => {
    if (state.reply instanceof Error) throw state.reply
    return state.reply
  }
  const deriveKey = vi.fn(async (signature: string) => ({ mnemonic: `words of ${signature}`, address: 'dydx1derived' }))
  const message =
    (typeUrl: string) =>
    async (...args: unknown[]) => ({ typeUrl, value: args })
  const send = vi.fn(async (_subaccount: unknown, messaging: () => Promise<unknown[]>) => {
    state.sent = await messaging()
    return answer()
  })
  return Object.assign(state, {
    placeOrder: vi.fn(answer),
    cancelOrder: vi.fn(answer),
    placeOrderMsg: vi.fn(message('place')),
    cancelOrderMsg: vi.fn(message('cancel')),
    send,
    deriveKey,
  })
})

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // SHORT_BLOCK_FORWARD in build/esm/src/clients/constants.js of v4-client-js 3.6.0.
  sdk: async () => ({ SubaccountInfo: { forLocalWallet: () => ({}) }, SHORT_BLOCK_FORWARD: 15 }),
  deriveKey: chain.deriveKey,
  walletOf: async () => ({ address: 'dydx1test' }),
  validatorOf: async () => ({
    get: { latestBlockHeight: async () => 1 },
    post: {
      placeOrder: chain.placeOrder,
      cancelOrder: chain.cancelOrder,
      placeOrderMsg: chain.placeOrderMsg,
      cancelOrderMsg: chain.cancelOrderMsg,
      send: chain.send,
    },
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
    mainnet: new Set(),
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
const failure = (pending: Promise<unknown>) =>
  pending.then(
    () => null,
    (error: unknown) => (error instanceof TradeFailure ? error.error : error),
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
      const error = await dydx.execute(ctx, place).catch((thrown: unknown) => thrown)
      expect(error instanceof TradeFailure && error.error.kind).toBe('unknown-outcome')
    }
  })

  it('calls a cancel reply without a hash an unknown outcome, not a done cancel', async () => {
    chain.reply = { height: 1, code: 0, rawLog: '' }
    const error = await dydx
      .execute(ctx, { kind: 'cancel', order: 'BTC-USD:7:64:0' as OrderRef })
      .catch((thrown: unknown) => thrown)
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

  it('calls a long-term cancel done when the chain already holds an uncommitted cancel for the order', async () => {
    // ErrStatefulOrderCancellationAlreadyExists, code 32 in x/clob/types/errors.go of dydxprotocol/v4-chain,
    // wrapped by x/clob/keeper/orders.go.
    chain.reply = {
      code: 32,
      log:
        'An uncommitted stateful order cancellation with this OrderId already exists and stateful order cancellation'
        + ' replacement is not supported. Existing order cancellation GoodTilBlockTime (1730000100), New order'
        + ' cancellation GoodTilBlockTime (1730000160). Existing order cancellation: ({...}). New order cancellation:'
        + ' ({...}).: Existing stateful order cancellation has higher-or-equal priority than the new one',
      hash: 'A1B2C3',
    }
    expect(await dydx.execute(ctx, { kind: 'cancel', order: 'BTC-USD:7:64:0' as OrderRef })).toEqual({
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

  it('stops waiting on a broadcast after 20 s as an unknown outcome, and lets the next long-term order sign', async () => {
    vi.useFakeTimers()
    try {
      chain.placeOrder.mockImplementationOnce(() => new Promise(() => {}))
      const hung = failure(dydx.execute(ctx, place))
      await vi.advanceTimersByTimeAsync(20_000)
      expect(await hung).toEqual({ kind: 'unknown-outcome', detail: 'No reply from the dYdX chain after 20 s' })
      chain.reply = { height: 1, hash: 'A1B2C3', code: 0, rawLog: '' }
      expect(await dydx.execute(ctx, place)).toEqual({ kind: 'placed', status: 'resting', detail: 'Broadcast A1B2C3' })
    } finally {
      vi.useRealTimers()
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
    expect(await failure(dydx.lookup(locked, sentOf(place.intent)))).toMatchObject({ kind: 'needs-setup' })
    expect(chain.placeOrder).not.toHaveBeenCalled()

    const at = (status: number, body: unknown) => indexer(() => new Response(JSON.stringify(body), { status })).ctx
    expect(await dydx.lookup(at(404, {}), sentOf(place.intent))).toEqual({
      kind: 'absent',
      detail: 'The dYdX indexer has no account for this address',
    })
    expect(await dydx.lookup(at(200, [{ clientId: '1', status: 'OPEN' }]), sentOf(place.intent))).toMatchObject({
      kind: 'absent',
    })
    const never = recordedWrite('dydx', 'lookupUnknown').exchanges[0]!
    expect(await dydx.lookup(at(never.status, never.response), sentOf(place.intent))).toMatchObject({ kind: 'absent' })
    expect(await failure(dydx.lookup(at(502, 'Bad Gateway'), sentOf(place.intent)))).toMatchObject({
      kind: 'unreachable',
    })
  })

  it('asks the dYdX testnet indexer about a testnet order', async () => {
    const { urls, ctx: testnet } = indexer(() => [])
    await dydx.lookup(testnet, sentOf(place.intent))
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

describe('dydx closes', () => {
  const long = {
    symbol: 'BTC-USD',
    side: 'long',
    size: toDecimal('0.002'),
    entry: toDecimal('79000'),
    mark: null,
    unrealizedPnl: toDecimal('2'),
    liquidation: null,
    leverage: null,
  } as const

  it('sends a limit close as a reduce-only short-term IOC, and refuses a close resting at the mid before any read', async () => {
    chain.reply = { code: 0, hash: 'A1' }
    const limit = closeIntent(
      btc,
      long,
      { kind: 'limit', px: 80_500 as Px, tif: closeTif(dydx.capabilities) },
      10 as Qty,
    )!
    expect(await dydx.execute(ctx, { kind: 'place', intent: limit })).toMatchObject({ status: 'accepted' })
    expect(wire(chain.placeOrder.mock.calls[0])).toMatchObject({ side: 2, tif: 1, flags: 0, quantums: '10000000' })
    expect(chain.placeOrder.mock.calls[0]?.[8]).toBe(true)

    const { urls, ctx: watched } = indexer(() => markets)
    expect(
      await failure(dydx.execute(watched, { kind: 'place', intent: closeIntent(btc, long, { kind: 'mid' })! })),
    ).toEqual({
      kind: 'invalid-order',
      detail: 'dYdX takes a reduce-only order only as IOC',
    })
    expect(urls.some((url) => url.includes('/orderbooks/'))).toBe(false)
  })

  // A touch of 80000 and 80201 has its mid at 80100.5, between the market's 1 USD ticks.
  it('rests an order at the mid as a long-term order on the tick on the passive side', async () => {
    chain.reply = { code: 0, hash: 'A1' }
    const { ctx: booked } = indexer((url) =>
      url.includes('/orderbooks/') ? { bids: [{ price: '80000' }], asks: [{ price: '80201' }] } : markets,
    )
    const opening = { ...intentOf(btc), order: { kind: 'mid' } } as const
    for (const side of ['buy', 'sell'] as const)
      expect(await dydx.execute(booked, { kind: 'place', intent: { ...opening, side } })).toMatchObject({
        status: 'resting',
      })
    expect(chain.placeOrder.mock.calls.map(wire)).toEqual([
      expect.objectContaining({ side: 1, subticks: '8010000000', tif: 0, flags: 64 }),
      expect.objectContaining({ side: 2, subticks: '8010100000', tif: 0, flags: 64 }),
    ])
  })
})

describe('dydx contract', () => {
  it('refuses a stop loss on a dYdX ticket, since place sends no trigger orders', () => {
    expect(buildIntent(btc, { ...draft, stopLoss: '79000' }, dydx.capabilities)).toMatchObject({
      ok: false,
      errors: { stopLoss: 'Not offered on this venue' },
    })
    expect(buildIntent(btc, { ...draft, tif: 'ioc' }, dydx.capabilities).ok).toBe(true)
    expect(buildIntent(btc, { ...draft, tif: 'post-only' }, dydx.capabilities).ok).toBe(true)
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

  // MsgPlaceOrder.ValidateBasic in v4-chain refuses reduce-only on anything but a short-term IOC with code 9003.
  it('refuses a resting reduce-only limit before signing, and sends a reduce-only IOC', async () => {
    chain.reply = { code: 0, hash: 'A1' }
    const resting = { ...dydx.capabilities, restingReduceOnly: true }
    for (const tif of ['gtc', 'post-only'] as const) {
      const built = buildIntent(btc, { ...draft, tif, reduceOnly: true }, resting)
      if (!built.ok) throw new Error('intent')
      expect(await failure(dydx.execute(ctx, { kind: 'place', intent: built.intent }))).toEqual({
        kind: 'invalid-order',
        detail: 'dYdX takes a reduce-only order only as IOC',
      })
    }
    expect(chain.placeOrder).not.toHaveBeenCalled()
    await dydx.execute(ctx, { kind: 'place', intent: intentOf(btc, { tif: 'ioc', reduceOnly: true }) })
    expect(chain.placeOrder.mock.calls[0]?.[8]).toBe(true)
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
    expect(await dydx.execute(open, { kind: 'cancel-all', symbol: 'BTC-USD' })).toMatchObject({
      kind: 'canceled',
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

describe('dydx order edits', () => {
  const resting = 'BTC-USD:11:64:0' as OrderRef

  it('cancels the old order and places the new one in one transaction, cancel first', async () => {
    chain.reply = { height: 1, hash: 'E1', code: 0, rawLog: '' }
    const intent = intentOf(btc, { price: '79000', size: '0.002' })
    expect(await dydx.execute(ctx, { kind: 'modify', order: resting, intent })).toEqual({
      kind: 'placed',
      status: 'resting',
      detail: 'Broadcast E1',
    })
    expect(chain.send).toHaveBeenCalledTimes(1)
    expect(chain.sent.map((sent) => (sent as { typeUrl: string }).typeUrl)).toEqual(['cancel', 'place'])
    expect(chain.cancelOrderMsg.mock.calls[0]?.slice(0, 6)).toEqual(['dydx1test', 0, 11, 64, 0, 0])
    const placed = chain.placeOrderMsg.mock.calls[0]!
    expect([placed[2], placed[4], String(placed[5]), String(placed[6]), placed[7], placed[8]]).toEqual([
      clientIdOf(intent.clientId),
      1,
      '20000000',
      '7900000000',
      0,
      64,
    ])
    expect(chain.placeOrder).not.toHaveBeenCalled()
    expect(chain.cancelOrder).not.toHaveBeenCalled()
  })

  it('reports a refused transaction as refused, so the old order still stands', async () => {
    // ErrStatefulOrderDoesNotExist, code 3006 in x/clob/types/errors.go of dydxprotocol/v4-chain.
    chain.reply = { height: 1, hash: 'E2', code: 3006, log: 'Stateful order does not exist' }
    expect(
      await failure(dydx.execute(ctx, { kind: 'modify', order: resting, intent: intentOf(btc, { price: '79000' }) })),
    ).toEqual({ kind: 'rejected', detail: 'Stateful order does not exist' })
  })

  it('edits only a resting limit, before signing anything', async () => {
    const edits = [
      { kind: 'modify', order: 'BTC-USD:12:0:0' as OrderRef, intent: intentOf(btc) },
      { kind: 'modify', order: resting, intent: intentOf(btc, { tif: 'ioc' }) },
      { kind: 'modify', order: resting, intent: intentOf(btc, { kind: 'market' }) },
    ] as const
    for (const edit of edits) expect(await failure(dydx.execute(ctx, edit))).toMatchObject({ kind: 'invalid-order' })
    expect(chain.send).not.toHaveBeenCalled()
  })
})

describe('dydx position take profit and stop loss', () => {
  const protect = (takeProfit: ExitEdit, stopLoss: ExitEdit): Command => ({
    kind: 'protect',
    intent: { spec: btc, position: 'long', size: 20 as Qty, takeProfit, stopLoss },
  })
  const set = (trigger: string, legs: OrderRef[] = []): ExitEdit => ({
    kind: 'set',
    px: parsePx(trigger, btc.scale),
    clientId: newClientId(),
    legs,
  })
  const placed = (call: unknown[] | undefined) => ({
    side: call?.[4],
    quantums: String(call?.[5]),
    subticks: String(call?.[6]),
    tif: call?.[7],
    flags: call?.[8],
    reduceOnly: call?.[9],
    clientMetadata: call?.[12],
    conditionType: call?.[13],
    triggerSubticks: String(call?.[14]),
  })
  const typesSent = () => chain.sent.map((sent) => (sent as { typeUrl: string }).typeUrl)

  // A conditional market order as v4-client-js builds one: flags 32, IOC, clientMetadata 1, condition type
  // 2 for a take profit and 1 for a stop loss, the trigger in subticks. v4-web bounds a BTC-USD one 5% past
  // the trigger: 95000 less 5% is 90250, and 70000 less 5% is 66500. BTC-USD has 1e5 subticks per dollar
  // and 1e10 quantums per BTC.
  it('places each leg as a reduce-only conditional market order for the position size, in one transaction', async () => {
    chain.reply = { height: 1, hash: 'P1', code: 0, rawLog: '' }
    expect(await dydx.execute(ctx, protect(set('95000'), set('70000')))).toEqual({
      kind: 'done',
      detail: 'Take profit at 95,000, stop loss at 70,000. Broadcast P1',
    })
    expect(chain.send).toHaveBeenCalledTimes(1)
    expect(typesSent()).toEqual(['place', 'place'])
    const leg = { side: 2, quantums: '20000000', tif: 1, flags: 32, reduceOnly: true, clientMetadata: 1 }
    expect(chain.placeOrderMsg.mock.calls.map(placed)).toEqual([
      { ...leg, subticks: '9025000000', conditionType: 2, triggerSubticks: '9500000000' },
      { ...leg, subticks: '6650000000', conditionType: 1, triggerSubticks: '7000000000' },
    ])
  })

  it('cancels the legs it replaces or removes in the same transaction, before the new leg', async () => {
    chain.reply = { height: 1, hash: 'P2', code: 0, rawLog: '' }
    const replaced = set('96000', ['BTC-USD:21:32:0' as OrderRef])
    expect(
      await dydx.execute(ctx, protect(replaced, { kind: 'remove', legs: ['BTC-USD:22:32:0' as OrderRef] })),
    ).toMatchObject({ kind: 'done', detail: 'Take profit at 96,000, stop loss removed. Broadcast P2' })
    expect(typesSent()).toEqual(['cancel', 'cancel', 'place'])
    expect(chain.cancelOrderMsg.mock.calls.map((call) => call.slice(2, 6))).toEqual([
      [21, 32, 0, 0],
      [22, 32, 0, 0],
    ])
  })

  it('reports a refused transaction as refused, so the legs there still stand', async () => {
    // ErrStatefulOrderDoesNotExist, code 3006 in x/clob/types/errors.go of dydxprotocol/v4-chain.
    chain.reply = { height: 1, hash: 'P3', code: 3006, log: 'Stateful order does not exist' }
    expect(
      await failure(dydx.execute(ctx, protect(set('96000', ['BTC-USD:21:32:0' as OrderRef]), { kind: 'keep' }))),
    ).toEqual({ kind: 'rejected', detail: 'Stateful order does not exist' })
  })

  it('sends nothing when both kinds stay as they are', async () => {
    expect(await dydx.execute(ctx, protect({ kind: 'keep' }, { kind: 'keep' }))).toEqual({
      kind: 'done',
      detail: 'Nothing to change',
    })
    expect(chain.send).not.toHaveBeenCalled()
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
            mark: null,
            unrealizedPnl: '3.5',
            liquidation: null,
            leverage: null,
          },
          {
            symbol: 'ETH-USD',
            side: 'long',
            size: '0.5',
            entry: '2330.5',
            mark: null,
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
            cancelable: true,
            exit: null,
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
            cancelable: true,
            exit: null,
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

  // docs.dydx.xyz/types/order_response_object: a conditional keeps its trigger in triggerPrice. The v4-chain
  // indexer writes condition type 2 as TAKE_PROFIT and 1 as STOP_LIMIT, with clientMetadata 1 when at market.
  it('reads a reduce-only conditional as a take profit or stop loss at its trigger, and a stop that opens as none', async () => {
    const conditional = (clientId: string, type: string, reduceOnly: boolean, triggerPrice: string) => ({
      clientMetadata: '1',
      clientId,
      clobPairId: '0',
      ticker: 'BTC-USD',
      side: 'BUY',
      size: '0.002',
      price: '84000',
      type,
      reduceOnly,
      orderFlags: '32',
      triggerPrice,
    })
    const { ctx: live } = indexer((url) =>
      url.includes('/orders?')
        ? [
            conditional('21', 'TAKE_PROFIT', true, '76000'),
            conditional('22', 'STOP_LIMIT', true, '83000'),
            conditional('23', 'STOP_LIMIT', false, '83500'),
          ]
        : replies(url),
    )
    const view = await dydx.account(live)
    if (view.kind !== 'live') throw new Error(view.kind)
    expect(view.snapshot.orders.map((order) => [order.ref, order.px, order.exit])).toEqual([
      ['BTC-USD:21:32:0', '76000', { kind: 'tp', whole: false }],
      ['BTC-USD:22:32:0', '83000', { kind: 'sl', whole: false }],
      ['BTC-USD:23:32:0', '83500', null],
    ])
  })

  it('calls an address the indexer has no subaccount for empty, a failed read unreachable, and no key unknown', async () => {
    const missing = recordedWrite('dydx', 'unknownAddress').exchanges[0]!
    const { ctx: none } = indexer(() => new Response(JSON.stringify(missing.response), { status: missing.status }))
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
      write: (next: StoredKey) => {
        key = next
        writes.push(next)
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
    await dydx.enable({ ...ctx, keys }, signer, (step) => steps.push(step))
    expect(steps).toEqual(['derive-key'])
    // ethereumChainId of the testnet in v4-web's public/configs/v1/env.json.
    expect(signer.switchChain.mock.calls).toEqual([[11_155_111]])
    expect(signer.signed.map((request) => [request.primaryType, request.domain, request.message])).toEqual([
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
