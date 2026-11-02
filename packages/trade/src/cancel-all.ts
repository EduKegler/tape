import type { CommandOutcome, OpenOrder } from './types'

export const onMarket = (orders: readonly OpenOrder[], symbol: string | null) =>
  symbol === null ? orders : orders.filter((order) => order.symbol === symbol)

/** Lists what was canceled, so the trader sees which take profits and stop losses went with it. */
export const canceled = (orders: readonly OpenOrder[]): CommandOutcome =>
  orders.length === 0
    ? { kind: 'done', detail: 'Nothing to cancel' }
    : { kind: 'canceled', orders, detail: `Canceled ${orders.length}` }
