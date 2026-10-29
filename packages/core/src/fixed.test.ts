import { describe, expect, it } from 'vitest'
import {
  DecimalError,
  formatMid,
  formatNotional,
  formatPx,
  formatQty,
  notional,
  parsePx,
  parseQty,
  rescalePx,
  spreadBps,
  toDisplayFloat,
  wireDecimal,
} from './fixed'

const btc = { px: 2, qty: 5 } as const

describe('parsePx', () => {
  it('reads venue strings at the market scale', () => {
    expect(parsePx('80798.01000000', btc)).toBe(8079801)
    expect(parsePx('80798', btc)).toBe(8079800)
    expect(parsePx('0.5', btc)).toBe(50)
    expect(parsePx('80999.0', { px: 1, qty: 5 })).toBe(809990)
  })

  it('rejects digits the market cannot have', () => {
    expect(() => parsePx('80798.015', btc)).toThrow(DecimalError)
    expect(() => parsePx('1e5', btc)).toThrow(DecimalError)
    expect(() => parsePx('-1', btc)).toThrow(DecimalError)
    expect(() => parsePx('', btc)).toThrow(DecimalError)
    expect(() => parsePx('99999999999999999', btc)).toThrow(DecimalError)
  })

  it('never goes through float', () => {
    expect(parseQty('0.30000', btc)).toBe(30000)
    expect(parseQty('0.1', btc) + parseQty('0.2', btc)).toBe(parseQty('0.3', btc))
  })
})

describe('parseQty', () => {
  it('reads zero as zero', () => {
    expect(parseQty('0.00000000', btc)).toBe(0)
    expect(parseQty('0', btc)).toBe(0)
  })
})

describe('format', () => {
  it('formats exactly at the requested decimals', () => {
    expect(formatPx(parsePx('80798.01', btc), btc)).toBe('80,798.01')
    expect(formatPx(parsePx('80798.01', btc), btc, 0)).toBe('80,798')
    expect(formatQty(parseQty('0.00056', btc), btc)).toBe('0.00056')
    expect(formatQty(parseQty('12', btc), btc, 3)).toBe('12.000')
  })

  it('prints the mid with an extra digit when the sum is odd', () => {
    expect(formatMid(parsePx('100.01', btc), parsePx('100.02', btc), btc)).toBe('100.015')
    expect(formatMid(parsePx('100.00', btc), parsePx('100.02', btc), btc)).toBe('100.01')
  })
})

describe('cross-scale math', () => {
  it('computes notional exactly in bigint', () => {
    const value = notional(parsePx('80000.01', btc), parseQty('2.5', btc))
    expect(value).toBe(2000000250000n)
    expect(formatNotional(value, btc)).toBe('200,000.02')
  })

  it('rescales to a finer scale', () => {
    expect(rescalePx(parsePx('80999', { px: 0, qty: 4 }), 0, 2)).toBe(8099900)
    expect(() => rescalePx(parsePx('100000000', { px: 0, qty: 4 }), 0, 8)).toThrow(DecimalError)
  })

  it('computes spread in basis points', () => {
    expect(spreadBps(parsePx('100.00', btc), parsePx('100.10', btc))).toBe('9.99')
    expect(spreadBps(parsePx('81029.43', btc), parsePx('81029.44', btc))).toBe('0.00')
  })

  it('leaves the integer domain only through toDisplayFloat', () => {
    expect(toDisplayFloat(parsePx('80798.01', btc), 2)).toBe(80798.01)
  })
})

describe('wireDecimal', () => {
  it('writes the shortest exact decimal a venue accepts', () => {
    expect(wireDecimal(parsePx('80798.10', btc), btc.px)).toBe('80798.1')
    expect(wireDecimal(parsePx('80798', btc), btc.px)).toBe('80798')
    expect(wireDecimal(parseQty('0.00120', btc), btc.qty)).toBe('0.0012')
    expect(wireDecimal(0n, 6)).toBe('0')
    expect(wireDecimal(-1500n, 3)).toBe('-1.5')
  })
})
