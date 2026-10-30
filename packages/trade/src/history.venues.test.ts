import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { realize, summarize } from './history'
import type { FundingPayment, HistoryFill } from './history'
import { abs, amount, format, subtract } from './money'
import type { TradeVenueId } from './types'
import { TRADING } from './index'

interface Recording {
  address: string
  reference: Record<string, string>
  exchanges: { url: string; body: unknown; response: unknown }[]
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  )

function replay(venue: TradeVenueId) {
  const recording = JSON.parse(
    readFileSync(new URL(`./__fixtures__/history.${venue}.json`, import.meta.url), 'utf8'),
  ) as Recording
  const answers = new Map(recording.exchanges.map((e) => [`${e.url} ${canonical(e.body)}`, e.response]))
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(init.body as string) as unknown) : null
    const key = `${url} ${canonical(body)}`
    if (!answers.has(key)) throw new Error(`not recorded: ${key}`)
    return new Response(JSON.stringify(answers.get(key)))
  }) as typeof globalThis.fetch
  return { recording, read: () => TRADING[venue].history({ network: 'mainnet', address: recording.address, fetch }) }
}

const timed = (h: { fills: readonly { time: number }[]; funding: readonly { time: number }[] }) =>
  [...h.fills, ...h.funding].every((e) => Number.isSafeInteger(e.time) && e.time > 0)

const fundingSignsHold = (h: { funding: readonly FundingPayment[] }) =>
  h.funding.every((p) => {
    const pull = Number(p.position) * Number(p.rate)
    return pull === 0 || Number(p.amount) === 0 || pull > 0 === Number(p.amount) < 0
  })

const unreported = (fills: readonly HistoryFill[]) => fills.map((f) => ({ ...f, venuePnl: null }))

function worstMismatch(fills: readonly HistoryFill[]) {
  const computed = new Map(realize(unreported(fills)).map((f) => [f.id, f.pnl]))
  let worst = amount('0')
  for (const f of fills) {
    const gap = abs(subtract(amount(computed.get(f.id) ?? '0'), amount(f.venuePnl ?? '0')))
    if (gap > worst) worst = gap
  }
  return format(worst, 6)
}

const netOf = (h: Awaited<ReturnType<ReturnType<typeof replay>['read']>>) =>
  summarize(realize(h.fills), h.funding, () => 'all').map((t) => [t.asset, t.net])

describe('hyperliquid history', () => {
  const { recording, read } = replay('hyperliquid')

  it('reads every perp fill and payment, with no gap in a history that starts flat', async () => {
    const h = await read()
    expect(h.fills.length).toBeGreaterThan(500)
    expect(h.funding.length).toBeGreaterThan(100)
    expect(h.fills.some((f) => f.liquidation)).toBe(true)
    expect(h.fills.every((f) => f.liquidation)).toBe(false)
    expect(fundingSignsHold(h)).toBe(true)
    expect(h.gaps).toEqual([])
    expect(timed(h)).toBe(true)
  })

  it('reproduces closedPnl on every fill by average cost', async () => {
    const h = await read()
    expect(Number(worstMismatch(h.fills))).toBeLessThan(0.001)
  })

  it('nets to the perp PnL Hyperliquid charts for the account, which it rounds to cents', async () => {
    const [[asset, net]] = netOf(await read()) as [[string, string]]
    expect(asset).toBe('USDC')
    expect(Math.abs(Number(net) - Number(recording.reference.perpAllTimePnl))).toBeLessThan(0.05)
  })
})

describe('dydx history', () => {
  const { recording, read } = replay('dydx')

  it('computes every fill, since the indexer reports no PnL per fill', async () => {
    const h = await read()
    expect(timed(h)).toBe(true)
    expect(fundingSignsHold(h)).toBe(true)
    const realized = realize(h.fills)
    expect(realized.length).toBeGreaterThan(20)
    expect(realized.every((f) => f.pnlSource === 'computed')).toBe(true)
  })

  it('nets to the total PnL the indexer reports for the closed account, to the micro dollar', async () => {
    expect(netOf(await read())).toEqual([['USDC', recording.reference.totalPnl]])
  })
})

describe('orderly history', () => {
  const { read } = replay('orderly')

  it('takes the realized PnL Orderly reports on every fill', async () => {
    const h = await read()
    expect(h.fills.length).toBeGreaterThan(300)
    expect(realize(h.fills).every((f) => f.pnlSource === 'venue')).toBe(true)
    expect(timed(h)).toBe(true)
    expect(h.funding.length).toBeGreaterThan(0)
    expect(fundingSignsHold(h)).toBe(true)
  })

  it('reproduces that PnL by average cost, within the micro dollar Tape rounds to', async () => {
    expect(Number(worstMismatch((await read()).fills))).toBeLessThanOrEqual(0.000001)
  })
})
