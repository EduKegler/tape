import { describe, expect, it } from 'vitest'
import { realize } from './history'
import type { HistoryFill } from './history'
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
