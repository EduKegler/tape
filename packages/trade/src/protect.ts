import { parseQty } from '@tape/core/fixed'
import type { Px } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import { checkExits, newClientId } from './intent'
import type { Capabilities, ExitEdit, OpenOrder, OrderExit, OrderRef, Position, ProtectIntent } from './types'

export const EXIT_NAMES = { tp: 'take profit', sl: 'stop loss' } as const

export const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** What a protect did, such as "Take profit at 95000, stop loss removed". */
export const exitDetail = (notes: readonly string[]) => capitalized(notes.join(', ')) || 'Nothing to change'

/** What the trader asks of one kind of exit. */
export type ExitWish =
  { readonly kind: 'keep' } | { readonly kind: 'remove' } | { readonly kind: 'set'; readonly px: Px }

/**
 * The legs of one kind that stand for the position: those for the whole position where the venue
 * keeps such legs, else every reduce-only leg of that kind on the market.
 */
export function positionLegs(
  orders: readonly OpenOrder[],
  symbol: string,
  kind: OrderExit['kind'],
  caps: Pick<Capabilities, 'wholeExits'>,
): readonly OrderRef[] {
  return orders
    .filter((order) => order.symbol === symbol && order.exit?.kind === kind && order.exit.whole === caps.wholeExits)
    .map((order) => order.ref)
}

function editOf(wish: ExitWish, legs: readonly OrderRef[]): ExitEdit {
  if (wish.kind === 'set') return { kind: 'set', px: wish.px, clientId: newClientId(), legs }
  return wish.kind === 'remove' && legs.length > 0 ? { kind: 'remove', legs } : { kind: 'keep' }
}

export function protectIntent(
  spec: MarketSpec,
  position: Position,
  orders: readonly OpenOrder[],
  caps: Pick<Capabilities, 'wholeExits'>,
  wishes: { readonly takeProfit: ExitWish; readonly stopLoss: ExitWish },
): ProtectIntent {
  const legs = (kind: OrderExit['kind']) => positionLegs(orders, spec.venueSymbol, kind, caps)
  return {
    spec,
    position: position.side,
    size: parseQty(position.size, spec.scale),
    takeProfit: editOf(wishes.takeProfit, legs('tp')),
    stopLoss: editOf(wishes.stopLoss, legs('sl')),
  }
}

/** A take profit beyond the far touch and a stop loss short of the near one, as on an order that opened the position. */
export function checkProtect(
  position: Position['side'],
  book: { readonly bid: Px | null; readonly ask: Px | null },
  wishes: { readonly takeProfit: ExitWish; readonly stopLoss: ExitWish },
): { readonly takeProfit?: string; readonly stopLoss?: string } {
  const errors = checkExits(
    position === 'long' ? 'buy' : 'sell',
    { px: null, ...book },
    {
      takeProfits: wishes.takeProfit.kind === 'set' ? [wishes.takeProfit.px] : [],
      stopLoss: wishes.stopLoss.kind === 'set' ? wishes.stopLoss.px : null,
    },
  )
  return {
    ...(errors.takeProfit1 ? { takeProfit: errors.takeProfit1 } : {}),
    ...(errors.stopLoss ? { stopLoss: errors.stopLoss } : {}),
  }
}
