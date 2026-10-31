import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient, custom } from 'viem'
import type { Address, Hex } from 'viem'
import { burnToHyperCore } from './cctp'
import { blocksDeposit, depositIssues, parseUsdc } from './deposit'
import type {
  DepositFee,
  DepositIssue,
  DepositReadings,
  DepositRoute,
  DepositTerms,
  ProgressIo,
  SentDeposit,
} from './deposit'
import type { TradeConfig, TradeError } from './types'
import { TradeFailure } from './types'
import { DEPOSITS } from './index'

const owner: Address = '0x2e5346477b01397553df3ec9a637f3e535325d6d'
const known: DepositReadings = {
  usdc: 50_000_000n,
  native: 10n ** 15n,
  code: '0x',
  terms: null,
  gasCost: 10n ** 12n,
  rejected: null,
}
const config: TradeConfig = {
  mainnet: true,
  hyperliquid: { builder: null },
  dydx: { builder: null },
  orderly: { brokerId: { mainnet: 'tape', testnet: 'demo' } },
}
const feeOnly = (fee: DepositFee): DepositTerms => ({ fee, message: null, refusal: null })
const noFee = feeOnly({ expected: 0n, max: 0n })
const io = (fetch: typeof globalThis.fetch): ProgressIo => ({
  fetch,
  keys: { read: () => null, write: () => {}, clear: () => {} },
})
const noChain = createPublicClient({
  transport: custom({ request: () => Promise.reject(new Error('this route reads no chain')) }),
})
const [mainnetBridge] = DEPOSITS.hyperliquid!.routes('mainnet', config)
const bridge = mainnetBridge!

const routeFrom = (chainId: number): DepositRoute => {
  const found = DEPOSITS.hyperliquid!.routes('mainnet', config).find((route) => route.chainId === chainId)
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
    expect(depositIssues(route, 200_000n, { ...known, terms: feeOnly({ expected: 150_000n, max: 200_000n }) })).toEqual(
      [{ kind: 'fee-exceeds-amount', fee: 200_000n }],
    )
    expect(
      depositIssues(route, 20_000_000n, { ...known, terms: feeOnly({ expected: 250_000n, max: 300_000n }) }),
    ).toEqual([{ kind: 'high-fee', bps: 125 }])
    expect(
      depositIssues(route, 50_000_000n, { ...known, terms: feeOnly({ expected: 250_000n, max: 300_000n }) }),
    ).toEqual([])
  })

  it('stops a deposit the venue refuses, and counts the messenger fee in the gas the wallet needs', () => {
    const terms: DepositTerms = {
      fee: { expected: 0n, max: 0n },
      message: { via: 'LayerZero', wei: 10n ** 14n },
      refusal: { kind: 'no-account' },
    }
    expect(depositIssues(bridge, 10_000_000n, { ...known, native: 10n ** 14n, terms })).toEqual([
      { kind: 'no-account' },
      { kind: 'insufficient-gas', need: 10n ** 14n + 10n ** 12n, have: 10n ** 14n },
    ])
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

  it('warns from exactly 1% fee', () => {
    const route = { ...bridge, minimum: null }
    expect(
      depositIssues(route, 25_000_000n, { ...known, terms: feeOnly({ expected: 250_000n, max: 300_000n }) }),
    ).toEqual([{ kind: 'high-fee', bps: 100 }])
  })

  it('judges gas only once it knows the native balance, and passes a balance that covers it exactly', () => {
    expect(depositIssues(bridge, 10_000_000n, { ...known, native: null })).toEqual([])
    expect(depositIssues(bridge, 10_000_000n, { ...known, native: known.gasCost })).toEqual([])
  })

  it('lists a chain revert next to an issue other than the balance', () => {
    const rejected = 'Blacklistable: account is blacklisted'
    expect(depositIssues(bridge, 10_000_000n, { ...known, code: '0x6080604052', rejected })).toEqual([
      { kind: 'contract-wallet' },
      { kind: 'chain-rejects', reason: rejected },
    ])
  })

  it('lets a high fee through as a warning and blocks every other deposit issue', () => {
    const blocking: DepositIssue[] = [
      { kind: 'below-minimum', minimum: 5_000_000n, lost: true },
      { kind: 'fee-exceeds-amount', fee: 200_000n },
      { kind: 'insufficient-usdc', balance: 0n },
      { kind: 'insufficient-gas', need: 2n, have: 1n },
      { kind: 'contract-wallet' },
      { kind: 'chain-rejects', reason: 'paused' },
      { kind: 'no-account' },
      { kind: 'over-limit', room: 0n },
    ]
    expect(blocking.map(blocksDeposit)).toEqual(blocking.map(() => true))
    expect(blocksDeposit({ kind: 'high-fee', bps: 150 })).toBe(false)
  })

  it('waits for readings it does not have yet', () => {
    const unknown = { usdc: null, native: null, code: null, terms: null, gasCost: null, rejected: null }
    expect(depositIssues(bridge, 10_000_000n, unknown)).toEqual([])
  })
})

describe('Hyperliquid bridge deposit', () => {
  it('sends USDC to the bridge on Arbitrum in one transfer, as a deposit already credited did', () => {
    expect(bridge.chainId).toBe(42161)
    expect(bridge.calls(owner, 10_000_000n, noFee, 0n)).toEqual([
      {
        kind: 'deposit',
        to: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        // Input of 0xb3c8792e…c38d, which Hyperliquid credited as 10 USDC.
        data: '0xa9059cbb0000000000000000000000002df1c51e09aecf9cacb7bc98cb1742757f163df70000000000000000000000000000000000000000000000000000000000989680',
        value: 0n,
        gasFallback: expect.any(BigInt) as bigint,
      },
    ])
  })

  it('uses the testnet bridge and its USDC on Arbitrum Sepolia', () => {
    const [testnet] = DEPOSITS.hyperliquid!.routes('testnet', config)
    const [call] = testnet!.calls(owner, 5_000_000n, noFee, 0n)
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
      claimed: new Set(),
    }
    const waiting = ledgerFetch([
      { time: 1, hash: '0x01', delta: { type: 'deposit', usdc: '10.0' } },
      { time: 2, hash: '0x02', delta: { type: 'withdraw', usdc: '3.0', nonce: 1, fee: '1.0' } },
    ])
    expect(await bridge.progress(io(waiting.fetch), sent)).toMatchObject({ stage: 'relaying' })
    expect(waiting.asked[0]).toEqual({
      type: 'userNonFundingLedgerUpdates',
      user: owner,
      startTime: sent.sentAt - 600_000,
    })
    const credited = ledgerFetch([{ time: 1_793_325_632_379, hash, delta: { type: 'deposit', usdc: '10.0' } }])
    expect(await bridge.progress(io(credited.fetch), sent)).toEqual({
      stage: 'credited',
      amount: 10_000_000n,
      at: 1_793_325_632_379,
      receipt: hash,
    })
  })
})

describe('Hyperliquid CCTP deposit', () => {
  const base = routeFrom(8453)
  const fee = feeOnly({ expected: 280_927n, max: 280_927n })

  it('leaves from Base, Optimism and Ethereum on mainnet only', () => {
    expect(DEPOSITS.hyperliquid!.routes('mainnet', config).map((route) => route.chainId)).toEqual([42161, 8453, 10, 1])
    expect(DEPOSITS.hyperliquid!.routes('testnet', config).map((route) => route.chainId)).toEqual([421614])
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
    expect(base.calls(owner, 100_000_000n, fee, 0n).map((call) => [call.kind, call.to])).toEqual([
      ['approve', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
      ['deposit', '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'],
    ])
    expect(base.calls(owner, 100_000_000n, fee, 100_000_000n).map((call) => call.kind)).toEqual(['deposit'])
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
    expect(await base.terms({ fetch, chain: noChain }, owner, 100_000_000n)).toEqual(fee)
    expect(asked).toEqual(['https://iris-api.circle.com/v2/burn/USDC/fees/6/19?forward=true&hyperCoreDeposit=true'])
  })

  it('quotes the Fast Transfer tier wherever Circle lists it', async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify([
          { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 236453, med: 250890, high: 265327 } },
          { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 236453, med: 250890, high: 265327 } },
        ]),
      )) as typeof globalThis.fetch
    expect(await base.terms({ fetch, chain: noChain }, owner, 100_000_000n)).toEqual(fee)
  })

  it('calls Circle unreachable when it fails, errs, sends what it cannot read or no Fast Transfer fee', async () => {
    const failure = (fetch: typeof globalThis.fetch) =>
      base.terms({ fetch, chain: noChain }, owner, 100_000_000n).then(
        () => null,
        (thrown: unknown): TradeError | null => (thrown instanceof TradeFailure ? thrown.error : null),
      )
    const replying = (body: unknown, status = 200) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch
    const offline = (async () => {
      throw new Error('offline')
    }) as unknown as typeof globalThis.fetch
    const noFast = { kind: 'unreachable', detail: 'Circle sent no Fast Transfer fee' }
    expect(await failure(offline)).toEqual({ kind: 'unreachable', detail: 'offline' })
    expect(await failure(replying({ error: 'busy' }, 500))).toEqual({ kind: 'unreachable', detail: 'Circle 500' })
    const cutOff = (async () => new Response('[{"finalityThreshold":1000,')) as unknown as typeof globalThis.fetch
    expect(await failure(cutOff)).toEqual({ kind: 'unreachable', detail: 'Circle sent an unreadable reply' })
    expect(await failure(replying([{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { high: 265327 } }]))).toEqual(
      noFast,
    )
    expect(await failure(replying({ code: 0 }))).toEqual(noFast)
  })

  it('takes the first matching CCTP credit after the send that no other deposit claimed', async () => {
    const wallet: Address = '0xefc1aaf1ced837a170c2cad8d0551a49b31a2458'
    const sentAt = 1_793_320_800_000
    const credit = (hash: string, time: number) => ({
      time,
      hash,
      delta: {
        type: 'send',
        user: '0x6b9e773128f453f5c2c60935ee2de2cbc5390a24',
        destination: wallet,
        destinationDex: '',
        token: 'USDC',
        amount: '99.8',
      },
    })
    const earlier = credit('0x01', sentAt - 180_000)
    const own = credit('0x02', sentAt + 20_000)
    const later = credit('0x03', sentAt + 200_000)
    const fetch = (async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('circle')
            ? {
                messages: [
                  {
                    status: 'complete',
                    forwardState: 'COMPLETE',
                    forwardTxHash: '0xe7517ef6e8d20dcc5baa413981d377935d544f1379c907e2139477fc3e85ac84',
                    decodedMessage: { decodedMessageBody: { feeExecuted: '200000' } },
                  },
                ],
              }
            : [earlier, later, own],
        ),
      )) as typeof globalThis.fetch
    const sent = (claimed: string[]): SentDeposit => ({
      ref: { venue: 'hyperliquid', network: 'mainnet', owner: wallet },
      chainId: 8453,
      amount: 100_000_000n,
      hash: '0x984cf110c222b69d4d4f6b9b281957afb58327de519ffc457365f6be24ef46d7',
      sentAt,
      claimed: new Set(claimed),
    })
    expect(await base.progress(io(fetch), sent([]))).toMatchObject({ receipt: own.hash })
    expect(await base.progress(io(fetch), sent([own.hash]))).toMatchObject({ receipt: later.hash })
  })
})

interface CctpRecording {
  readonly burn: { chainId: number; domain: number; owner: Address; amount: string; hash: Hex; sentAt: number }
  readonly iris: Record<'unindexed' | 'unattested' | 'PENDING' | 'SENT' | 'COMPLETE', IrisReply>
  readonly ledger: unknown[]
}

interface IrisReply {
  readonly status: number
  readonly body: unknown
}

describe('Circle forward to HyperCore', () => {
  const recorded = JSON.parse(
    readFileSync(new URL('./__fixtures__/cctp.hypercore.json', import.meta.url), 'utf8'),
  ) as CctpRecording
  const { burn, iris, ledger } = recorded
  const route = routeFrom(burn.chainId)
  const sent: SentDeposit = {
    ref: { venue: 'hyperliquid', network: 'mainnet', owner: burn.owner },
    chainId: burn.chainId,
    amount: BigInt(burn.amount),
    hash: burn.hash,
    sentAt: burn.sentAt,
    claimed: new Set(),
  }
  const message = `https://iris-api.circle.com/v2/messages/${burn.domain}?transactionHash=${burn.hash}`
  /** Hyperliquid's send from the CoreDepositWallet: 663.093537 USDC less the 0.348633 Circle executed. */
  const credit = {
    stage: 'credited',
    amount: 662_744_904n,
    at: 1_793_408_914_355,
    receipt: '0xfdced985e182eb01ff480447ba6bf0000009f16b7c8609d4a19784d8a086c4ec',
  }
  /** Circle sent no CONFIRMED, FAILED or new value while this was recorded, so those are its COMPLETE reply with the state swapped. */
  const reporting = (forwardState: string): IrisReply => {
    const { messages } = iris.COMPLETE.body as { messages: Record<string, unknown>[] }
    const { destinationMintTxHash: _, ...rest } = messages[0]!
    return { status: 200, body: { messages: [{ ...rest, forwardState }] } }
  }
  const answer = (reply: IrisReply, entries = ledger) => {
    const asked: string[] = []
    const fetch = (async (url: string) => {
      asked.push(url)
      return url.includes('circle')
        ? new Response(JSON.stringify(reply.body), { status: reply.status })
        : new Response(JSON.stringify(entries))
    }) as typeof globalThis.fetch
    return { fetch, asked }
  }
  const at = (ms: number) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(ms)
  }
  afterEach(() => vi.useRealTimers())

  it('keeps relaying while Circle forwards, even with the credit already in the ledger', async () => {
    at(burn.sentAt + 60_000)
    for (const reply of [iris.unindexed, iris.unattested, iris.PENDING, iris.SENT, reporting('CONFIRMED')]) {
      const { fetch, asked } = answer(reply)
      expect(await route.progress(io(fetch), sent)).toMatchObject({ stage: 'relaying' })
      expect(asked).toEqual([message])
    }
  })

  it('waits for the attestation until Circle has signed the burn, then waits for the forward', async () => {
    at(burn.sentAt + 60_000)
    expect(await route.progress(io(answer(iris.unattested).fetch), sent)).toEqual({
      stage: 'relaying',
      detail: 'Waiting for Circle to attest the burn',
    })
    expect(await route.progress(io(answer(iris.PENDING).fetch), sent)).toEqual({
      stage: 'relaying',
      detail: 'Circle is forwarding it to Hyperliquid',
    })
  })

  it('credits what Hyperliquid booked once Circle reports the forward COMPLETE, and only that amount', async () => {
    at(burn.sentAt + 60_000)
    expect(await route.progress(io(answer(iris.COMPLETE).fetch), sent)).toEqual(credit)
    const [booked] = ledger as { delta: Record<string, unknown> }[]
    const other = [{ ...booked, delta: { ...booked!.delta, amount: '662.744903' } }]
    expect(await route.progress(io(answer(iris.COMPLETE, other).fetch), sent)).toMatchObject({ stage: 'relaying' })
  })

  it('ends the watch for a check by hand when Circle reports FAILED or a state it does not document', async () => {
    at(burn.sentAt + 60_000)
    for (const state of ['FAILED', 'SOMETHING_NEW']) {
      const { fetch, asked } = answer(reporting(state))
      expect(await route.progress(io(fetch), sent)).toEqual({
        stage: 'unresolved',
        detail: `Circle reports the forward as ${state}, a state Tape does not know`,
        check: { label: 'Circle message', url: message },
      })
      expect(asked).toEqual([message])
    }
  })

  it('ends the watch 30 min after the send without COMPLETE, and still credits a COMPLETE after that', async () => {
    at(burn.sentAt + 30 * 60_000)
    expect(await route.progress(io(answer(iris.PENDING).fetch), sent)).toMatchObject({ stage: 'relaying' })
    at(burn.sentAt + 30 * 60_000 + 1)
    expect(await route.progress(io(answer(iris.PENDING).fetch), sent)).toEqual({
      stage: 'unresolved',
      detail: 'Circle has not completed the forward after 30 min',
      check: { label: 'Circle message', url: message },
    })
    expect(await route.progress(io(answer(iris.unindexed).fetch), sent)).toMatchObject({ stage: 'unresolved' })
    expect(await route.progress(io(answer(iris.COMPLETE).fetch), sent)).toEqual(credit)
  })
})
