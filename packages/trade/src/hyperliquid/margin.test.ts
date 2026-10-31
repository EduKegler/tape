import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { VenueContext } from '../types'
import { hyperliquid } from '.'

const owner: Address = '0x9f3c2b1a0e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b'
// The meta and margin table shapes of the info endpoint docs.
const meta = {
  universe: [
    { name: 'BTC', szDecimals: 5, maxLeverage: 40, marginTableId: 56 },
    { name: 'ETH', szDecimals: 4, maxLeverage: 25, marginTableId: 25 },
    { name: 'XYZ', szDecimals: 0, maxLeverage: 3, marginTableId: 3, onlyIsolated: true },
  ],
  marginTables: [
    [
      56,
      {
        description: 'tiered 40x',
        marginTiers: [
          { lowerBound: '0.0', maxLeverage: 40 },
          { lowerBound: '150000000.0', maxLeverage: 20 },
        ],
      },
    ],
  ],
}

const position = (coin: string, szi: string, positionValue: string, type: string) => ({
  position: { coin, szi, positionValue, leverage: { type, value: 10 } },
})

function margin(symbol: string, answers: { mode?: string; positions?: unknown[]; active?: string }) {
  const asked: Record<string, unknown>[] = []
  const reply: Record<string, unknown> = {
    meta,
    userAbstraction: answers.mode ?? 'default',
    clearinghouseState: {
      crossMarginSummary: { accountValue: '1000.0' },
      crossMaintenanceMarginUsed: '250.0',
      assetPositions: answers.positions ?? [],
    },
    activeAssetData: { user: owner, coin: symbol, leverage: { type: answers.active ?? 'cross', value: 10 } },
  }
  const fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { type: string }
    asked.push(body)
    return new Response(JSON.stringify(reply[body.type] ?? null))
  }) as typeof globalThis.fetch
  const ctx: VenueContext = {
    ref: { venue: 'hyperliquid', network: 'mainnet', owner },
    config: {
      mainnet: true,
      hyperliquid: { builder: null },
      dydx: { builder: null },
      orderly: { brokerId: { mainnet: 'tape', testnet: 'demo' } },
    },
    keys: { read: () => null, write: () => {}, clear: () => {} },
    fetch,
  }
  return { state: hyperliquid.margin(ctx, symbol), asked }
}

describe('hyperliquid cross margin', () => {
  it('declines unified accounts and isolated margin', async () => {
    const unified = { kind: 'unsupported', reason: 'Not estimated for unified accounts' }
    const isolated = { kind: 'unsupported', reason: 'Not estimated for isolated margin' }
    expect(await margin('BTC', { mode: 'unifiedAccount' }).state).toEqual(unified)
    expect(await margin('BTC', { mode: 'portfolioMargin' }).state).toEqual(unified)
    expect(await margin('XYZ', {}).state).toEqual(isolated)
    expect(await margin('BTC', { active: 'isolated' }).state).toEqual(isolated)
    expect(await margin('BTC', { positions: [position('BTC', '0.1', '8000.0', 'isolated')] }).state).toEqual(isolated)
    expect(
      await margin('BTC', { active: 'isolated', positions: [position('BTC', '0.1', '8000.0', 'cross')] }).state,
    ).toMatchObject({ kind: 'cross' })
  })

  // Margin tiers docs: maintenance is half the initial margin at the tier's max leverage, so 8000 at 40x needs 100.
  it("takes this market's own maintenance out of the cross maintenance in use, by the venue's margin table", async () => {
    const { state, asked } = margin('BTC', {
      positions: [position('ETH', '0.5', '1500.0', 'cross'), position('BTC', '-0.1', '8000.0', 'cross')],
    })
    expect(await state).toEqual({
      kind: 'cross',
      accountValue: 1000,
      othersMaintenance: 150,
      tiers: [
        { lowerBound: 0, maxLeverage: 40 },
        { lowerBound: 150_000_000, maxLeverage: 20 },
      ],
      position: { size: -0.1, mark: 80_000 },
    })
    expect(asked.filter((body) => body.type !== 'meta')).toEqual([
      { type: 'userAbstraction', user: owner },
      { type: 'clearinghouseState', user: owner },
      { type: 'activeAssetData', user: owner, coin: 'BTC' },
    ])
  })

  it('gives a market whose margin table the list lacks one tier at its max leverage, and no position when none is held', async () => {
    expect(await margin('ETH', {}).state).toEqual({
      kind: 'cross',
      accountValue: 1000,
      othersMaintenance: 250,
      tiers: [{ lowerBound: 0, maxLeverage: 25 }],
      position: null,
    })
  })
})
