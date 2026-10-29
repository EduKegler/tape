import { concat, encodeAbiParameters, keccak256, stringToBytes } from 'viem'
import type { Address, Hex } from 'viem'

/**
 * EIP-712 for the flat structs venues ask wallets to sign. Hashed here, not by viem, because
 * viem refuses Hyperliquid's `HyperliquidTransaction:` type names, so its signTypedData cannot
 * carry them to a wallet either.
 */

type FieldType = 'string' | 'address' | 'uint64' | 'uint256' | 'bytes32'
export interface Field {
  readonly name: string
  readonly type: FieldType
}

export interface TypedData {
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: Address }
  readonly types: Readonly<Record<string, readonly Field[]>>
  readonly primaryType: string
  readonly message: Readonly<Record<string, string | number>>
}

export interface TypedDataSigner {
  readonly address: Address
  signTypedData: (data: TypedData) => Promise<Hex>
}

const DOMAIN_FIELDS: readonly Field[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]

function structHash(name: string, fields: readonly Field[], value: Readonly<Record<string, string | number>>): Hex {
  const signature = `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`
  const encoded = fields.map((f) => {
    const v = value[f.name]
    if (f.type === 'string') return keccak256(stringToBytes(String(v)))
    if (f.type === 'address') return encodeAbiParameters([{ type: 'address' }], [v as Address])
    if (f.type === 'bytes32') return v as Hex
    return encodeAbiParameters([{ type: 'uint256' }], [BigInt(v as number | string)])
  })
  return keccak256(concat([keccak256(stringToBytes(signature)), ...encoded]))
}

export function typedDataDigest(data: TypedData): Hex {
  const fields = data.types[data.primaryType] as readonly Field[]
  return keccak256(concat(['0x1901', structHash('EIP712Domain', DOMAIN_FIELDS, data.domain), structHash(data.primaryType, fields, data.message)]))
}

export function localSigner(account: { readonly address: Address; sign: (args: { hash: Hex }) => Promise<Hex> }): TypedDataSigner {
  return { address: account.address, signTypedData: (data) => account.sign({ hash: typedDataDigest(data) }) }
}
