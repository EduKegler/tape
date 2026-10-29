import { createConfig, http } from 'wagmi'
import { arbitrum, base, mainnet, optimism } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

export const chains = [mainnet, arbitrum, base, optimism] as const

/** Native USDC per chain. Tape only reads balances: nothing here signs or sends. */
export const USDC: Record<(typeof chains)[number]['id'], `0x${string}`> = {
  [mainnet.id]: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  [arbitrum.id]: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  [base.id]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  [optimism.id]: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
}

export const wagmiConfig = createConfig({
  chains,
  connectors: [injected()],
  ssr: true,
  transports: { [mainnet.id]: http(), [arbitrum.id]: http(), [base.id]: http(), [optimism.id]: http() },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
