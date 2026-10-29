import { numberToHex } from 'viem'
import type { Address, Hex } from 'viem'
import type { Eip712, WalletSigner } from './types'

interface Eip1193 {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

const DOMAIN_TYPES = {
  name: 'string',
  version: 'string',
  chainId: 'uint256',
  verifyingContract: 'address',
  salt: 'bytes32',
} as const

/** The domain's own keys, in EIP-712 order, as viem and MetaMask derive them. */
export function domainTypes(domain: Eip712['domain']) {
  return (Object.keys(DOMAIN_TYPES) as (keyof typeof DOMAIN_TYPES)[])
    .filter((k) => k in domain)
    .map((name) => ({ name, type: DOMAIN_TYPES[name] }))
}

export function walletJson(data: Eip712): string {
  return JSON.stringify({ ...data, types: { EIP712Domain: domainTypes(data.domain), ...data.types } })
}

/** eth_signTypedData_v4 with raw JSON, because viem refuses Hyperliquid's `HyperliquidTransaction:` type names. */
export function walletSigner(provider: Eip1193, address: Address): WalletSigner {
  return {
    address,
    chainId: async () => Number(await provider.request({ method: 'eth_chainId' })),
    switchChain: async (chainId) =>
      void (await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: numberToHex(chainId) }],
      })),
    signTypedData: async (data) =>
      (await provider.request({ method: 'eth_signTypedData_v4', params: [address, walletJson(data)] })) as Hex,
  }
}
