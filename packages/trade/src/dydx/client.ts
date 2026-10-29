// The npm polyfill, not Node's module: this runs in the browser, where cosmjs expects a global Buffer.
// eslint-disable-next-line node/prefer-node-protocol
import { Buffer } from 'buffer'
import type { Network } from '../types'

export async function sdk() {
  const scope = globalThis as { Buffer?: unknown }
  scope.Buffer ??= Buffer
  return import('@dydxprotocol/v4-client-js')
}

type Sdk = Awaited<ReturnType<typeof sdk>>
export type LocalWallet = Awaited<ReturnType<Sdk['LocalWallet']['fromMnemonic']>>
export type Validator = Awaited<ReturnType<Sdk['ValidatorClient']['connect']>>

/**
 * The Ethereum chain dYdX's frontend puts in the onboarding domain: `ethereumChainId` in v4-web's
 * public/configs/v1/env.json. The same wallet only derives the same dYdX account with the same chain.
 */
export const ONBOARDING_CHAIN: Record<Network, number> = { mainnet: 1, testnet: 11_155_111 }

/** What the wallet signs to derive the dYdX key, as v4-web's useSignForWalletDerivation asks for it. */
export const onboarding = (network: Network) =>
  ({
    primaryType: 'dYdX',
    domain: { name: 'dYdX Chain', chainId: ONBOARDING_CHAIN[network] },
    types: { dYdX: [{ name: 'action', type: 'string' }] },
    message: { action: 'dYdX Chain Onboarding' },
  }) as const

export async function deriveKey(signature: string): Promise<{ mnemonic: string; address: string }> {
  const { onboarding: derivation, LocalWallet } = await sdk()
  const { mnemonic } = derivation.deriveHDKeyFromEthereumSignature(signature)
  const wallet = await LocalWallet.fromMnemonic(mnemonic, 'dydx')
  return { mnemonic, address: wallet.address ?? '' }
}

const wallets = new Map<string, Promise<LocalWallet>>()
export function walletOf(mnemonic: string): Promise<LocalWallet> {
  let w = wallets.get(mnemonic)
  if (!w) {
    w = sdk().then(({ LocalWallet }) => LocalWallet.fromMnemonic(mnemonic, 'dydx'))
    wallets.set(mnemonic, w)
  }
  return w
}

const validators = new Map<Network, Promise<Validator>>()
export function validatorOf(network: Network): Promise<Validator> {
  let v = validators.get(network)
  if (!v) {
    v = sdk().then(({ Network: Net, ValidatorClient }) => ValidatorClient.connect((network === 'mainnet' ? Net.mainnet() : Net.testnet()).validatorConfig))
    v.catch(() => validators.delete(network))
    validators.set(network, v)
  }
  return v
}
