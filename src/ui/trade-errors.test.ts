import { describe, expect, it } from 'vitest'
import type { TradeError } from '@tape/trade/types'
import { readFailure } from './trade-errors'

const KINDS: Record<TradeError['kind'], true> = {
  'wallet-rejected': true,
  'needs-setup': true,
  'no-account': true,
  'insufficient-margin': true,
  'invalid-order': true,
  rejected: true,
  'rate-limited': true,
  unsupported: true,
  unreachable: true,
  'unknown-outcome': true,
  unexpected: true,
}

describe('read failure', () => {
  it('never speaks of sending or of an order, whatever the error', () => {
    for (const kind of Object.keys(KINDS) as TradeError['kind'][])
      expect(readFailure({ kind, detail: '' })).not.toMatch(/\b(?:send|sent|order)\b/i)
  })
})
