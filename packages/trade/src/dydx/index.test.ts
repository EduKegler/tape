import { describe, expect, it, vi } from 'vitest'
import type { Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { buildIntent } from '../intent'
import { TradeFailure } from '../types'
import type { Bps, OrderRef, VenueContext } from '../types'
import { dydx } from '.'

const chain = vi.hoisted((): { reply: unknown } => ({ reply: undefined }))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sdk: async () => ({ SubaccountInfo: { forLocalWallet: () => ({}) }, SHORT_BLOCK_FORWARD: 20 }),
  walletOf: async () => ({ address: 'dydx1test' }),
  validatorOf: async () => ({
    get: { latestBlockHeight: async () => 1 },
    post: { placeOrder: async () => chain.reply, cancelOrder: async () => chain.reply },
  }),
}))

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
const built = buildIntent(
  btc,
  {
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
  },
  dydx.capabilities,
)
if (!built.ok) throw new Error('intent')
const place = { kind: 'place', intent: built.intent } as const

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
})
