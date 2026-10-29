import { ed25519 } from '@noble/curves/ed25519'
import { base58, base64url } from '@scure/base'
import { encodeAbiParameters, keccak256, stringToBytes } from 'viem'
import type { Address, Hex } from 'viem'
import type { TypedData } from '../typed-data'

/**
 * Orderly signs twice. The wallet signs EIP-712 once to register and once to add an ed25519
 * key, and that key then signs every private REST request.
 */

const VERIFYING_CONTRACT: Address = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC'
const domain = (chainId: number) => ({ name: 'Orderly', version: '1', chainId, verifyingContract: VERIFYING_CONTRACT })

export function registrationTypedData(brokerId: string, chainId: number, registrationNonce: string, timestamp: number): TypedData {
  return {
    domain: domain(chainId),
    primaryType: 'Registration',
    types: {
      Registration: [
        { name: 'brokerId', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'timestamp', type: 'uint64' },
        { name: 'registrationNonce', type: 'uint256' },
      ],
    },
    message: { brokerId, chainId, timestamp, registrationNonce },
  }
}

export interface AddKeyMessage {
  readonly brokerId: string
  readonly chainId: number
  readonly orderlyKey: string
  readonly scope: string
  readonly timestamp: number
  readonly expiration: number
}

export function addKeyTypedData(message: AddKeyMessage): TypedData {
  return {
    domain: domain(message.chainId),
    primaryType: 'AddOrderlyKey',
    types: {
      AddOrderlyKey: [
        { name: 'brokerId', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'orderlyKey', type: 'string' },
        { name: 'scope', type: 'string' },
        { name: 'timestamp', type: 'uint64' },
        { name: 'expiration', type: 'uint64' },
      ],
    },
    message: { ...message },
  }
}

export function accountId(address: Address, brokerId: string): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [address, keccak256(stringToBytes(brokerId))]))
}

export interface OrderlyKey {
  readonly secret: Uint8Array
  /** `ed25519:<base58 public key>`, the form Orderly takes in headers and in AddOrderlyKey. */
  readonly id: string
}

export function orderlyKey(secret: Uint8Array = ed25519.utils.randomPrivateKey()): OrderlyKey {
  return { secret, id: `ed25519:${base58.encode(ed25519.getPublicKey(secret))}` }
}

/** The four auth headers for one private request. `path` includes the query string. */
export function signRequest(key: OrderlyKey, account: Hex, timestamp: number, method: string, path: string, body = ''): Record<string, string> {
  const signature = ed25519.sign(stringToBytes(`${timestamp}${method.toUpperCase()}${path}${body}`), key.secret)
  return {
    'orderly-account-id': account,
    'orderly-key': key.id,
    'orderly-signature': base64url.encode(signature),
    'orderly-timestamp': String(timestamp),
  }
}
