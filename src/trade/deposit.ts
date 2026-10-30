import { useMemo, useSyncExternalStore } from 'react'
import { queryOptions, skipToken, useMutation, useQuery } from '@tanstack/react-query'
import { useBalance, useBytecode, useConnection, useEstimateFeesPerGas, useReadContract, useReadContracts } from 'wagmi'
import { estimateGas, waitForTransactionReceipt } from 'wagmi/actions'
import { BaseError, ExecutionRevertedError, UserRejectedRequestError, erc20Abi, numberToHex } from 'viem'
import type { Address, Hex } from 'viem'
import { DEPOSITS } from '@tape/trade'
import { blocksDeposit, depositIssues } from '@tape/trade/deposit'
import type { DepositCall, DepositFee, DepositIssue, DepositProgress, DepositRoute } from '@tape/trade/deposit'
import { TradeFailure } from '@tape/trade/types'
import type { AccountRef } from '@tape/trade/types'
import { track } from '#/analytics/track'
import { wagmiConfig } from '#/wallet/config'
import { addDeposit, depositsSnapshot, parseDeposits, subscribeVault, updateDeposit } from './vault'
import type { DepositRecord } from './vault'

const PROGRESS_POLL_MS = 4_000

type ChainId = (typeof wagmiConfig.chains)[number]['id']
const wagmiChain = (id: number) => id as ChainId

interface Eip1193 {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

const browserFetch: typeof globalThis.fetch = (input, init) => fetch(input, init)

export function depositRoutes(ref: AccountRef): readonly DepositRoute[] {
  return DEPOSITS[ref.venue]?.routes(ref.network) ?? []
}

/** USDC the owner holds on each route's chain, in route order. Null while unread. */
export function useRouteBalances(ref: AccountRef, routes: readonly DepositRoute[]): readonly (bigint | null)[] {
  const { data } = useReadContracts({
    contracts: routes.map((r) => ({
      address: r.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [ref.owner],
      chainId: wagmiChain(r.chainId),
    })),
  })
  return routes.map((_, i) => {
    const read = data?.[i]
    return read?.status === 'success' ? (read.result as bigint) : null
  })
}

export interface DepositQuote {
  readonly fee: DepositFee | null
  readonly feeError: boolean
  readonly calls: readonly DepositCall[] | null
  /** Wei for every call, at the chain's max fee per gas. */
  readonly gasCost: bigint | null
  readonly issues: readonly DepositIssue[]
  /** Every reading is in and nothing blocks. */
  readonly ready: boolean
}

/** Calls after an approval cannot run before it lands, so only the first call's revert means the chain refuses. */
async function estimateCalls(chainId: ChainId, owner: Address, calls: readonly DepositCall[]) {
  let rejected: string | null = null
  const gas: bigint[] = []
  for (const [i, call] of calls.entries()) {
    try {
      gas.push(await estimateGas(wagmiConfig, { chainId, account: owner, to: call.to, data: call.data }))
    } catch (e) {
      const revert = e instanceof BaseError ? e.walk((x) => x instanceof ExecutionRevertedError) : null
      if (i === 0 && revert instanceof ExecutionRevertedError)
        rejected = (revert.details || revert.shortMessage).replace(/^execution reverted:\s*/i, '')
      gas.push(call.gasFallback)
    }
  }
  return { gas, rejected }
}

export function useDepositQuote(ref: AccountRef, route: DepositRoute, amount: bigint | null): DepositQuote {
  const chainId = wagmiChain(route.chainId)
  const usdc = useReadContract({
    address: route.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [ref.owner],
    chainId,
  })
  const allowance = useReadContract({
    address: route.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ref.owner, route.spender ?? ref.owner],
    chainId,
    query: { enabled: route.spender !== null },
  })
  const native = useBalance({ address: ref.owner, chainId })
  const code = useBytecode({ address: ref.owner, chainId })
  const gasPrice = useEstimateFeesPerGas({ chainId })
  const fee = useQuery(
    queryOptions({
      queryKey: ['deposit', 'fee', route.chainId, amount?.toString() ?? null],
      queryFn: amount ? () => route.fee(browserFetch, amount) : skipToken,
      staleTime: 30_000,
    }),
  )
  const allowed = route.spender === null ? 0n : (allowance.data ?? null)
  const calls = useMemo(
    () => (amount && fee.data && allowed !== null ? route.calls(ref.owner, amount, fee.data, allowed) : null),
    [route, ref.owner, amount, fee.data, allowed],
  )
  const gas = useQuery(
    queryOptions({
      queryKey: ['deposit', 'gas', chainId, ref.owner, calls?.map((c) => c.data) ?? null],
      queryFn: calls ? () => estimateCalls(chainId, ref.owner, calls) : skipToken,
      staleTime: 30_000,
    }),
  )
  const maxFeePerGas = gasPrice.data?.maxFeePerGas ?? gasPrice.data?.gasPrice
  const gasCost = gas.data && maxFeePerGas ? gas.data.gas.reduce((a, b) => a + b, 0n) * maxFeePerGas : null
  const readings = {
    usdc: usdc.data ?? null,
    native: native.data?.value ?? null,
    code: code.isSuccess ? (code.data ?? '0x') : null,
    fee: fee.data ?? null,
    gasCost,
    rejected: gas.data?.rejected ?? null,
  }
  const issues = amount ? depositIssues(route, amount, readings) : []
  const known = [readings.usdc, readings.native, readings.code, readings.fee, readings.gasCost].every((v) => v !== null)
  return {
    fee: fee.data ?? null,
    feeError: fee.isError,
    calls,
    gasCost,
    issues,
    ready: known && calls !== null && !issues.some(blocksDeposit),
  }
}

export type SendFailure = { readonly kind: 'wallet-rejected' } | { readonly kind: 'failed'; readonly detail: string }

async function onChain(provider: Eip1193, chainId: number) {
  const current = () => provider.request({ method: 'eth_chainId' }).then(Number)
  if ((await current()) === chainId) return
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(chainId) }] })
  if ((await current()) !== chainId) throw new Error(`The wallet did not switch to chain ${chainId}`)
}

export function sendFailure(e: unknown): SendFailure {
  if ((e as { code?: number } | null)?.code === UserRejectedRequestError.code) return { kind: 'wallet-rejected' }
  if (e instanceof TradeFailure) return { kind: 'failed', detail: e.message }
  return { kind: 'failed', detail: e instanceof Error ? e.message.split('\n')[0]! : String(e) }
}

/** Sends the calls from the route's chain, waiting for an approval to land before the deposit. Resolves with the deposit's hash once the wallet sends it. */
export function useSendDeposit(ref: AccountRef) {
  const { connector } = useConnection()
  return useMutation<
    Hex,
    Error,
    { route: DepositRoute; amount: bigint; fee: DepositFee; calls: readonly DepositCall[] }
  >({
    mutationFn: async ({ route, amount, fee, calls }) => {
      if (!connector) throw new Error('No wallet connected')
      const provider = (await connector.getProvider()) as Eip1193
      let deposit: Hex | null = null
      for (const call of calls) {
        await onChain(provider, route.chainId)
        const hash = (await provider.request({
          method: 'eth_sendTransaction',
          params: [{ from: ref.owner, to: call.to, data: call.data, chainId: numberToHex(route.chainId) }],
        })) as Hex
        if (call.kind === 'deposit') {
          deposit = hash
          addDeposit(ref, {
            chainId: route.chainId,
            amount,
            fee,
            hash,
            replacement: null,
            sentAt: Date.now(),
            gasPaid: null,
            outcome: null,
          })
          continue
        }
        const receipt = await waitForTransactionReceipt(wagmiConfig, {
          chainId: wagmiChain(route.chainId),
          hash,
        })
        if (receipt.status !== 'success') throw new Error('The approval reverted. Nothing was deposited')
      }
      if (!deposit) throw new Error('No deposit call to send')
      return deposit
    },
    onMutate: ({ route }) => track({ event: 'deposit_started', venue: ref.venue, chain: route.chainId }),
    onSuccess: (_hash, { route }) => track({ event: 'deposit_sent', venue: ref.venue, chain: route.chainId }),
    onError: (failure, { route }) =>
      track({
        event: 'deposit_failed',
        venue: ref.venue,
        chain: route.chainId,
        reason: sendFailure(failure).kind === 'wallet-rejected' ? 'wallet-rejected' : 'send',
      }),
  })
}

export function useDeposits(ref: AccountRef): readonly DepositRecord[] {
  const raw = useSyncExternalStore(
    subscribeVault,
    () => depositsSnapshot(ref),
    () => null,
  )
  return useMemo(() => parseDeposits(raw), [raw])
}

export type DepositStatus =
  { readonly stage: 'confirming' } | { readonly stage: 'reverted' } | { readonly stage: 'replaced' } | DepositProgress

export const sentHash = (record: DepositRecord) => record.replacement ?? record.hash

/** Follows one deposit from the source chain's receipt to the venue's credit, and stores each step on the record. */
export function useDepositStatus(ref: AccountRef, record: DepositRecord): { status: DepositStatus; late: boolean } {
  const route = depositRoutes(ref).find((r) => r.chainId === record.chainId)
  const chainId = wagmiChain(record.chainId)
  const others = useDeposits(ref)
  const claimed = new Set(
    others.flatMap((d) => (d.hash !== record.hash && d.outcome?.stage === 'credited' ? [d.outcome.receipt] : [])),
  )
  const confirmed = useQuery(
    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- the hash names the deposit
    queryOptions({
      queryKey: ['deposit', 'receipt', record.hash],
      queryFn:
        record.gasPaid === null && !record.outcome
          ? async () => {
              const seen = { dropped: false }
              const r = await waitForTransactionReceipt(wagmiConfig, {
                chainId,
                hash: sentHash(record),
                onReplaced: ({ reason, transaction }) => {
                  if (reason === 'repriced') updateDeposit(ref, record.hash, { replacement: transaction.hash })
                  else seen.dropped = true
                },
              })
              const failed = seen.dropped ? 'replaced' : r.status === 'success' ? null : 'reverted'
              if (failed) {
                updateDeposit(ref, record.hash, { outcome: { stage: failed } })
                track({ event: 'deposit_failed', venue: ref.venue, chain: record.chainId, reason: failed })
              } else updateDeposit(ref, record.hash, { gasPaid: r.gasUsed * r.effectiveGasPrice })
              return r.status
            }
          : skipToken,
      retry: true,
      staleTime: Infinity,
    }),
  )
  const progress = useQuery(
    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- the hash names the deposit
    queryOptions({
      queryKey: ['deposit', 'progress', record.hash],
      queryFn:
        route && record.gasPaid !== null && !record.outcome
          ? async () => {
              const p = await route.progress(browserFetch, { ...record, hash: sentHash(record), ref, claimed })
              if (p.stage === 'credited') {
                updateDeposit(ref, record.hash, { outcome: p })
                track({
                  event: 'deposit_credited',
                  venue: ref.venue,
                  chain: record.chainId,
                  seconds: Math.max(0, Math.round((p.at - record.sentAt) / 1000)),
                })
              }
              return p
            }
          : skipToken,
      refetchInterval: PROGRESS_POLL_MS,
    }),
  )
  const checkedAt = Math.max(confirmed.dataUpdatedAt, progress.dataUpdatedAt, confirmed.errorUpdatedAt)
  const late = route ? checkedAt > record.sentAt + route.eta.worst * 1000 : false
  if (record.outcome) return { status: record.outcome, late: false }
  if (record.gasPaid === null) return { status: { stage: 'confirming' }, late }
  return { status: progress.data ?? { stage: 'relaying', detail: 'Checking with the venue' }, late }
}
