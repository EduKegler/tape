import { describe, expect, it } from 'vitest'
import { realize, summarize } from './history'
import type { FundingPayment, HistoryFill } from './history'
import type { Decimal, Side } from './types'

let seq = 0
const fill = (side: Side, size: string, px: string, extra: Partial<HistoryFill> = {}): HistoryFill => ({
  venue: 'dydx',
  account: 'a',
  id: String(++seq),
  symbol: 'BTC-USD',
  side,
  px: px as Decimal,
  size: size as Decimal,
  fee: '0' as Decimal,
  asset: 'USDC',
  time: seq,
  liquidation: false,
  venuePnl: null,
  ...extra,
})

const pnls = (fills: HistoryFill[]) => realize(fills).map((f) => f.pnl)

describe('realized pnl', () => {
  it('realizes a long against its entry on each partial close', () => {
    expect(pnls([fill('buy', '1', '100'), fill('sell', '0.4', '110'), fill('sell', '0.6', '90')])).toEqual([
      '0',
      '4',
      '-6',
    ])
  })

  it('averages the entry over every increase', () => {
    expect(pnls([fill('buy', '1', '100'), fill('buy', '1', '120'), fill('sell', '2', '115')])).toEqual(['0', '0', '10'])
  })

  it('realizes a short when the price falls', () => {
    expect(pnls([fill('sell', '2', '100'), fill('buy', '1', '90')])).toEqual(['0', '10'])
  })

  it('closes the whole position on a flip and opens the rest at the fill price', () => {
    expect(pnls([fill('buy', '1', '100'), fill('sell', '3', '110'), fill('buy', '2', '100')])).toEqual([
      '0',
      '10',
      '20',
    ])
  })

  it('keeps an average entry that does not divide evenly', () => {
    const out = pnls([fill('buy', '1', '100'), fill('buy', '2', '101'), fill('sell', '3', '102')])
    expect(out[2]).toBe('4')
    const thirds = pnls([fill('buy', '3', '100'), fill('buy', '0', '0'), fill('sell', '1', '100.01')])
    expect(thirds[2]).toBe('0.01')
  })

  it('rounds a computed figure to the 6 decimals USDC settles in', () => {
    expect(pnls([fill('buy', '1', '1'), fill('buy', '2', '2'), fill('sell', '1', '0')])[2]).toBe('-1.666667')
  })

  it('tracks each market, account and venue on its own', () => {
    const eth = { symbol: 'ETH-USD' }
    const hl = { venue: 'hyperliquid' } as const
    const other = { account: 'b' }
    expect(
      pnls([
        fill('buy', '1', '100'),
        fill('sell', '1', '2000', eth),
        fill('sell', '1', '150', hl),
        fill('sell', '1', '150', other),
        fill('sell', '1', '110'),
      ]),
    ).toEqual(['0', '0', '0', '0', '10'])
  })

  it('orders by time before it realizes', () => {
    const late = fill('sell', '1', '110')
    const early = fill('buy', '1', '100')
    expect(
      realize([
        { ...late, time: 2 },
        { ...early, time: 1 },
      ]).map((f) => [f.id, f.pnl]),
    ).toEqual([
      [early.id, '0'],
      [late.id, '10'],
    ])
  })

  it('takes the venue figure where the venue reports one', () => {
    const out = realize([
      fill('buy', '1', '100', { venuePnl: '0' as Decimal }),
      fill('sell', '1', '110', { venuePnl: '9.999' as Decimal }),
    ])
    expect(out.map((f) => [f.pnl, f.pnlSource])).toEqual([
      ['0', 'venue'],
      ['9.999', 'venue'],
    ])
  })
})

const funding = (amount: string, time: number, extra: Partial<FundingPayment> = {}): FundingPayment => ({
  venue: 'dydx',
  account: 'a',
  symbol: 'BTC-USD',
  time,
  amount: amount as Decimal,
  rate: '0.0001' as Decimal,
  position: '1' as Decimal,
  asset: 'USDC',
  ...extra,
})

describe('history totals', () => {
  const fills = realize([
    fill('buy', '1', '100', { fee: '0.5' as Decimal, time: 10 }),
    fill('sell', '1', '110', { fee: '0.25' as Decimal, time: 20 }),
    fill('buy', '1', '100', { fee: '-0.1' as Decimal, time: 30, venue: 'hyperliquid' }),
  ])
  const payments = [funding('0.2', 15), funding('-0.05', 25), funding('1', 35, { venue: 'hyperliquid' })]

  it('keeps pnl, fees and funding apart and nets them', () => {
    expect(summarize(fills, payments, () => 'all')).toEqual([
      {
        group: 'all',
        asset: 'USDC',
        fills: 3,
        payments: 3,
        realized: '10',
        fees: '0.65',
        funding: '1.15',
        net: '10.5',
      },
    ])
  })

  it('totals each group on its own', () => {
    expect(summarize(fills, payments, (e) => e.venue).map((t) => [t.group, t.net])).toEqual([
      ['dydx', '9.4'],
      ['hyperliquid', '1.1'],
    ])
  })

  it('never adds amounts settled in different assets', () => {
    const other = realize([fill('buy', '1', '1', { fee: '2' as Decimal, asset: 'USDH', time: 1 })])
    expect(summarize([...fills, ...other], [], () => 'all').map((t) => [t.asset, t.fees])).toEqual([
      ['USDC', '0.65'],
      ['USDH', '2'],
    ])
  })
})
