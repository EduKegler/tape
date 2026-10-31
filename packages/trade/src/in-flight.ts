import { accountKey } from './types'
import type { AccountRef, Command } from './types'

/**
 * Query marks a mutation pending a tick after `mutate`, so two clicks inside that tick would both
 * send.
 */
const sending = new Set<string>()

type Write = Command | { readonly kind: 'deposit' }

const lane = (write: Write) => (write.kind === 'place' ? 'every order' : JSON.stringify(write))

const slot = (ref: AccountRef, write: Write) => `${accountKey(ref)}|${lane(write)}`

export function claim(ref: AccountRef, write: Write): boolean {
  const key = slot(ref, write)
  if (sending.has(key)) return false
  sending.add(key)
  return true
}

export function release(ref: AccountRef, write: Write): void {
  sending.delete(slot(ref, write))
}
