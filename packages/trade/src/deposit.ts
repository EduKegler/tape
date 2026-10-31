import { encodeFunctionData, erc20Abi } from 'viem'
import type { Address, Hex, PublicClient } from 'viem'
import type { Network } from '@tape/core/ids'
import type { AccountRef, KeySlot, TradeConfig } from './types'

/** USDC base units. USDC has 6 decimals on every chain Tape deposits from. */
export const USDC_DECIMALS = 6
const ONE_USDC = 10n ** BigInt(USDC_DECIMALS)
const HIGH_FEE_BPS = 100n

export interface DepositRoute {
  readonly chainId: number
  /** The USDC contract the route takes on that chain. */
  readonly token: Address
  /** The contract the wallet approves first. Null when one transfer is the whole deposit. */
  readonly spender: Address | null
  /** Each hop the USDC makes after it leaves the wallet's chain. */
  readonly hops: readonly string[]
  /** lost: the venue keeps a smaller deposit and credits nothing. */
  readonly minimum: { readonly amount: bigint; readonly lost: boolean } | null
  /** Seconds from the source chain's confirmation to the credit on the venue. */
  readonly eta: { readonly typical: number; readonly worst: number }
  /** Milliseconds between two looks for the credit, inside the venue's rate limit. */
  readonly pollEvery: number
  terms: (io: TermsIo, owner: Address, amount: bigint) => Promise<DepositTerms>
  /** The approval, when the allowance falls short, then the deposit. */
  calls: (owner: Address, amount: bigint, terms: DepositTerms, allowance: bigint) => readonly DepositCall[]
  progress: (io: ProgressIo, sent: SentDeposit) => Promise<DepositProgress>
}

export interface TermsIo {
  readonly fetch: typeof globalThis.fetch
  /** Reads the route's chain. */
  readonly chain: Pick<PublicClient, 'readContract'>
}

export interface ProgressIo {
  readonly fetch: typeof globalThis.fetch
  /** The account's trading key on this device. Orderly shows its deposit records only to it. */
  readonly keys: KeySlot
}

/** What the route charges and whether the venue takes the deposit, read before the wallet signs. */
export interface DepositTerms {
  readonly fee: DepositFee
  /** Native wei the deposit call carries to pay the messenger that crosses chains. */
  readonly message: { readonly via: string; readonly wei: bigint } | null
  readonly refusal: DepositRefusal | null
}

export type DepositRefusal =
  | { readonly kind: 'no-account' }
  /** USDC the venue's vault still takes before its deposit limit. */
  | { readonly kind: 'over-limit'; readonly room: bigint }

/** In USDC base units, taken out of the amount on the way. */
export interface DepositFee {
  readonly expected: bigint
  readonly max: bigint
}

export interface DepositCall {
  readonly kind: 'approve' | 'deposit'
  readonly to: Address
  readonly data: Hex
  /** Native wei sent with the call. */
  readonly value: bigint
  /** Gas to assume where the node cannot estimate yet, such as a deposit whose approval is not mined. */
  readonly gasFallback: bigint
}

/** What the venue needs to find a deposit once the source chain has it. `hash` is the deposit call's. */
export interface SentDeposit {
  readonly ref: AccountRef
  readonly chainId: number
  readonly amount: bigint
  readonly hash: Hex
  readonly sentAt: number
  /** Venue records that other deposits of this account were already credited with. */
  readonly claimed: ReadonlySet<string>
}

export type DepositProgress =
  | { readonly stage: 'relaying'; readonly detail: string }
  | { readonly stage: 'credited'; readonly amount: bigint; readonly at: number; readonly receipt: string }
  /** The watch ended without an outcome Tape can trust. `check` is where a person can look it up. */
  | {
      readonly stage: 'unresolved'
      readonly detail: string
      readonly check: { readonly label: string; readonly url: string }
    }

export interface DepositVenue {
  /** Where the USDC lands, in the venue's words. */
  readonly destination: string
  /** At most one route per chain. */
  routes: (network: Network, config: TradeConfig) => readonly DepositRoute[]
}

/** Null for anything but a plain positive decimal with at most USDC's 6 places. */
export function parseUsdc(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(text.trim())
  if (!m) return null
  const units = BigInt(m[1]!) * ONE_USDC + BigInt((m[2] ?? '').padEnd(USDC_DECIMALS, '0'))
  return units > 0n ? units : null
}

export const approveCall = (token: Address, spender: Address, amount: bigint): DepositCall => ({
  kind: 'approve',
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
  value: 0n,
  gasFallback: 80_000n,
})

export const transferCall = (token: Address, to: Address, amount: bigint): DepositCall => ({
  kind: 'deposit',
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
  value: 0n,
  gasFallback: 80_000n,
})

/** What the wallet holds on the route's chain, and what the deposit costs there. Null while unknown. */
export interface DepositReadings {
  readonly usdc: bigint | null
  readonly native: bigint | null
  /** Bytecode at the owner. EIP-7702 delegations start 0xef0100 and stay plain accounts. */
  readonly code: Hex | null
  readonly terms: DepositTerms | null
  /** Wei for every call, at the chain's max fee per gas, plus the L1 data fee where the chain charges one. */
  readonly gasCost: bigint | null
  /** The revert reason the chain gives when it simulates the first call. Null when it passes or is unknown. */
  readonly rejected: string | null
}

export type DepositIssue =
  | { readonly kind: 'below-minimum'; readonly minimum: bigint; readonly lost: boolean }
  | { readonly kind: 'fee-exceeds-amount'; readonly fee: bigint }
  | { readonly kind: 'insufficient-usdc'; readonly balance: bigint }
  /** `need` covers the gas and the messenger's fee. */
  | { readonly kind: 'insufficient-gas'; readonly need: bigint; readonly have: bigint }
  | { readonly kind: 'contract-wallet' }
  | { readonly kind: 'chain-rejects'; readonly reason: string }
  | { readonly kind: 'high-fee'; readonly bps: number }
  | DepositRefusal

/** Every issue but `high-fee` stops the deposit. */
export const blocksDeposit = (issue: DepositIssue) => issue.kind !== 'high-fee'

export function depositIssues(route: DepositRoute, amount: bigint, r: DepositReadings): readonly DepositIssue[] {
  const issues: DepositIssue[] = []
  if (route.minimum && amount < route.minimum.amount)
    issues.push({ kind: 'below-minimum', minimum: route.minimum.amount, lost: route.minimum.lost })
  const fee = r.terms?.fee
  if (fee && fee.max >= amount) issues.push({ kind: 'fee-exceeds-amount', fee: fee.max })
  else if (fee && fee.expected * 10_000n >= amount * HIGH_FEE_BPS)
    issues.push({ kind: 'high-fee', bps: Number((fee.expected * 10_000n) / amount) })
  if (r.terms?.refusal) issues.push(r.terms.refusal)
  if (r.usdc !== null && r.usdc < amount) issues.push({ kind: 'insufficient-usdc', balance: r.usdc })
  const native = r.gasCost === null ? null : r.gasCost + (r.terms?.message?.wei ?? 0n)
  if (r.native !== null && native !== null && r.native < native)
    issues.push({ kind: 'insufficient-gas', need: native, have: r.native })
  if (r.code && r.code !== '0x' && !r.code.startsWith('0xef0100')) issues.push({ kind: 'contract-wallet' })
  if (r.rejected !== null && !issues.some((i) => i.kind === 'insufficient-usdc'))
    issues.push({ kind: 'chain-rejects', reason: r.rejected })
  return issues
}
