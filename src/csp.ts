import type { Network } from '@tape/core/ids'
import { CHAINS } from '#/wallet/chains'

export const CONNECT: Record<Network, readonly string[]> = {
  mainnet: [
    'https://data-api.binance.vision',
    'wss://data-stream.binance.vision',
    'https://api.hyperliquid.xyz',
    'wss://api.hyperliquid.xyz',
    'https://indexer.dydx.trade',
    'wss://indexer.dydx.trade',
    'https://dydx-ops-rpc.kingnodes.com',
    'https://api.orderly.org',
    'wss://ws-evm.orderly.org',
    'https://iris-api.circle.com',
    ...CHAINS.mainnet.flatMap((chain) => chain.rpcUrls.default.http.map((url) => new URL(url).origin)),
  ],
  testnet: [
    'https://testnet.binance.vision',
    'wss://stream.testnet.binance.vision',
    'https://api.hyperliquid-testnet.xyz',
    'wss://api.hyperliquid-testnet.xyz',
    'https://indexer.v4testnet.dydx.exchange',
    'wss://indexer.v4testnet.dydx.exchange',
    'https://test-dydx-rpc.kingnodes.com',
    'https://testnet-api.orderly.org',
    'wss://testnet-ws-evm.orderly.org',
    ...CHAINS.testnet.flatMap((chain) => chain.rpcUrls.default.http.map((url) => new URL(url).origin)),
  ],
}

const WALLETCONNECT = ['wss://relay.walletconnect.org']

const connectSrc = (origins: readonly string[]) => `connect-src 'self' ${origins.join(' ')}`

export function contentSecurityPolicy(nonce: string, network: Network, walletConnect: boolean): string {
  return [
    "default-src 'self'",
    // The dYdX client compiles WebAssembly. This allows that and still no eval.
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    connectSrc([...CONNECT[network], ...(walletConnect ? WALLETCONNECT : [])]),
    `frame-src ${walletConnect ? 'https://verify.walletconnect.org' : "'none'"}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export function workerSecurityPolicy(network: Network): string {
  return ["default-src 'self'", connectSrc(CONNECT[network])].join('; ')
}
