import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import type { DepositRoute, ProgressIo, SentDeposit } from '../deposit'
import type { TradeConfig } from '../types'
import { hyperliquidDeposit } from './deposit'

const config: TradeConfig = {
  mainnet: true,
  hyperliquid: { builder: null },
  dydx: { builder: null },
  orderly: { brokerId: { mainnet: 'tape', testnet: 'demo' } },
}
const io = (fetch: typeof globalThis.fetch): ProgressIo => ({
  fetch,
  keys: { read: () => null, write: () => {}, clear: () => {} },
})
const routeFrom = (chainId: number): DepositRoute => {
  const found = hyperliquidDeposit.routes('mainnet', config).find((route) => route.chainId === chainId)
  if (!found) throw new Error(`no route from ${chainId}`)
  return found
}

interface Recording {
  readonly burn: { chainId: number; owner: Address; amount: string; hash: Hex; sentAt: number }
  readonly iris: { COMPLETE: { body: { messages: Record<string, unknown>[] } } }
  readonly ledger: { time: number; hash: string; delta: Record<string, unknown> }[]
}

const { burn, iris, ledger } = JSON.parse(
  readFileSync(new URL('../__fixtures__/cctp.hypercore.json', import.meta.url), 'utf8'),
) as Recording
const [booked] = ledger as [Recording['ledger'][number]]
const complete = iris.COMPLETE.body
const sent = (claimed: string[] = []): SentDeposit => ({
  ref: { venue: 'hyperliquid', network: 'mainnet', owner: burn.owner },
  chainId: burn.chainId,
  amount: BigInt(burn.amount),
  hash: burn.hash,
  sentAt: burn.sentAt,
  claimed: new Set(claimed),
})

function answer(circle: unknown, entries: unknown[]) {
  const asked: string[] = []
  const fetch = (async (url: string) => {
    asked.push(url)
    return new Response(JSON.stringify(url.includes('circle') ? circle : entries))
  }) as typeof globalThis.fetch
  return { fetch, asked }
}

describe('Hyperliquid bridge terms', () => {
  // The Arbitrum bridge docs charge no deposit fee.
  it('quotes no fee on the Hyperliquid bridge', async () => {
    const [bridge] = hyperliquidDeposit.routes('mainnet', config)
    const unused = {
      fetch: () => Promise.reject(new Error('the bridge asks nothing')),
      chain: { readContract: () => Promise.reject(new Error('the bridge reads no chain')) },
    } as unknown as Parameters<DepositRoute['terms']>[0]
    expect(await bridge!.terms(unused, burn.owner, 10_000_000n)).toEqual({
      fee: { expected: 0n, max: 0n },
      message: null,
      refusal: null,
    })
  })

  // The info endpoint docs serve testnet at api.hyperliquid-testnet.xyz.
  it('reads the testnet bridge deposit from the testnet ledger', async () => {
    const [bridge] = hyperliquidDeposit.routes('testnet', config)
    const { fetch, asked } = answer(null, [])
    const deposit = { ...sent(), ref: { ...sent().ref, network: 'testnet' as const } }
    expect(await bridge!.progress(io(fetch), deposit)).toMatchObject({ stage: 'relaying' })
    expect(asked).toEqual(['https://api.hyperliquid-testnet.xyz/info'])
  })
})

describe('Hyperliquid CCTP credit', () => {
  const route = routeFrom(burn.chainId)
  const credited = { stage: 'credited', amount: 662_744_904n, at: booked.time, receipt: booked.hash }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(burn.sentAt + 60_000)
  })
  afterEach(() => vi.useRealTimers())

  it('ignores a ledger send that is not Circle crediting this wallet perps in USDC', async () => {
    expect(await route.progress(io(answer(complete, ledger).fetch), sent())).toEqual(credited)
    for (const change of [
      { type: 'accountClassTransfer' },
      { user: '0x0000000000000000000000000000000000000001' },
      { destination: '0xefc1aaf1ced837a170c2cad8d0551a49b31a2458' },
      { destinationDex: 'xyz' },
      { token: 'USDH' },
    ]) {
      const other = [{ ...booked, delta: { ...booked.delta, ...change } }]
      expect(await route.progress(io(answer(complete, other).fetch), sent())).toMatchObject({ stage: 'relaying' })
    }
  })

  it('credits the first matching send at the mainnet host when Circle has not decoded its fee', async () => {
    const [message] = complete.messages
    const undecoded = { messages: [{ ...message, decodedMessage: null }] }
    const other = [{ ...booked, delta: { ...booked.delta, amount: '662.744903' } }]
    const { fetch, asked } = answer(undecoded, other)
    expect(await route.progress(io(fetch), sent())).toEqual({ ...credited, amount: 662_744_903n })
    expect(asked.filter((url) => !url.includes('circle'))).toEqual(['https://api.hyperliquid.xyz/info'])
  })

  // The wallet clock can run ahead of Hyperliquid's, so a credit before the send can still be this one.
  it('takes the latest unclaimed credit before the send when none came after it', async () => {
    const before = (hash: string, ago: number) => ({ ...booked, hash, time: burn.sentAt - ago })
    const entries = [before('0x01', 300_000), before('0x02', 200_000), before('0x03', 100_000)]
    const { fetch } = answer(complete, entries)
    expect(await route.progress(io(fetch), sent())).toMatchObject({ stage: 'credited', receipt: '0x03' })
    expect(await route.progress(io(fetch), sent(['0x03']))).toMatchObject({ stage: 'credited', receipt: '0x02' })
  })
})
