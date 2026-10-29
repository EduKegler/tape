import { encode } from '@msgpack/msgpack'
import { concat, hexToBytes, keccak256, numberToHex, parseSignature } from 'viem'
import type { Address, Hex } from 'viem'
import type { TypedData, TypedDataSigner } from '../typed-data'

/**
 * Hyperliquid has two signing schemes, both EIP-712, mirrored from the official
 * Python SDK (hyperliquid/utils/signing.py), whose vectors the tests replay.
 *
 * L1 actions (order, cancel, leverage) are msgpack-hashed with the nonce and signed
 * by the agent key as a "phantom agent". User actions (approve an agent, approve a
 * builder fee) are typed data the wallet signs itself.
 */

export type HlChain = 'Mainnet' | 'Testnet'

export interface HlSignature {
  readonly r: Hex
  readonly s: Hex
  readonly v: number
}

export function actionHash(action: unknown, vault: Address | null, nonce: number, expiresAfter: number | null): Hex {
  const parts: Uint8Array[] = [encode(action), u64(nonce)]
  parts.push(vault ? concat([Uint8Array.of(1), hexToBytes(vault)]) : Uint8Array.of(0))
  if (expiresAfter !== null) parts.push(Uint8Array.of(0), u64(expiresAfter))
  return keccak256(concat(parts))
}

export function l1TypedData(hash: Hex, chain: HlChain): TypedData {
  return {
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent',
    message: { source: chain === 'Mainnet' ? 'a' : 'b', connectionId: hash },
  }
}

export async function signL1Action(signer: TypedDataSigner, action: unknown, nonce: number, chain: HlChain, vault: Address | null = null): Promise<HlSignature> {
  return split(await signer.signTypedData(l1TypedData(actionHash(action, vault, nonce, null), chain)))
}

/** Any chain id works for user actions. `hyperliquidChain` is what stops a replay across networks. */
export const SIGNATURE_CHAIN_ID = 0x66eee

const USER_TYPES = {
  'HyperliquidTransaction:ApproveAgent': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'agentAddress', type: 'address' },
    { name: 'agentName', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ],
  'HyperliquidTransaction:ApproveBuilderFee': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'maxFeeRate', type: 'string' },
    { name: 'builder', type: 'address' },
    { name: 'nonce', type: 'uint64' },
  ],
  'HyperliquidTransaction:UsdSend': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'destination', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'time', type: 'uint64' },
  ],
  'HyperliquidTransaction:Withdraw': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'destination', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'time', type: 'uint64' },
  ],
} as const

export type UserActionType = keyof typeof USER_TYPES

export function userTypedData(primaryType: UserActionType, message: Record<string, string | number>, chainId: number = SIGNATURE_CHAIN_ID): TypedData {
  return {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: { [primaryType]: USER_TYPES[primaryType] },
    primaryType,
    message,
  }
}

export async function signUserAction(signer: TypedDataSigner, primaryType: UserActionType, message: Record<string, string | number>, chainId?: number): Promise<HlSignature> {
  return split(await signer.signTypedData(userTypedData(primaryType, message, chainId)))
}

export const signatureChainIdHex = (chainId: number = SIGNATURE_CHAIN_ID): Hex => numberToHex(chainId)

function split(signature: Hex): HlSignature {
  const { r, s, v, yParity } = parseSignature(signature)
  return { r, s, v: v === undefined ? 27 + yParity : Number(v) }
}

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value))
  return bytes
}
