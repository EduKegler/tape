import { z } from 'zod'
import { accountKey } from '@tape/trade/types'
import type { AccountRef, KeySlot, SecretLifetime, StoredKey } from '@tape/trade/types'

/**
 * localStorage `tape:trade:v1:<AccountKey>` holds the status and the public half. The secret sits
 * beside it in localStorage, or in sessionStorage when the venue's lifetime is 'tab'. Nothing
 * touches storage at import, so SSR can import this.
 */
const stored = z.object({ status: z.enum(['draft', 'linked']), public: z.record(z.string(), z.string()) })
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

const slotName = (ref: AccountRef) => `tape:trade:v1:${accountKey(ref)}`

export function keySlot(ref: AccountRef, lifetime: SecretLifetime): KeySlot {
  const name = slotName(ref)
  const secretStore = () => (lifetime === 'tab' ? sessionStorage : localStorage)
  return {
    read() {
      const raw = localStorage.getItem(name)
      const parsed = raw ? stored.safeParse(JSON.parse(raw)) : null
      if (!parsed?.success) return null
      return { ...parsed.data, secret: secretStore().getItem(`${name}:secret`) }
    },
    write(key: StoredKey) {
      localStorage.setItem(name, JSON.stringify({ status: key.status, public: key.public }))
      if (key.secret === null) secretStore().removeItem(`${name}:secret`)
      else secretStore().setItem(`${name}:secret`, key.secret)
      notify()
    },
    clear() {
      localStorage.removeItem(name)
      secretStore().removeItem(`${name}:secret`)
      notify()
    },
  }
}

/** Linked and, for 'tab' secrets, present in this tab. Server snapshot is false. */
export function isLinked(ref: AccountRef, lifetime: SecretLifetime): boolean {
  const key = keySlot(ref, lifetime).read()
  return key?.status === 'linked' && key.secret !== null
}

/** A `storage` event from another tab counts too: that is how a second tab learns trading was enabled. */
export function subscribeVault(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => e.key?.startsWith('tape:trade:') && listener()
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}
