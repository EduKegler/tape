import { arbitrum, arbitrumSepolia, base, mainnet, optimism, sepolia } from 'wagmi/chains'

export const CHAINS = {
  mainnet: [mainnet, arbitrum, base, optimism],
  testnet: [arbitrumSepolia, sepolia],
} as const
