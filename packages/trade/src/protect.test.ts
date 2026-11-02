import { describe, expect, it } from 'vitest'
import { parsePx } from '@tape/core/fixed'
import type { Px, Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { checkProtect, exitDetail, notePrice, positionLegs, protectIntent } from './protect'
import { toDecimal } from './types'
import type { OpenOrder, OrderExit, OrderRef, Position } from './types'

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
const px = (text: string) => parsePx(text, btc.scale)
const order = (ref: string, symbol: string, exit: OrderExit | null): OpenOrder => ({
  ref: ref as OrderRef,
  symbol,
  side: 'sell',
  kind: exit ? 'Trigger' : 'Limit',
  px: toDecimal('90000'),
  size: toDecimal(exit?.whole ? '0' : '0.001'),
  reduceOnly: exit !== null,
  placedAt: 0,
  cancelable: true,
  exit,
})
const orders = [
  order('3:1', 'BTC', { kind: 'tp', whole: true }),
  order('3:2', 'BTC', { kind: 'tp', whole: false }),
  order('3:3', 'BTC', { kind: 'sl', whole: true }),
  order('4:4', 'ETH', { kind: 'tp', whole: true }),
  order('3:5', 'BTC', null),
]
const long: Position = {
  symbol: 'BTC',
  side: 'long',
  size: toDecimal('0.0025'),
  entry: toDecimal('80000'),
  mark: null,
  unrealizedPnl: toDecimal('1'),
  liquidation: null,
  leverage: null,
}

describe('the legs that stand for a position', () => {
  it('takes the whole-position legs where the venue keeps them, else the legs with a size', () => {
    expect(positionLegs(orders, 'BTC', 'tp', { wholeExits: true })).toEqual(['3:1'])
    expect(positionLegs(orders, 'BTC', 'tp', { wholeExits: false })).toEqual(['3:2'])
    expect(positionLegs(orders, 'BTC', 'sl', { wholeExits: true })).toEqual(['3:3'])
    expect(positionLegs(orders, 'SOL', 'tp', { wholeExits: true })).toEqual([])
  })
})

describe('a position take profit and stop loss', () => {
  it('sets a leg over the one it replaces, removes the one there, and keeps a kind with nothing to remove', () => {
    const intent = protectIntent(
      btc,
      long,
      orders,
      { wholeExits: true },
      {
        takeProfit: { kind: 'set', px: px('95000') },
        stopLoss: { kind: 'remove' },
      },
    )
    expect(intent).toMatchObject({
      position: 'long',
      size: 250,
      takeProfit: { kind: 'set', px: px('95000'), legs: ['3:1'] },
      stopLoss: { kind: 'remove', legs: ['3:3'] },
    })
    const bare = protectIntent(
      btc,
      long,
      [],
      { wholeExits: true },
      {
        takeProfit: { kind: 'keep' },
        stopLoss: { kind: 'remove' },
      },
    )
    expect([bare.takeProfit, bare.stopLoss]).toEqual([{ kind: 'keep' }, { kind: 'keep' }])
  })

  it('keeps the legs there when asked to keep them', () => {
    const intent = protectIntent(
      btc,
      long,
      orders,
      { wholeExits: true },
      {
        takeProfit: { kind: 'keep' },
        stopLoss: { kind: 'keep' },
      },
    )
    expect([intent.takeProfit, intent.stopLoss]).toEqual([{ kind: 'keep' }, { kind: 'keep' }])
  })

  it('gives each set leg its own client id', () => {
    const intent = protectIntent(
      btc,
      long,
      [],
      { wholeExits: true },
      {
        takeProfit: { kind: 'set', px: px('95000') },
        stopLoss: { kind: 'set', px: px('70000') },
      },
    )
    if (intent.takeProfit.kind !== 'set' || intent.stopLoss.kind !== 'set') throw new Error('not set')
    expect(intent.takeProfit.clientId).not.toBe(intent.stopLoss.clientId)
  })

  it('wants a take profit past the far touch and a stop loss short of the near one', () => {
    const book = { bid: px('80000'), ask: px('80010') }
    const set = (text: string) => ({ kind: 'set', px: px(text) }) as const
    expect(checkProtect('long', book, { takeProfit: set('80005'), stopLoss: set('80001') })).toEqual({
      takeProfit: 'Must be above the ask',
      stopLoss: 'Must be below the bid',
    })
    expect(checkProtect('long', book, { takeProfit: set('80011'), stopLoss: set('79999') })).toEqual({})
    expect(checkProtect('short', book, { takeProfit: set('80005'), stopLoss: set('80009') })).toEqual({
      takeProfit: 'Must be below the bid',
      stopLoss: 'Must be above the ask',
    })
    expect(
      checkProtect('short', { bid: null, ask: null }, { takeProfit: { kind: 'keep' }, stopLoss: { kind: 'remove' } }),
    ).toEqual({})
  })
})

describe('protect notes', () => {
  it('groups the thousands of a price and drops its trailing zeros', () => {
    expect(notePrice(800_000 as Px, btc.scale)).toBe('80,000')
    expect(notePrice(950_005 as Px, btc.scale)).toBe('95,000.5')
    expect(notePrice(1_234_567 as Px, { px: 2, qty: 4 })).toBe('12,345.67')
    expect(notePrice(5 as Px, btc.scale)).toBe('0.5')
  })

  it('reads each change in one sentence', () => {
    expect(exitDetail([`take profit at ${notePrice(800_000 as Px, btc.scale)}`, 'stop loss removed'])).toBe(
      'Take profit at 80,000, stop loss removed',
    )
    expect(exitDetail([])).toBe('Nothing to change')
  })
})
