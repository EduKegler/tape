import { useState, useSyncExternalStore } from 'react'
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import type { VenueId } from '#/core/ids'
import { TRADING } from './index'
import { TradeFailure, accountKey, isTradeVenue } from './types'
import type { AccountRef, AccountView, Capabilities, Command, CommandOutcome, Network, SetupStep, StepId, TradeError, TradeVenueId, VenueContext } from './types'
import { keySlot, subscribeVault } from './vault'
import { walletSigner } from './wallet'

export type TradeSession =
  | { readonly status: 'read-only' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'disconnected' }
  | {
      readonly status: 'setup'
      readonly ref: AccountRef
      readonly capabilities: Capabilities
      readonly steps: readonly SetupStep[] | undefined
      /** A key exists on this device, approved or not. Orders go out and the venue judges them. */
      readonly keyed: boolean
      readonly enable: () => void
      readonly progress: StepId | null
      readonly error: TradeError | null
    }
  | { readonly status: 'ready'; readonly ref: AccountRef; readonly capabilities: Capabilities; readonly forget: () => void }

export function tradeKeys(ref: AccountRef) {
  const all = ['trade', ref.venue, ref.network, ref.owner] as const
  return { all, account: [...all, 'account'] as const, steps: [...all, 'steps'] as const, command: [...all, 'command'] as const }
}

function contextFor(ref: AccountRef): VenueContext {
  return { ref, keys: keySlot(ref, TRADING[ref.venue].secrets), fetch: (input, init) => fetch(input, init) }
}

/** The one place a foreign throw becomes typed. EIP-1193 code 4001 is the user saying no. */
async function guard<T>(venue: TradeVenueId, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof TradeFailure) throw e
    if ((e as { code?: number } | null)?.code === 4001) throw new TradeFailure(venue, { kind: 'wallet-rejected' })
    throw new TradeFailure(venue, { kind: 'unexpected', detail: e instanceof Error ? e.message : String(e) })
  }
}

function useRef(venue: VenueId, network: Network): AccountRef | null {
  const { address } = useAccount()
  return address && isTradeVenue(venue) ? { venue, network, owner: address.toLowerCase() as Address } : null
}

/** `status:secret` of the slot, a primitive so useSyncExternalStore can compare it. Null on the server. */
function useSlot(ref: AccountRef | null): string | null {
  return useSyncExternalStore(
    subscribeVault,
    () => {
      if (!ref) return null
      const key = keySlot(ref, TRADING[ref.venue].secrets).read()
      return key ? `${key.status}:${key.secret !== null}` : 'none'
    },
    () => null,
  )
}

export function useTradeSession(venue: VenueId, network: Network): TradeSession {
  const ref = useRef(venue, network)
  const slot = useSlot(ref)
  const client = useQueryClient()
  const { connector } = useAccount()
  const [progress, setProgress] = useState<StepId | null>(null)
  const module = isTradeVenue(venue) ? TRADING[venue] : null
  const unavailable = module?.unavailable(network) ?? null
  const linked = slot === 'linked:true'
  const steps = useQuery<readonly SetupStep[], TradeFailure>({
    queryKey: ref ? tradeKeys(ref).steps : ['trade', 'none'],
    queryFn: () => guard(ref!.venue, () => TRADING[ref!.venue].steps(contextFor(ref!))),
    enabled: Boolean(ref && !unavailable && !linked && slot !== null),
    staleTime: 30_000,
  })
  const enable = useMutation<void, TradeFailure>({
    mutationFn: async () => {
      const r = ref!
      const provider = (await connector!.getProvider()) as Parameters<typeof walletSigner>[0]
      const run = () => guard(r.venue, () => TRADING[r.venue].enable(contextFor(r), walletSigner(provider, r.owner), setProgress))
      await (typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks.request(`tape:enable:${accountKey(r)}`, run) : run())
    },
    onSettled: () => {
      setProgress(null)
      if (ref) void client.invalidateQueries({ queryKey: tradeKeys(ref).all })
    },
  })
  if (!module) return { status: 'read-only' }
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
    keyed: slot?.endsWith(':true') ?? false,
    enable: () => enable.mutate(),
    progress,
    error: enable.error?.error ?? steps.error?.error ?? null,
  }
}

/** Polls every 10 s while mounted and visible, inside Hyperliquid's weight budget with two tabs. Every command invalidates it. */
export function useAccountView(ref: AccountRef | null) {
  const query = useQuery<AccountView, TradeFailure>({
    queryKey: ref ? tradeKeys(ref).account : ['trade', 'none', 'account'],
    queryFn: () => guard(ref!.venue, () => TRADING[ref!.venue].account(contextFor(ref!))),
    enabled: Boolean(ref),
    refetchInterval: 10_000,
  })
  return { view: query.data, error: query.error?.error ?? null, isFetching: query.isFetching }
}

/** Null ref: nothing to send to yet (Binance, no wallet). `run` is then a no-op. */
export function useTradeCommands(ref: AccountRef | null) {
  const client = useQueryClient()
  const command = ref ? tradeKeys(ref).command : ['trade', 'none', 'command']
  const mutation = useMutation<CommandOutcome, TradeFailure, Command>({
    mutationKey: command,
    mutationFn: (c) => (ref ? guard(ref.venue, () => TRADING[ref.venue].execute(contextFor(ref), c)) : Promise.reject(new Error('no account'))),
    onError: (failure) => {
      // The venue no longer knows the key (revoked, or replaced from another device): back to the checklist.
      if (!ref || failure.error.kind !== 'needs-setup') return
      const slot = keySlot(ref, TRADING[ref.venue].secrets)
      const key = slot.read()
      if (key?.status === 'linked') slot.write({ ...key, status: 'draft' })
    },
    onSettled: () => (ref ? client.invalidateQueries({ queryKey: tradeKeys(ref).all }) : undefined),
  })
  const inFlight = useMutationState({ filters: { mutationKey: command, status: 'pending' }, select: (m) => m.state.variables as Command })
  return {
    run: mutation.mutate,
    last: { outcome: mutation.data ?? null, error: mutation.error?.error ?? null, pending: mutation.isPending, command: mutation.variables ?? null },
    inFlight,
  }
}
