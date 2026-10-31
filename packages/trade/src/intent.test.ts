import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { wireDecimal } from '@tape/core/fixed'
import type { Decimals, Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import type { MarketSpec, TickRule } from '@tape/core/market'
import { priceTick } from '@tape/core/market'
import {
  buildIntent,
  checkCount,
  checkExitPrices,
  checkPrice,
  checkShare,
  checkSize,
  checkSkew,
  closeIntent,
  worstPrice,
} from './intent'
import type { IntentDraft } from './intent'
import type { Bps, Capabilities, Decimal, Position } from './types'
import { TRADING } from './index'

const hl: MarketSpec = {
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
const dydx: MarketSpec = { ...hl, venue: 'dydx', scale: { px: 0, qty: 4 }, tick: { kind: 'fixed', tick: 1 as Px } }

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

const errorsOf = (
  overrides: Partial<IntentDraft>,
  spec = hl,
  caps: Capabilities = TRADING.hyperliquid.capabilities,
) => {
  const built = buildIntent(spec, { ...draft, ...overrides }, caps)
  return built.ok ? {} : built.errors
}

describe('order intent', () => {
  it('rejects prices off the tick and sizes off the step', () => {
    expect(checkPrice(hl, '101234')).toBeUndefined()
    expect(checkPrice(hl, '101234.5')).toBe('Price must be a multiple of 1.0')
    expect(checkPrice(hl, '0')).toBe('Price must be above zero')
    expect(checkSize(dydx, '0.0001')).toBeUndefined()
    expect(checkSize(dydx, '0.00015')).toBe('At most 4 decimals')
  })

  it('caps a market buy at the slippage and keeps it on a Hyperliquid tick', () => {
    expect(worstPrice(hl, 'buy', 1_012_340 as Px, 100)).toBe(1_022_460)
    expect(checkPrice(hl, '102246')).toBeUndefined()
  })

  it('floors a market sell at the slippage and rounds it up onto the tick', () => {
    expect(worstPrice(dydx, 'sell', 80_000 as Px, 50)).toBe(79_600)
    expect(worstPrice(dydx, 'sell', 80_001 as Px, 50)).toBe(79_601)
  })

  it('refuses a stop loss on a venue that cannot send triggers', () => {
    for (const venue of [TRADING.dydx, TRADING.orderly]) {
      expect(errorsOf({ stopLoss: '70000' }, hl, venue.capabilities)).toEqual({ stopLoss: 'Not offered on this venue' })
      expect(
        errorsOf({ kind: 'market', bid: '79990', ask: '80010', stopLoss: '70000' }, hl, venue.capabilities),
      ).toEqual({ stopLoss: 'Not offered on this venue' })
    }
  })

  it("checks a limit's stop against its own price when the book has no side", () => {
    expect(errorsOf({ stopLoss: '81000' })).toEqual({ stopLoss: 'Must be below the price' })
    expect(errorsOf({ stopLoss: '79000' })).toEqual({})
    expect(errorsOf({ kind: 'market', price: '', stopLoss: '78000' })).toEqual({ stopLoss: 'No price on the book yet' })
  })

  it('accepts exits on the right side of a sell', () => {
    const sell = { side: 'sell', bid: '79990', ask: '80010' } as const
    expect(errorsOf({ ...sell, takeProfits: [{ price: '79000', share: '100' }], stopLoss: '81000' })).toEqual({})
    expect(errorsOf({ ...sell, takeProfits: [{ price: '79000', share: '100' }] })).toEqual({})
    expect(errorsOf({ ...sell, stopLoss: '81000' })).toEqual({})
  })

  it('refuses an exit at the order price', () => {
    const at = [{ price: '80000', share: '100' }]
    expect(errorsOf({ takeProfits: at })).toEqual({ takeProfit1: 'Must be above the price' })
    expect(errorsOf({ side: 'sell', takeProfits: at })).toEqual({ takeProfit1: 'Must be below the price' })
    expect(errorsOf({ stopLoss: '80000' })).toEqual({ stopLoss: 'Must be below the price' })
    expect(errorsOf({ side: 'sell', stopLoss: '80000' })).toEqual({ stopLoss: 'Must be above the price' })
  })

  it('accepts an order worth exactly the venue minimum', () => {
    expect(errorsOf({ price: '100000', size: '0.0001' }, { ...hl, minNotional: 100 as Px })).toEqual({})
  })

  it('refuses an empty, unreadable or off-tick field instead of throwing', () => {
    const ten = { ...hl, minNotional: 100 as Px }
    expect(errorsOf({ price: '' })).toEqual({ price: 'Enter a price' })
    expect(errorsOf({ size: '' })).toEqual({ size: 'Enter a size' })
    expect(errorsOf({ price: 'abc' })).toEqual({ price: 'Not a number' })
    expect(errorsOf({ size: 'abc' })).toEqual({ size: 'Not a number' })
    expect(errorsOf({ price: '80000.55' })).toEqual({ price: 'At most 1 decimals' })
    expect(errorsOf({ size: '0.000015' })).toEqual({ size: 'At most 5 decimals' })
    expect(errorsOf({ size: '0.000015' }, ten)).toEqual({ size: 'At most 5 decimals' })
    expect(errorsOf({ price: '101234.5' })).toEqual({ price: 'Price must be a multiple of 1.0' })
    expect(errorsOf({ stopLoss: '71234.5' })).toEqual({ stopLoss: 'Price must be a multiple of 1.0' })
    expect(errorsOf({ size: '0' })).toEqual({ size: 'Minimum is 0.00001' })
  })

  it("takes from 2 to the venue's max orders and a skew from 0.1 to 10, both ends included", () => {
    expect(checkCount('2', 20)).toBeUndefined()
    expect(checkCount('20', 20)).toBeUndefined()
    expect(checkSkew('0.1')).toBeUndefined()
    expect(checkSkew('10')).toBeUndefined()
    expect(checkSkew('10.1')).toBe('Between 0.1 and 10')
    expect(checkSkew('0.09')).toBe('Between 0.1 and 10')
  })
})

describe('order intent exits and time in force', () => {
  const touch = { kind: 'market', price: '', bid: '79990', ask: '80010' } as const

  it('takes a take profit share from 1 to 100%, whole percents only', () => {
    expect(checkShare('1')).toBeUndefined()
    expect(checkShare('100')).toBeUndefined()
    for (const share of ['0', '101', '1.5', 'abc', '']) expect(checkShare(share)).toBe('From 1 to 100%')
  })

  it('names the size a short take profit leaves, on the step', () => {
    const coarse = { ...hl, step: 10 as Qty }
    expect(errorsOf({ takeProfits: [{ price: '82000', share: '60' }] }, coarse)).toEqual({
      takeProfits: 'Sizes add up to 60%, so 0.00040 BTC has no take profit',
    })
  })

  it('reports only the size while it is invalid, even with take profits that add up', () => {
    const halves = [
      { price: '81000', share: '50' },
      { price: '82000', share: '50' },
    ]
    expect(errorsOf({ size: '', takeProfits: halves })).toEqual({ size: 'Enter a size' })
  })

  it('checks a take profit with no stop loss', () => {
    expect(
      checkExitPrices(hl, { ...touch, side: 'buy', takeProfits: [{ price: '80000', share: '100' }], stopLoss: '' }),
    ).toStrictEqual({ takeProfit1: 'Must be above the ask' })
  })

  it('checks a market order against the touch, not a stale price left in the field', () => {
    const stale = { ...touch, side: 'buy', price: '79000', stopLoss: '' } as const
    expect(checkExitPrices(hl, { ...stale, takeProfits: [{ price: '79500', share: '100' }] })).toEqual({
      takeProfit1: 'Must be above the ask',
    })
  })

  it('treats a touch it cannot read as no price on the book', () => {
    const exits = { ...touch, side: 'buy', bid: '79990.55', takeProfits: [], stopLoss: '79000' } as const
    expect(checkExitPrices(hl, exits)).toEqual({ stopLoss: 'No price on the book yet' })
  })

  it('reports only the price while a limit has none, even with a take profit', () => {
    expect(errorsOf({ price: 'abc', takeProfits: [{ price: '82000', share: '100' }] })).toEqual({
      price: 'Not a number',
    })
  })

  it('refuses a time in force the venue does not offer on a resting order only', () => {
    const gtcOnly: Capabilities = { ...TRADING.hyperliquid.capabilities, tif: ['gtc'] }
    expect(errorsOf({ tif: 'post-only' }, hl, gtcOnly)).toEqual({ tif: 'Not offered on this venue' })
    const scale = { kind: 'scale', tif: 'post-only', start: '79000', end: '78000', count: '2' } as const
    expect(errorsOf(scale, hl, gtcOnly)).toEqual({ tif: 'Not offered on this venue' })
    expect(errorsOf({ ...touch, tif: 'post-only' }, hl, gtcOnly)).toEqual({})
  })
})

describe('order intent properties', () => {
  const markets = fc
    .tuple(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 8 }), fc.integer({ min: 1, max: 1_000 }))
    .chain(([px, qty, step]) =>
      fc
        .oneof(
          fc.integer({ min: 1, max: 10 ** px }).map((tick): TickRule => ({ kind: 'fixed', tick: tick as Px })),
          fc.constant<TickRule>({ kind: 'sigfig', figures: 5 }),
        )
        .map((tick): MarketSpec => ({
          ...hl,
          scale: { px: px as Decimals, qty: qty as Decimals },
          tick,
          step: step as Qty,
        })),
    )
  const validPrice = ({ tick, scale }: MarketSpec) =>
    tick.kind === 'fixed'
      ? fc.integer({ min: 1, max: 10_000_000 }).map((ticks) => ticks * tick.tick)
      : fc.oneof(
          fc
            .tuple(fc.integer({ min: 1, max: 99_999 }), fc.integer({ min: 0, max: 6 }))
            .map(([figures, power]) => figures * 10 ** power),
          fc.integer({ min: 1, max: 10_000_000 }).map((whole) => whole * 10 ** scale.px),
        )

  it('closes a position with a reduce-only market order on the other side for its exact size, or not at all', () => {
    const held = markets.chain((market) =>
      fc.record({
        market: fc.constant(market),
        side: fc.constantFrom('long' as const, 'short' as const),
        units: fc.oneof(
          fc.integer({ min: 1, max: 1_000_000 }).map((steps) => steps * market.step),
          fc.integer({ min: 0, max: 10 ** 12 }),
        ),
        negative: fc.boolean(),
        zeros: fc.integer({ min: 0, max: 8 }),
        finerDigit: fc.option(fc.integer({ min: 1, max: 9 }), { freq: 4 }),
      }),
    )
    fc.assert(
      fc.property(
        held,
        fc.integer({ min: 0, max: 1_000 }),
        ({ market, side, units, negative, zeros, finerDigit }, slippage) => {
          const wire = wireDecimal(units as Qty, market.scale.qty)
          const padded = `${wire}${wire.includes('.') || zeros === 0 ? '' : '.'}${'0'.repeat(zeros)}`
          const size = `${negative ? '-' : ''}${padded}`
          const position: Position = {
            symbol: market.venueSymbol,
            side,
            size: (finerDigit === null
              ? size
              : `${size}${size.includes('.') ? '' : '.'}00000000${finerDigit}`) as Decimal,
            entry: '1' as Decimal,
            unrealizedPnl: '0' as Decimal,
            liquidation: null,
            leverage: null,
          }
          const onStep = finerDigit === null && units >= market.step && units % market.step === 0
          const intent = closeIntent(market, position, slippage as Bps)
          expect(
            intent && {
              side: intent.side,
              size: intent.size,
              reduceOnly: intent.reduceOnly,
              order: intent.order,
              triggers: intent.triggers,
            },
          ).toEqual(
            onStep
              ? {
                  side: side === 'long' ? 'sell' : 'buy',
                  size: units,
                  reduceOnly: true,
                  order: { kind: 'market', slippage },
                  triggers: { takeProfits: [], stopLoss: null },
                }
              : null,
          )
        },
      ),
    )
  })

  it('caps a taking order at the slippage on the nearest valid tick inside it', () => {
    const touch = markets.chain((market) =>
      fc.record({
        market: fc.constant(market),
        side: fc.constantFrom('buy' as const, 'sell' as const),
        far: validPrice(market),
        slippage: fc.integer({ min: 0, max: 1_000 }),
      }),
    )
    fc.assert(
      fc.property(touch, ({ market, side, far, slippage }) => {
        const limit = worstPrice(market, side, far as Px, slippage)
        const moved = (far * (10_000 + (side === 'buy' ? slippage : -slippage))) / 10_000
        const passive = side === 'buy' ? 1 : -1
        expect(checkPrice(market, wireDecimal(limit, market.scale.px))).toBeUndefined()
        expect(passive * (limit - moved)).toBeLessThanOrEqual(0)
        expect(Math.abs(limit - moved)).toBeLessThan(priceTick(market, Math.ceil(moved) as Px))
      }),
    )
  })
})
