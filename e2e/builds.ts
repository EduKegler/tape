import type { Network } from '@tape/core/ids'

export const TEST_BUILDER = '0x7e57000000000000000000000000000000000b1d'

export const BUILD_ENV: Record<Network, Readonly<Record<string, string>>> = {
  testnet: {},
  mainnet: { VITE_TRADE_MAINNET: 'hyperliquid', VITE_HL_BUILDER_ADDRESS: TEST_BUILDER },
}
