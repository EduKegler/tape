import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parsePx, parseQty } from '@tape/core/fixed'
import type { Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import {
  checkStopLoss,
  closeShare,
  isMovable,
  keptAfter,
  leverageOf,
  marginOf,
  nearestTick,
  orderKindLabel,
  pnlAt,
  priceDecimals,
  priceForRoe,
  roeOf,
} from './position'
import { toDecimal } from './types'
import type { Position } from './types'

const eth: MarketSpec = {
  key: marketKey('hyperliquid', 'ETH' as Base),
  venue: 'hyperliquid',
  base: 'ETH' as Base,
  quote: 'USDC',
  kind: 'perp',
  venueSymbol: 'ETH',
  scale: { px: 2, qty: 4 },
  tick: { kind: 'fixed', tick: 1 as Px },
  step: 1 as Qty,
}
const holding = (side: Position['side'], size: string, entry: string, leverage: string | null): Position => ({
  symbol: 'ETH',
  side,
  size: toDecimal(size),
  entry: toDecimal(entry),
  mark: null,
  unrealizedPnl: toDecimal('0'),
  liquidation: null,
  leverage,
})
const long = holding('long', '2', '3000', '10x cross')
const short = holding('short', '-0.5', '80000', '20x isolated')

describe('position money', () => {
  it('reads the leverage number Hyperliquid sends', () => {
    expect(leverageOf(long)).toBe(10)
    expect(leverageOf(short)).toBe(20)
    expect(leverageOf(holding('long', '1', '1', null))).toBeNull()
  })

  it('counts the profit of closing at a price on either side', () => {
    expect(pnlAt(long, 3150)).toBe(300)
    expect(pnlAt(long, 2900)).toBe(-200)
    expect(pnlAt(short, 78000)).toBe(1000)
    expect(pnlAt(short, 80400)).toBe(-200)
  })

  it('counts the return on the opening margin', () => {
    expect(marginOf(long)).toBe(600)
    expect(roeOf(long, 300)).toBe(50)
    expect(marginOf(short)).toBe(2000)
    expect(roeOf(short, -200)).toBe(-10)
    expect(roeOf(holding('long', '1', '1', null), 5)).toBeNull()
  })

  // Hyperliquid's clearinghouseState docs: szi 0.0335, entryPx 2986.3, 20x, unrealizedPnl -0.0134, returnOnEquity -0.0026789.
  it("matches Hyperliquid's documented returnOnEquity", () => {
    const documented = holding('long', '0.0335', '2986.3', '20x cross')
    expect(roeOf(documented, -0.0134)! / 100).toBeCloseTo(-0.0026789, 7)
  })
})

describe('price for a return', () => {
  const px = (text: string) => parsePx(text, eth.scale)

  it('finds the price that returns a percent of the margin', () => {
    expect(priceForRoe(eth, long, 25)).toBe(px('3075'))
    expect(priceForRoe(eth, long, -25)).toBe(px('2925'))
    expect(priceForRoe(eth, holding('short', '-1', '3000', '10x cross'), 10)).toBe(px('2970'))
  })

  it('rounds onto the tick on the side the close trades', () => {
    // 3000 + 0.1 * (3 * 3000 / 7) / 3 = 3042.857..., a sell rounds up and a buy down.
    expect(priceForRoe(eth, holding('long', '3', '3000', '7x cross'), 10)).toBe(px('3042.86'))
    expect(priceForRoe(eth, holding('short', '-3', '3000', '7x cross'), -10)).toBe(px('3042.85'))
  })

  it('has no price without a leverage or below zero', () => {
    expect(priceForRoe(eth, holding('long', '1', '3000', null), 10)).toBeNull()
    expect(priceForRoe(eth, holding('short', '-1', '3000', '1x cross'), 100)).toBeNull()
  })

  it('lands within one tick past the asked return', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Position['side']>('long', 'short'),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 100_000, max: 10_000_000 }),
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: -90, max: 90 }),
        (side, sizeUnits, entryUnits, leverage, percent) => {
          const size = (sizeUnits / 10 ** eth.scale.qty).toFixed(eth.scale.qty)
          const entry = (entryUnits / 10 ** eth.scale.px).toFixed(eth.scale.px)
          const position = holding(side, side === 'long' ? size : `-${size}`, entry, `${leverage}x cross`)
          const price = priceForRoe(eth, position, percent)!
          const reached = roeOf(position, pnlAt(position, price / 10 ** eth.scale.px))!
          const tickWorth = roeOf(position, pnlAt(position, Number(entry) + 0.01) - pnlAt(position, Number(entry)))!
          expect(reached).toBeGreaterThanOrEqual(percent - 1e-6)
          expect(reached - percent).toBeLessThanOrEqual(Math.abs(tickWorth) + 1e-6)
        },
      ),
    )
  })
})

describe('stop loss and liquidation', () => {
  const px = (text: string) => parsePx(text, eth.scale)
  const at = (side: Position['side'], liquidation: string | null) => ({
    side,
    liquidation: liquidation === null ? null : toDecimal(liquidation),
  })

  it('warns of a stop at or past the liquidation price', () => {
    expect(checkStopLoss(at('long', '2700'), px('2650'), eth.scale.px)).toBe('Past liquidation at 2700')
    expect(checkStopLoss(at('long', '2700'), px('2700'), eth.scale.px)).toBe('Past liquidation at 2700')
    expect(checkStopLoss(at('long', '2700'), px('2750'), eth.scale.px)).toBeUndefined()
    expect(checkStopLoss(at('short', '3300'), px('3300'), eth.scale.px)).toBe('Past liquidation at 3300')
    expect(checkStopLoss(at('short', '3300'), px('3250'), eth.scale.px)).toBeUndefined()
    expect(checkStopLoss(at('long', null), px('1'), eth.scale.px)).toBeUndefined()
  })
})

describe('close share', () => {
  const qty = (text: string) => parseQty(text, eth.scale)

  it('takes a share of the size, floored to the step', () => {
    expect(closeShare(eth, long, 25)).toBe(qty('0.5'))
    expect(closeShare(eth, short, 50)).toBe(qty('0.25'))
    expect(closeShare(eth, holding('long', '0.0003', '3000', null), 50)).toBe(qty('0.0001'))
    expect(closeShare({ ...eth, step: 10 as Qty }, holding('long', '0.0125', '3000', null), 50)).toBe(qty('0.006'))
  })

  it('takes the whole size at 100, on the step or not', () => {
    expect(closeShare({ ...eth, step: 10 as Qty }, holding('long', '0.0125', '3000', null), 100)).toBe(qty('0.0125'))
  })

  it('keeps what the close leaves', () => {
    expect(keptAfter(eth, long, qty('0.5'))).toBe(qty('1.5'))
    expect(keptAfter(eth, short, qty('0.5'))).toBe(qty('0'))
  })
})

describe('orders', () => {
  const order = (kind: string, px: string | null, exit: 'tp' | null = null) => ({
    kind,
    px: px === null ? null : toDecimal(px),
    exit: exit ? { kind: exit, whole: true } : null,
  })

  it('moves exits and resting limits only', () => {
    expect(isMovable(order('Limit', '3000'))).toBe(true)
    expect(isMovable(order('LIMIT', '3000'))).toBe(true)
    expect(isMovable(order('POST_ONLY', '3000'))).toBe(true)
    expect(isMovable(order('Take Profit Market', '3500', 'tp'))).toBe(true)
    expect(isMovable(order('Stop Market', '2500'))).toBe(false)
    expect(isMovable(order('MARKET', null))).toBe(false)
  })

  it('names each venue order type in sentence case', () => {
    expect(orderKindLabel('Stop Market')).toBe('Stop market')
    expect(orderKindLabel('Take Profit Market')).toBe('Take profit market')
    expect(orderKindLabel('STOP_LIMIT')).toBe('Stop limit')
    expect(orderKindLabel('TAKE_PROFIT')).toBe('Take profit')
    expect(orderKindLabel('Limit')).toBe('Limit')
  })
})

describe('ticks', () => {
  const btc: MarketSpec = { ...eth, scale: { px: 1, qty: 5 }, tick: { kind: 'sigfig', figures: 5 } }

  it('snaps to the nearest tick', () => {
    expect(nearestTick(eth, 3042.857)).toBe(parsePx('3042.86', eth.scale))
    expect(nearestTick(eth, 3042.852)).toBe(parsePx('3042.85', eth.scale))
    // Five figures at 78,632 leave a whole-dollar tick.
    expect(nearestTick(btc, 78632.4)).toBe(parsePx('78632', btc.scale))
    expect(nearestTick(btc, 78636.5)).toBe(parsePx('78637', btc.scale))
  })

  it('never snaps to zero', () => {
    expect(nearestTick(eth, 0.001)).toBe(parsePx('0.01', eth.scale))
  })

  it('shows the decimals the tick leaves', () => {
    expect(priceDecimals(eth, parsePx('3042.86', eth.scale))).toBe(2)
    expect(priceDecimals(btc, parsePx('78632', btc.scale))).toBe(0)
    expect(priceDecimals(btc, parsePx('3520.5', btc.scale))).toBe(1)
  })
})
