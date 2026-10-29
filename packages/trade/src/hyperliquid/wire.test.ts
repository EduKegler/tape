import { describe, expect, it } from 'vitest'
import { hexToBigInt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { localSigner } from '../typed-data'
import { signL1Action } from './sign'
import { orderAction, orderWire } from './wire'

const wallet = localSigner(privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123'))
const r = async (action: unknown) => hexToBigInt((await signL1Action(wallet, action, 0, 'Mainnet')).r)

describe('hyperliquid wire', () => {
  it('builds the order actions the SDK vectors sign', async () => {
    const limit = orderAction([orderWire(1, true, '100', '100', false, { limit: { tif: 'Gtc' } })], 'na', null)
    expect(await r(limit)).toBe(hexToBigInt('0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e'))
    const cloid = orderAction(
      [orderWire(1, true, '100', '100', false, { limit: { tif: 'Gtc' } }, '0x00000000000000000000000000000001')],
      'na',
      null,
    )
    expect(await r(cloid)).toBe(hexToBigInt('0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3'))
    const stop = orderAction(
      [orderWire(1, true, '100', '100', false, { trigger: { tpsl: 'sl', triggerPx: '103', isMarket: true } })],
      'na',
      null,
    )
    expect(await r(stop)).toBe(hexToBigInt('0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9'))
  })

  it('appends the builder after grouping with a lowercase address', () => {
    const action = orderAction([], 'na', { b: '0xAbCdEf0000000000000000000000000000000001', f: 10 })
    expect(Object.keys(action)).toEqual(['type', 'orders', 'grouping', 'builder'])
    expect(action.builder?.b).toBe('0xabcdef0000000000000000000000000000000001')
  })
})
