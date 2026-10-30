import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { burnToHyperCore } from './cctp'
import { depositIssues, parseUsdc } from './deposit'
import type { DepositReadings, DepositRoute, SentDeposit } from './deposit'
import { DEPOSITS } from './index'

const owner: Address = '0x2e5346477b01397553df3ec9a637f3e535325d6d'
const known: DepositReadings = {
  usdc: 50_000_000n,
  native: 10n ** 15n,
  code: '0x',
  fee: null,
  gasCost: 10n ** 12n,
  rejected: null,
}
const [mainnetBridge] = DEPOSITS.hyperliquid!.routes('mainnet')
const bridge = mainnetBridge!

const routeFrom = (chainId: number): DepositRoute => {
  const found = DEPOSITS.hyperliquid!.routes('mainnet').find((r) => r.chainId === chainId)
  if (!found) throw new Error(`no route from ${chainId}`)
  return found
}

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

  it('stops a deposit the chain would revert, unless the balance already says why', () => {
    const rejected = 'Blacklistable: account is blacklisted'
    expect(depositIssues(bridge, 10_000_000n, { ...known, rejected })).toEqual([
      { kind: 'chain-rejects', reason: rejected },
    ])
    expect(depositIssues(bridge, 60_000_000n, { ...known, rejected: 'transfer amount exceeds balance' })).toEqual([
      { kind: 'insufficient-usdc', balance: 50_000_000n },
    ])
  })

  it('waits for readings it does not have yet', () => {
    const unknown = { usdc: null, native: null, code: null, fee: null, gasCost: null, rejected: null }
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

describe('Hyperliquid CCTP deposit', () => {
  const base = routeFrom(8453)
  const fee = { expected: 280_927n, max: 280_927n }

  it('leaves from Base, Optimism and Ethereum on mainnet only', () => {
    expect(DEPOSITS.hyperliquid!.routes('mainnet').map((r) => r.chainId)).toEqual([42161, 8453, 10, 1])
    expect(DEPOSITS.hyperliquid!.routes('testnet').map((r) => r.chainId)).toEqual([421614])
  })

  it('burns to the HyperCore forwarder exactly as a deposit Circle already forwarded', () => {
    // Input of 0xaa622ce2…e37c on Arbitrum: 685.64 USDC to the sender's own HyperCore perps.
    expect(
      burnToHyperCore(
        '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        '0x257caa046a30fa3459cd0a8af642cfb3664f4fca',
        0x28de0940n,
        200_000n,
      ).data.toLowerCase(),
    ).toBe(
      '0x779b432d0000000000000000000000000000000000000000000000000000000028de09400000000000000000000000000000000000000000000000000000000000000013000000000000000000000000b21d281dedb17ae5b501f6aa8256fe38c4e45757000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000b21d281dedb17ae5b501f6aa8256fe38c4e457570000000000000000000000000000000000000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000038636374702d666f72776172640000000000000000000000000000000000000018257caa046a30fa3459cd0a8af642cfb3664f4fca000000000000000000000000',
    )
  })

  it('approves exactly the amount first when the allowance falls short', () => {
    expect(base.calls(owner, 100_000_000n, fee, 0n).map((c) => [c.kind, c.to])).toEqual([
      ['approve', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
      ['deposit', '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'],
    ])
    expect(base.calls(owner, 100_000_000n, fee, 100_000_000n).map((c) => c.kind)).toEqual(['deposit'])
  })

  it('quotes the padded Fast Transfer fee plus the high forwarding fee, which Circle takes whole', async () => {
    const asked: string[] = []
    const fetch = (async (url: string) => {
      asked.push(url)
      return new Response(
        JSON.stringify([
          { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 236453, med: 250890, high: 265327 } },
          { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 236453, med: 250890, high: 265327 } },
        ]),
      )
    }) as typeof globalThis.fetch
    expect(await base.fee(fetch, 100_000_000n)).toEqual(fee)
    expect(asked).toEqual(['https://iris-api.circle.com/v2/burn/USDC/fees/6/19?forward=true&hyperCoreDeposit=true'])
  })

  it('follows the burn through Circle to the send Hyperliquid books from the CoreDepositWallet', async () => {
    const recipient: Address = '0xefc1aaf1ced837a170c2cad8d0551a49b31a2458'
    const sent: SentDeposit = {
      ref: { venue: 'hyperliquid', network: 'mainnet', owner: recipient },
      chainId: 8453,
      amount: 10_000_000_000n,
      hash: '0x984cf110c222b69d4d4f6b9b281957afb58327de519ffc457365f6be24ef46d7',
      sentAt: 1_793_320_800_000,
    }
    const credit = {
      time: 1_793_320_818_376,
      hash: '0x85e38878870112a1875d0447a7792800001ea05e2204317329ac33cb4604ec8c',
      delta: {
        type: 'send',
        user: '0x6b9e773128f453f5c2c60935ee2de2cbc5390a24',
        destination: recipient,
        sourceDex: 'spot',
        destinationDex: '',
        token: 'USDC',
        amount: '9999.8',
      },
    }
    const answer = (circle: unknown, ledger: unknown[]) =>
      (async (url: string) =>
        url.includes('circle')
          ? new Response(JSON.stringify(circle), { status: circle ? 200 : 404 })
          : new Response(JSON.stringify(ledger))) as typeof globalThis.fetch
    const forwarded = {
      messages: [
        {
          status: 'complete',
          forwardState: 'COMPLETE',
          forwardTxHash: '0xe7517ef6e8d20dcc5baa413981d377935d544f1379c907e2139477fc3e85ac84',
          decodedMessage: { decodedMessageBody: { feeExecuted: '200000' } },
        },
      ],
    }
    expect(await base.progress(answer(null, []), sent)).toMatchObject({ stage: 'relaying' })
    expect(await base.progress(answer({ messages: [{ status: 'pending_confirmations' }] }, []), sent)).toMatchObject({
      stage: 'relaying',
      detail: 'Waiting for Circle to attest the burn',
    })
    expect(
      await base.progress(answer(forwarded, [{ ...credit, delta: { ...credit.delta, amount: '9999.7' } }]), sent),
    ).toMatchObject({ stage: 'relaying' })
    expect(await base.progress(answer(forwarded, [credit]), sent)).toEqual({
      stage: 'credited',
      amount: 9_999_800_000n,
      at: credit.time,
      receipt: credit.hash,
    })
  })
})
