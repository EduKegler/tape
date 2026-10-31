import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { queryOptions, skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBalance, useBytecode, useConnection, useEstimateFeesPerGas, useReadContract, useReadContracts } from 'wagmi'
import { estimateGas, getPublicClient, waitForTransactionReceipt } from 'wagmi/actions'
import { BaseError, ExecutionRevertedError, UserRejectedRequestError, erc20Abi, numberToHex } from 'viem'
import type { Address, Chain, Client, Hex, Transport } from 'viem'
import { estimateL1Fee } from 'viem/op-stack'
import { DEPOSITS, TRADING } from '@tape/trade'
import { blocksDeposit, depositIssues } from '@tape/trade/deposit'
import type { DepositCall, DepositIssue, DepositProgress, DepositRoute, DepositTerms } from '@tape/trade/deposit'
import { TradeFailure } from '@tape/trade/types'
import type { AccountRef } from '@tape/trade/types'
import { track } from '#/analytics/track'
import { wagmiConfig } from '#/wallet/config'
import { TRADE_CONFIG } from './config'
import { addDeposit, depositsSnapshot, keySlot, parseDeposits, subscribeVault, updateDeposit } from './vault'
import type { DepositRecord } from './vault'

const watchEnded = (p: DepositProgress | undefined) => p?.stage === 'unresolved'

type ChainId = (typeof wagmiConfig.chains)[number]['id']
const wagmiChain = (id: number) => id as ChainId

interface Eip1193 {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

const browserFetch: typeof globalThis.fetch = (input, init) => fetch(input, init)

export function depositRoutes(ref: AccountRef): readonly DepositRoute[] {
  return DEPOSITS[ref.venue]?.routes(ref.network, TRADE_CONFIG) ?? []
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
  readonly terms: DepositTerms | null
  readonly termsError: boolean
  readonly calls: readonly DepositCall[] | null
  /** Wei for every call, at the chain's max fee per gas, plus the L1 data fee on Base and OP Mainnet. */
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
      gas.push(
        await estimateGas(wagmiConfig, { chainId, account: owner, to: call.to, data: call.data, value: call.value }),
      )
    } catch (e) {
      const revert = e instanceof BaseError ? e.walk((x) => x instanceof ExecutionRevertedError) : null
      if (i === 0 && revert instanceof ExecutionRevertedError)
        rejected = (revert.details || revert.shortMessage).replace(/^execution reverted:\s*/i, '')
      gas.push(call.gasFallback)
    }
  }
  return { gas, l1Fee: await l1DataFee(chainId, owner, calls), rejected }
}

/** OP Stack chains such as Base and OP Mainnet charge each transaction an L1 data fee on top of its gas. */
async function l1DataFee(chainId: ChainId, owner: Address, calls: readonly DepositCall[]) {
  const client = getPublicClient(wagmiConfig, { chainId }) as Client<Transport, Chain>
  if (!client.chain.contracts?.gasPriceOracle) return 0n
  const fees = await Promise.all(
    calls.map((c) => estimateL1Fee(client, { account: owner, to: c.to, data: c.data, value: c.value })),
  )
  return fees.reduce((a, b) => a + b, 0n)
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
  const terms = useQuery(
    queryOptions({
      queryKey: ['deposit', 'terms', ref.venue, chainId, ref.owner, amount?.toString() ?? null],
      queryFn: amount
        ? () =>
            route.terms({ fetch: browserFetch, chain: getPublicClient(wagmiConfig, { chainId }) }, ref.owner, amount)
        : skipToken,
      staleTime: 30_000,
    }),
  )
  const allowed = route.spender === null ? 0n : (allowance.data ?? null)
  const calls = useMemo(
    () => (amount && terms.data && allowed !== null ? route.calls(ref.owner, amount, terms.data, allowed) : null),
    [route, ref.owner, amount, terms.data, allowed],
  )
  const gas = useQuery(
    queryOptions({
      queryKey: ['deposit', 'gas', chainId, ref.owner, calls?.map((c) => c.data) ?? null],
      queryFn: calls ? () => estimateCalls(chainId, ref.owner, calls) : skipToken,
      staleTime: 30_000,
    }),
  )
  const maxFeePerGas = gasPrice.data?.maxFeePerGas ?? gasPrice.data?.gasPrice
  const gasCost =
    gas.data && maxFeePerGas ? gas.data.gas.reduce((a, b) => a + b, 0n) * maxFeePerGas + gas.data.l1Fee : null
  const readings = {
    usdc: usdc.data ?? null,
    native: native.data?.value ?? null,
    code: code.isSuccess ? (code.data ?? '0x') : null,
    terms: terms.data ?? null,
    gasCost,
    rejected: gas.data?.rejected ?? null,
  }
  const issues = amount ? depositIssues(route, amount, readings) : []
  const known = [readings.usdc, readings.native, readings.code, readings.terms, readings.gasCost].every(
    (v) => v !== null,
  )
  return {
    terms: terms.data ?? null,
    termsError: terms.isError,
    calls,
    gasCost,
    issues,
    ready: known && calls !== null && !issues.some(blocksDeposit),
  }
}

export type SendFailure = (
  { readonly kind: 'wallet-rejected' } | { readonly kind: 'failed'; readonly detail: string }
) & { readonly approved: boolean }

class FailedAfterApproval extends Error {}

async function onChain(provider: Eip1193, chainId: number) {
  const current = () => provider.request({ method: 'eth_chainId' }).then(Number)
  if ((await current()) === chainId) return
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(chainId) }] })
  if ((await current()) !== chainId) throw new Error(`The wallet did not switch to chain ${chainId}`)
}

export function sendFailure(error: unknown): SendFailure {
  const approved = error instanceof FailedAfterApproval
  const e = approved ? error.cause : error
  if ((e as { code?: number } | null)?.code === UserRejectedRequestError.code)
    return { kind: 'wallet-rejected', approved }
  if (e instanceof TradeFailure) return { kind: 'failed', detail: e.message, approved }
  return { kind: 'failed', detail: e instanceof Error ? e.message.split('\n')[0]! : String(e), approved }
}

/** Sends the calls from the route's chain, waiting for an approval to land before the deposit. Resolves with the deposit's hash once the wallet sends it. */
export function useSendDeposit(ref: AccountRef) {
  const { connector } = useConnection()
  const queryClient = useQueryClient()
  return useMutation<
    Hex,
    Error,
    { route: DepositRoute; amount: bigint; terms: DepositTerms; calls: readonly DepositCall[] }
  >({
    mutationFn: async ({ route, amount, terms, calls }) => {
      if (!connector) throw new Error('No wallet connected')
      const provider = (await connector.getProvider()) as Eip1193
      const send = async (call: DepositCall) => {
        await onChain(provider, route.chainId)
        return (await provider.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: ref.owner,
              to: call.to,
              data: call.data,
              ...(call.value > 0n ? { value: numberToHex(call.value) } : {}),
              chainId: numberToHex(route.chainId),
            },
          ],
        })) as Hex
      }
      let approved = false
      for (const call of calls) {
        if (call.kind === 'approve') {
          const receipt = await waitForTransactionReceipt(wagmiConfig, {
            chainId: wagmiChain(route.chainId),
            hash: await send(call),
          })
          if (receipt.status !== 'success') throw new Error('The approval reverted. Nothing was deposited')
          approved = true
          await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'readContract' })
          continue
        }
        let hash: Hex
        try {
          hash = await send(call)
        } catch (e) {
          throw approved ? new FailedAfterApproval('The approval went through, the deposit did not', { cause: e }) : e
        }
        addDeposit(ref, {
          chainId: route.chainId,
          amount,
          fee: terms.fee,
          hash,
          replacement: null,
          sentAt: Date.now(),
          gasPaid: null,
          outcome: null,
        })
        return hash
      }
      throw new Error('No deposit call to send')
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

function usePassed(deadline: number): boolean {
  const [passed, setPassed] = useState(() => Date.now() > deadline)
  useEffect(() => {
    if (passed || !Number.isFinite(deadline)) return
    const timer = setTimeout(() => setPassed(true), deadline - Date.now())
    return () => clearTimeout(timer)
  }, [deadline, passed])
  return passed
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
  useQuery(
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
              const io = { fetch: browserFetch, keys: keySlot(ref, TRADING[ref.venue].secrets) }
              const p = await route.progress(io, { ...record, hash: sentHash(record), ref, claimed })
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
      refetchInterval: (q) => (!route || watchEnded(q.state.data) ? false : route.pollEvery),
      staleTime: (q) => (watchEnded(q.state.data) ? Infinity : 0),
    }),
  )
  const late = usePassed(route ? record.sentAt + route.eta.worst * 1000 : Infinity)
  if (record.outcome) return { status: record.outcome, late: false }
  if (record.gasPaid === null) return { status: { stage: 'confirming' }, late }
  return { status: progress.data ?? { stage: 'relaying', detail: 'Checking with the venue' }, late }
}
