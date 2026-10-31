import { describe, expect, it } from 'vitest'
import { formatPct } from './format'

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
