import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { depositIssues, parseUsdc } from './deposit'
import type { DepositReadings, SentDeposit } from './deposit'
import { DEPOSITS } from './index'

const owner: Address = '0x2e5346477b01397553df3ec9a637f3e535325d6d'
const known: DepositReadings = { usdc: 50_000_000n, native: 10n ** 15n, code: '0x', fee: null, gasCost: 10n ** 12n }
const [mainnetBridge] = DEPOSITS.hyperliquid!.routes('mainnet')
const bridge = mainnetBridge!

function ledgerFetch(entries: unknown[]) {
  const asked: Record<string, unknown>[] = []
  const fetch = (async (_url: string, init?: RequestInit) => {
    asked.push(JSON.parse(init!.body as string) as Record<string, unknown>)
    return new Response(JSON.stringify(entries))
  }) as typeof globalThis.fetch
  return { fetch, asked }
}

describe('USDC amounts', () => {
  it('reads plain decimals at 6 places and nothing finer', () => {
    expect(parseUsdc('10')).toBe(10_000_000n)
    expect(parseUsdc('0.000001')).toBe(1n)
    expect(parseUsdc('5.5')).toBe(5_500_000n)
    expect(parseUsdc('1.0000001')).toBeNull()
    expect(parseUsdc('0')).toBeNull()
    expect(parseUsdc('-1')).toBeNull()
    expect(parseUsdc('1e3')).toBeNull()
    expect(parseUsdc('')).toBeNull()
  })
})

describe('deposit issues', () => {
  it('stops a bridge deposit under 5 USDC, which Hyperliquid would keep', () => {
    expect(depositIssues(bridge, 4_999_999n, known)).toEqual([
      { kind: 'below-minimum', minimum: 5_000_000n, lost: true },
    ])
    expect(depositIssues(bridge, 5_000_000n, known)).toEqual([])
  })

  it('stops a deposit past the balance or the gas the wallet holds', () => {
    expect(depositIssues(bridge, 60_000_000n, { ...known, native: 1n })).toEqual([
      { kind: 'insufficient-usdc', balance: 50_000_000n },
      { kind: 'insufficient-gas', need: 10n ** 12n, have: 1n },
    ])
  })

  it('stops a contract wallet, since the venue credits the same address, but not an EIP-7702 account', () => {
    expect(depositIssues(bridge, 10_000_000n, { ...known, code: '0x6080604052' })).toEqual([
      { kind: 'contract-wallet' },
    ])
    expect(depositIssues(bridge, 10_000_000n, { ...known, code: `0xef0100${'ab'.repeat(20)}` })).toEqual([])
  })

  it('stops a fee that eats the deposit and warns from 1%', () => {
    const route = { ...bridge, minimum: null }
    expect(depositIssues(route, 200_000n, { ...known, fee: { expected: 150_000n, max: 200_000n } })).toEqual([
      { kind: 'fee-exceeds-amount', fee: 200_000n },
    ])
    expect(depositIssues(route, 20_000_000n, { ...known, fee: { expected: 250_000n, max: 300_000n } })).toEqual([
      { kind: 'high-fee', bps: 125 },
    ])
    expect(depositIssues(route, 50_000_000n, { ...known, fee: { expected: 250_000n, max: 300_000n } })).toEqual([])
  })

  it('waits for readings it does not have yet', () => {
    const unknown = { usdc: null, native: null, code: null, fee: null, gasCost: null }
    expect(depositIssues(bridge, 10_000_000n, unknown)).toEqual([])
  })
})

describe('Hyperliquid bridge deposit', () => {
  it('sends USDC to the bridge on Arbitrum in one transfer, as a deposit already credited did', () => {
    expect(bridge.chainId).toBe(42161)
    expect(bridge.calls(owner, 10_000_000n, { expected: 0n, max: 0n }, 0n)).toEqual([
      {
        kind: 'deposit',
        to: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        // Input of 0xb3c8792e…c38d, which Hyperliquid credited as 10 USDC.
        data: '0xa9059cbb0000000000000000000000002df1c51e09aecf9cacb7bc98cb1742757f163df70000000000000000000000000000000000000000000000000000000000989680',
        gasFallback: expect.any(BigInt) as bigint,
      },
    ])
  })

  it('uses the testnet bridge and its USDC on Arbitrum Sepolia', () => {
    const [testnet] = DEPOSITS.hyperliquid!.routes('testnet')
    const [call] = testnet!.calls(owner, 5_000_000n, { expected: 0n, max: 0n }, 0n)
    expect(testnet!.chainId).toBe(421614)
    expect(call?.to).toBe('0x1baAbB04529D43a73232B713C0FE471f7c7334d5')
    expect(call?.data.toLowerCase()).toContain('08cfc1b6b2dcf36a1480b99353a354aa8ac56f89')
  })

  it('finds the credit by the Arbitrum hash in the ledger', async () => {
    const hash: Hex = '0xb3c8792eef5f30fa47a67dfffc3338656530ee1b80f6805b6de3b8fc5ec5c38d'
    const sent: SentDeposit = {
      ref: { venue: 'hyperliquid', network: 'mainnet', owner },
      chainId: 42161,
      amount: 10_000_000n,
      hash,
      sentAt: 1_793_325_600_000,
    }
    const waiting = ledgerFetch([
      { time: 1, hash: '0x01', delta: { type: 'deposit', usdc: '10.0' } },
      { time: 2, hash: '0x02', delta: { type: 'withdraw', usdc: '3.0', nonce: 1, fee: '1.0' } },
    ])
    expect(await bridge.progress(waiting.fetch, sent)).toMatchObject({ stage: 'relaying' })
    expect(waiting.asked[0]).toEqual({
      type: 'userNonFundingLedgerUpdates',
      user: owner,
      startTime: sent.sentAt - 600_000,
    })
    const credited = ledgerFetch([{ time: 1_793_325_632_379, hash, delta: { type: 'deposit', usdc: '10.0' } }])
    expect(await bridge.progress(credited.fetch, sent)).toEqual({
      stage: 'credited',
      amount: 10_000_000n,
      at: 1_793_325_632_379,
      receipt: hash,
    })
  })
})
