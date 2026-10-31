import { isHex } from 'viem'
import type { Address } from 'viem'
import { isRecord } from '@tape/core/json'
import { keysOf } from '@tape/core/record'
import type { Eip712, WalletSigner } from './types'

export interface Eip1193 {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

/** A wallet provider with EIP-1193's `request`. Throws on anything else. */
export function toEip1193(provider: unknown): Eip1193 {
  if (!isEip1193(provider)) throw new Error('The wallet has no EIP-1193 provider')
  return provider
}

const isEip1193 = (provider: unknown): provider is Eip1193 =>
  isRecord(provider) && typeof provider.request === 'function'

const DOMAIN_TYPES = {
  name: 'string',
  version: 'string',
  chainId: 'uint256',
  verifyingContract: 'address',
  salt: 'bytes32',
} as const

/** The domain's own keys, in EIP-712 order, as viem and MetaMask derive them. */
export function domainTypes(domain: Eip712['domain']) {
  return keysOf(DOMAIN_TYPES)
    .filter((key) => key in domain)
    .map((name) => ({ name, type: DOMAIN_TYPES[name] }))
}

export function walletJson(data: Eip712): string {
  return JSON.stringify({ ...data, types: { EIP712Domain: domainTypes(data.domain), ...data.types } })
}

/** eth_signTypedData_v4 with raw JSON, because viem refuses Hyperliquid's `HyperliquidTransaction:` type names. */
export function walletSigner(
  provider: Eip1193,
  address: Address,
  switchChain: (chainId: number) => Promise<void>,
): WalletSigner {
  return {
    address,
    chainId: async () => Number(await provider.request({ method: 'eth_chainId' })),
    switchChain,
    signTypedData: async (data) => {
      const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [address, walletJson(data)] })
      if (!isHex(signature)) throw new Error('The wallet returned a signature that is not hex')
      return signature
    },
  }
}

/** What went wrong in a wallet call. Wallets such as MetaMask reject with a plain `{ code, message }`, not an Error. */
export function rejectionMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = isRecord(error) ? error.message : undefined
  return typeof message === 'string' ? message : String(error)
}
