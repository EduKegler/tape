import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  DecimalError,
  decimalsOf,
  formatMid,
  formatNotional,
  formatPx,
  formatQty,
  notional,
  parsePx,
  parseQty,
  plainDecimal,
  rescalePx,
  spreadBps,
  toDisplayFloat,
  wireDecimal,
} from './fixed'
import type { Decimals, Px } from './fixed'

const btc = { px: 2, qty: 5 } as const

const decimals = fc.integer({ min: 0, max: 8 }).map((d) => d as Decimals)
const units = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })

function venueString(value: number, scale: number, padding: number, trimmed: boolean): string {
  const digits = String(value).padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = digits.slice(digits.length - scale) + '0'.repeat(padding)
  const shown = trimmed ? fraction.replace(/(?<!0)0+$/, '') : fraction
  return shown ? `${whole}.${shown}` : whole
}

function grouped(plain: string): string {
  const [whole = '', fraction] = plain.split('.')
  const groups: string[] = []
  for (let end = whole.length; end > 0; end -= 3) groups.unshift(whole.slice(Math.max(0, end - 3), end))
  return fraction === undefined ? groups.join(',') : `${groups.join(',')}.${fraction}`
}

describe('decimal properties', () => {
  it('reads any venue string at the market scale as its exact units', () => {
    fc.assert(
      fc.property(units, decimals, fc.integer({ min: 0, max: 8 }), fc.boolean(), (value, scale, padding, trimmed) => {
        expect(parsePx(venueString(value, scale, padding, trimmed), { px: scale, qty: 0 })).toBe(value)
      }),
    )
  })

  it('refuses a nonzero digit beyond the market scale', () => {
    fc.assert(
      fc.property(
        units,
        decimals,
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 1, max: 9 }),
        (value, scale, zeros, extra) => {
          fc.pre(scale < 8)
          const tooFine = `${venueString(value, scale, 0, false)}${scale === 0 ? '.' : ''}${'0'.repeat(zeros)}${extra}`
          expect(() => parsePx(tooFine, { px: scale, qty: 0 })).toThrow(new DecimalError(tooFine, 'precision'))
        },
      ),
    )
  })

  it('writes the shortest wire decimal that reads back the same', () => {
    fc.assert(
      fc.property(units, decimals, (value, scale) => {
        const wire = wireDecimal(value as Px, scale)
        expect(wire).toMatch(/^(0|[1-9]\d*)(\.\d*[1-9])?$/)
        expect(parsePx(wire, { px: scale, qty: 0 })).toBe(value)
      }),
    )
  })

  it('formats every scale digit with grouping, and reads back once it goes', () => {
    fc.assert(
      fc.property(units, decimals, (value, scale) => {
        const shown = formatPx(value as Px, { px: scale, qty: 0 })
        expect(shown).toBe(grouped(venueString(value, scale, 0, false)))
        expect(parsePx(shown.replaceAll(',', ''), { px: scale, qty: 0 })).toBe(value)
      }),
    )
  })

  it('cuts digits below the scale toward zero', () => {
    fc.assert(
      fc.property(units, decimals, decimals, (value, scale, shown) => {
        fc.pre(shown < scale)
        const full = venueString(value, scale, 0, false)
        const cut = shown === 0 ? full.slice(0, full.indexOf('.')) : full.slice(0, full.indexOf('.') + 1 + shown)
        expect(formatPx(value as Px, { px: scale, qty: 0 }, shown)).toBe(grouped(cut))
      }),
    )
  })

  it('rescales a price on a coarser scale to its exact steps there', () => {
    fc.assert(
      fc.property(units, decimals, decimals, (seed, from, to) => {
        fc.pre(to < from)
        const step = 10n ** BigInt(from - to)
        const steps = BigInt(seed) / step
        expect(rescalePx(Number(steps * step) as Px, from, to)).toBe(Number(steps))
      }),
    )
  })

  it('refuses to rescale to a coarser scale a price between its steps', () => {
    fc.assert(
      fc.property(units, decimals, decimals, (value, from, to) => {
        fc.pre(to < from && BigInt(value) % 10n ** BigInt(from - to) !== 0n)
        expect(() => rescalePx(value as Px, from, to)).toThrow(new DecimalError(String(value), 'precision'))
      }),
    )
  })
})

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

  it('rescales to a coarser scale without a float remainder', () => {
    expect(rescalePx(parsePx('823678.362', { px: 8, qty: 0 }), 8, 3)).toBe(823678362)
  })

  it('computes spread in basis points, truncated to 2 dp', () => {
    expect(spreadBps(parsePx('100.00', btc), parsePx('100.10', btc))).toBe('9.99')
    expect(spreadBps(parsePx('81029.43', btc), parsePx('81029.44', btc))).toBe('0.00')
  })

  it('leaves the spread empty when bid and ask are both zero', () => {
    expect(spreadBps(parsePx('0', btc), parsePx('0', btc))).toBe('')
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

describe('decimalsOf', () => {
  it('reads the decimals a venue increment implies, trailing zeros or not', () => {
    // Binance BTCUSDT tickSize and stepSize, and dYdX ETH-USD and BTC-USD tickSize, from the recorded frames.
    expect(['0.01000000', '0.00001000', '0.1', '1'].map(decimalsOf)).toEqual([2, 5, 1, 0])
  })
})

describe('plainDecimal', () => {
  it('expands JSON exponents without a float', () => {
    expect(plainDecimal('1e-7')).toBe('0.0000001')
    expect(plainDecimal('-2.5E+3')).toBe('-2500')
    expect(plainDecimal('100.50')).toBe('100.5')
  })

  it('expands every number form JSON allows into a plain decimal, and refuses anything else as a DecimalError', () => {
    expect(['1e5', '1e-10', '1e-1', '0.05e3', '1.2300e2'].map(plainDecimal)).toEqual([
      '100000',
      '0.0000000001',
      '0.1',
      '50',
      '123',
    ])
    expect(() => plainDecimal('12,5')).toThrow(new DecimalError('12,5', 'syntax'))
  })
})
