import { ChainNotConfiguredError, createConfig, http } from 'wagmi'
import type { Transport } from 'wagmi'
import { switchChain } from 'wagmi/actions'
import { injected, walletConnect } from 'wagmi/connectors'
import { z } from 'zod'
import { fromKeys } from '@tape/core/record'
import { NETWORK } from '#/site'
import { CHAINS } from './chains'

export const chains = CHAINS[NETWORK]
export type ChainId = (typeof chains)[number]['id']

export const isChainId = (id: number): id is ChainId => chains.some((chain) => chain.id === id)

export function toChainId(id: number): ChainId {
  if (!isChainId(id)) throw new ChainNotConfiguredError()
  return id
}

export const WALLETCONNECT_PROJECT_ID = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .optional()
  .parse(import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || undefined)

export const wagmiConfig = createConfig({
  chains,
  connectors: [
    injected(),
    ...(WALLETCONNECT_PROJECT_ID
      ? [
          walletConnect({
            projectId: WALLETCONNECT_PROJECT_ID,
            showQrModal: false,
            metadata: {
              name: 'Tape',
              description: 'Order book, trades and order entry across venues.',
              url: typeof window === 'undefined' ? 'https://tape.kegler.dev' : window.location.origin,
              icons: [],
            },
          }),
        ]
      : []),
  ],
  ssr: true,
  transports: fromKeys(
    chains.map((chain) => chain.id),
    (): Transport => http(),
  ),
})

export async function switchOrAddChain(chainId: number): Promise<void> {
  await switchChain(wagmiConfig, { chainId: toChainId(chainId) })
}

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
