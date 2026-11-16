import type { DepositProgress, DepositRoute } from '@tape/trade/deposit'
import type { DepositRecord } from './vault'

export type DepositStatus =
  { readonly stage: 'confirming' } | { readonly stage: 'reverted' } | { readonly stage: 'replaced' } | DepositProgress

export interface Followed {
  readonly status: DepositStatus
  readonly late: boolean
}

export const FOLLOW_FOR_MS = 24 * 60 * 60_000

export const followed = (record: DepositRecord, now: number) =>
  record.outcome === null && now - record.sentAt < FOLLOW_FOR_MS

export function depositStatus(
  record: DepositRecord,
  route: Pick<DepositRoute, 'eta'> | undefined,
  progress: { readonly data: DepositProgress | undefined; readonly pending: boolean },
  now: number,
): Followed {
  if (record.outcome) return { status: record.outcome, late: false }
  const late = route !== undefined && now > record.sentAt + route.eta.worst * 1000
  if (record.gasPaid === null) return { status: { stage: 'confirming' }, late }
  const status = progress.data ?? { stage: 'relaying', detail: 'Checking with the venue' }
  return { status, late: late && !progress.pending && status.stage !== 'unwatched' }
}

export const failed = (status: DepositStatus) => status.stage === 'reverted' || status.stage === 'replaced'

export const ended = (status: DepositStatus) =>
  status.stage === 'credited' || failed(status) || status.stage === 'unresolved'

export const waits = (record: DepositRecord, { status }: Followed, now: number) =>
  ended(status) ? !record.seen : followed(record, now)

export const creditDueIn = (record: DepositRecord, route: Pick<DepositRoute, 'eta'>, now: number) =>
  record.sentAt + route.eta.typical * 1000 - now

function urgency({ status, late }: Followed): number {
  if (failed(status)) return 0
  if (status.stage === 'unresolved') return 1
  if (late) return 2
  if (status.stage === 'unwatched') return 3
  if (status.stage === 'relaying') return 4
  if (status.stage === 'confirming') return 5
  return 6
}

export function byUrgency<TEntry extends { readonly record: DepositRecord; readonly followed: Followed }>(
  entries: readonly TEntry[],
): readonly TEntry[] {
  return entries.toSorted(
    (left, right) => urgency(left.followed) - urgency(right.followed) || left.record.sentAt - right.record.sentAt,
  )
}
