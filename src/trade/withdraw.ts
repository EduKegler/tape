import { queryOptions, skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useConnection } from 'wagmi'
import { WITHDRAWALS } from '@tape/trade'
import { claim, release } from '@tape/trade/in-flight'
import type { AccountRef, TradeFailure } from '@tape/trade/types'
import { toEip1193, walletSigner } from '@tape/trade/wallet'
import type { SentWithdrawal, WithdrawProgress } from '@tape/trade/withdraw'
import { track } from '#/analytics/track'
import { switchOrAddChain } from '#/wallet/config'
import { contextFor, guard, tradeKeys } from './hooks'

const WITHDRAW = { kind: 'withdraw' } as const

export const withdrawVenue = (ref: AccountRef) => WITHDRAWALS[ref.venue] ?? null

/** Signs the withdrawal with the wallet and resolves once the venue takes it. */
export function useWithdraw(ref: AccountRef) {
  const { connector } = useConnection()
  const client = useQueryClient()
  const mutation = useMutation<SentWithdrawal, TradeFailure, bigint>({
    networkMode: 'always',
    mutationFn: (amount) =>
      guard(ref.venue, async () => {
        const venue = withdrawVenue(ref)
        if (!venue || !connector) throw new Error('No wallet connected')
        const provider = toEip1193(await connector.getProvider())
        return venue.withdraw(contextFor(ref), walletSigner(provider, ref.owner, switchOrAddChain), amount)
      }),
    onMutate: () => track({ event: 'withdraw_started', venue: ref.venue }),
    onSuccess: () => track({ event: 'withdraw_sent', venue: ref.venue }),
    onError: (failure) => track({ event: 'withdraw_failed', venue: ref.venue, error: failure.error.kind }),
    onSettled: () => {
      release(ref, WITHDRAW)
      return client.invalidateQueries({ queryKey: tradeKeys(ref).account })
    },
  })
  return {
    send: (amount: bigint) => {
      if (claim(ref, WITHDRAW)) mutation.mutate(amount)
    },
    pending: mutation.isPending,
    sent: mutation.data ?? null,
    error: mutation.error?.error ?? null,
    reset: mutation.reset,
  }
}

/** Looks for the withdrawal on the venue until it finalizes. Null before the first answer or with nothing sent. */
export function useWithdrawProgress(ref: AccountRef, sent: SentWithdrawal | null): WithdrawProgress | null {
  const venue = withdrawVenue(ref)
  const query = useQuery(
    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- the nonce names the withdrawal
    queryOptions<WithdrawProgress, TradeFailure>({
      queryKey: [...tradeKeys(ref).all, 'withdraw', sent?.nonce ?? null],
      queryFn: venue && sent ? () => guard(ref.venue, () => venue.progress(contextFor(ref), sent)) : skipToken,
      refetchInterval: (state) => (state.state.data?.stage === 'finalized' ? false : (venue?.pollEvery ?? false)),
      staleTime: (state) => (state.state.data?.stage === 'finalized' ? Infinity : 0),
    }),
  )
  return query.data ?? null
}
