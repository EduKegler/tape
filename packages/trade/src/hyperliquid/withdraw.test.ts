import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zeroAddress } from 'viem'
import type { Hex } from 'viem'
import { TradeFailure } from '../types'
import type { Eip712, VenueContext, WalletSigner } from '../types'
import { hyperliquidWithdraw } from './withdraw'

interface Recording {
  readonly ledger: { readonly response: readonly { time: number; hash: string; delta: { nonce: number } }[] }
  readonly refused: { readonly response: unknown }
}

const { ledger, refused } = JSON.parse(
  readFileSync(new URL('../__fixtures__/withdraw.hyperliquid.json', import.meta.url), 'utf8'),
) as Recording
const [booked] = ledger.response as [Recording['ledger']['response'][number]]

const owner: Hex = '0x14dc79964da2c08b23698b3d3cc7ca32193d9955'
const ARBITRUM = 42161
const SIG_R: Hex = `0x${'11'.repeat(32)}`
const SIG_S: Hex = `0x${'22'.repeat(32)}`

function stubWallet() {
  const asked: Eip712[] = []
  const wallet: WalletSigner = {
    address: owner,
    chainId: () => Promise.resolve(ARBITRUM),
    switchChain: () => Promise.reject(new Error('no switch expected')),
    signTypedData: (data) => {
      asked.push(data)
      return Promise.resolve<Hex>(`${SIG_R}${SIG_S.slice(2)}1b`)
    },
  }
  return { wallet, asked }
}

function context(reply: () => Promise<Response>) {
  const sent: { url: string; body: unknown }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(init?.body as string) })
    return reply()
  }) as typeof globalThis.fetch
  const ctx: VenueContext = {
    ref: { venue: 'hyperliquid', network: 'mainnet', owner },
    config: {
      mainnet: true,
      hyperliquid: { builder: null },
      dydx: { builder: null },
      orderly: { brokerId: { mainnet: null, testnet: 'demo' } },
    },
    keys: { read: () => null, write: () => {}, clear: () => {} },
    fetch,
  }
  return { ctx, sent }
}

const json = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body)))

const NOW = 1_793_593_820_807

describe('hyperliquid withdraw', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends withdraw3 to the same address, signed by the wallet with the time as nonce', async () => {
    const { wallet, asked } = stubWallet()
    const { ctx, sent } = context(json({ status: 'ok', response: { type: 'default' } }))
    await expect(hyperliquidWithdraw.withdraw(ctx, wallet, 10_500_000n)).resolves.toEqual({
      amount: 10_500_000n,
      nonce: NOW,
    })
    // The typed data of Hyperliquid's Python SDK, utils/signing.py, WITHDRAW_SIGN_TYPES, on the wallet's chain.
    expect(asked).toEqual([
      {
        domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: ARBITRUM, verifyingContract: zeroAddress },
        types: {
          'HyperliquidTransaction:Withdraw': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'destination', type: 'string' },
            { name: 'amount', type: 'string' },
            { name: 'time', type: 'uint64' },
          ],
        },
        primaryType: 'HyperliquidTransaction:Withdraw',
        message: { hyperliquidChain: 'Mainnet', destination: owner, amount: '10.5', time: NOW },
      },
    ])
    expect(sent).toEqual([
      {
        url: 'https://api.hyperliquid.xyz/exchange',
        body: {
          action: {
            type: 'withdraw3',
            signatureChainId: '0xa4b1',
            hyperliquidChain: 'Mainnet',
            destination: owner,
            amount: '10.5',
            time: NOW,
          },
          nonce: NOW,
          signature: { r: SIG_R, s: SIG_S, v: 27 },
        },
      },
    ])
  })

  it('reads a refusal as rejected, so the trader knows nothing left', async () => {
    const { ctx } = context(json(refused.response))
    const failure = await hyperliquidWithdraw
      .withdraw(ctx, stubWallet().wallet, 2_000_000n)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TradeFailure)
    expect((failure as TradeFailure).error).toEqual({ kind: 'rejected', detail: 'Error withdrawing from bridge' })
  })

  it('reads a send with no answer as an unknown outcome', async () => {
    const { ctx } = context(() => Promise.reject(new TypeError('Failed to fetch')))
    const failure = await hyperliquidWithdraw
      .withdraw(ctx, stubWallet().wallet, 2_000_000n)
      .catch((error: unknown) => error)
    expect((failure as TradeFailure).error.kind).toBe('unknown-outcome')
  })

  it('finds the finalized withdrawal by its nonce, with what left after the fee', async () => {
    const nonce = booked.delta.nonce / 1000
    const { ctx, sent } = context(json(ledger.response))
    await expect(hyperliquidWithdraw.progress(ctx, { amount: 10_000_000n, nonce })).resolves.toEqual({
      stage: 'finalized',
      received: 9_000_000n,
      at: booked.time,
    })
    expect(sent).toEqual([
      {
        url: 'https://api.hyperliquid.xyz/info',
        body: { type: 'userNonFundingLedgerUpdates', user: owner, startTime: nonce },
      },
    ])
  })

  it('waits while the ledger holds no withdrawal with that nonce', async () => {
    const { ctx } = context(json(ledger.response))
    await expect(hyperliquidWithdraw.progress(ctx, { amount: 10_000_000n, nonce: NOW })).resolves.toEqual({
      stage: 'pending',
    })
  })
})
