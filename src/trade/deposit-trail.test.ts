import { describe, expect, it } from 'vitest'
import type { DepositProgress } from '@tape/trade/deposit'
import { FOLLOW_FOR_MS, byUrgency, creditDueIn, depositStatus, followed, waits } from './deposit-trail'
import type { Followed } from './deposit-trail'
import type { DepositRecord } from './vault'

const SENT = 1_700_000_000_000
const ROUTE = { eta: { typical: 60, worst: 600 } }
const MINUTE = 60_000

const record = (patch: Partial<DepositRecord> = {}): DepositRecord => ({
  chainId: 421614,
  amount: 25_000_000n,
  fee: { expected: 0n, max: 0n },
  message: null,
  hash: `0x${'a'.repeat(64)}`,
  replacement: null,
  sentAt: SENT,
  gasPaid: null,
  confirmedAt: null,
  outcome: null,
  seen: false,
  ...patch,
})
const credited = { stage: 'credited', amount: 25_000_000n, at: SENT + MINUTE, receipt: '0xbeef' } as const
const relaying: DepositProgress = { stage: 'relaying', detail: 'The bridge is signing' }
const idle = { data: undefined, pending: false }

describe('depositStatus', () => {
  it.each<[string, Partial<DepositRecord>, { data: DepositProgress | undefined; pending: boolean }, number, Followed]>([
    ['waits for the source chain', {}, idle, SENT + MINUTE, { status: { stage: 'confirming' }, late: false }],
    [
      'is late unconfirmed past the worst case',
      {},
      idle,
      SENT + 11 * MINUTE,
      { status: { stage: 'confirming' }, late: true },
    ],
    [
      'relays once the chain confirmed',
      { gasPaid: 1n },
      { data: relaying, pending: false },
      SENT + MINUTE,
      { status: relaying, late: false },
    ],
    [
      'is late uncredited past the worst case',
      { gasPaid: 1n },
      { data: relaying, pending: false },
      SENT + 11 * MINUTE,
      { status: relaying, late: true },
    ],
    [
      'is not late while the first read of the venue is out',
      { gasPaid: 1n },
      { data: undefined, pending: true },
      SENT + 11 * MINUTE,
      { status: { stage: 'relaying', detail: 'Checking with the venue' }, late: false },
    ],
    [
      'is not late where Tape cannot follow',
      { gasPaid: 1n },
      { data: { stage: 'unwatched', detail: 'No reader' }, pending: false },
      SENT + 11 * MINUTE,
      { status: { stage: 'unwatched', detail: 'No reader' }, late: false },
    ],
    [
      'keeps a stored outcome whatever the clock says',
      { gasPaid: 1n, outcome: credited },
      idle,
      SENT + 11 * MINUTE,
      { status: credited, late: false },
    ],
  ])('%s', (_name, patch, progress, now, expected) => {
    expect(depositStatus(record(patch), ROUTE, progress, now)).toEqual(expected)
  })
})

describe('what stays beside Deposit', () => {
  it('follows a deposit with no outcome for a day and no longer', () => {
    expect(followed(record(), SENT + FOLLOW_FOR_MS - 1)).toBe(true)
    expect(followed(record(), SENT + FOLLOW_FOR_MS)).toBe(false)
    expect(followed(record({ outcome: credited }), SENT + MINUTE)).toBe(false)
  })

  it('keeps an ended deposit until the trader opens its receipt', () => {
    const ended: Followed = { status: credited, late: false }
    expect(waits(record({ outcome: credited }), ended, SENT + 2 * FOLLOW_FOR_MS)).toBe(true)
    expect(waits(record({ outcome: credited, seen: true }), ended, SENT + MINUTE)).toBe(false)
  })

  it('drops a deposit on its way once the day is over', () => {
    const onItsWay: Followed = { status: relaying, late: true }
    expect(waits(record({ gasPaid: 1n }), onItsWay, SENT + MINUTE)).toBe(true)
    expect(waits(record({ gasPaid: 1n }), onItsWay, SENT + FOLLOW_FOR_MS)).toBe(false)
  })

  it('counts down to the usual credit and goes negative after it', () => {
    expect(creditDueIn(record(), ROUTE, SENT + 15_000)).toBe(45_000)
    expect(creditDueIn(record(), ROUTE, SENT + 90_000)).toBe(-30_000)
  })

  it('puts the deposit that needs the trader first, then the older one', () => {
    const entry = (name: string, status: Followed['status'], late = false, sentAt = SENT) => ({
      name,
      record: record({ sentAt }),
      followed: { status, late },
    })
    const sorted = byUrgency([
      entry('credited', credited),
      entry('confirming', { stage: 'confirming' }),
      entry('relaying, newer', relaying, false, SENT + MINUTE),
      entry('relaying, older', relaying),
      entry('unwatched', { stage: 'unwatched', detail: '' }),
      entry('late', relaying, true),
      entry('unresolved', { stage: 'unresolved', detail: '', check: { label: '', url: '' } }),
      entry('reverted', { stage: 'reverted' }),
    ])
    expect(sorted.map((each) => each.name)).toEqual([
      'reverted',
      'unresolved',
      'late',
      'unwatched',
      'relaying, older',
      'relaying, newer',
      'confirming',
      'credited',
    ])
  })
})
