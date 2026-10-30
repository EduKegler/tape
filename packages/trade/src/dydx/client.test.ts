import { describe, expect, it, vi } from 'vitest'
import { validatorOf } from './client'

const connect = vi.hoisted(() => vi.fn())

vi.mock('@dydxprotocol/v4-client-js', () => ({
  Network: {
    mainnet: () => ({ validatorConfig: 'mainnet validator' }),
    testnet: () => ({ validatorConfig: 'testnet validator' }),
  },
  ValidatorClient: { connect },
}))

describe('dydx validator', () => {
  it('connects a testnet account to the testnet validator, and retries after a failed connect', async () => {
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(validatorOf('testnet')).rejects.toThrow('ECONNREFUSED')
    connect.mockResolvedValueOnce('testnet client')
    expect(await validatorOf('testnet')).toBe('testnet client')
    expect(connect).toHaveBeenLastCalledWith('testnet validator')
    connect.mockResolvedValueOnce('mainnet client')
    expect(await validatorOf('mainnet')).toBe('mainnet client')
    expect(connect).toHaveBeenLastCalledWith('mainnet validator')
  })
})
