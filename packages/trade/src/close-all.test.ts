import { describe, expect, it } from 'vitest'
import type { Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { closeEach, closeIntents } from './close-all'
import { TradeFailure, toDecimal } from './types'
import type { Bps, CommandOutcome, OrderIntent, Position, TradeError } from './types'

const spec = (base: string): MarketSpec => ({
  key: marketKey('hyperliquid', base as Base),
  venue: 'hyperliquid',
  base: base as Base,
  quote: 'USDC',
  kind: 'perp',
  venueSymbol: base,
  scale: { px: 1, qty: 3 },
  tick: { kind: 'sigfig', figures: 5 },
  step: 1 as Qty,
})
const held = (symbol: string, side: Position['side'], size: string, pnl: string): Position => ({
  symbol,
  side,
  size: toDecimal(size),
  entry: toDecimal('100'),
  unrealizedPnl: toDecimal(pnl),
  liquidation: null,
  leverage: null,
})
const positions = [
  held('BTC', 'long', '0.002', '12.5'),
  held('ETH', 'short', '0.5', '-3'),
  held('SOL', 'long', '3', '0'),
  held('DOGE', 'long', '10', '1'),
]
const market = { kind: 'market', slippage: 100 as Bps } as const
const specOf = (symbol: string) => (symbol === 'DOGE' ? undefined : spec(symbol))

describe('which positions a close-all takes', () => {
  it('takes every position, those in profit, or those in loss, and leaves one at zero out of both', () => {
    const symbols = (scope: 'all' | 'profit' | 'loss') =>
      closeIntents(positions, specOf, scope, market).intents.map((intent) => intent.spec.venueSymbol)
    expect(symbols('all')).toEqual(['BTC', 'ETH', 'SOL'])
    expect(symbols('profit')).toEqual(['BTC'])
    expect(symbols('loss')).toEqual(['ETH'])
  })

  it('closes each whole position on the other side, reduce-only, and skips one with no market', () => {
    const { intents, skipped } = closeIntents(positions, specOf, 'all', { kind: 'mid' })
    expect(intents.map((intent) => [intent.side, intent.size, intent.reduceOnly, intent.order])).toEqual([
      ['sell', 2, true, { kind: 'mid' }],
      ['buy', 500, true, { kind: 'mid' }],
      ['sell', 3000, true, { kind: 'mid' }],
    ])
    expect(skipped.map((position) => position.symbol)).toEqual(['DOGE'])
    expect(new Set(intents.map((intent) => intent.clientId)).size).toBe(3)
  })
})

describe('sending a close-all', () => {
  const { intents } = closeIntents(positions, specOf, 'all', market)
  const filled: CommandOutcome = { kind: 'placed', status: 'filled', detail: 'Filled' }
  const refused: TradeError = { kind: 'rejected', detail: 'Reduce only order would increase position' }
  const answering = (answers: Record<string, CommandOutcome | TradeError>) => async (intent: OrderIntent) => {
    const answer = answers[intent.spec.venueSymbol]!
    if (answer.kind === 'placed' || answer.kind === 'done') return answer
    if (answer.kind === 'closed' || answer.kind === 'canceled') throw new Error('not an order outcome')
    throw new TradeFailure('hyperliquid', answer)
  }

  it('reports each close on its own, with the client id that finds it', async () => {
    const unknown: TradeError = { kind: 'unknown-outcome', detail: '502' }
    const outcome = await closeEach(intents, answering({ BTC: filled, ETH: refused, SOL: unknown }))
    expect(outcome).toEqual({
      kind: 'closed',
      detail: '1 of 3 close orders placed',
      rows: [
        { symbol: 'BTC', sent: { venueSymbol: 'BTC', clientIds: [intents[0]!.clientId] }, outcome: filled },
        { symbol: 'ETH', sent: { venueSymbol: 'ETH', clientIds: [intents[1]!.clientId] }, error: refused },
        { symbol: 'SOL', sent: { venueSymbol: 'SOL', clientIds: [intents[2]!.clientId] }, error: unknown },
      ],
    })
  })

  it('fails as a whole only when every close failed and none may have reached the venue', async () => {
    const needsSetup: TradeError = { kind: 'needs-setup', detail: 'Enable trading on this device first' }
    await expect(
      closeEach(intents, answering({ BTC: needsSetup, ETH: needsSetup, SOL: needsSetup })),
    ).rejects.toMatchObject({ error: needsSetup })
    const unknown: TradeError = { kind: 'unknown-outcome', detail: '502' }
    expect(await closeEach(intents, answering({ BTC: refused, ETH: refused, SOL: unknown }))).toMatchObject({
      kind: 'closed',
      detail: '0 of 3 close orders placed',
    })
    expect(await closeEach([], answering({}))).toEqual({ kind: 'done', detail: 'Nothing to close' })
  })

  it('lets a bug in one close escape instead of reporting it as a refusal', async () => {
    await expect(
      closeEach(intents, answering({ BTC: filled, ETH: filled, SOL: { kind: 'closed', rows: [], detail: '' } })),
    ).rejects.toThrow('not an order outcome')
  })
})
