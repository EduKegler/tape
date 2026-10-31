import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { hashTypedData, hexToBigInt } from 'viem'
import type { Hex } from 'viem'
import { localSigner, typedDataDigest } from '../typed-data'
import { actionHash, l1TypedData, signL1Action, signUserAction } from './sign'
import type { HlSignature } from './sign'

// Vectors from hyperliquid-python-sdk tests/signing_test.py. Python's to_hex drops leading zeros, so compare as integers.
const wallet = localSigner(privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123'))

function expectSig(actual: HlSignature, r: Hex, s: Hex, v: number) {
  expect([hexToBigInt(actual.r), hexToBigInt(actual.s), actual.v]).toEqual([hexToBigInt(r), hexToBigInt(s), v])
}

const order = (t: unknown, c?: string) => ({
  type: 'order',
  orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t, ...(c ? { c } : {}) }],
  grouping: 'na',
})

describe('hyperliquid signing', () => {
  it('computes the same EIP-712 digest as viem where viem accepts the type names', () => {
    const data = l1TypedData('0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908', 'Mainnet')
    expect(typedDataDigest(data)).toBe(hashTypedData(data as Parameters<typeof hashTypedData>[0]))
  })

  it('hashes an order action like production', () => {
    const action = {
      type: 'order',
      orders: [{ a: 4, b: true, p: '1670.1', s: '0.0147', r: false, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    }
    expect(actionHash(action, null, 1677777606040, null)).toBe(
      '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908',
    )
  })

  it('signs an L1 action on both chains', async () => {
    const action = { type: 'dummy', num: 100_000_000_000 }
    expectSig(
      await signL1Action(wallet, action, 0, 'Mainnet'),
      '0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298',
      '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8',
      27,
    )
    expectSig(
      await signL1Action(wallet, action, 0, 'Testnet'),
      '0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510',
      '0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613',
      28,
    )
  })

  it('signs a limit order', async () => {
    const action = order({ limit: { tif: 'Gtc' } })
    expectSig(
      await signL1Action(wallet, action, 0, 'Mainnet'),
      '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e',
      '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e',
      28,
    )
    expectSig(
      await signL1Action(wallet, action, 0, 'Testnet'),
      '0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54',
      '0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5',
      27,
    )
  })

  it('signs an order with a client id', async () => {
    const action = order({ limit: { tif: 'Gtc' } }, '0x00000000000000000000000000000001')
    expectSig(
      await signL1Action(wallet, action, 0, 'Mainnet'),
      '0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3',
      '0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da',
      27,
    )
  })

  it('signs a stop-loss trigger order', async () => {
    const action = order({ trigger: { isMarket: true, triggerPx: '103', tpsl: 'sl' } })
    expectSig(
      await signL1Action(wallet, action, 0, 'Mainnet'),
      '0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9',
      '0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405',
      27,
    )
  })

  it('signs with a vault address', async () => {
    const action = { type: 'dummy', num: 100_000_000_000 }
    expectSig(
      await signL1Action(wallet, action, 0, 'Mainnet', '0x1719884eb866cb12b2287399b15f7db5e7d775ea'),
      '0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239',
      '0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c',
      28,
    )
  })

  it('signs schedule cancel with and without a time', async () => {
    expectSig(
      await signL1Action(wallet, { type: 'scheduleCancel' }, 0, 'Mainnet'),
      '0x6cdfb286702f5917e76cd9b3b8bf678fcc49aec194c02a73e6d4f16891195df9',
      '0x6557ac307fa05d25b8d61f21fb8a938e703b3d9bf575f6717ba21ec61261b2a0',
      27,
    )
    expectSig(
      await signL1Action(wallet, { type: 'scheduleCancel', time: 123456789 }, 0, 'Mainnet'),
      '0x609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55',
      '0x16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b',
      28,
    )
  })

  it('signs user actions with the wallet', async () => {
    const message = {
      hyperliquidChain: 'Testnet',
      destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a',
      amount: '1',
      time: 1687816341423,
    }
    expectSig(
      await signUserAction(wallet, 'HyperliquidTransaction:UsdSend', message),
      '0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073',
      '0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7',
      27,
    )
    expectSig(
      await signUserAction(wallet, 'HyperliquidTransaction:Withdraw', message),
      '0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9',
      '0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881',
      28,
    )
  })

  // Some wallets end the signature with the y parity 00 or 01, and Hyperliquid takes v as 27 or 28 like the vectors above.
  it('normalizes a wallet signature with v 0 or 1 to 27 or 28', async () => {
    const message = {
      hyperliquidChain: 'Testnet',
      destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a',
      amount: '1',
      time: 1,
    }
    const ending = (r: Hex, s: Hex, parity: '00' | '01') => ({
      address: wallet.address,
      signTypedData: async () => `${r}${s.slice(2)}${parity}` as Hex,
    })
    const [r27, s27] = [
      '0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073',
      '0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7',
    ] as const
    const [r28, s28] = [
      '0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9',
      '0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881',
    ] as const
    expectSig(await signUserAction(ending(r27, s27, '00'), 'HyperliquidTransaction:UsdSend', message), r27, s27, 27)
    expectSig(await signUserAction(ending(r28, s28, '01'), 'HyperliquidTransaction:UsdSend', message), r28, s28, 28)
  })
})
