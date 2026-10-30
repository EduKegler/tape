import type { Network } from '@tape/core/ids'
import { NETWORK } from '#/site'
import { CHAINS, WALLETCONNECT_PROJECT_ID } from '#/wallet/config'

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
    ...CHAINS.mainnet.flatMap((c) => c.rpcUrls.default.http.map((url) => new URL(url).origin)),
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
    ...CHAINS.testnet.flatMap((c) => c.rpcUrls.default.http.map((url) => new URL(url).origin)),
  ],
}

const WALLETCONNECT = ['wss://relay.walletconnect.org']

export function contentSecurityPolicy(
  nonce: string,
  network: Network = NETWORK,
  walletConnect = Boolean(WALLETCONNECT_PROJECT_ID),
): string {
  const connect = [...CONNECT[network], ...(walletConnect ? WALLETCONNECT : [])]
  return [
    "default-src 'self'",
    // The dYdX client compiles WebAssembly. This allows that and still no eval.
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${connect.join(' ')}`,
    `frame-src ${walletConnect ? 'https://verify.walletconnect.org' : "'none'"}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}
