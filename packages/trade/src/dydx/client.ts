// The npm polyfill, not Node's module: this runs in the browser, where cosmjs expects a global Buffer.
// eslint-disable-next-line node/prefer-node-protocol
import { Buffer } from 'buffer'
import type { Network } from '../types'

/**
 * The only file that touches @dydxprotocol/v4-client-js. It is about 2.7 MB of cosmjs, so it
 * loads with import() on the first dYdX action, never on SSR or the first paint.
 */
export async function sdk() {
  const scope = globalThis as { Buffer?: unknown }
  scope.Buffer ??= Buffer
  return import('@dydxprotocol/v4-client-js')
}

type Sdk = Awaited<ReturnType<typeof sdk>>
export type LocalWallet = Awaited<ReturnType<Sdk['LocalWallet']['fromMnemonic']>>
export type Validator = Awaited<ReturnType<Sdk['ValidatorClient']['connect']>>

/** What the wallet signs to derive the dYdX key, as dYdX's own frontend asks for it. */
export const ONBOARDING = {
  primaryType: 'dYdX',
  domain: { name: 'dYdX Chain' },
  types: { dYdX: [{ name: 'action', type: 'string' }] },
  message: { action: 'dYdX Chain Onboarding' },
} as const

export async function deriveKey(signature: string): Promise<{ mnemonic: string; address: string }> {
  const { onboarding, LocalWallet } = await sdk()
  const { mnemonic } = onboarding.deriveHDKeyFromEthereumSignature(signature)
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
