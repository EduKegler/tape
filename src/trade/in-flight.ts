import { accountKey } from './types'
import type { AccountRef, Command } from './types'

/**
 * Query marks a mutation pending a tick after `mutate`, so two clicks inside that tick would both
 * send. This set is checked and filled synchronously. Every order counts as one slot per account,
 * since each carries a fresh clientId; a cancel or leverage change is one slot per exact command.
 */
const sending = new Set<string>()

const slot = (ref: AccountRef, command: Command) => `${accountKey(ref)}|${command.kind === 'place' ? 'place' : JSON.stringify(command)}`

export function claim(ref: AccountRef, command: Command): boolean {
  const key = slot(ref, command)
  if (sending.has(key)) return false
  sending.add(key)
  return true
}

export function release(ref: AccountRef, command: Command): void {
  sending.delete(slot(ref, command))
}
