import { describe, expect, it } from 'vitest'
import { parseDeposits } from './vault'

const HASH = `0x${'a'.repeat(64)}`

describe('parseDeposits', () => {
  it('reads a record stored before Tape kept the confirmation time and the seen mark', () => {
    const stored = [
      {
        chainId: 421614,
        amount: '25000000',
        fee: { expected: '0', max: '0' },
        message: null,
        hash: HASH,
        replacement: null,
        sentAt: 1_700_000_000_000,
        gasPaid: '21000',
        outcome: null,
      },
    ]
    expect(parseDeposits(JSON.stringify(stored))).toEqual([
      {
        chainId: 421614,
        amount: 25_000_000n,
        fee: { expected: 0n, max: 0n },
        message: null,
        hash: HASH,
        replacement: null,
        sentAt: 1_700_000_000_000,
        gasPaid: 21_000n,
        confirmedAt: null,
        outcome: null,
        seen: true,
      },
    ])
  })
})
