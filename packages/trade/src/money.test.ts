import { describe, expect, it } from 'vitest'
import { amount, divide, format, multiply } from './money'

describe('money', () => {
  it('reads signed and exponent decimals exactly', () => {
    expect(format(amount('-0.000123'), 6)).toBe('-0.000123')
    expect(format(amount('1e-7'), 7)).toBe('0.0000001')
    expect(format(amount('118250.5'), 2)).toBe('118250.50')
  })

  it('refuses text that is not a decimal', () => {
    expect(() => amount('12,5')).toThrow()
    expect(() => amount('')).toThrow()
  })

  it('refuses an amount finer than 18 places', () => {
    expect(() => amount('0.0000000000000000001')).toThrow(RangeError)
    expect(format(amount('0.000000000000000001'), 18)).toBe('0.000000000000000001')
  })

  it('multiplies without float error', () => {
    expect(format(multiply(amount('0.1'), amount('0.2')), 6)).toBe('0.020000')
    expect(format(multiply(amount('-3.5'), amount('118250.1')), 2)).toBe('-413875.35')
  })

  it('rounds half away from zero when it drops places', () => {
    expect(format(amount('0.0000005'), 6)).toBe('0.000001')
    expect(format(amount('-0.0000005'), 6)).toBe('-0.000001')
    expect(format(amount('0.0000004'), 6)).toBe('0.000000')
    expect(format(divide(amount('2'), amount('3')), 6)).toBe('0.666667')
  })

  it('never writes a negative zero', () => {
    expect(format(amount('-0.0000001'), 6)).toBe('0.000000')
  })
})
