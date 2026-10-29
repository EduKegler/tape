import { accountKey } from './types'
import type { AccountRef, Command } from './types'

/**
 * Query marks a mutation pending a tick after `mutate`, so two clicks inside that tick would both
 * send.
 */
const sending = new Set<string>()

const lane = (command: Command) => (command.kind === 'place' ? 'every order' : JSON.stringify(command))

const slot = (ref: AccountRef, command: Command) => `${accountKey(ref)}|${lane(command)}`

export function claim(ref: AccountRef, command: Command): boolean {
  const key = slot(ref, command)
  if (sending.has(key)) return false
  sending.add(key)
  return true
}

export function release(ref: AccountRef, command: Command): void {
  sending.delete(slot(ref, command))
}
