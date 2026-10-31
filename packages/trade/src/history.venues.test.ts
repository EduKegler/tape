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
  JSON.stringify(value, (_k, node: unknown) =>
    node && typeof node === 'object' && !Array.isArray(node)
      ? Object.fromEntries(Object.entries(node).sort(([left], [right]) => left.localeCompare(right)))
      : node,
  )

function replay(venue: TradeVenueId) {
  const recording = JSON.parse(
    readFileSync(new URL(`./__fixtures__/history.${venue}.json`, import.meta.url), 'utf8'),
  ) as Recording
  const answers = new Map(
    recording.exchanges.map((exchange) => [`${exchange.url} ${canonical(exchange.body)}`, exchange.response]),
  )
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(init.body as string) as unknown) : null
    const key = `${url} ${canonical(body)}`
    if (!answers.has(key)) throw new Error(`not recorded: ${key}`)
    return new Response(JSON.stringify(answers.get(key)))
  }) as typeof globalThis.fetch
  return { recording, read: () => TRADING[venue].history({ network: 'mainnet', address: recording.address, fetch }) }
}

const timed = (history: { fills: readonly { time: number }[]; funding: readonly { time: number }[] }) =>
  [...history.fills, ...history.funding].every((entry) => Number.isSafeInteger(entry.time) && entry.time > 0)

const fundingSignsHold = (history: { funding: readonly FundingPayment[] }) =>
  history.funding.every((payment) => {
    const pull = Number(payment.position) * Number(payment.rate)
    return pull === 0 || Number(payment.amount) === 0 || pull > 0 === Number(payment.amount) < 0
  })

const unreported = (fills: readonly HistoryFill[]) => fills.map((fill) => ({ ...fill, venuePnl: null }))

function worstMismatch(fills: readonly HistoryFill[]) {
  const computed = new Map(realize(unreported(fills)).map((fill) => [fill.id, fill.pnl]))
  let worst = amount('0')
  for (const fill of fills) {
    const gap = abs(subtract(amount(computed.get(fill.id) ?? '0'), amount(fill.venuePnl ?? '0')))
    if (gap > worst) worst = gap
  }
  return format(worst, 6)
}

const netOf = (history: Awaited<ReturnType<ReturnType<typeof replay>['read']>>) =>
  summarize(realize(history.fills), history.funding, () => 'all').map((totals) => [totals.asset, totals.net])

describe('hyperliquid history', () => {
  const { recording, read } = replay('hyperliquid')

  it('reads every perp fill and payment, with no gap in a history that starts flat', async () => {
    const history = await read()
    expect(history.fills.length).toBeGreaterThan(500)
    expect(history.funding.length).toBeGreaterThan(100)
    expect(history.fills.some((fill) => fill.liquidation)).toBe(true)
    expect(history.fills.every((fill) => fill.liquidation)).toBe(false)
    expect(fundingSignsHold(history)).toBe(true)
    expect(history.gaps).toEqual([])
    expect(timed(history)).toBe(true)
  })

  it('reproduces closedPnl on every fill by average cost', async () => {
    const history = await read()
    expect(Number(worstMismatch(history.fills))).toBeLessThan(0.001)
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
    const history = await read()
    expect(timed(history)).toBe(true)
    expect(fundingSignsHold(history)).toBe(true)
    const realized = realize(history.fills)
    expect(realized.length).toBeGreaterThan(20)
    expect(realized.every((fill) => fill.pnlSource === 'computed')).toBe(true)
  })

  it('nets to the total PnL the indexer reports for the closed account, to the micro dollar', async () => {
    expect(netOf(await read())).toEqual([['USDC', recording.reference.totalPnl]])
  })

  it('tags every fill and payment with the venue, and keeps the recorded sells sells', async () => {
    const history = await read()
    const recorded = recording.exchanges.flatMap(
      (exchange) => (exchange.response as { fills?: { id: string; side: string; marketType: string }[] }).fills ?? [],
    )
    const sells = recorded
      .filter((fill) => fill.side === 'SELL' && fill.marketType === 'PERPETUAL')
      .map((fill) => fill.id)
    expect(sells.length).toBeGreaterThan(0)
    expect(history.fills.filter((fill) => fill.side === 'sell').map((fill) => fill.id)).toEqual(sells)
    expect([...history.fills, ...history.funding].every((entry) => entry.venue === 'dydx')).toBe(true)
  })
})

describe('orderly history', () => {
  const { read } = replay('orderly')

  it('takes the realized PnL Orderly reports on every fill', async () => {
    const history = await read()
    expect(history.fills.length).toBeGreaterThan(300)
    expect(realize(history.fills).every((fill) => fill.pnlSource === 'venue')).toBe(true)
    expect(timed(history)).toBe(true)
    expect(history.funding.length).toBeGreaterThan(0)
    expect(fundingSignsHold(history)).toBe(true)
  })

  it('reproduces that PnL by average cost, within the micro dollar Tape rounds to', async () => {
    expect(Number(worstMismatch((await read()).fills))).toBeLessThanOrEqual(0.000001)
  })
})
