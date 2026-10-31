import { afterEach, describe, expect, it, vi } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import type { Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { recordedWrite } from '../fixtures'
import { buildIntent, closeIntent } from '../intent'
import type { TakeProfitDraft } from '../intent'
import { TradeFailure } from '../types'
import type { Bps, Command, KeySlot, OrderRef, StoredKey, VenueContext, WalletSigner } from '../types'
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
  key: marketKey('hyperliquid', 'BTC' as Base),
  venue: 'hyperliquid',
  base: 'BTC' as Base,
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
  takeProfits: [] as readonly TakeProfitDraft[],
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
}

function place(over: Partial<typeof draft>, spec = btc): Command {
  const built = buildIntent(spec, { ...draft, ...over } as Parameters<typeof buildIntent>[1], hyperliquid.capabilities)
  if (!built.ok) throw new Error(JSON.stringify(built))
  return { kind: 'place', intent: built.intent }
}

function memorySlot(initial: StoredKey | null): KeySlot {
  let key = initial
  return { read: () => key, write: (k) => void (key = k), clear: () => void (key = null) }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const statuses = (list: unknown[]) => json({ status: 'ok', response: { type: 'order', data: { statuses: list } } })

/** Hyperliquid testnet's reply to the one request of a recorded case. */
const recorded = (name: string) => recordedWrite('hyperliquid', name).exchanges[0]!.response
const replied = (name: string) => () => json(recorded(name))
type OrderStatus = { resting?: { oid: number }; filled?: { totalSz: string; avgPx: string }; error?: string }
const statusOf = (name: string) =>
  (recorded(name) as { response: { data: { statuses: OrderStatus[] } } }).response.data.statuses[0]!
const restingOid = statusOf('rest').resting!.oid
const recordedFill = statusOf('fill').filled!
const refusalOf = (name: string) => statusOf(name).error!

interface Sent {
  url: string
  body: Record<string, unknown>
}

function venue(
  exchange: () => Response | Promise<Response>,
  openOrders: unknown[] = [],
  levels: unknown[][] = [[{ px: '79990' }], [{ px: '80010' }]],
) {
  const sent: Sent[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>
    sent.push({ url, body })
    if (url.endsWith('/exchange')) return exchange()
    if (body.type === 'meta') return json(testnetMeta)
    if (body.type === 'l2Book') return json({ levels })
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
  return { ctx, sent, posts }
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
    const market = venue(() => statuses([statusOf('fill'), 'waitingForTrigger', 'waitingForTrigger']))
    await hyperliquid.execute(
      market.ctx,
      place({
        side: 'sell',
        kind: 'market',
        price: '',
        takeProfits: [{ price: '78000', share: '100' }],
        stopLoss: '82000',
      }),
    )
    expect(wiresOf(market.posts()[0])).toEqual({
      grouping: 'normalTpsl',
      orders: [
        [false, '79191', false, { limit: { tif: 'Ioc' } }],
        [true, '85800', true, { trigger: { isMarket: true, triggerPx: '78000', tpsl: 'tp' } }],
        [true, '90200', true, { trigger: { isMarket: true, triggerPx: '82000', tpsl: 'sl' } }],
      ],
    })

    const limit = venue(replied('rest'))
    expect(await hyperliquid.execute(limit.ctx, place({ side: 'sell', price: '80100' }))).toEqual({
      kind: 'placed',
      status: 'resting',
      detail: `Resting as order ${restingOid}`,
    })
    expect(wiresOf(limit.posts()[0])).toEqual({
      grouping: 'na',
      orders: [[false, '80100', false, { limit: { tif: 'Gtc' } }]],
    })
  })
})

describe('hyperliquid time in force', () => {
  // Order type docs: tif is Alo, Ioc or Gtc, and an order with no TP/SL goes under grouping na.
  it('sends an IOC limit as Ioc, alone under grouping na', async () => {
    const { ctx, posts } = venue(replied('fill'))
    await hyperliquid.execute(ctx, place({ tif: 'ioc', price: '80010' }))
    expect(wiresOf(posts()[0])).toEqual({ grouping: 'na', orders: [[true, '80010', false, { limit: { tif: 'Ioc' } }]] })
  })
})

describe('hyperliquid nonces', () => {
  afterEach(() => vi.useRealTimers())

  // Nonce docs: the signer's nonces must grow and stay within a day or two of the block time.
  it('signs each action with the current millisecond, or one above the last within the same millisecond', async () => {
    const now = Date.now() + 3_600_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    const { ctx, posts } = venue(replied('rest'))
    await hyperliquid.execute(ctx, place({}))
    await hyperliquid.execute(ctx, place({}))
    expect(posts().map((p) => p.body.nonce)).toEqual([now, now + 1])
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

describe('hyperliquid reads that fail', () => {
  it('calls a failed read unreachable, since nothing was sent, and reads the market rules again next time', async () => {
    const metaReplies = [new Response('<html>502 Bad Gateway</html>', { status: 502 }), json(testnetMeta)]
    const { ctx, sent, posts } = venue(replied('rest'))
    const fetch = ((url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { type?: string }
      if (body.type !== 'meta') return ctx.fetch(url, init)
      sent.push({ url, body })
      return Promise.resolve(metaReplies.shift()!)
    }) as typeof globalThis.fetch
    const mainnet: VenueContext = { ...ctx, ref: { ...ctx.ref, network: 'mainnet' }, fetch }
    expect(await failureOf(hyperliquid.execute(mainnet, place({})))).toMatchObject({ kind: 'unreachable' })
    expect(posts()).toEqual([])
    expect(await hyperliquid.execute(mainnet, place({}))).toEqual({
      kind: 'placed',
      status: 'resting',
      detail: `Resting as order ${restingOid}`,
    })
    expect(sent.filter((s) => s.body.type === 'meta').map((s) => s.url)).toEqual([
      'https://api.hyperliquid.xyz/info',
      'https://api.hyperliquid.xyz/info',
    ])
  })
})

describe('hyperliquid refusals', () => {
  it('refuses an order Hyperliquid refuses in its own status, by the venue words', async () => {
    for (const [name, kind] of [
      ['insufficientMargin', 'insufficient-margin'],
      ['minimumValue', 'invalid-order'],
      ['offTick', 'invalid-order'],
      ['offStep', 'invalid-order'],
      ['reduceOnly', 'rejected'],
    ] as const) {
      const { ctx } = venue(replied(name))
      expect(await failureOf(hyperliquid.execute(ctx, place({})))).toEqual({ kind, detail: refusalOf(name) })
    }
  })

  it('refuses a scale order when Hyperliquid refuses every leg', async () => {
    const refused = statusOf('insufficientMargin')
    const { ctx } = venue(() => statuses([refused, refused, refused]))
    const scale = place({ kind: 'scale', tif: 'post-only', size: '0.003', start: '80000', end: '79000', count: '3' })
    expect(await failureOf(hyperliquid.execute(ctx, scale))).toEqual({
      kind: 'insufficient-margin',
      detail: refusalOf('insufficientMargin'),
    })
  })
})

describe('hyperliquid refusals before signing', () => {
  const spec = (venueSymbol: string): MarketSpec => ({
    ...btc,
    key: marketKey('hyperliquid', venueSymbol as Base),
    base: venueSymbol as Base,
    venueSymbol,
  })
  const sol = { price: '150', bid: '149.9', ask: '150.1' }

  it('refuses before signing when this device has no key or the market is not listed', async () => {
    const { ctx, posts } = venue(replied('rest'))
    expect(await failureOf(hyperliquid.execute({ ...ctx, keys: memorySlot(null) }, place({})))).toEqual({
      kind: 'needs-setup',
      detail: 'Enable trading on this device first',
    })
    expect(await failureOf(hyperliquid.execute(ctx, place({}, spec('DOGE'))))).toEqual({
      kind: 'invalid-order',
      detail: 'DOGE is not listed on Hyperliquid testnet',
    })
    expect(posts()).toEqual([])
  })

  it('refuses a size or a scale leg finer than the 2 szDecimals SOL has on this network', async () => {
    const { ctx, posts } = venue(replied('rest'))
    expect(await failureOf(hyperliquid.execute(ctx, place({ ...sol, size: '0.001' }, spec('SOL'))))).toMatchObject({
      kind: 'invalid-order',
      detail: expect.stringMatching(/^Size 0\.001: /) as string,
    })
    const scale = place({ ...sol, kind: 'scale', size: '0.05', start: '150', end: '149', count: '3' }, spec('SOL'))
    expect(await failureOf(hyperliquid.execute(ctx, scale))).toMatchObject({
      kind: 'invalid-order',
      detail: expect.stringMatching(/^Order 1 size 0\.0\d+: /) as string,
    })
    expect(posts()).toEqual([])
  })

  it('refuses a take profit finer than the 2 szDecimals SOL has on this network, naming it', async () => {
    const { ctx, posts } = venue(replied('rest'))
    const takeProfits = [
      { price: '160', share: '50' },
      { price: '170', share: '50' },
    ]
    const bracket = place({ ...sol, size: '0.03', takeProfits }, spec('SOL'))
    expect(await failureOf(hyperliquid.execute(ctx, bracket))).toMatchObject({
      kind: 'invalid-order',
      detail: expect.stringMatching(/^Take profit 1 size 0\.015: .+ on this network$/) as string,
    })
    expect(posts()).toEqual([])
  })

  it('refuses a scale order that carries a take profit or a stop loss', async () => {
    const { ctx, posts } = venue(replied('rest'))
    const command = place({ kind: 'scale', size: '0.003', start: '80000', end: '79000', count: '3' })
    if (command.kind !== 'place') throw new Error('place')
    for (const triggers of [
      { takeProfits: [{ px: 820_000 as Px, size: 300 as Qty }], stopLoss: null },
      { takeProfits: [], stopLoss: 780_000 as Px },
    ]) {
      expect(
        await failureOf(hyperliquid.execute(ctx, { kind: 'place', intent: { ...command.intent, triggers } })),
      ).toEqual({ kind: 'invalid-order', detail: 'A scale order carries no take profit or stop loss' })
    }
    expect(posts()).toEqual([])
  })
})

describe('hyperliquid trailing stops', () => {
  const trailing = { kind: 'trailing', price: '', retracement: '1.5' }
  const oid = () => json({ status: 'ok', response: { type: 'trailingStop', data: { oid: 77738308 } } })

  // The trailingStop action of the exchange endpoint docs.
  it('sends a trailing buy as isBuy true', async () => {
    const { ctx, posts } = venue(oid)
    expect(await hyperliquid.execute(ctx, place(trailing))).toEqual({
      kind: 'placed',
      status: 'resting',
      detail: 'Resting as order 77738308',
    })
    expect(posts()[0]?.body.action).toEqual({
      type: 'trailingStop',
      asset: 3,
      isBuy: true,
      sz: '0.001',
      reduceOnly: false,
      retracement: { pct: '1.5%' },
      activationPx: null,
    })
  })

  it('refuses a trailing stop that carries a take profit or a stop loss, before reading the market', async () => {
    const { ctx, sent } = venue(oid)
    const command = place(trailing)
    if (command.kind !== 'place') throw new Error('place')
    for (const triggers of [
      { takeProfits: [{ px: 820_000 as Px, size: 100 as Qty }], stopLoss: null },
      { takeProfits: [], stopLoss: 780_000 as Px },
    ]) {
      expect(
        await failureOf(hyperliquid.execute(ctx, { kind: 'place', intent: { ...command.intent, triggers } })),
      ).toEqual({ kind: 'invalid-order', detail: 'A trailing stop carries no take profit or stop loss' })
    }
    expect(sent).toEqual([])
  })

  // BTC prices carry 6 - szDecimals = 1 decimal on Hyperliquid, so 123.45 is off this network.
  it('refuses a retracement or an activation price with more decimals than this network allows, naming which', async () => {
    const { ctx, posts } = venue(oid)
    const command = place(trailing)
    if (command.kind !== 'place') throw new Error('place')
    const finer = { ...command.intent, spec: { ...btc, scale: { px: 2, qty: 5 } } } as typeof command.intent
    for (const [order, detail] of [
      [{ kind: 'trailing', retracement: { px: 12_345 as Px }, activation: null }, 'Retracement 123.45'],
      [{ kind: 'trailing', retracement: { pct: 150 as Bps }, activation: 12_345 as Px }, 'Activation price 123.45'],
    ] as const) {
      expect(await failureOf(hyperliquid.execute(ctx, { kind: 'place', intent: { ...finer, order } }))).toEqual({
        kind: 'invalid-order',
        detail: `${detail}: At most 1 decimal on this network`,
      })
    }
    expect(posts()).toEqual([])
  })
})

describe('hyperliquid order outcomes', () => {
  it('reports an order Hyperliquid answered with a status it does not name as accepted, not as a failure', async () => {
    for (const [status, detail] of [
      ['waitingForFill', 'waitingForFill'],
      [{ other: 'x' }, '{"other":"x"}'],
    ] as const) {
      const { ctx } = venue(() => statuses([status]))
      expect(await hyperliquid.execute(ctx, place({}))).toEqual({ kind: 'placed', status: 'accepted', detail })
    }
  })

  it('calls a scale order filled when every leg filled', async () => {
    const filled = statusOf('fill')
    const { ctx } = venue(() => statuses([filled, filled, filled]))
    const scale = place({ kind: 'scale', size: '0.003', start: '80100', end: '80020', count: '3' })
    expect(await hyperliquid.execute(ctx, scale)).toEqual({
      kind: 'placed',
      status: 'filled',
      detail: '3 of 3 orders placed: 0 resting, 3 filled',
    })
  })

  it('calls a scale order filled with the refusals when the legs that stood all filled', async () => {
    const filled = statusOf('fill')
    const { ctx } = venue(() => statuses([filled, filled, statusOf('insufficientMargin')]))
    const scale = place({ kind: 'scale', size: '0.003', start: '80100', end: '80020', count: '3' })
    expect(await hyperliquid.execute(ctx, scale)).toEqual({
      kind: 'placed',
      status: 'filled',
      detail: `2 of 3 orders placed: 0 resting, 2 filled. Order 3 not placed: ${refusalOf('insufficientMargin')}`,
    })
  })
})

describe('hyperliquid cancels', () => {
  const cancel: Command = { kind: 'cancel', order: '3:42' as OrderRef }
  // The cancel action shape is from the exchange endpoint docs.
  it('cancels an order Hyperliquid already canceled or filled without an error, but not one it refuses', async () => {
    for (const name of ['cancel', 'cancelCanceled', 'cancelFilled']) {
      const { ctx, posts } = venue(replied(name))
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

describe('hyperliquid leverage', () => {
  // The updateLeverage action from the exchange endpoint docs.
  it('sets cross leverage on the testnet asset id at the testnet host', async () => {
    const { ctx, posts } = venue(() => json({ status: 'ok', response: { type: 'default' } }))
    expect(await hyperliquid.execute(ctx, { kind: 'leverage', symbol: 'BTC', leverage: 5 })).toEqual({
      kind: 'done',
      detail: 'Leverage 5x cross',
    })
    expect(posts().map((p) => [p.url, p.body.action])).toEqual([
      [
        'https://api.hyperliquid-testnet.xyz/exchange',
        { type: 'updateLeverage', asset: 3, isCross: true, leverage: 5 },
      ],
    ])
  })
})

describe('hyperliquid exits', () => {
  const bracket = { kind: 'market', price: '', takeProfits: [{ price: '82000', share: '100' }], stopLoss: '78000' }
  const filled = statusOf('fill')

  it('keeps the order when Hyperliquid refuses its stop loss, and names the leg', async () => {
    const both = venue(() => statuses([filled, 'waitingForTrigger', 'waitingForTrigger']))
    expect(await hyperliquid.execute(both.ctx, place(bracket))).toEqual({
      kind: 'placed',
      status: 'filled',
      detail: `Filled ${recordedFill.totalSz} at ${recordedFill.avgPx}`,
    })

    const noStop = venue(() => statuses([filled, 'waitingForTrigger', { error: 'Invalid TP/SL price.' }]))
    expect(await hyperliquid.execute(noStop.ctx, place(bracket))).toEqual({
      kind: 'placed',
      status: 'filled',
      detail: `Filled ${recordedFill.totalSz} at ${recordedFill.avgPx}. SL not placed: Invalid TP/SL price.`,
    })

    const noTarget = venue(() => statuses([statusOf('rest'), { error: 'Invalid TP/SL price.' }, 'waitingForTrigger']))
    expect(await hyperliquid.execute(noTarget.ctx, place({ ...bracket, kind: 'limit', price: '80000' }))).toEqual({
      kind: 'placed',
      status: 'resting',
      detail: `Resting as order ${restingOid}. TP not placed: Invalid TP/SL price.`,
    })
  })

  it('refuses a limit order whose stop loss the book on this network already crossed, before signing', async () => {
    const { ctx, posts } = venue(() => statuses([]), [], [[{ px: '78990' }], [{ px: '79010' }]])
    expect(await failureOf(hyperliquid.execute(ctx, place({ stopLoss: '79000' })))).toEqual({
      kind: 'invalid-order',
      detail: 'Stop loss: Must be below the bid on this network',
    })
    expect(posts()).toEqual([])
  })

  it('refuses more than 2 triggers on one order and sends nothing', async () => {
    const { ctx, sent } = venue(() => statuses([]))
    const command = place({})
    if (command.kind !== 'place') throw new Error('place')
    const triggers = {
      takeProfits: [
        { px: 820_000 as Px, size: 50 as Qty },
        { px: 840_000 as Px, size: 50 as Qty },
      ],
      stopLoss: 780_000 as Px,
    }
    expect(
      await failureOf(hyperliquid.execute(ctx, { kind: 'place', intent: { ...command.intent, triggers } })),
    ).toEqual({
      kind: 'invalid-order',
      detail: 'At most 2 take profits and stop losses on one order',
    })
    expect(sent).toEqual([])
  })

  it('refuses a limit order whose second take profit is not above its price, naming it, before signing', async () => {
    const { ctx, posts } = venue(() => statuses([]))
    const command = place({})
    if (command.kind !== 'place') throw new Error('place')
    const triggers = {
      takeProfits: [
        { px: 820_000 as Px, size: 50 as Qty },
        { px: 790_000 as Px, size: 50 as Qty },
      ],
      stopLoss: null,
    }
    expect(
      await failureOf(hyperliquid.execute(ctx, { kind: 'place', intent: { ...command.intent, triggers } })),
    ).toEqual({
      kind: 'invalid-order',
      detail: 'Take profit 2: Must be above the price on this network',
    })
    expect(posts()).toEqual([])
  })
})

describe('hyperliquid market orders without exits', () => {
  it('sends a market order with no take profit or stop loss at the slippage bound off the far touch', async () => {
    const short = {
      symbol: 'BTC',
      side: 'short',
      size: '0.001',
      entry: '80100',
      unrealizedPnl: '0',
      liquidation: null,
      leverage: null,
    } as const
    const intent = closeIntent(btc, short as Parameters<typeof closeIntent>[1], 100 as Bps)
    if (!intent) throw new Error('close')
    const { ctx, sent, posts } = venue(replied('fill'))
    expect(await hyperliquid.execute(ctx, { kind: 'place', intent })).toEqual({
      kind: 'placed',
      status: 'filled',
      detail: `Filled ${recordedFill.totalSz} at ${recordedFill.avgPx}`,
    })
    expect(sent.find((s) => s.body.type === 'l2Book')?.body).toEqual({ type: 'l2Book', coin: 'BTC' })
    expect(wiresOf(posts()[0])).toEqual({ grouping: 'na', orders: [[true, '80810', true, { limit: { tif: 'Ioc' } }]] })
  })

  it('refuses a market order into an empty side of the book', async () => {
    const { ctx, posts } = venue(() => statuses([]), [], [[{ px: '79990' }], []])
    expect(await failureOf(hyperliquid.execute(ctx, place({ kind: 'market', price: '' })))).toEqual({
      kind: 'invalid-order',
      detail: 'The book on this network is empty',
    })
    expect(posts()).toEqual([])
  })
})

describe('hyperliquid account sides', () => {
  // The recorded history.hyperliquid.json frame has a side B fill as Open Long and a long with a positive szi.
  it('reads a long position, a sell order and a buy fill in the venue shapes', async () => {
    const position = (coin: string, szi: string, liquidationPx: string) => ({
      position: {
        coin,
        szi,
        entryPx: '80100.0',
        unrealizedPnl: '1.5',
        liquidationPx,
        leverage: { type: 'cross', value: 5 },
      },
    })
    const order = (coin: string, oid: number) => ({
      coin,
      side: 'A',
      limitPx: '90000.0',
      sz: '0.02',
      oid,
      timestamp: 1793248070251,
      orderType: 'Limit',
      reduceOnly: true,
      isTrigger: false,
      triggerPx: '0.0',
    })
    const answers: Record<string, unknown> = {
      meta: testnetMeta,
      clearinghouseState: {
        marginSummary: { accountValue: '1008.5' },
        withdrawable: '900.25',
        assetPositions: [position('BTC', '0.02', '40000.5'), position('ETH', '0.5', '3100.123456789')],
      },
      frontendOpenOrders: [order('BTC', 589008353129), order('ETH', 589008353130)],
      userFills: [{ coin: 'BTC', px: '80100.0', sz: '0.02', side: 'B', time: 1793248071468, fee: '0.36', tid: 1 }],
    }
    const { ctx } = venue(() => statuses([]))
    const view = await hyperliquid.account({
      ...ctx,
      fetch: (async (_url: string, init?: RequestInit) =>
        json(answers[(JSON.parse(init?.body as string) as { type: string }).type] ?? null)) as typeof globalThis.fetch,
    })
    if (view.kind !== 'live') throw new Error(view.kind)
    expect(view.snapshot.positions.map((p) => [p.symbol, p.side, p.size, p.liquidation])).toEqual([
      ['BTC', 'long', '0.02', '40000.5'],
      ['ETH', 'long', '0.5', '3100.123457'],
    ])
    const [btcOrder, ethOrder] = view.snapshot.orders
    expect([btcOrder?.ref, btcOrder?.side]).toEqual(['3:589008353129', 'sell'])
    expect(ethOrder?.side).toBe('sell')
    expect(ethOrder?.ref).toMatch(/:589008353130$/)
    expect(view.snapshot.fills.map((f) => f.side)).toEqual(['buy'])
  })

  // Info endpoint docs: a spot order's coin is "@" and the spot pair index, or a name such as PURR/USDC.
  it('lists a spot order Tape cannot cancel, since it trades only the perps in the meta', async () => {
    const order = (coin: string, oid: number) => ({
      coin,
      side: 'B',
      limitPx: '20.0',
      sz: '1.0',
      oid,
      timestamp: 1793248070251,
      orderType: 'Limit',
      reduceOnly: false,
      isTrigger: false,
      triggerPx: '0.0',
    })
    const noState = { marginSummary: { accountValue: '10.0' }, withdrawable: '10.0', assetPositions: [] }
    const answers: Record<string, unknown> = {
      meta: testnetMeta,
      clearinghouseState: noState,
      spotClearinghouseState: { balances: [] },
      frontendOpenOrders: [order('BTC', 11), order('@107', 12), order('PURR/USDC', 13)],
      userFills: [],
    }
    const { ctx } = venue(() => statuses([]))
    const view = await hyperliquid.account({
      ...ctx,
      fetch: (async (_url: string, init?: RequestInit) =>
        json(answers[(JSON.parse(init?.body as string) as { type: string }).type] ?? null)) as typeof globalThis.fetch,
    })
    if (view.kind !== 'live') throw new Error(view.kind)
    expect(view.snapshot.orders.map((o) => [o.symbol, o.cancelable])).toEqual([
      ['BTC', true],
      ['@107', false],
      ['PURR/USDC', false],
    ])
  })
})

describe('hyperliquid balances', () => {
  const noState = { marginSummary: { accountValue: '0.0' }, withdrawable: '0.0', assetPositions: [] }
  const accountOf = (answers: Record<string, unknown>) =>
    hyperliquid.account({
      ...venue(() => statuses([])).ctx,
      fetch: (async (_url: string, init?: RequestInit) => {
        const { type } = JSON.parse(init?.body as string) as { type: string }
        return json(type === 'meta' ? testnetMeta : (answers[type] ?? []))
      }) as typeof globalThis.fetch,
    })

  // Account abstraction docs: a unified or portfolio margin account keeps its USDC in spot.
  it('reads a portfolio margin balance from the USDC row in spot, whatever comes before it', async () => {
    const spot = {
      balances: [
        { coin: 'HYPE', token: 150, total: '12.5' },
        { coin: 'USDC', token: 0, total: '907.158556' },
      ],
      tokenToAvailableAfterMaintenance: [
        [150, '12.5'],
        [0, '904.758556'],
      ],
    }
    const portfolio = { userAbstraction: 'portfolioMargin', clearinghouseState: noState }
    const view = await accountOf({ ...portfolio, spotClearinghouseState: spot })
    expect(view.kind === 'live' && view.snapshot).toMatchObject({ equity: '907.158556', available: '904.758556' })
    const { tokenToAvailableAfterMaintenance: _, ...noAvailable } = spot
    for (const spotState of [noAvailable, { ...noAvailable, tokenToAvailableAfterMaintenance: [[150, '12.5']] }]) {
      const all = await accountOf({ ...portfolio, spotClearinghouseState: spotState })
      expect(all.kind === 'live' && all.snapshot).toMatchObject({ equity: '907.158556', available: '907.158556' })
    }
  })

  it('reads an account with nothing in it as empty, and one with only past fills as live', async () => {
    expect(await accountOf({ clearinghouseState: noState })).toEqual({ kind: 'empty' })
    const fill = { coin: 'BTC', px: '80100.0', sz: '0.02', side: 'B', time: 1793248071468, fee: '0.36', tid: 1 }
    expect(await accountOf({ clearinghouseState: noState, userFills: [fill] })).toMatchObject({ kind: 'live' })
  })
})

describe('hyperliquid setup', () => {
  const builder = { b: '0x1924b8561eef20e70ede628a296175d358be80e5' as Address, f: 10 }
  const day = 86_400_000
  const listed = (address: string, validUntil: number) => [{ name: 'tape', address, validUntil }]
  const valid = () => listed(agent.toLowerCase(), Date.now() + day)
  const withKey = (status: StoredKey['status'], secret: string | null = agentKey) =>
    memorySlot({ status, public: { agent }, secret })

  function setup(keys: KeySlot, agents: unknown[], fee: number | null = null) {
    const sent: Sent[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>
      sent.push({ url, body })
      if (url.endsWith('/exchange')) return json({ status: 'ok', response: { type: 'default' } })
      if (body.type === 'extraAgents') return json(agents)
      if (body.type === 'maxBuilderFee') return json(fee)
      return json(null)
    }) as typeof globalThis.fetch
    const { ctx } = venue(() => statuses([]))
    const config = { ...ctx.config, hyperliquid: { builder: fee === null ? null : builder } }
    return { ctx: { ...ctx, config, keys, fetch }, sent, posts: () => sent.filter((s) => s.url.endsWith('/exchange')) }
  }

  function wallet() {
    const signed: unknown[] = []
    const signer: WalletSigner = {
      address: owner,
      chainId: async () => 421614,
      switchChain: async () => {},
      signTypedData: async (data) => {
        signed.push(data)
        return `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`
      },
    }
    return { signer, signed }
  }

  afterEach(() => vi.useRealTimers())

  // extraAgents from the info endpoint docs lists the API wallets with their expiry in ms.
  it('marks the trading key approved only when Hyperliquid lists it unexpired', async () => {
    const approved = async (keys: KeySlot, agents: unknown[]) => (await hyperliquid.steps(setup(keys, agents).ctx))[0]
    expect(await approved(withKey('linked'), valid())).toEqual({
      id: 'approve-agent',
      label: 'Approve a trading key',
      done: true,
    })
    expect((await approved(withKey('linked'), listed(agent.toLowerCase(), Date.now() - 1000)))?.done).toBe(false)
    expect((await approved(withKey('linked'), listed(owner, Date.now() + day)))?.done).toBe(false)
    expect((await approved(withKey('linked'), [...listed(owner, Date.now() + day), ...valid()]))?.done).toBe(true)
    expect((await approved(withKey('draft', null), valid()))?.done).toBe(false)
    const { ctx, sent } = setup(withKey('linked'), valid())
    await hyperliquid.steps(ctx)
    expect(sent.map((s) => s.body)).toEqual([{ type: 'extraAgents', user: owner }])
  })

  // maxBuilderFee from the info endpoint docs answers in tenths of a basis point, the unit of the builder f.
  it("asks for Tape's builder fee until the user approved at least that rate", async () => {
    for (const [fee, done] of [
      [5, false],
      [10, true],
    ] as const) {
      const { ctx, sent } = setup(withKey('linked'), valid(), fee)
      expect(await hyperliquid.steps(ctx)).toEqual([
        { id: 'approve-agent', label: 'Approve a trading key', done: true },
        { id: 'approve-builder', label: "Approve Tape's fee of 1 bp", done },
      ])
      expect(sent.find((s) => s.body.type === 'maxBuilderFee')?.body).toEqual({
        type: 'maxBuilderFee',
        user: owner,
        builder: builder.b,
      })
    }
  })

  // approveAgent and approveBuilderFee from the exchange endpoint docs, signed with the EIP-712 types of
  // hyperliquid-python-sdk signing.py. 421614 is 0x66eee, and a fee of 10 tenths of a basis point is 0.01%.
  it('sends the agent named tape and the builder fee the wallet signed, then links the key', async () => {
    const now = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    const keys = memorySlot(null)
    const { ctx, posts } = setup(keys, [], 0)
    const { signer, signed } = wallet()
    const steps: string[] = []
    await hyperliquid.enable(ctx, signer, (step) => steps.push(step))
    const key = keys.read()
    const agentAddress = key?.public.agent
    expect(key).toEqual({ status: 'linked', public: { agent: agentAddress }, secret: expect.any(String) as string })
    expect(privateKeyToAccount(key?.secret as `0x${string}`).address).toBe(agentAddress)
    expect(steps).toEqual(['approve-agent', 'approve-builder'])
    const signature = { r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, v: 27 }
    const chain = { signatureChainId: '0x66eee', hyperliquidChain: 'Testnet' }
    const agentMessage = { hyperliquidChain: 'Testnet', agentAddress, agentName: 'tape', nonce: now }
    const feeMessage = { hyperliquidChain: 'Testnet', maxFeeRate: '0.01%', builder: builder.b, nonce: now }
    expect(posts().map((p) => [p.url, p.body])).toEqual([
      [
        'https://api.hyperliquid-testnet.xyz/exchange',
        { action: { type: 'approveAgent', ...chain, ...agentMessage }, nonce: now, signature },
      ],
      [
        'https://api.hyperliquid-testnet.xyz/exchange',
        { action: { type: 'approveBuilderFee', ...chain, ...feeMessage }, nonce: now, signature },
      ],
    ])
    const domain = {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: 421614,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    }
    expect(signed).toEqual([
      {
        domain,
        types: {
          'HyperliquidTransaction:ApproveAgent': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'agentAddress', type: 'address' },
            { name: 'agentName', type: 'string' },
            { name: 'nonce', type: 'uint64' },
          ],
        },
        primaryType: 'HyperliquidTransaction:ApproveAgent',
        message: agentMessage,
      },
      {
        domain,
        types: {
          'HyperliquidTransaction:ApproveBuilderFee': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'maxFeeRate', type: 'string' },
            { name: 'builder', type: 'address' },
            { name: 'nonce', type: 'uint64' },
          ],
        },
        primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
        message: feeMessage,
      },
    ])
  })

  it('skips the steps already done and keeps the approved key', async () => {
    const keys = withKey('draft')
    const { ctx, posts } = setup(keys, valid(), 0)
    const steps: string[] = []
    await hyperliquid.enable(ctx, wallet().signer, (step) => steps.push(step))
    expect(steps).toEqual(['approve-builder'])
    expect(posts().map((p) => (p.body.action as { type: string }).type)).toEqual(['approveBuilderFee'])
    expect(keys.read()).toEqual({ status: 'linked', public: { agent }, secret: agentKey })
  })
})
