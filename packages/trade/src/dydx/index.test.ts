import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { buildIntent } from '../intent'
import type { IntentDraft } from '../intent'
import { TradeFailure } from '../types'
import type { Bps, OrderRef, VenueContext } from '../types'
import { dydx } from '.'

const chain = vi.hoisted(() => {
  const state: { reply: unknown } = { reply: undefined }
  const answer = async () => {
    if (state.reply instanceof Error) throw state.reply
    return state.reply
  }
  return Object.assign(state, { placeOrder: vi.fn(answer), cancelOrder: vi.fn(answer) })
})

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // SHORT_BLOCK_FORWARD in build/esm/src/clients/constants.js of v4-client-js 3.6.0.
  sdk: async () => ({ SubaccountInfo: { forLocalWallet: () => ({}) }, SHORT_BLOCK_FORWARD: 15 }),
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
  key: marketKey('dydx', 'BTC'),
  venue: 'dydx',
  base: 'BTC',
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
  takeProfit: '',
  stopLoss: '',
  slippage: 100 as Bps,
  bid: '',
  ask: '',
  start: '',
  end: '',
  count: '',
  skew: '1',
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
})
