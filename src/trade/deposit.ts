import { useMemo, useState, useSyncExternalStore } from 'react'
import { queryOptions, skipToken, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBalance, useBytecode, useEstimateFeesPerGas, useReadContract, useReadContracts } from 'wagmi'
import { estimateGas, getPublicClient, waitForTransactionReceipt } from 'wagmi/actions'
import { BaseError, ExecutionRevertedError, UserRejectedRequestError, erc20Abi, isHex, numberToHex } from 'viem'
import type { Address, Chain, Client, Hex, Transport } from 'viem'
import { estimateL1Fee } from 'viem/op-stack'
import { isRecord } from '@tape/core/json'
import { DEPOSITS, TRADING } from '@tape/trade'
import { blocksDeposit, depositIssues } from '@tape/trade/deposit'
import { claim, release } from '@tape/trade/in-flight'
import type { DepositCall, DepositIssue, DepositProgress, DepositRoute, DepositTerms } from '@tape/trade/deposit'
import { TradeFailure } from '@tape/trade/types'
import type { AccountRef } from '@tape/trade/types'
import { rejectionMessage, toEip1193 } from '@tape/trade/wallet'
import type { Eip1193 } from '@tape/trade/wallet'
import { useWalletConnection } from '#/wallet/connection'
import { track } from '#/analytics/track'
import { switchOrAddChain, toChainId, wagmiConfig } from '#/wallet/config'
import type { ChainId } from '#/wallet/config'
import { TRADE_CONFIG } from './config'
import { addDeposit, depositsSnapshot, keySlot, parseDeposits, subscribeVault, updateDeposit } from './vault'
import type { DepositRecord } from './vault'
import { depositStatus, followed } from './deposit-trail'
import type { Followed } from './deposit-trail'

const watchEnded = (progress: DepositProgress | undefined) => progress?.stage === 'unresolved'

const browserFetch: typeof globalThis.fetch = (input, init) => fetch(input, init)

export function depositRoutes(ref: AccountRef): readonly DepositRoute[] {
  return DEPOSITS[ref.venue]?.routes(ref.network, TRADE_CONFIG) ?? []
}

/** USDC the owner holds on each route's chain, in route order. Null while unread. */
export function useRouteBalances(ref: AccountRef, routes: readonly DepositRoute[]): readonly (bigint | null)[] {
  const { data } = useReadContracts({
    contracts: routes.map((route) => ({
      address: route.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [ref.owner],
      chainId: toChainId(route.chainId),
    })),
  })
  return routes.map((_, index) => {
    const read = data?.[index]
    return read?.status === 'success' && typeof read.result === 'bigint' ? read.result : null
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
  for (const [index, call] of calls.entries()) {
    try {
      gas.push(
        await estimateGas(wagmiConfig, { chainId, account: owner, to: call.to, data: call.data, value: call.value }),
      )
    } catch (error) {
      const revert = error instanceof BaseError ? error.walk((cause) => cause instanceof ExecutionRevertedError) : null
      if (index === 0 && revert instanceof ExecutionRevertedError)
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
    calls.map((call) => estimateL1Fee(client, { account: owner, to: call.to, data: call.data, value: call.value })),
  )
  return fees.reduce((sum, fee) => sum + fee, 0n)
}

export function useDepositQuote(ref: AccountRef, route: DepositRoute, amount: bigint | null): DepositQuote {
  const chainId = toChainId(route.chainId)
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
      queryKey: ['deposit', 'gas', chainId, ref.owner, calls?.map((call) => call.data) ?? null],
      queryFn: calls ? () => estimateCalls(chainId, ref.owner, calls) : skipToken,
      staleTime: 30_000,
    }),
  )
  const maxFeePerGas = gasPrice.data?.maxFeePerGas ?? gasPrice.data?.gasPrice
  const gasCost =
    gas.data && maxFeePerGas
      ? gas.data.gas.reduce((sum, units) => sum + units, 0n) * maxFeePerGas + gas.data.l1Fee
      : null
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
    (reading) => reading !== null,
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
  await switchOrAddChain(chainId)
  if ((await current()) !== chainId) throw new Error(`The wallet did not switch to chain ${chainId}`)
}

export function sendFailure(error: unknown): SendFailure {
  const approved = error instanceof FailedAfterApproval
  const cause = approved ? error.cause : error
  if (isRecord(cause) && cause.code === UserRejectedRequestError.code) return { kind: 'wallet-rejected', approved }
  if (cause instanceof TradeFailure) return { kind: 'failed', detail: cause.message, approved }
  return { kind: 'failed', detail: rejectionMessage(cause).split('\n')[0]!, approved }
}

interface DepositRequest {
  readonly route: DepositRoute
  readonly amount: bigint
  readonly terms: DepositTerms
  readonly calls: readonly DepositCall[]
}

const DEPOSIT = { kind: 'deposit' } as const

export type SendStep = 'approving' | 'approval' | 'signing'

/** Sends the calls from the route's chain, waiting for an approval to land before the deposit. Hands over the deposit's hash once the wallet sends it. */
export function useSendDeposit(ref: AccountRef) {
  const { connector } = useWalletConnection()
  const queryClient = useQueryClient()
  const [step, setStep] = useState<SendStep | null>(null)
  const mutation = useMutation<Hex, Error, DepositRequest>({
    networkMode: 'always',
    mutationFn: async ({ route, amount, terms, calls }) => {
      if (!connector) throw new Error('No wallet connected')
      const provider = toEip1193(await connector.getProvider())
      const send = async (call: DepositCall) => {
        await onChain(provider, route.chainId)
        const hash = await provider.request({
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
        })
        if (!isHex(hash)) throw new Error('The wallet returned a transaction hash that is not hex')
        return hash
      }
      let approved = false
      for (const call of calls) {
        if (call.kind === 'approve') {
          setStep('approving')
          const approval = await send(call)
          setStep('approval')
          const receipt = await waitForTransactionReceipt(wagmiConfig, {
            chainId: toChainId(route.chainId),
            hash: approval,
          })
          if (receipt.status !== 'success') throw new Error('The approval reverted. Nothing was deposited')
          approved = true
          await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'readContract' })
          continue
        }
        setStep('signing')
        let hash: Hex
        try {
          hash = await send(call)
        } catch (error) {
          throw approved
            ? new FailedAfterApproval('The approval went through, the deposit did not', { cause: error })
            : error
        }
        addDeposit(ref, {
          chainId: route.chainId,
          amount,
          fee: terms.fee,
          message: terms.message,
          hash,
          replacement: null,
          sentAt: Date.now(),
          gasPaid: null,
          confirmedAt: null,
          outcome: null,
          seen: false,
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
    onSettled: () => release(ref, DEPOSIT),
  })
  return {
    send: (request: DepositRequest, onSent: (hash: Hex) => void) => {
      if (claim(ref, DEPOSIT)) mutation.mutate(request, { onSuccess: onSent })
    },
    pending: mutation.isPending,
    step: mutation.isPending ? step : null,
    error: mutation.error,
    reset: mutation.reset,
  }
}

export function useDeposits(ref: AccountRef): readonly DepositRecord[] {
  const raw = useSyncExternalStore(
    subscribeVault,
    () => depositsSnapshot(ref),
    () => null,
  )
  return useMemo(() => parseDeposits(raw), [raw])
}

export const sentHash = (record: DepositRecord) => record.replacement ?? record.hash

const stored = (ref: AccountRef, hash: Hex) =>
  parseDeposits(depositsSnapshot(ref)).find((deposit) => deposit.hash === hash)

export const markSeen = (ref: AccountRef, hash: Hex) => updateDeposit(ref, hash, { seen: true })

export function useDepositStatuses(
  ref: AccountRef,
  records: readonly DepositRecord[],
  now: number,
  open: Hex | null,
): ReadonlyMap<Hex, Followed> {
  const routes = depositRoutes(ref)
  const routeOf = (record: DepositRecord) => routes.find((candidate) => candidate.chainId === record.chainId)
  const watched = (record: DepositRecord) => followed(record, now) || (record.hash === open && !record.outcome)
  useQueries({
    queries: records.map((record) =>
      // eslint-disable-next-line @tanstack/query/exhaustive-deps -- the hash names the deposit
      queryOptions({
        queryKey: ['deposit', 'receipt', record.hash],
        queryFn:
          watched(record) && record.gasPaid === null
            ? async () => {
                const seen = { dropped: false }
                // wagmi's waitForTransactionReceipt throws on a reverted receipt, which a retrying query never stores.
                const chain = getPublicClient(wagmiConfig, { chainId: toChainId(record.chainId) })
                const receipt = await chain.waitForTransactionReceipt({
                  hash: sentHash(record),
                  onReplaced: ({ reason, transaction }) => {
                    if (reason === 'repriced') updateDeposit(ref, record.hash, { replacement: transaction.hash })
                    else seen.dropped = true
                  },
                })
                const failure = seen.dropped ? 'replaced' : receipt.status === 'success' ? null : 'reverted'
                const inAnotherTab = stored(ref, record.hash)
                if (inAnotherTab?.gasPaid !== null || inAnotherTab.outcome) return receipt.status
                if (failure) {
                  updateDeposit(ref, record.hash, { outcome: { stage: failure } })
                  track({ event: 'deposit_failed', venue: ref.venue, chain: record.chainId, reason: failure })
                } else
                  updateDeposit(ref, record.hash, {
                    gasPaid: receipt.gasUsed * receipt.effectiveGasPrice,
                    confirmedAt: Date.now(),
                  })
                return receipt.status
              }
            : skipToken,
        retry: true,
        staleTime: Infinity,
      }),
    ),
  })
  const progress = useQueries({
    queries: records.map((record) => {
      const route = routeOf(record)
      // eslint-disable-next-line @tanstack/query/exhaustive-deps -- the hash names the deposit
      return queryOptions({
        queryKey: ['deposit', 'progress', record.hash],
        queryFn:
          route && watched(record) && record.gasPaid !== null
            ? async () => {
                const claimed = new Set(
                  parseDeposits(depositsSnapshot(ref)).flatMap((other) =>
                    other.hash !== record.hash && other.outcome?.stage === 'credited' ? [other.outcome.receipt] : [],
                  ),
                )
                const io = { fetch: browserFetch, keys: keySlot(ref, TRADING[ref.venue].secrets) }
                const reported = await route.progress(io, { ...record, hash: sentHash(record), ref, claimed })
                if (reported.stage === 'credited' && !stored(ref, record.hash)?.outcome) {
                  updateDeposit(ref, record.hash, { outcome: reported })
                  track({
                    event: 'deposit_credited',
                    venue: ref.venue,
                    chain: record.chainId,
                    seconds: Math.max(0, Math.round((reported.at - record.sentAt) / 1000)),
                  })
                }
                return reported
              }
            : skipToken,
        refetchInterval: (query) => (!route || watchEnded(query.state.data) ? false : route.pollEvery),
        staleTime: (query) => (watchEnded(query.state.data) ? Infinity : 0),
      })
    }),
  })
  return new Map(
    records.map((record, index) => [
      record.hash,
      depositStatus(
        record,
        routeOf(record),
        { data: progress[index]?.data, pending: progress[index]?.isPending ?? true },
        now,
      ),
    ]),
  )
}
