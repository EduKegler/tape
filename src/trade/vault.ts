import { z } from 'zod'
import type { Hex } from 'viem'
import type { DepositFee } from '@tape/trade/deposit'
import { accountKey } from '@tape/trade/types'
import type { AccountRef, KeySlot, SecretLifetime, StoredKey } from '@tape/trade/types'

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

export function subscribeVault(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => e.key?.startsWith('tape:trade:') && listener()
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

type DepositOutcome =
  | { readonly stage: 'credited'; readonly amount: bigint; readonly at: number; readonly receipt: string }
  | { readonly stage: 'reverted' }
  | { readonly stage: 'replaced' }

/** A deposit as Tape sent it, and what came of it. Kept so a reload or a later visit still has the receipt. */
export interface DepositRecord {
  readonly chainId: number
  readonly amount: bigint
  readonly fee: DepositFee
  readonly hash: Hex
  /** The hash the wallet sped the transaction up to, which the chain and the venue know it by. */
  readonly replacement: Hex | null
  readonly sentAt: number
  /** Wei, once the source chain has the receipt. */
  readonly gasPaid: bigint | null
  readonly outcome: DepositOutcome | null
}

const MAX_DEPOSITS = 20
const units = z
  .string()
  .regex(/^\d+$/)
  .transform((v) => BigInt(v))
const txHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((h) => h as Hex)
const depositRecord = z.object({
  chainId: z.number().int(),
  amount: units,
  fee: z.object({ expected: units, max: units }),
  hash: txHash,
  replacement: txHash.nullable().default(null),
  sentAt: z.number(),
  gasPaid: units.nullable(),
  outcome: z
    .discriminatedUnion('stage', [
      z.object({ stage: z.literal('credited'), amount: units, at: z.number(), receipt: z.string() }),
      z.object({ stage: z.literal('reverted') }),
      z.object({ stage: z.literal('replaced') }),
    ])
    .nullable(),
})

const depositsName = (ref: AccountRef) => `tape:trade:v1:${accountKey(ref)}:deposits`

/** The raw stored list, stable between writes, for useSyncExternalStore. */
export const depositsSnapshot = (ref: AccountRef) => localStorage.getItem(depositsName(ref))

export function parseDeposits(raw: string | null): readonly DepositRecord[] {
  if (!raw) return []
  const parsed = z.array(z.unknown()).safeParse(JSON.parse(raw))
  return parsed.success ? parsed.data.flatMap((d) => depositRecord.safeParse(d).data ?? []) : []
}

const bigintsAsText = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)

function writeDeposits(ref: AccountRef, records: readonly DepositRecord[]) {
  localStorage.setItem(depositsName(ref), JSON.stringify(records.slice(0, MAX_DEPOSITS), bigintsAsText))
  notify()
}

export function addDeposit(ref: AccountRef, record: DepositRecord) {
  writeDeposits(ref, [record, ...parseDeposits(depositsSnapshot(ref)).filter((d) => d.hash !== record.hash)])
}

export function updateDeposit(
  ref: AccountRef,
  hash: Hex,
  patch: Partial<Pick<DepositRecord, 'replacement' | 'gasPaid' | 'outcome'>>,
) {
  writeDeposits(
    ref,
    parseDeposits(depositsSnapshot(ref)).map((d) => (d.hash === hash ? { ...d, ...patch } : d)),
  )
}
