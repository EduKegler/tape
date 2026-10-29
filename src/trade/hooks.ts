import { useState, useSyncExternalStore } from 'react'
import { queryOptions, skipToken, useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import { useConnection } from 'wagmi'
import { UserRejectedRequestError } from 'viem'
import type { Address } from 'viem'
import type { VenueId } from '@tape/core/ids'
import { NETWORK } from '#/site'
import { claim, release } from '@tape/trade/in-flight'
import { TRADING } from '@tape/trade'
import { SITE_READ_ONLY, TRADE_CONFIG } from './config'
import { TradeFailure, accountKey, isTradeVenue } from '@tape/trade/types'
import type {
  AccountRef,
  AccountView,
  Capabilities,
  Command,
  CommandOutcome,
  OrderLookup,
  SetupStep,
  StepId,
  StoredKey,
  TradeError,
  TradeVenueId,
  VenueContext,
} from '@tape/trade/types'
import { keySlot, subscribeVault } from './vault'
import { walletSigner } from '@tape/trade/wallet'
import type { MarginState } from '@tape/trade/liquidation'

export type TradeSession =
  | { readonly status: 'read-only'; readonly cause: 'venue-not-traded' | 'site-reads-only' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'disconnected' }
  | {
      readonly status: 'setup'
      readonly ref: AccountRef
      readonly capabilities: Capabilities
      readonly steps: readonly SetupStep[] | undefined
      readonly keyed: boolean
      readonly enable: () => void
      readonly progress: StepId | null
      readonly error: TradeError | null
    }
  | {
      readonly status: 'ready'
      readonly ref: AccountRef
      readonly capabilities: Capabilities
      readonly forget: () => void
    }

const ACCOUNT_POLL_MS = 10_000
const LOOKUP_DELAY_MS = 2_000

type SlotState = 'none' | `${StoredKey['status']}:${'keyed' | 'unkeyed'}`

export function tradeKeys(ref: AccountRef) {
  const all = ['trade', ref.venue, ref.network, ref.owner] as const
  return {
    all,
    account: [...all, 'account'] as const,
    steps: [...all, 'steps'] as const,
    command: [...all, 'command'] as const,
  }
}

function contextFor(ref: AccountRef): VenueContext {
  return {
    ref,
    config: TRADE_CONFIG,
    keys: keySlot(ref, TRADING[ref.venue].secrets),
    fetch: (input, init) => fetch(input, init),
  }
}

async function guard<T>(venue: TradeVenueId, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof TradeFailure) throw e
    if ((e as { code?: number } | null)?.code === UserRejectedRequestError.code)
      throw new TradeFailure(venue, { kind: 'wallet-rejected' })
    throw new TradeFailure(venue, { kind: 'unexpected', detail: e instanceof Error ? e.message : String(e) })
  }
}

function useRef(venue: VenueId): AccountRef | null {
  const { address } = useConnection()
  return address && isTradeVenue(venue) && !SITE_READ_ONLY
    ? { venue, network: NETWORK, owner: address.toLowerCase() as Address }
    : null
}

function useSlot(ref: AccountRef | null): SlotState | null {
  return useSyncExternalStore(
    subscribeVault,
    (): SlotState | null => {
      if (!ref) return null
      const key = keySlot(ref, TRADING[ref.venue].secrets).read()
      return key ? `${key.status}:${key.secret === null ? 'unkeyed' : 'keyed'}` : 'none'
    },
    () => null,
  )
}

export function useTradeSession(venue: VenueId): TradeSession {
  const ref = useRef(venue)
  const slot = useSlot(ref)
  const client = useQueryClient()
  const { connector } = useConnection()
  const [progress, setProgress] = useState<StepId | null>(null)
  const module = isTradeVenue(venue) ? TRADING[venue] : null
  const unavailable = module?.unavailable(NETWORK, TRADE_CONFIG) ?? null
  const linked = slot === 'linked:keyed'
  const steps = useQuery(
    queryOptions<readonly SetupStep[], TradeFailure>({
      queryKey: ref ? tradeKeys(ref).steps : ['trade', 'none'],
      queryFn:
        ref && !unavailable && !linked && slot !== null
          ? () => guard(ref.venue, () => TRADING[ref.venue].steps(contextFor(ref)))
          : skipToken,
      staleTime: 30_000,
    }),
  )
  const enable = useMutation<undefined, TradeFailure>({
    mutationFn: async () => {
      const r = ref!
      const provider = (await connector!.getProvider()) as Parameters<typeof walletSigner>[0]
      const run = () =>
        guard(r.venue, () => TRADING[r.venue].enable(contextFor(r), walletSigner(provider, r.owner), setProgress))
      await (typeof navigator !== 'undefined' && 'locks' in navigator
        ? navigator.locks.request(`tape:enable:${accountKey(r)}`, run)
        : run())
    },
    onSettled: () => {
      setProgress(null)
      if (ref) void client.invalidateQueries({ queryKey: tradeKeys(ref).all })
    },
  })
  if (!module) return { status: 'read-only', cause: 'venue-not-traded' }
  if (SITE_READ_ONLY) return { status: 'read-only', cause: 'site-reads-only' }
  if (unavailable) return { status: 'unavailable', reason: unavailable }
  if (!ref) return { status: 'disconnected' }
  if (linked) {
    return {
      status: 'ready',
      ref,
      capabilities: module.capabilities,
      forget: () => {
        keySlot(ref, module.secrets).clear()
        void client.invalidateQueries({ queryKey: tradeKeys(ref).all })
      },
    }
  }
  return {
    status: 'setup',
    ref,
    capabilities: module.capabilities,
    steps: steps.data,
    keyed: slot?.endsWith(':keyed') ?? false,
    enable: () => enable.mutate(),
    progress,
    error: enable.error?.error ?? steps.error?.error ?? null,
  }
}

export function useAccountView(ref: AccountRef | null) {
  const query = useQuery(
    queryOptions<AccountView, TradeFailure>({
      queryKey: ref ? tradeKeys(ref).account : ['trade', 'none', 'account'],
      queryFn: ref ? () => guard(ref.venue, () => TRADING[ref.venue].account(contextFor(ref))) : skipToken,
      refetchInterval: ACCOUNT_POLL_MS,
    }),
  )
  return { view: query.data, error: query.error?.error ?? null, isFetching: query.isFetching }
}

export type MarginReading =
  | { readonly status: 'no-estimate' }
  | { readonly status: 'unknown' }
  | { readonly status: 'known'; readonly state: MarginState }

export function useMarginReading(ref: AccountRef | null, symbol: string): MarginReading {
  const margin = ref ? TRADING[ref.venue].margin : undefined
  const query = useQuery(
    queryOptions<MarginState, TradeFailure>({
      queryKey: ref ? [...tradeKeys(ref).all, 'margin', symbol] : ['trade', 'none', 'margin'],
      queryFn: ref && margin ? () => guard(ref.venue, () => margin(contextFor(ref), symbol)) : skipToken,
      refetchInterval: ACCOUNT_POLL_MS,
    }),
  )
  if (!margin) return { status: 'no-estimate' }
  return query.data ? { status: 'known', state: query.data } : { status: 'unknown' }
}

export function useTradeCommands(ref: AccountRef | null) {
  const client = useQueryClient()
  const command = ref ? tradeKeys(ref).command : ['trade', 'none', 'command']
  const mutation = useMutation<CommandOutcome, TradeFailure, Command>({
    mutationKey: command,
    mutationFn: (c) =>
      ref
        ? guard(ref.venue, () => TRADING[ref.venue].execute(contextFor(ref), c))
        : Promise.reject(new Error('no account')),
    onError: (failure) => {
      if (!ref || failure.error.kind !== 'needs-setup') return
      const slot = keySlot(ref, TRADING[ref.venue].secrets)
      const key = slot.read()
      if (key?.status === 'linked') slot.write({ ...key, status: 'draft' })
    },
    onSettled: (_data, _error, c) => {
      if (!ref) return
      release(ref, c)
      return client.invalidateQueries({ queryKey: tradeKeys(ref).all })
    },
  })
  const inFlight = useMutationState({
    filters: { mutationKey: command, status: 'pending' },
    select: (m) => m.state.variables as Command,
  })
  const unknown =
    mutation.error?.error.kind === 'unknown-outcome' && mutation.variables?.kind === 'place'
      ? mutation.variables.intent
      : null
  const lookup = useQuery(
    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- the client id names the intent
    queryOptions<OrderLookup, TradeFailure>({
      queryKey: [...(ref ? tradeKeys(ref).all : ['trade', 'none']), 'lookup', unknown?.clientId ?? null],
      queryFn:
        ref && unknown
          ? async () => {
              await new Promise((resolve) => setTimeout(resolve, LOOKUP_DELAY_MS))
              return guard(ref.venue, () => TRADING[ref.venue].lookup(contextFor(ref), unknown))
            }
          : skipToken,
      retry: false,
      staleTime: Infinity,
    }),
  )
  return {
    run: (c: Command) => {
      if (ref && claim(ref, c)) mutation.mutate(c)
    },
    last: {
      outcome: mutation.data ?? null,
      error: mutation.error?.error ?? null,
      pending: mutation.isPending,
      command: mutation.variables ?? null,
      lookup: unknown ? { result: lookup.data ?? null, error: lookup.error?.error ?? null } : null,
    },
    inFlight,
  }
}
