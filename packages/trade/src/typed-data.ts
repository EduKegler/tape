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
  readonly domain: {
    readonly name: string
    readonly version: string
    readonly chainId: number
    readonly verifyingContract: Address
  }
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
  const signature = `${name}(${fields.map((field) => `${field.type} ${field.name}`).join(',')})`
  const encoded = fields.map((field) => {
    const fieldValue = value[field.name]
    if (field.type === 'string') return keccak256(stringToBytes(String(fieldValue)))
    if (field.type === 'address') return encodeAbiParameters([{ type: 'address' }], [fieldValue as Address])
    if (field.type === 'bytes32') return fieldValue as Hex
    return encodeAbiParameters([{ type: 'uint256' }], [BigInt(fieldValue as number | string)])
  })
  return keccak256(concat([keccak256(stringToBytes(signature)), ...encoded]))
}

export function typedDataDigest(data: TypedData): Hex {
  const fields = data.types[data.primaryType] as readonly Field[]
  return keccak256(
    concat([
      '0x1901',
      structHash('EIP712Domain', DOMAIN_FIELDS, data.domain),
      structHash(data.primaryType, fields, data.message),
    ]),
  )
}

export function localSigner(account: {
  readonly address: Address
  sign: (args: { hash: Hex }) => Promise<Hex>
}): TypedDataSigner {
  return { address: account.address, signTypedData: (data) => account.sign({ hash: typedDataDigest(data) }) }
}
