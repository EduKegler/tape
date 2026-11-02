import type { Network } from '@tape/core/ids'
import { USDC_DECIMALS } from './deposit'
import type { AccountRef, Decimal, VenueContext, WalletSigner } from './types'

export interface WithdrawVenue {
  /** Where the USDC leaves from, in the venue's words. */
  readonly source: string
  /** The chain the USDC arrives on, at the same address. */
  readonly chainId: Readonly<Record<Network, number>>
  /** Each hop the USDC makes after it leaves the venue. */
  readonly hops: readonly string[]
  /** USDC base units the venue keeps from each withdrawal. */
  readonly fee: bigint
  /** Seconds from the venue taking the withdrawal to the USDC on the chain. */
  readonly eta: number
  /** Milliseconds between two looks for the finalized withdrawal, inside the venue's rate limit. */
  readonly pollEvery: number
  /** Where a person sees the account's withdrawals on the venue. */
  check: (ref: AccountRef) => { readonly label: string; readonly url: string }
  /** Signs with the wallet, never the trading key, and resolves once the venue takes the withdrawal. */
  withdraw: (ctx: VenueContext, wallet: WalletSigner, amount: bigint) => Promise<SentWithdrawal>
  progress: (ctx: VenueContext, sent: SentWithdrawal) => Promise<WithdrawProgress>
}

/** `nonce` is what the wallet signed, and names the withdrawal on the venue. */
export interface SentWithdrawal {
  readonly amount: bigint
  readonly nonce: number
}

export type WithdrawProgress =
  | { readonly stage: 'pending' }
  /** `received` is what leaves for the chain after the fee. */
  | { readonly stage: 'finalized'; readonly received: bigint; readonly at: number }

export type WithdrawIssue =
  | { readonly kind: 'not-above-fee'; readonly fee: bigint }
  | { readonly kind: 'over-available'; readonly available: bigint }

export function withdrawIssues(
  venue: WithdrawVenue,
  amount: bigint,
  available: bigint | null,
): readonly WithdrawIssue[] {
  const issues: WithdrawIssue[] = []
  if (amount <= venue.fee) issues.push({ kind: 'not-above-fee', fee: venue.fee })
  if (available !== null && amount > available) issues.push({ kind: 'over-available', available })
  return issues
}

const ONE_USDC = 10n ** BigInt(USDC_DECIMALS)

/** USDC base units in a venue balance, cut down to USDC's 6 places. A negative balance holds nothing to withdraw. */
export function usdcFloor(balance: Decimal): bigint {
  if (balance.startsWith('-')) return 0n
  const [whole = '0', fraction = ''] = balance.split('.')
  return BigInt(whole) * ONE_USDC + BigInt(fraction.slice(0, USDC_DECIMALS).padEnd(USDC_DECIMALS, '0'))
}
