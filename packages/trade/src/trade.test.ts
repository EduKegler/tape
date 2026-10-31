import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { decode, encode } from '@msgpack/msgpack'
import { bech32 } from '@scure/base'
import { hashTypedData, recoverAddress, ripemd160, sha256 } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import type { Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { deriveKey, onboarding, walletOf } from './dydx/client'
import { classifyMessage as dydxMessage } from './dydx'
import { actionHash, l1TypedData } from './hyperliquid/sign'
import { typedDataDigest } from './typed-data'
import { claim, release } from './in-flight'
import { buildIntent, closeIntent, splitSize } from './intent'
import type { IntentDraft, TakeProfitDraft } from './intent'
import type { Bps, KeySlot, OrderRef, StoredKey, TradeConfig, VenueContext } from './types'
import { TradeFailure } from './types'
import { domainTypes, walletJson } from './wallet'
import { TRADING } from './index'

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
const caps = TRADING.hyperliquid.capabilities
const draft = {
  side: 'buy',
  kind: 'limit',
  price: '80000',
  size: '0.001',
  tif: 'gtc',
  reduceOnly: false,
  takeProfits: [] as readonly TakeProfitDraft[],
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
} as const

const tp = (price: string, share = '100'): TakeProfitDraft => ({ price, share })

const trailing = {
  ...draft,
  kind: 'trailing',
  side: 'sell',
  price: '',
  reduceOnly: true,
  bid: '79990',
  ask: '80010',
  retracement: '1.5',
} as const

const config: TradeConfig = {
  mainnet: false,
  hyperliquid: { builder: null },
  dydx: { builder: null },
  orderly: { brokerId: { mainnet: null, testnet: 'demo' } },
}

function memorySlot(initial: StoredKey | null = null): KeySlot {
  let key = initial
  return { read: () => key, write: (k) => void (key = k), clear: () => void (key = null) }
}

function venue(answer: (url: string, body: Record<string, unknown>) => unknown) {
  const sent: { url: string; body: Record<string, unknown> }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {}
    sent.push({ url, body })
    return new Response(JSON.stringify(answer(url, body)))
  }) as typeof globalThis.fetch
  return { fetch, sent }
}

describe('order intent', () => {
  it('builds a limit intent and refuses take profit on the wrong side', () => {
    const ok = buildIntent(btc, draft, caps)
    expect(ok.ok && ok.intent.order).toEqual({ kind: 'limit', px: 800_000, tif: 'gtc' })
    const bad = buildIntent(btc, { ...draft, takeProfits: [tp('79000')] }, caps)
    expect(!bad.ok && bad.errors.takeProfit1).toBe('Must be above the price')
  })

  it('checks take profit and stop loss on a market order against the touch it will take', () => {
    const market = { ...draft, kind: 'market', price: '', bid: '79990', ask: '80010' } as const
    const ok = buildIntent(btc, { ...market, takeProfits: [tp('82000')], stopLoss: '78000' }, caps)
    expect(ok.ok && ok.intent.triggers).toEqual({ takeProfits: [{ px: 820_000, size: 100 }], stopLoss: 780_000 })
    const wrong = buildIntent(btc, { ...market, takeProfits: [tp('80000')], stopLoss: '79995' }, caps)
    expect(!wrong.ok && wrong.errors).toEqual({
      takeProfit1: 'Must be above the ask',
      stopLoss: 'Must be below the bid',
    })
    const sell = buildIntent(btc, { ...market, side: 'sell', takeProfits: [tp('80000')], stopLoss: '80005' }, caps)
    expect(!sell.ok && sell.errors).toEqual({ takeProfit1: 'Must be below the bid', stopLoss: 'Must be above the ask' })
    const blind = buildIntent(btc, { ...market, bid: '', ask: '', takeProfits: [tp('82000')] }, caps)
    expect(!blind.ok && blind.errors.takeProfit1).toBe('No price on the book yet')
  })

  it('splits the size across take profits by whole percent, floored to the step with the rest on the last', () => {
    // 0.001 BTC is 100 steps of 0.00001, so 40, 30 and 30 percent are 40, 30 and 30 steps.
    const three = [tp('82000', '40'), tp('84000', '30'), tp('86000', '30')]
    const built = buildIntent(btc, { ...draft, takeProfits: three }, caps)
    expect(built.ok && built.intent.triggers.takeProfits).toEqual([
      { px: 820_000, size: 40 },
      { px: 840_000, size: 30 },
      { px: 860_000, size: 30 },
    ])
    // 0.00007 BTC is 7 steps: 40% is 2.8 and 30% is 2.1, floored to 2 and 2, so the last takes 3.
    expect(splitSize(btc, 7 as Qty, [40, 30, 30])).toEqual([2, 2, 3])
    expect(splitSize({ ...btc, step: 10 as Qty }, 70 as Qty, [50, 50])).toEqual([30, 40])
  })

  it('keeps every split on the step and sums it to the size', () => {
    const split = fc
      .record({ step: fc.integer({ min: 1, max: 1000 }), steps: fc.integer({ min: 1, max: 1_000_000 }) })
      .chain(({ step, steps }) =>
        fc
          .array(fc.integer({ min: 1, max: 97 }), { minLength: 1, maxLength: 3 })
          .filter((head) => head.reduce((a, b) => a + b, 0) < 100)
          .map((head) => ({ step, steps, shares: [...head, 100 - head.reduce((a, b) => a + b, 0)] })),
      )
    fc.assert(
      fc.property(split, ({ step, steps, shares }) => {
        const size = step * steps
        const parts = splitSize({ ...btc, step: step as Qty }, size as Qty, shares)
        expect(parts.reduce((a, b) => a + b, 0)).toBe(size)
        for (const part of parts) expect(part % step).toBe(0)
        parts.slice(0, -1).forEach((part, i) => {
          const exact = (size * shares[i]!) / 100
          expect(part).toBeLessThanOrEqual(exact)
          expect(part).toBeGreaterThan(exact - step)
        })
      }),
    )
  })

  it('refuses take profit sizes that miss the order size and names the size left over', () => {
    const errors = (takeProfits: readonly TakeProfitDraft[], size = '0.001') => {
      const built = buildIntent(btc, { ...draft, size, takeProfits }, caps)
      return built.ok ? {} : built.errors
    }
    expect(errors([tp('82000', '40'), tp('84000', '30'), tp('86000', '20')])).toEqual({
      takeProfits: 'Sizes add up to 90%, so 0.00010 BTC has no take profit',
    })
    expect(errors([tp('82000', '60'), tp('84000', '60')])).toEqual({ takeProfits: 'Sizes add up to 120%, not 100%' })
    expect(errors([tp('82000', '50'), tp('84000', '49')], '0.00015')).toEqual({
      takeProfits: 'Sizes add up to 99%, not 100%',
    })
    expect(errors([tp('82000', '0'), tp('84000', '100')])).toEqual({ takeProfit1: 'From 1 to 100%' })
    expect(errors([tp('82000', '50'), tp('84000', '50')], '0.00001')).toEqual({
      takeProfit1: 'Size rounds below 0.00001',
    })
  })

  it('names the take profit on the wrong side of the touch', () => {
    const market = { ...draft, kind: 'market', price: '', bid: '79990', ask: '80010' } as const
    const takeProfits = [tp('82000', '50'), tp('80000', '25'), tp('83000', '25')]
    const built = buildIntent(btc, { ...market, takeProfits }, caps)
    expect(!built.ok && built.errors).toEqual({ takeProfit2: 'Must be above the ask' })
  })

  it('takes up to four take profits on Hyperliquid and none on Orderly or dYdX', () => {
    const errors = (takeProfits: readonly TakeProfitDraft[], c = caps) => {
      const built = buildIntent(btc, { ...draft, takeProfits }, c)
      return built.ok ? {} : built.errors
    }
    const quarter = (price: string) => tp(price, '25')
    expect(errors(['81000', '82000', '83000', '84000'].map(quarter))).toEqual({})
    expect(errors(['81000', '82000', '83000', '84000', '85000'].map((p) => tp(p, '20')))).toEqual({
      takeProfits: 'At most 4 on this venue',
    })
    for (const other of [TRADING.orderly, TRADING.dydx]) {
      expect(errors([tp('82000')], other.capabilities)).toEqual({ takeProfits: 'Not offered on this venue' })
      expect(errors([tp('82000', '50'), tp('84000', '50')], other.capabilities)).toEqual({
        takeProfits: 'Not offered on this venue',
      })
    }
  })

  it('builds a trailing stop by percent or by price, armed at once or at a price', () => {
    const order = (overrides: Partial<IntentDraft>) => {
      const built = buildIntent(btc, { ...trailing, ...overrides }, caps)
      return built.ok ? built.intent.order : built.errors
    }
    expect(order({})).toEqual({ kind: 'trailing', retracement: { pct: 150 }, activation: null })
    expect(order({ retracement: '0.01' })).toEqual({ kind: 'trailing', retracement: { pct: 1 }, activation: null })
    expect(order({ retracementUnit: 'px', retracement: '800', activation: '82000' })).toEqual({
      kind: 'trailing',
      retracement: { px: 8000 },
      activation: 820000,
    })
  })

  it('refuses a retracement of 0 or 100% and more than 2 decimals, and any take profit or stop loss with it', () => {
    const errors = (overrides: Partial<IntentDraft>) => {
      const built = buildIntent(btc, { ...trailing, ...overrides }, caps)
      return built.ok ? {} : built.errors
    }
    expect(errors({ retracement: '0' })).toEqual({ retracement: 'Above 0 and below 100%' })
    expect(errors({ retracement: '100' })).toEqual({ retracement: 'Above 0 and below 100%' })
    expect(errors({ retracement: '1.234' })).toEqual({ retracement: 'At most 2 decimals' })
    expect(errors({ retracement: '' })).toEqual({ retracement: 'Enter a percent' })
    expect(errors({ retracementUnit: 'px', retracement: '0' })).toEqual({ retracement: 'Price must be above zero' })
    expect(errors({ activation: '82000.55' })).toEqual({ activation: 'At most 1 decimals' })
    expect(errors({ takeProfits: [tp('70000')], stopLoss: '85000' })).toEqual({
      takeProfits: 'Not with a trailing stop',
      stopLoss: 'Not with a trailing stop',
    })
  })

  it('offers a trailing stop on Hyperliquid and not on Orderly or dYdX', () => {
    expect(buildIntent(btc, trailing, caps).ok).toBe(true)
    for (const other of [TRADING.orderly, TRADING.dydx])
      expect(buildIntent(btc, trailing, other.capabilities)).toEqual({
        ok: false,
        errors: { retracement: 'Not offered on this venue' },
      })
  })

  it('keeps the stop of a limit that crosses the book below the bid it will fill near', () => {
    const crossing = { ...draft, price: '80100', bid: '79990', ask: '80010' } as const
    const built = buildIntent(btc, { ...crossing, stopLoss: '80000' }, caps)
    expect(!built.ok && built.errors.stopLoss).toBe('Must be below the bid')
    expect(buildIntent(btc, { ...crossing, stopLoss: '79900' }, caps).ok).toBe(true)
  })

  it('refuses an order worth less than the venue minimum, unless it only reduces', () => {
    const ten = { ...btc, minNotional: 100 as Px }
    const small = { ...draft, size: '0.0001' } as const
    expect(buildIntent(ten, small, caps)).toEqual({ ok: false, errors: { size: 'Must be worth at least 10.0 USDC' } })
    expect(buildIntent(ten, { ...small, size: '0.00013' }, caps).ok).toBe(true)
    expect(buildIntent(ten, { ...small, reduceOnly: true }, caps).ok).toBe(true)
    const market = { ...small, kind: 'market', price: '', bid: '79990', ask: '125000' } as const
    expect(buildIntent(ten, market, caps).ok).toBe(true)
    expect(buildIntent(ten, { ...market, side: 'sell' }, caps).ok).toBe(false)
  })

  it('builds a scale order whose legs sum to the size, the first under the intent client id', () => {
    const scale = {
      ...draft,
      kind: 'scale',
      price: '',
      size: '0.01',
      start: '80000',
      end: '79000',
      count: '5',
    } as const
    const built = buildIntent(btc, scale, caps)
    if (!built.ok) throw new Error(JSON.stringify(built.errors))
    if (built.intent.order.kind !== 'scale') throw new Error(built.intent.order.kind)
    const legs = built.intent.order.legs
    expect(legs.map((l) => [l.px, l.size])).toEqual([
      [800_000, 200],
      [797_500, 200],
      [795_000, 200],
      [792_500, 200],
      [790_000, 200],
    ])
    expect(legs[0]?.clientId).toBe(built.intent.clientId)
    expect(new Set(legs.map((l) => l.clientId)).size).toBe(5)
  })

  it('refuses a scale order the venue cannot send or the legs cannot carry', () => {
    const scale = {
      ...draft,
      kind: 'scale',
      price: '',
      size: '0.01',
      start: '80000',
      end: '79000',
      count: '5',
    } as const
    const errors = (d: Parameters<typeof buildIntent>[1], c = caps, spec = btc) => {
      const built = buildIntent(spec, d, c)
      return built.ok ? {} : built.errors
    }
    expect(errors(scale, TRADING.dydx.capabilities)).toEqual({ count: 'Not offered on this venue' })
    expect(errors({ ...scale, count: '21' })).toEqual({ count: 'From 2 to 20 orders' })
    expect(errors({ ...scale, count: '1', skew: '0' })).toEqual({
      count: 'From 2 to 20 orders',
      skew: 'Between 0.1 and 10',
    })
    expect(errors({ ...scale, end: '79999' })).toEqual({ count: 'The range is too narrow for 5 orders' })
    expect(errors({ ...scale, tif: 'ioc', takeProfits: [tp('90000')] })).toEqual({
      tif: 'Not with a scale order',
      takeProfits: 'Not with a scale order',
    })
    expect(errors({ ...scale, size: '0.0005' }, caps, { ...btc, minNotional: 100 as Px })).toEqual({
      size: 'Each order must be worth at least 10.0 USDC',
    })
  })

  it('gives every build a fresh client id', () => {
    const a = buildIntent(btc, draft, caps)
    const b = buildIntent(btc, draft, caps)
    expect(a.ok && b.ok && a.intent.clientId !== b.intent.clientId).toBe(true)
  })

  it('closes a short with a reduce-only market buy of the whole size', () => {
    const intent = closeIntent(
      btc,
      {
        symbol: 'BTC',
        side: 'short',
        size: '0.0123' as never,
        entry: '1' as never,
        unrealizedPnl: '0' as never,
        liquidation: null,
        leverage: null,
      },
      100 as Bps,
    )
    expect(
      intent && { side: intent.side, size: intent.size, reduceOnly: intent.reduceOnly, kind: intent.order.kind },
    ).toEqual({ side: 'buy', size: 1230, reduceOnly: true, kind: 'market' })
  })
})

describe('failure classification', () => {
  it('treats a dYdX timeout as unknown and a missing chain account as no account', () => {
    expect(
      dydxMessage(
        'Transaction with hash [AB] was submitted but was not yet found on the chain. You might want to check later. Query timed out after 60 seconds.',
      ).kind,
    ).toBe('unknown-outcome')
    expect(
      dydxMessage('Query failed with (22): rpc error: code = NotFound desc = account dydx1abc not found: key not found')
        .kind,
    ).toBe('no-account')
  })

  it('calls the dYdX order rate limits rate limited, though the short-term one mentions collateral', () => {
    // x/clob/types/errors.go in dydxprotocol/v4-chain, codes 5001 and 5002.
    for (const message of [
      'Block rate limit exceeded',
      "Short-term order rate exceeded: an address's 30-day volume and collateral set its order budget",
    ])
      expect(dydxMessage(message).kind).toBe('rate-limited')
  })
})

describe('commands in flight', () => {
  const ref = { venue: 'hyperliquid', network: 'testnet', owner: '0x0000000000000000000000000000000000000001' } as const
  const built = buildIntent(btc, draft, caps)
  if (!built.ok) throw new Error('intent')
  const place = { kind: 'place', intent: built.intent } as const

  it('lets one order out per account until it settles, even from another button', () => {
    expect(claim(ref, place)).toBe(true)
    expect(claim(ref, { kind: 'place', intent: { ...built.intent, clientId: '0x02' as never } })).toBe(false)
    expect(claim({ ...ref, network: 'mainnet' }, place)).toBe(true)
    release(ref, place)
    expect(claim(ref, place)).toBe(true)
    release(ref, place)
    release({ ...ref, network: 'mainnet' }, place)
  })

  it('lets two different cancels out together but not the same cancel twice', () => {
    const a = { kind: 'cancel', order: '3:1' as never } as const
    const b = { kind: 'cancel', order: '3:2' as never } as const
    expect([claim(ref, a), claim(ref, b), claim(ref, a)]).toEqual([true, true, false])
    release(ref, a)
    release(ref, b)
  })
})

describe('dydx key', () => {
  // From v4-client-js __tests__/helpers/constants.ts: SIGNATURE_RESULT, MNEMONIC_ and PUBLIC_KEY_FROM_SIGNATURE_RESULT.
  const signature =
    '0xf2006b4fc0afa08a6048b40d3d67e437ac2e20e6bacf3f947f9b33aa2756d204287f5fb2155bec067d879a25d7ddac791826cf28e2786919065e19848020f1531b'
  const mnemonic =
    'waste sample once ocean tenant mushroom festival hollow regret convince stage able candy jazz champion isolate diary group under entry decorate glare quiz job'
  const publicKey = new Uint8Array([
    2, 204, 94, 45, 7, 83, 196, 55, 195, 107, 10, 35, 169, 32, 24, 37, 193, 196, 34, 210, 84, 26, 107, 89, 119, 240,
    211, 63, 187, 34, 162, 197, 36,
  ])
  const address = bech32.encode('dydx', bech32.toWords(ripemd160(sha256(publicKey, 'bytes'), 'bytes')))

  it('derives the mnemonic and address of the official onboarding vector', async () => {
    const key = await deriveKey(signature)
    expect(key.mnemonic).toBe(mnemonic)
    expect(key.address).toBe(address)
  }, 30_000)

  it('opens the wallet of the onboarding vector mnemonic at its dydx1 address', async () => {
    expect((await walletOf(mnemonic)).address).toBe(address)
  }, 30_000)
})

describe('wallet typed data', () => {
  it('hashes the dYdX onboarding exactly as dYdX v4-web asks the wallet to sign it', () => {
    // v4-web useSignForWalletDerivation: getSignTypedData plus the env's ethereumChainId, and an empty
    // verifyingContract for MetaMask that viem leaves out of the domain type.
    for (const [network, chainId] of [
      ['mainnet', 1],
      ['testnet', 11_155_111],
    ] as const) {
      const official = {
        primaryType: 'dYdX',
        domain: { name: 'dYdX Chain', chainId },
        types: { dYdX: [{ name: 'action', type: 'string' }] },
        message: { action: 'dYdX Chain Onboarding' },
      } as const
      const metaMask = { ...official, domain: { ...official.domain, verifyingContract: '' as never } }
      const sent = JSON.parse(walletJson(onboarding(network))) as Parameters<typeof hashTypedData>[0]
      expect(sent.types.EIP712Domain).toEqual([
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ])
      expect(hashTypedData(sent)).toBe(hashTypedData(official))
      expect(hashTypedData(sent)).toBe(hashTypedData(metaMask))
    }
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
  const testnetMeta = {
    universe: [
      { name: 'SOL', szDecimals: 2 },
      { name: 'X', szDecimals: 0 },
      { name: 'Y', szDecimals: 0 },
      { name: 'BTC', szDecimals: 5 },
    ],
  }

  it('signs the order with the agent for the testnet asset id', async () => {
    const { fetch, sent } = venue((url, body) =>
      url.endsWith('/info')
        ? body.type === 'meta'
          ? testnetMeta
          : null
        : { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 7 } }] } } },
    )
    const ctx: VenueContext = {
      ref: { venue: 'hyperliquid', network: 'testnet', owner },
      config,
      keys: memorySlot({ status: 'draft', public: { agent }, secret: agentKey }),
      fetch,
    }
    const built = buildIntent(btc, draft, caps)
    if (!built.ok) throw new Error('intent')
    const outcome = await TRADING.hyperliquid.execute(ctx, { kind: 'place', intent: built.intent })
    expect(outcome).toEqual({ kind: 'placed', status: 'resting', detail: 'Resting as order 7' })
    const post = sent.find((s) => s.url.endsWith('/exchange'))!
    const action = post.body.action as { orders: { a: number; p: string; s: string; c: string }[] }
    expect(action.orders[0]).toMatchObject({ a: 3, p: '80000', s: '0.001', c: built.intent.clientId })
    const signature = post.body.signature as { r: Hex; s: Hex; v: number }
    const digest = typedDataDigest(l1TypedData(actionHash(action, null, post.body.nonce as number, null), 'Testnet'))
    expect(
      await recoverAddress({ hash: digest, signature: { r: signature.r, s: signature.s, v: BigInt(signature.v) } }),
    ).toBe(agent)
  })

  it('sends a market order with its take profit and stop loss as one normalTpsl group', async () => {
    const book = (bid: string, ask: string) => ({ levels: [[{ px: bid }], [{ px: ask }]] })
    const answer = (bid: string, ask: string) => (url: string, body: Record<string, unknown>) =>
      url.endsWith('/info')
        ? body.type === 'meta'
          ? testnetMeta
          : book(bid, ask)
        : {
            status: 'ok',
            response: {
              type: 'order',
              data: {
                statuses: [{ filled: { totalSz: '0.001', avgPx: '80010' } }, 'waitingForFill', 'waitingForFill'],
              },
            },
          }
    const built = buildIntent(
      btc,
      {
        ...draft,
        kind: 'market',
        price: '',
        bid: '79990',
        ask: '80010',
        takeProfits: [tp('82000')],
        stopLoss: '78000',
      },
      caps,
    )
    if (!built.ok) throw new Error('intent')
    const ctx = (fetch: typeof globalThis.fetch): VenueContext => ({
      ref: { venue: 'hyperliquid', network: 'testnet', owner },
      config,
      keys: memorySlot({ status: 'draft', public: { agent }, secret: agentKey }),
      fetch,
    })
    const live = venue(answer('79990', '80010'))
    expect(await TRADING.hyperliquid.execute(ctx(live.fetch), { kind: 'place', intent: built.intent })).toMatchObject({
      status: 'filled',
    })
    const action = live.sent.find((s) => s.url.endsWith('/exchange'))!.body.action as {
      grouping: string
      orders: { b: boolean; p: string; r: boolean; t: unknown }[]
    }
    expect(action.grouping).toBe('normalTpsl')
    expect(action.orders.map((o) => [o.b, o.p, o.r, o.t])).toEqual([
      [true, '80810', false, { limit: { tif: 'Ioc' } }],
      [false, '73800', true, { trigger: { isMarket: true, triggerPx: '82000', tpsl: 'tp' } }],
      [false, '70200', true, { trigger: { isMarket: true, triggerPx: '78000', tpsl: 'sl' } }],
    ])
    const moved = venue(answer('81990', '82010'))
    const error = await TRADING.hyperliquid
      .execute(ctx(moved.fetch), { kind: 'place', intent: built.intent })
      .catch((e: unknown) => e)
    expect(error instanceof TradeFailure && error.error).toEqual({
      kind: 'invalid-order',
      detail: 'Take profit: Must be above the ask on this network',
    })
    expect(moved.sent.some((s) => s.url.endsWith('/exchange'))).toBe(false)
  })

  it('sends each take profit as its own reduce-only tp child of the size it closes, and names the one refused', async () => {
    const { fetch, sent } = venue((url, body) =>
      url.endsWith('/info')
        ? body.type === 'meta'
          ? testnetMeta
          : { levels: [[{ px: '79990' }], [{ px: '80010' }]] }
        : {
            status: 'ok',
            response: {
              type: 'order',
              data: {
                statuses: [
                  { resting: { oid: 7 } },
                  'waitingForFill',
                  { error: 'Order must have minimum value of $10.' },
                  'waitingForFill',
                  'waitingForFill',
                ],
              },
            },
          },
    )
    const built = buildIntent(
      btc,
      {
        ...draft,
        bid: '79990',
        ask: '80010',
        takeProfits: [tp('82000', '40'), tp('84000', '30'), tp('86000', '30')],
        stopLoss: '78000',
      },
      caps,
    )
    if (!built.ok) throw new Error(JSON.stringify(built.errors))
    const ctx: VenueContext = {
      ref: { venue: 'hyperliquid', network: 'testnet', owner },
      config,
      keys: memorySlot({ status: 'draft', public: { agent }, secret: agentKey }),
      fetch,
    }
    expect(await TRADING.hyperliquid.execute(ctx, { kind: 'place', intent: built.intent })).toEqual({
      kind: 'placed',
      status: 'resting',
      detail: 'Resting as order 7. TP 2 not placed: Order must have minimum value of $10.',
    })
    const action = sent.find((x) => x.url.endsWith('/exchange'))!.body.action
    // Each trigger is bounded 10% past its price, as Hyperliquid's own UI does: 82000 less 10% is 73800.
    const exit = (tpsl: 'tp' | 'sl', triggerPx: string, p: string, size: string) => ({
      a: 3,
      b: false,
      p,
      s: size,
      r: true,
      t: { trigger: { isMarket: true, triggerPx, tpsl } },
    })
    expect(action).toEqual({
      type: 'order',
      orders: [
        { a: 3, b: true, p: '80000', s: '0.001', r: false, t: { limit: { tif: 'Gtc' } }, c: built.intent.clientId },
        exit('tp', '82000', '73800', '0.0004'),
        exit('tp', '84000', '75600', '0.0003'),
        exit('tp', '86000', '77400', '0.0003'),
        exit('sl', '78000', '70200', '0.001'),
      ],
      grouping: 'normalTpsl',
    })
  })

  it('signs a trailingStop action with its keys in the order of the exchange docs, and reads the oid', async () => {
    const DOCS_ORDER = ['type', 'asset', 'isBuy', 'sz', 'reduceOnly', 'retracement', 'activationPx']
    const cases = [
      [{}, { pct: '1.5%' }, null],
      [{ retracementUnit: 'px', retracement: '800', activation: '82000' }, { px: '800' }, '82000'],
    ] as const
    for (const [overrides, retracement, activationPx] of cases) {
      const { fetch, sent } = venue((url, body) =>
        url.endsWith('/info')
          ? body.type === 'meta'
            ? testnetMeta
            : null
          : { status: 'ok', response: { type: 'trailingStop', data: { oid: 77738308 } } },
      )
      const ctx: VenueContext = {
        ref: { venue: 'hyperliquid', network: 'testnet', owner },
        config,
        keys: memorySlot({ status: 'linked', public: { agent }, secret: agentKey }),
        fetch,
      }
      const built = buildIntent(btc, { ...trailing, size: '0.001', ...overrides }, caps)
      if (!built.ok) throw new Error('intent')
      const outcome = await TRADING.hyperliquid.execute(ctx, { kind: 'place', intent: built.intent })
      expect(outcome).toEqual({ kind: 'placed', status: 'resting', detail: 'Resting as order 77738308' })
      const post = sent.find((s) => s.url.endsWith('/exchange'))!
      const action = post.body.action as Record<string, unknown>
      expect(action).toEqual({
        type: 'trailingStop',
        asset: 3,
        isBuy: false,
        sz: '0.001',
        reduceOnly: true,
        retracement,
        activationPx,
      })
      expect(Object.keys(decode(encode(action)) as object)).toEqual(DOCS_ORDER)
      const signature = post.body.signature as { r: Hex; s: Hex; v: number }
      const digest = typedDataDigest(l1TypedData(actionHash(action, null, post.body.nonce as number, null), 'Testnet'))
      expect(
        await recoverAddress({ hash: digest, signature: { r: signature.r, s: signature.s, v: BigInt(signature.v) } }),
      ).toBe(agent)
    }
  })

  it('calls a trailing stop write that times out, answers 5xx or carries no oid an unknown outcome', async () => {
    const built = buildIntent(btc, trailing, caps)
    if (!built.ok) throw new Error('intent')
    const replies = [
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
      () => Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502 })),
      () => Promise.resolve(new Response(JSON.stringify({ status: 'ok', response: { type: 'trailingStop' } }))),
    ]
    for (const exchange of replies) {
      const fetch = (async (url: string) =>
        url.endsWith('/info') ? new Response(JSON.stringify(testnetMeta)) : exchange()) as typeof globalThis.fetch
      const ctx: VenueContext = {
        ref: { venue: 'hyperliquid', network: 'testnet', owner },
        config,
        keys: memorySlot({ status: 'linked', public: { agent }, secret: agentKey }),
        fetch,
      }
      const error = await TRADING.hyperliquid
        .execute(ctx, { kind: 'place', intent: built.intent })
        .catch((e: unknown) => e)
      expect(error instanceof TradeFailure && error.error.kind).toBe('unknown-outcome')
    }
  })

  it('sends every scale leg in one action and reports the legs Hyperliquid refused', async () => {
    const { fetch, sent } = venue((url, body) =>
      url.endsWith('/info')
        ? body.type === 'meta'
          ? testnetMeta
          : null
        : {
            status: 'ok',
            response: {
              type: 'order',
              data: {
                statuses: [
                  { resting: { oid: 1 } },
                  { error: 'Post only order would have immediately matched' },
                  { resting: { oid: 3 } },
                ],
              },
            },
          },
    )
    const ctx: VenueContext = {
      ref: { venue: 'hyperliquid', network: 'testnet', owner },
      config,
      keys: memorySlot({ status: 'draft', public: { agent }, secret: agentKey }),
      fetch,
    }
    const built = buildIntent(
      btc,
      { ...draft, kind: 'scale', tif: 'post-only', size: '0.003', start: '80000', end: '79000', count: '3' },
      caps,
    )
    if (!built.ok || built.intent.order.kind !== 'scale') throw new Error('intent')
    const outcome = await TRADING.hyperliquid.execute(ctx, { kind: 'place', intent: built.intent })
    expect(outcome).toEqual({
      kind: 'placed',
      status: 'resting',
      detail:
        '2 of 3 orders placed: 2 resting, 0 filled. Order 2 not placed: Post only order would have immediately matched',
    })
    const action = sent.find((s) => s.url.endsWith('/exchange'))!.body.action as {
      grouping: string
      orders: { p: string; s: string; t: unknown; c: string }[]
    }
    expect(action.grouping).toBe('na')
    expect(action.orders.map((o) => [o.p, o.s, o.t, o.c])).toEqual(
      built.intent.order.legs.map((l, i) => [
        ['80000', '79500', '79000'][i],
        '0.001',
        { limit: { tif: 'Alo' } },
        l.clientId,
      ]),
    )
  })

  it('turns an unknown API wallet into needs-setup with the venue words', async () => {
    const { fetch } = venue((url, body) =>
      url.endsWith('/info')
        ? body.type === 'meta'
          ? testnetMeta
          : null
        : { status: 'err', response: `User or API Wallet ${agent} does not exist.` },
    )
    const ctx: VenueContext = {
      ref: { venue: 'hyperliquid', network: 'testnet', owner },
      config,
      keys: memorySlot({ status: 'draft', public: { agent }, secret: agentKey }),
      fetch,
    }
    const built = buildIntent(btc, { ...draft, price: '80001' }, caps)
    if (!built.ok) throw new Error('intent')
    const error = await TRADING.hyperliquid
      .execute(ctx, { kind: 'place', intent: built.intent })
      .catch((e: unknown) => e)
    expect(error instanceof TradeFailure && error.error).toEqual({
      kind: 'needs-setup',
      detail: `User or API Wallet ${agent} does not exist.`,
    })
  })

  it('calls a 200 it cannot read an unknown outcome, since the signed order may be placed', async () => {
    for (const reply of [{ status: 'ok' }, { status: 'ok', response: { type: 'order', data: { statuses: [] } } }]) {
      const { fetch } = venue((url, body) =>
        url.endsWith('/info') ? (body.type === 'meta' ? testnetMeta : null) : reply,
      )
      const ctx: VenueContext = {
        ref: { venue: 'hyperliquid', network: 'testnet', owner },
        config,
        keys: memorySlot({ status: 'draft', public: { agent }, secret: agentKey }),
        fetch,
      }
      const built = buildIntent(btc, draft, caps)
      if (!built.ok) throw new Error('intent')
      const error = await TRADING.hyperliquid
        .execute(ctx, { kind: 'place', intent: built.intent })
        .catch((e: unknown) => e)
      expect(error instanceof TradeFailure && error.error.kind).toBe('unknown-outcome')
    }
  })

  it('refuses a price the testnet rules reject instead of rounding it', async () => {
    const { fetch } = venue((url, body) =>
      url.endsWith('/info') && body.type === 'meta' ? { universe: [{ name: 'BTC', szDecimals: 5 }] } : null,
    )
    const ctx: VenueContext = {
      ref: { venue: 'hyperliquid', network: 'testnet', owner },
      config,
      keys: memorySlot({ status: 'draft', public: { agent }, secret: agentKey }),
      fetch,
    }
    const built = buildIntent(
      { ...btc, scale: { px: 2, qty: 5 }, tick: { kind: 'fixed', tick: 1 } as MarketSpec['tick'] },
      { ...draft, price: '80000.25' },
      caps,
    )
    if (!built.ok) throw new Error('intent')
    const error = await TRADING.hyperliquid
      .execute(ctx, { kind: 'place', intent: built.intent })
      .catch((e: unknown) => e)
    expect(error instanceof TradeFailure && error.error.kind).toBe('invalid-order')
  })

  it('reads positions, orders and fills by address in the venue shapes', async () => {
    const { fetch } = venue((_url, body) => {
      if (body.type === 'meta') return testnetMeta
      if (body.type === 'clearinghouseState')
        return {
          marginSummary: { accountValue: '1008.5' },
          withdrawable: '900.25',
          assetPositions: [
            {
              position: {
                coin: 'BTC',
                szi: '-0.01',
                entryPx: '80100.0',
                unrealizedPnl: '-1.5',
                liquidationPx: '95000.5139240506',
                leverage: { type: 'cross', value: 5 },
              },
            },
          ],
        }
      if (body.type === 'frontendOpenOrders')
        return [
          {
            coin: 'BTC',
            side: 'B',
            limitPx: '70000.0',
            sz: '0.001',
            oid: 589008353129,
            timestamp: 1793248070251,
            orderType: 'Limit',
            reduceOnly: false,
            isTrigger: false,
            triggerPx: '0.0',
          },
        ]
      if (body.type === 'userFills')
        return [
          { coin: 'BTC', px: '80100.0', sz: '0.01', side: 'A', time: 1793248071468, fee: '0.36', tid: 151386843995060 },
        ]
      return null
    })
    const view = await TRADING.hyperliquid.account({
      ref: { venue: 'hyperliquid', network: 'testnet', owner },
      config,
      keys: memorySlot(),
      fetch,
    })
    if (view.kind !== 'live') throw new Error(view.kind)
    expect(view.snapshot.positions[0]).toMatchObject({
      symbol: 'BTC',
      side: 'short',
      size: '0.01',
      leverage: '5x cross',
      liquidation: '95000.5',
    })
    expect(view.snapshot.orders[0]).toMatchObject({ ref: '3:589008353129', side: 'buy', px: '70000.0' })
    expect(view.snapshot.fills[0]).toMatchObject({ id: '151386843995060', side: 'sell' })
  })

  it('reads a unified account balance from spot, where the venue keeps it', async () => {
    const { fetch } = venue((_url, body) => {
      if (body.type === 'meta') return testnetMeta
      if (body.type === 'userAbstraction') return 'unifiedAccount'
      if (body.type === 'clearinghouseState')
        return { marginSummary: { accountValue: '0.0' }, withdrawable: '0.0', assetPositions: [] }
      if (body.type === 'spotClearinghouseState')
        return {
          balances: [{ coin: 'USDC', token: 0, total: '907.158556', hold: '2.4', entryNtl: '0.0' }],
          tokenToAvailableAfterMaintenance: [[0, '904.758556']],
        }
      if (body.type === 'frontendOpenOrders' || body.type === 'userFills') return []
      return null
    })
    const view = await TRADING.hyperliquid.account({
      ref: { venue: 'hyperliquid', network: 'testnet', owner },
      config,
      keys: memorySlot(),
      fetch,
    })
    if (view.kind !== 'live') throw new Error(view.kind)
    expect(view.snapshot).toMatchObject({ equity: '907.158556', available: '904.758556' })
  })

  it('writes the agent as draft before the wallet signs, and keeps it when the venue says deposit first', async () => {
    const { fetch } = venue((url, body) =>
      url.endsWith('/info')
        ? body.type === 'extraAgents'
          ? []
          : null
        : { status: 'err', response: `Must deposit before performing actions. User: ${owner}` },
    )
    const keys = memorySlot()
    const ctx: VenueContext = { ref: { venue: 'hyperliquid', network: 'testnet', owner }, config, keys, fetch }
    const wallet = {
      address: owner,
      chainId: async () => 421614,
      switchChain: async () => {},
      signTypedData: async () => `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as Hex,
    }
    const error = await TRADING.hyperliquid.enable(ctx, wallet, () => {}).catch((e: unknown) => e)
    expect(error instanceof TradeFailure && error.error.kind).toBe('no-account')
    expect(keys.read()).toMatchObject({ status: 'draft', public: { agent: expect.stringMatching(/^0x/) } })
  })
})

describe('orderly module', () => {
  const owner = '0x9f3c2b1a0e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b' as Address
  const perp: MarketSpec = {
    ...btc,
    key: marketKey('orderly', 'BTC'),
    venue: 'orderly',
    venueSymbol: 'PERP_BTC_USDC',
    tick: { kind: 'fixed', tick: 1 as Px },
  }

  it('sends a scale order as one signed batch in the exact decimals', async () => {
    const posts: { url: string; body: string }[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: init.body as string })
        return new Response(
          '{"success":true,"data":{"rows":[{"order_id":1,"error_message":"none"},{"order_id":null,"error_message":"Price out of range"}]}}',
        )
      }
      return new Response('{"success":true,"data":{"quote_tick":0.1,"base_tick":0.00001}}')
    }) as typeof globalThis.fetch
    const ctx: VenueContext = {
      ref: { venue: 'orderly', network: 'testnet', owner },
      config,
      keys: memorySlot({ status: 'linked', public: {}, secret: `0x${'11'.repeat(32)}` }),
      fetch,
    }
    const built = buildIntent(
      perp,
      { ...draft, kind: 'scale', size: '0.002', start: '80000.5', end: '79000', count: '2' },
      TRADING.orderly.capabilities,
    )
    if (!built.ok || built.intent.order.kind !== 'scale') throw new Error('intent')
    expect(await TRADING.orderly.execute(ctx, { kind: 'place', intent: built.intent })).toEqual({
      kind: 'placed',
      status: 'resting',
      detail: '1 of 2 orders placed. Order 2 not placed: Price out of range',
    })
    const [first, second] = built.intent.order.legs
    expect(posts).toEqual([
      {
        url: 'https://testnet-api.orderly.org/v1/batch-order',
        body: `{"orders":[{"symbol":"PERP_BTC_USDC","client_order_id":"${first?.clientId}","order_type":"LIMIT","order_price":80000.5,"order_quantity":0.001,"side":"BUY","reduce_only":false},{"symbol":"PERP_BTC_USDC","client_order_id":"${second?.clientId}","order_type":"LIMIT","order_price":79000,"order_quantity":0.001,"side":"BUY","reduce_only":false}]}`,
      },
    ])
  })

  it('calls a 200 it cannot read an unknown outcome on a write and unreachable on a read', async () => {
    const ctx = (reply: string): VenueContext => ({
      ref: { venue: 'orderly', network: 'testnet', owner },
      config,
      keys: memorySlot({ status: 'linked', public: {}, secret: `0x${'11'.repeat(32)}` }),
      fetch: (async (url: string) =>
        new Response(
          url.includes('/v1/public/info/') ? '{"success":true,"data":{"quote_tick":0.1,"base_tick":0.00001}}' : reply,
        )) as typeof globalThis.fetch,
    })
    const built = buildIntent(perp, draft, TRADING.orderly.capabilities)
    if (!built.ok) throw new Error('intent')
    const kindOf = (run: Promise<unknown>) =>
      run.then(
        () => 'settled',
        (e: unknown) => e instanceof TradeFailure && e.error.kind,
      )
    for (const reply of ['<html>502 Bad Gateway</html>', '{"success":true,"timestamp":1702989203989}']) {
      const place = TRADING.orderly.execute(ctx(reply), { kind: 'place', intent: built.intent })
      expect(await kindOf(place)).toBe('unknown-outcome')
      const cancel = TRADING.orderly.execute(ctx(reply), { kind: 'cancel', order: 'PERP_BTC_USDC:13' as OrderRef })
      expect(await kindOf(cancel)).toBe('unknown-outcome')
      expect(await kindOf(TRADING.orderly.lookup(ctx(reply), built.intent))).toBe('unreachable')
    }
  })

  it('cancels an order Orderly no longer has, by its code, but not past a key it refuses', async () => {
    const cancel = (status: number, reply: unknown) =>
      TRADING.orderly.execute(
        {
          ref: { venue: 'orderly', network: 'testnet', owner },
          config,
          keys: memorySlot({ status: 'linked', public: {}, secret: `0x${'11'.repeat(32)}` }),
          fetch: async () => new Response(JSON.stringify(reply), { status }),
        },
        { kind: 'cancel', order: 'PERP_BTC_USDC:13' as OrderRef },
      )
    expect(await cancel(200, { success: true, data: { status: 'CANCEL_SENT' }, timestamp: 1702989203989 })).toEqual({
      kind: 'done',
      detail: 'Canceled',
    })
    // Orderly's error codes page documents -1006 for cancelling a CANCELLED order and -1002 for a bad key, not
    // the messages that come with them.
    expect(await cancel(400, { success: false, code: -1006, message: 'The data is not found on the server.' })).toEqual(
      { kind: 'done', detail: 'Canceled' },
    )
    const error = await cancel(401, { success: false, code: -1002, message: 'Orderly key not found' }).catch(
      (e: unknown) => e,
    )
    expect(error instanceof TradeFailure && error.error.kind).toBe('needs-setup')
  })

  it('calls a key Orderly refuses needs-setup by its code, whatever the message says', async () => {
    const built = buildIntent(perp, draft, TRADING.orderly.capabilities)
    if (!built.ok) throw new Error('intent')
    // The descriptions Orderly's error codes page gives -1001 and -1002, both on a 401.
    for (const [code, message] of [
      [-1001, 'The API key or secret is in wrong format.'],
      [-1002, 'API key or secret is invalid. The key may have insufficient permissions, or is expired/revoked.'],
    ] as const) {
      const ctx: VenueContext = {
        ref: { venue: 'orderly', network: 'testnet', owner },
        config,
        keys: memorySlot({ status: 'linked', public: {}, secret: `0x${'11'.repeat(32)}` }),
        fetch: (async (url: string) =>
          url.includes('/v1/public/info/')
            ? new Response('{"success":true,"data":{"quote_tick":0.1,"base_tick":0.00001}}')
            : new Response(JSON.stringify({ success: false, code, message }), {
                status: 401,
              })) as typeof globalThis.fetch,
      }
      const error = await TRADING.orderly.execute(ctx, { kind: 'place', intent: built.intent }).catch((e: unknown) => e)
      expect(error instanceof TradeFailure && error.error).toEqual({ kind: 'needs-setup', detail: message })
    }
  })
})

describe('a trailing stop on a venue without one', () => {
  it('is refused by Orderly and dYdX in execute before anything is sent', async () => {
    const built = buildIntent(btc, trailing, caps)
    if (!built.ok) throw new Error('intent')
    for (const other of [TRADING.orderly, TRADING.dydx]) {
      const { fetch, sent } = venue(() => ({ success: true }))
      const ctx: VenueContext = {
        ref: { venue: other.id, network: 'testnet', owner: '0x9f3c2b1a0e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b' },
        config,
        keys: memorySlot({ status: 'linked', public: {}, secret: `0x${'11'.repeat(32)}` }),
        fetch,
      }
      await expect(other.execute(ctx, { kind: 'place', intent: built.intent })).rejects.toMatchObject({
        error: { kind: 'unsupported' },
      })
      expect(sent).toEqual([])
    }
  })
})

describe('order lookup after an unknown outcome', () => {
  const owner = '0x9f3c2b1a0e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b' as Address
  const built = buildIntent(btc, draft, caps)
  if (!built.ok) throw new Error('intent')
  const intent = built.intent

  it('asks Hyperliquid for the cloid under the owner and reads found or unknownOid', async () => {
    for (const [reply, expected] of [
      [
        { status: 'order', order: { status: 'filled' } },
        { kind: 'found', detail: 'Order filled' },
      ],
      [{ status: 'unknownOid' }, { kind: 'absent', detail: 'Hyperliquid answered unknownOid' }],
    ] as const) {
      const { fetch, sent } = venue(() => reply)
      const result = await TRADING.hyperliquid.lookup(
        { ref: { venue: 'hyperliquid', network: 'testnet', owner }, config, keys: memorySlot(), fetch },
        intent,
      )
      expect(result).toEqual(expected)
      expect(sent[0]?.body).toEqual({ type: 'orderStatus', user: owner, oid: intent.clientId })
    }
  })

  it('does not ask Hyperliquid for a trailing stop, which carries no cloid to find it by', async () => {
    const stop = buildIntent(btc, trailing, caps)
    if (!stop.ok) throw new Error('intent')
    const { fetch, sent } = venue(() => ({ status: 'unknownOid' }))
    const ctx = { ref: { venue: 'hyperliquid', network: 'testnet', owner }, config, keys: memorySlot(), fetch } as const
    await expect(TRADING.hyperliquid.lookup(ctx, stop.intent)).rejects.toMatchObject({
      error: { kind: 'unsupported' },
    })
    expect(sent).toEqual([])
  })

  it('calls a scale order found when any leg is on Hyperliquid, since legs are judged one by one', async () => {
    const scale = buildIntent(
      btc,
      { ...draft, kind: 'scale', size: '0.003', start: '80000', end: '79000', count: '3' },
      caps,
    )
    if (!scale.ok || scale.intent.order.kind !== 'scale') throw new Error('intent')
    const second = scale.intent.order.legs[1]?.clientId
    const { fetch, sent } = venue((_url, body) =>
      body.oid === second ? { status: 'order', order: { status: 'open' } } : { status: 'unknownOid' },
    )
    const result = await TRADING.hyperliquid.lookup(
      { ref: { venue: 'hyperliquid', network: 'testnet', owner }, config, keys: memorySlot(), fetch },
      scale.intent,
    )
    expect(result).toEqual({ kind: 'found', detail: '1 of 3 orders on the venue' })
    expect(sent.map((s) => s.body.oid)).toEqual(scale.intent.order.legs.map((l) => l.clientId))
  })

  it('finds a dYdX order by the uint32 client id among the latest on the market', async () => {
    const keys = memorySlot({ status: 'linked', public: { address: 'dydx1test' }, secret: 'mnemonic' })
    const clientId = String(Number(BigInt(intent.clientId) & 0xffff_ffffn))
    const { fetch, sent } = venue(() => [
      { clientId: '1', status: 'OPEN' },
      { clientId, status: 'FILLED' },
    ])
    const result = await TRADING.dydx.lookup(
      { ref: { venue: 'dydx', network: 'testnet', owner }, config, keys, fetch },
      intent,
    )
    expect(result).toEqual({ kind: 'found', detail: 'Order filled' })
    expect(sent[0]?.url).toContain(
      '/orders?address=dydx1test&subaccountNumber=0&ticker=BTC&limit=100&returnLatestOrders=true',
    )
  })

  it('treats only a missing Orderly order as absent, not a missing key', async () => {
    const keys = memorySlot({ status: 'linked', public: {}, secret: `0x${'11'.repeat(32)}` })
    const ctx = (answer: unknown): VenueContext => ({
      ref: { venue: 'orderly', network: 'testnet', owner },
      config,
      keys,
      fetch: venue(() => answer).fetch,
    })
    expect(await TRADING.orderly.lookup(ctx({ success: true, data: { status: 'NEW' } }), intent)).toEqual({
      kind: 'found',
      detail: 'Order new',
    })
    expect(await TRADING.orderly.lookup(ctx({ success: false, message: 'The order does not exist.' }), intent)).toEqual(
      { kind: 'absent', detail: 'The order does not exist.' },
    )
    const error = await TRADING.orderly
      .lookup(ctx({ success: false, message: 'Orderly key not registered' }), intent)
      .catch((e: unknown) => e)
    expect(error instanceof TradeFailure && error.error.kind).toBe('needs-setup')
  })
})
