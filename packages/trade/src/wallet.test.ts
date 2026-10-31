import { describe, expect, it } from 'vitest'
import { rejectionMessage, walletSigner } from './wallet'

const owner = '0x2e5346477b01397553df3ec9a637f3e535325d6d'

function provider() {
  const asked: { method: string; params?: unknown[] }[] = []
  return {
    asked,
    request: async (args: { method: string; params?: unknown[] }) => {
      asked.push(args)
      return args.method === 'eth_chainId' ? '0xa4b1' : '0xabcd'
    },
  }
}

describe('wallet signer', () => {
  it('asks the wallet for its chain and a v4 signature in EIP-1193 shapes, and leaves the switch to the caller', async () => {
    const wallet = provider()
    const switched: number[] = []
    const signer = walletSigner(wallet, owner, async (chainId) => {
      switched.push(chainId)
    })
    expect(signer.address).toBe(owner)
    expect(await signer.chainId()).toBe(42161)
    await signer.switchChain(42161)
    expect(switched).toEqual([42161])
    expect(
      await signer.signTypedData({
        domain: { name: 'Exchange', version: '1', chainId: 1337 },
        types: { Agent: [{ name: 'source', type: 'string' }] },
        primaryType: 'Agent',
        message: { source: 'b' },
      }),
    ).toBe('0xabcd')
    const [chain, sign, ...more] = wallet.asked
    expect(more).toEqual([])
    expect(chain).toEqual({ method: 'eth_chainId' })
    expect(sign?.method).toBe('eth_signTypedData_v4')
    expect(sign?.params?.[0]).toBe(owner)
    expect(JSON.parse(sign?.params?.[1] as string)).toEqual({
      domain: { name: 'Exchange', version: '1', chainId: 1337 },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        Agent: [{ name: 'source', type: 'string' }],
      },
      primaryType: 'Agent',
      message: { source: 'b' },
    })
  })
})

describe('rejection message', () => {
  it('reads the message of the plain { code, message } an EIP-1193 wallet rejects with', () => {
    expect(rejectionMessage({ code: -32603, message: 'Internal JSON-RPC error.' })).toBe('Internal JSON-RPC error.')
  })

  it('reads an Error, and writes anything else as it is', () => {
    expect(rejectionMessage(new Error('Request expired'))).toBe('Request expired')
    expect(rejectionMessage('Request expired')).toBe('Request expired')
    expect(rejectionMessage(null)).toBe('null')
  })
})
