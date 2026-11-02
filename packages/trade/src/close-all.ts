import type { MarketSpec } from '@tape/core/market'
import { closeIntent } from './intent'
import type { CloseExit } from './intent'
import { TradeFailure, sentOrders } from './types'
import type { CloseRow, CommandOutcome, OrderIntent, Position } from './types'

export type CloseScope = 'all' | 'profit' | 'loss'

const IN_SCOPE: Record<CloseScope, (pnl: number) => boolean> = {
  all: () => true,
  profit: (pnl) => pnl > 0,
  loss: (pnl) => pnl < 0,
}

/**
 * One reduce-only order for each position in scope, for its whole size. `skipped` holds the
 * positions Tape has no market for, or whose size is off the market's step.
 */
export function closeIntents(
  positions: readonly Position[],
  specOf: (symbol: string) => MarketSpec | undefined,
  scope: CloseScope,
  exit: CloseExit,
): { readonly intents: readonly OrderIntent[]; readonly skipped: readonly Position[] } {
  const intents: OrderIntent[] = []
  const skipped: Position[] = []
  for (const position of positions.filter((held) => IN_SCOPE[scope](Number(held.unrealizedPnl)))) {
    const spec = specOf(position.symbol)
    const intent = spec ? closeIntent(spec, position, exit) : null
    if (intent) intents.push(intent)
    else skipped.push(position)
  }
  return { intents, skipped }
}

/**
 * Sends every close at once and reports each on its own, since one can be refused while the others
 * fill. Throws only when every close failed and none of them may have reached the venue.
 */
export async function closeEach(
  intents: readonly OrderIntent[],
  place: (intent: OrderIntent) => Promise<CommandOutcome>,
): Promise<CommandOutcome> {
  if (intents.length === 0) return { kind: 'done', detail: 'Nothing to close' }
  const failures: TradeFailure[] = []
  const rows = await Promise.all(
    intents.map(async (intent): Promise<CloseRow> => {
      const row = { symbol: intent.spec.venueSymbol, sent: sentOrders({ kind: 'place', intent })! }
      try {
        return { ...row, outcome: await place(intent) }
      } catch (error) {
        if (!(error instanceof TradeFailure)) throw error
        failures.push(error)
        return { ...row, error: error.error }
      }
    }),
  )
  const [failure] = failures
  if (failure && failures.length === rows.length && failures.every((each) => each.error.kind !== 'unknown-outcome'))
    throw failure
  return { kind: 'closed', rows, detail: `${rows.length - failures.length} of ${rows.length} close orders placed` }
}
