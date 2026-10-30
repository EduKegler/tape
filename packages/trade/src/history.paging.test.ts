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
    const first = Array.from({ length: 2000 }, (_, i) => hlFill('BTC', 1000 + Math.floor(i / 2), i))
    const last = first.at(-1)!
    const { fetch, sent } = stub((_url, body) => {
      if (body?.type === 'userFunding') return []
      return body?.startTime === 0 ? first : [last, hlFill('BTC', last.time + 1, 5000)]
    })
    const h = await TRADING.hyperliquid.history({ network: 'mainnet', address: '0xA', fetch })
    expect(h.fills).toHaveLength(2001)
    expect(sent.filter((s) => s.body?.type === 'userFillsByTime').map((s) => s.body?.startTime)).toEqual([0, last.time])
  })

  it('says when the first fill of a coin joins a position already open, and leaves spot out', async () => {
    const { fetch } = stub((_url, body) =>
      body?.type === 'userFunding'
        ? []
        : [hlFill('BTC', 1, 1, '0.5'), hlFill('@107', 2, 2), hlFill('PURR/USDC', 3, 3), hlFill('xyz:SP500', 4, 4)],
    )
    const h = await TRADING.hyperliquid.history({ network: 'mainnet', address: '0xA', fetch })
    expect(h.fills.map((f) => f.symbol)).toEqual(['BTC', 'xyz:SP500'])
    expect(h.gaps).toHaveLength(2)
    expect(h.gaps[0]).toMatch(/position already open/)
    expect(h.gaps[1]).toBe('Spot fills are left out.')
  })

  it('says when the history reaches the most recent fills Hyperliquid serves', async () => {
    const all = Array.from({ length: 10000 }, (_, i) => hlFill('BTC', i + 1, i, i === 0 ? '0.5' : '0'))
    const { fetch } = stub((_url, body) => {
      if (body?.type === 'userFunding') return []
      const start = body?.startTime as number
      return all.filter((f) => f.time >= start).slice(0, 2000)
    })
    const h = await TRADING.hyperliquid.history({ network: 'mainnet', address: '0xA', fetch })
    expect(h.gaps).toEqual(['Hyperliquid serves only its 10000 most recent fills, so earlier fills are missing.'])
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
    const h = await TRADING.hyperliquid.history({ network: 'mainnet', address: '0xA', fetch })
    expect(h.fills.map((f) => f.liquidation)).toEqual([true, false])
    expect(h.funding.map((p) => p.asset)).toEqual(['USDH', 'USDC'])
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
  const page = (n: number) => Array.from({ length: n }, (_, i) => dydxFill(String(i)))

  it('reads pages until one comes back short', async () => {
    const { fetch, sent } = stub((url) =>
      url.includes('/fills') ? { fills: page(url.endsWith('page=1') ? 1000 : 3) } : { fundingPayments: [] },
    )
    const h = await TRADING.dydx.history({ network: 'mainnet', address: 'dydx1a', fetch })
    expect(h.fills).toHaveLength(1003)
    expect(sent.filter((s) => s.url.includes('/fills')).map((s) => s.url.split('page=')[1])).toEqual(['1', '2'])
    expect(h.gaps.some((g) => g.includes('25000'))).toBe(false)
    expect(h.gaps).toContain('Only subaccount 0 is read. Isolated positions on dYdX live in other subaccounts.')
  })

  it('stops at the last page the indexer serves and says so', async () => {
    const { fetch, sent } = stub((url) => (url.includes('/fills') ? { fills: page(1000) } : { fundingPayments: [] }))
    const h = await TRADING.dydx.history({ network: 'mainnet', address: 'dydx1a', fetch })
    expect(sent.filter((s) => s.url.includes('/fills')).at(-1)?.url).toMatch(/page=25$/)
    expect(h.gaps).toContain("dYdX's indexer pages through 25000 fills at most, so some fills are missing.")
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
    const h = await TRADING.dydx.history({ network: 'mainnet', address: 'dydx1a', fetch })
    expect(h.fills.map((f) => [f.id, f.liquidation])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
    ])
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
    const h = await TRADING.orderly.history({ network: 'mainnet', address: '0xA', fetch })
    expect(h.fills.map((f) => [f.account, f.id])).toEqual([
      ['A', 'a1'],
      ['A', 'a2'],
      ['A', 'a3'],
      ['B', 'b1'],
    ])
    expect(h.funding.map((p) => [p.account, p.amount])).toEqual([['A', '-0.5']])
    expect(sent.every((s) => s.body?.type === 'accountState' || s.body?.start_time === 1)).toBe(true)
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
