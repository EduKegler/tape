import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519'
import { base58, base64url } from '@scure/base'
import { bytesToHex, hashTypedData, hexToBytes, recoverTypedDataAddress, stringToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { localSigner, typedDataDigest } from '../typed-data'
import { accountId, addKeyTypedData, orderlyKey, registrationTypedData, signRequest } from './sign'

const wallet = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
type Viem = Parameters<typeof hashTypedData>[0]

describe('orderly signing', () => {
  it('builds registration typed data a wallet recovers to the owner', async () => {
    const data = registrationTypedData('woofi_pro', 421614, '194528949540', 1685973017064)
    expect(typedDataDigest(data)).toBe(hashTypedData(data as Viem))
    const signature = await localSigner(wallet).signTypedData(data)
    expect(await recoverTypedDataAddress({ ...(data as Viem), signature })).toBe(wallet.address)
  })

  it('builds AddOrderlyKey typed data that matches viem', () => {
    const data = addKeyTypedData({ brokerId: 'woofi_pro', chainId: 421614, orderlyKey: orderlyKey().id, scope: 'read,trading', timestamp: 1685973017064, expiration: 1688565017064 })
    expect(typedDataDigest(data)).toBe(hashTypedData(data as Viem))
  })

  it('derives one account id per address and broker', () => {
    expect(accountId(wallet.address, 'woofi_pro')).toMatch(/^0x[0-9a-f]{64}$/)
    expect(accountId(wallet.address, 'woofi_pro')).not.toBe(accountId(wallet.address, 'orderly'))
  })

  it('derives keys and signs as RFC 8032 test 1 does', () => {
    const secret = hexToBytes('0x9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
    expect(bytesToHex(ed25519.sign(new Uint8Array(), secret))).toBe(
      '0xe5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    )
    expect(orderlyKey(secret).id).toBe(`ed25519:${base58.encode(hexToBytes('0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'))}`)
  })

  it('signs timestamp, method, path and body in that order', () => {
    const key = orderlyKey()
    const body = '{"symbol":"PERP_ETH_USDC","order_type":"LIMIT","order_price":1521.03,"order_quantity":2.11,"side":"BUY"}'
    const headers = signRequest(key, '0xabc', 1649920583000, 'post', '/v1/order', body)
    const pub = base58.decode(key.id.slice('ed25519:'.length))
    expect(ed25519.verify(base64url.decode(headers['orderly-signature']!), stringToBytes(`1649920583000POST/v1/order${body}`), pub)).toBe(true)
    expect(headers['orderly-timestamp']).toBe('1649920583000')
    expect(headers['orderly-key']).toBe(key.id)
  })
})
