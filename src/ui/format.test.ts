import { describe, expect, it } from 'vitest'
import { formatAgo, formatPct, formatSigned } from './format'

describe('formatPct', () => {
  it('shows a change that rounds to zero with no sign', () => {
    expect([formatPct(-0.001), formatPct(0), formatPct(0.004), formatPct(-0.00001, 4)]).toEqual([
      '0.00%',
      '0.00%',
      '0.00%',
      '0.0000%',
    ])
  })
})

describe('formatSigned', () => {
  it('signs gains and losses and groups thousands', () => {
    expect(formatSigned(738)).toBe('+738.00')
    expect(formatSigned(-1354.5)).toBe('-1,354.50')
    expect(formatSigned(0)).toBe('0.00')
  })
})

describe('formatAgo', () => {
  const now = 1_000_000_000
  it('names the largest whole unit', () => {
    expect(formatAgo(now - 40_000, now)).toBe('40 s')
    expect(formatAgo(now - 24 * 60_000 - 5_000, now)).toBe('24 min')
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3 h')
    expect(formatAgo(now - 2 * 86_400_000, now)).toBe('2 d')
    expect(formatAgo(now + 5_000, now)).toBe('0 s')
  })
})
