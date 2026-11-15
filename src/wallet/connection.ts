import { useHydrated } from '@tanstack/react-router'
// eslint-disable-next-line no-restricted-imports -- the one place that reads wagmi's connection, so hydration sees what the server rendered
import { useConnection } from 'wagmi'
import type { UseConnectionReturnType } from 'wagmi'

const DISCONNECTED: Extract<UseConnectionReturnType, { status: 'disconnected' }> = {
  address: undefined,
  addresses: undefined,
  chain: undefined,
  chainId: undefined,
  connector: undefined,
  isConnected: false,
  isConnecting: false,
  isDisconnected: true,
  isReconnecting: false,
  status: 'disconnected',
}

/**
 * wagmi's useConnection hands React the live store as its server snapshot, and TanStack Router hydrates a lazy route
 * after WagmiProvider's mount effect has begun reconnecting, so the route reads disconnected until hydration ends.
 */
export function useWalletConnection(): UseConnectionReturnType {
  const connection = useConnection()
  return useHydrated() ? connection : DISCONNECTED
}
