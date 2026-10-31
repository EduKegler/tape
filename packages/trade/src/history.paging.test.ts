import { describe, expect, it } from 'vitest'
import { TRADING } from './index'

type Answer = (url: string, body: Record<string, unknown> | null) => unknown

function stub(answer: Answer) {
  const sent: { url: string; body: Record<string, unknown> | null }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null
    sent.push({ url, body })
    return new Response(JSON.stringify(answer(url, body)))
  }) as typeof globalThis.fetch
  return { fetch, sent }
}

const hlFill = (coin: string, time: number, tid: number, startPosition = '0') => ({
  coin,
  px: '100',
  sz: '1',
  side: 'B',
  time,
  startPosition,
  closedPnl: '0',
  hash: `0x${tid}`,
  oid: tid,
  fee: '0.1',
  feeToken: 'USDC',
  tid,
})

describe('hyperliquid history paging', () => {
  it('walks past a full page from the time of its last fill', async () => {
    const first = Array.from({ length: 2000 }, (_, index) => hlFill('BTC', 1000 + Math.floor(index / 2), index))
    const last = first.at(-1)!
    const { fetch, sent } = stub((_url, body) => {
      if (body?.type === 'userFunding') return []
      return body?.startTime === 0 ? first : [last, hlFill('BTC', last.time + 1, 5000)]
    })
    const history = await TRADING.hyperliquid.history({ network: 'mainnet', address: '0xA', fetch })
    expect(history.fills).toHaveLength(2001)
    expect(
      sent.filter((request) => request.body?.type === 'userFillsByTime').map((request) => request.body?.startTime),
    ).toEqual([0, last.time])
  })

  it('says when the first fill of a coin joins a position already open, and leaves spot out', async () => {
    const { fetch } = stub((_url, body) =>
      body?.type === 'userFunding'
        ? []
        : [hlFill('BTC', 1, 1, '0.5'), hlFill('@107', 2, 2), hlFill('PURR/USDC', 3, 3), hlFill('xyz:SP500', 4, 4)],
    )
    const history = await TRADING.hyperliquid.history({ network: 'mainnet', address: '0xA', fetch })
    expect(history.fills.map((fill) => fill.symbol)).toEqual(['BTC', 'xyz:SP500'])
    expect(history.gaps).toHaveLength(2)
    expect(history.gaps[0]).toMatch(/position already open/)
    expect(history.gaps[1]).toBe('Spot fills are left out.')
  })

  it('says when the history reaches the most recent fills Hyperliquid serves', async () => {
    const all = Array.from({ length: 10000 }, (_, index) => hlFill('BTC', index + 1, index, index === 0 ? '0.5' : '0'))
    const { fetch } = stub((_url, body) => {
      if (body?.type === 'userFunding') return []
      const start = body?.startTime as number
      return all.filter((fill) => fill.time >= start).slice(0, 2000)
    })
    const history = await TRADING.hyperliquid.history({ network: 'mainnet', address: '0xA', fetch })
    expect(history.gaps).toEqual(['Hyperliquid serves only its 10000 most recent fills, so earlier fills are missing.'])
  })

  it('marks only fills that liquidated this user, and pays funding in the collateral its fills paid fees in', async () => {
    const liquidated = (by: string) => ({
      ...hlFill('xyz:SP500', 1, 1),
      feeToken: 'USDH',
      liquidation: { liquidatedUser: by },
    })
    const { fetch } = stub((_url, body) =>
      body?.type === 'userFunding'
        ? [
            { time: 5, delta: { coin: 'xyz:SP500', usdc: '-1', szi: '1', fundingRate: '0.0001' } },
            { time: 6, delta: { coin: 'BTC', usdc: '-1', szi: '1', fundingRate: '0.0001' } },
          ]
        : [liquidated('0xa'), { ...liquidated('0xb'), tid: 2 }],
    )
    const history = await TRADING.hyperliquid.history({ network: 'mainnet', address: '0xA', fetch })
    expect(history.fills.map((fill) => fill.liquidation)).toEqual([true, false])
    expect(history.funding.map((payment) => payment.asset)).toEqual(['USDH', 'USDC'])
  })

  it('looks only at the first fill of each coin for an open start', async () => {
    const { fetch } = stub((_url, body) =>
      body?.type === 'userFunding' ? [] : [hlFill('BTC', 1, 1, '0'), hlFill('BTC', 2, 2, '0.5')],
    )
    expect((await TRADING.hyperliquid.history({ network: 'mainnet', address: '0xA', fetch })).gaps).toEqual([])
  })
})

const dydxFill = (id: string, type = 'LIMIT', marketType = 'PERPETUAL') => ({
  id,
  side: 'BUY',
  type,
  market: 'BTC-USD',
  marketType,
  price: '100',
  size: '1',
  fee: '0',
  createdAt: '2026-01-01T00:00:00.000Z',
})

describe('dydx history paging', () => {
  const page = (count: number) => Array.from({ length: count }, (_, index) => dydxFill(String(index)))

  it('reads pages until one comes back short', async () => {
    const { fetch, sent } = stub((url) =>
      url.includes('/fills') ? { fills: page(url.endsWith('page=1') ? 1000 : 3) } : { fundingPayments: [] },
    )
    const history = await TRADING.dydx.history({ network: 'mainnet', address: 'dydx1a', fetch })
    expect(history.fills).toHaveLength(1003)
    expect(
      sent.filter((request) => request.url.includes('/fills')).map((request) => request.url.split('page=')[1]),
    ).toEqual(['1', '2'])
    expect(history.gaps.some((gap) => gap.includes('25000'))).toBe(false)
    expect(history.gaps).toContain('Only subaccount 0 is read. Isolated positions on dYdX live in other subaccounts.')
  })

  it('stops at the last page the indexer serves and says so', async () => {
    const { fetch, sent } = stub((url) => (url.includes('/fills') ? { fills: page(1000) } : { fundingPayments: [] }))
    const history = await TRADING.dydx.history({ network: 'mainnet', address: 'dydx1a', fetch })
    expect(sent.filter((request) => request.url.includes('/fills')).at(-1)?.url).toMatch(/page=25$/)
    expect(history.gaps).toContain("dYdX's indexer pages through 25000 fills at most, so some fills are missing.")
  })

  it('marks fills the protocol forced and keeps perps only', async () => {
    const { fetch } = stub((url) =>
      url.includes('/fills')
        ? {
            fills: [
              dydxFill('a', 'LIQUIDATED'),
              dydxFill('b', 'DELEVERAGED'),
              dydxFill('c'),
              dydxFill('d', 'LIMIT', 'SPOT'),
            ],
          }
        : { fundingPayments: [] },
    )
    const history = await TRADING.dydx.history({ network: 'mainnet', address: 'dydx1a', fetch })
    expect(history.fills.map((fill) => [fill.id, fill.liquidation])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
    ])
  })

  it('stops at the last funding page the indexer serves and says so', async () => {
    const payment = {
      ticker: 'BTC-USD',
      payment: '0.1',
      rate: '0.0001',
      size: '1',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const { fetch } = stub((url) =>
      url.includes('/fills') ? { fills: [] } : { fundingPayments: Array.from({ length: 1000 }, () => payment) },
    )
    const history = await TRADING.dydx.history({ network: 'mainnet', address: 'dydx1a', fetch })
    expect(history.funding).toHaveLength(25_000)
    expect(history.gaps).toContain(
      "dYdX's indexer pages through 25000 funding payments at most, so some payments are missing.",
    )
  })

  it('reads an address the indexer does not know as an empty history', async () => {
    const fetch = (async () => new Response('{"errors":[]}', { status: 404 })) as typeof globalThis.fetch
    expect(await TRADING.dydx.history({ network: 'mainnet', address: 'dydx1a', fetch })).toEqual({
      fills: [],
      funding: [],
      gaps: [],
    })
  })
})

describe('orderly history paging', () => {
  const trade = (id: string) => ({
    id,
    symbol: 'PERP_BTC_USDC',
    side: 'BUY',
    executed_price: '100',
    executed_quantity: '1',
    fee: '0.1',
    fee_asset: 'USDC',
    order_id: '9',
    realized_pnl: '0',
    executed_timestamp: 1,
  })
  const payment = (fee: string, status: string) => ({
    symbol: 'PERP_BTC_USDC',
    funding_rate: '0.0001',
    funding_fee: fee,
    position_qty: '1',
    funding_rate_timestamp: 2,
    funding_status: status,
  })

  it('follows the cursor for every account under the address, oldest first, and keeps settled funding only', async () => {
    const { fetch, sent } = stub((_url, body) => {
      if (body?.type === 'accountState')
        return { success: true, data: { accounts: [{ account_id: 'A' }, { account_id: 'B' }] } }
      if (body?.type === 'trades') {
        if (body.account_id === 'B') return { success: true, data: { rows: [trade('b1')], next_cursor: null } }
        return body.cursor === 'c1'
          ? { success: true, data: { rows: [trade('a1')], next_cursor: null } }
          : { success: true, data: { rows: [trade('a3'), trade('a2')], next_cursor: 'c1' } }
      }
      return {
        success: true,
        data: {
          rows: body?.account_id === 'A' ? [payment('0.5', 'Settled'), payment('0.2', 'Accrued')] : [],
          next_cursor: null,
        },
      }
    })
    const history = await TRADING.orderly.history({ network: 'mainnet', address: '0xA', fetch })
    expect(history.fills.map((fill) => [fill.account, fill.id])).toEqual([
      ['A', 'a1'],
      ['A', 'a2'],
      ['A', 'a3'],
      ['B', 'b1'],
    ])
    expect(history.funding.map((row) => [row.account, row.amount])).toEqual([['A', '-0.5']])
    expect(sent.every((request) => request.body?.type === 'accountState' || request.body?.start_time === 1)).toBe(true)
  })

  it('reads an address Orderly does not know as empty', async () => {
    const { fetch } = stub(() => ({ success: false, code: 'ADDRESS_NOT_FOUND', message: 'not found' }))
    expect(await TRADING.orderly.history({ network: 'mainnet', address: '0xA', fetch })).toEqual({
      fills: [],
      funding: [],
      gaps: [],
    })
  })
})
