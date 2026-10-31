import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { wireDecimal } from '@tape/core/fixed'
import type { Decimals, Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import type { MarketSpec, TickRule } from '@tape/core/market'
import { priceTick } from '@tape/core/market'
import { buildIntent, checkPrice, checkSize, closeIntent, worstPrice } from './intent'
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
      ? fc.integer({ min: 1, max: 10_000_000 }).map((k) => k * tick.tick)
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
