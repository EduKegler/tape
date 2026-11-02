/**
 * Orderly takes prices and sizes as JSON numbers, and the ed25519 signature covers the body
 * text. So the body is written by hand with the exact decimal as the number literal, never
 * through a float.
 */

export type OrderType = 'LIMIT' | 'IOC' | 'POST_ONLY'

export interface Raw {
  readonly raw: string
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/
export function raw(decimal: string): Raw {
  if (!DECIMAL.test(decimal)) throw new Error(`not a decimal: ${decimal}`)
  return { raw: decimal }
}

export function body(fields: Readonly<Record<string, string | number | boolean | Raw | undefined>>): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${JSON.stringify(key)}:${typeof value === 'object' ? value.raw : JSON.stringify(value)}`)
  return `{${parts.join(',')}}`
}

export interface OrderFields {
  readonly symbol: string
  readonly clientOrderId: string
  readonly type: OrderType
  readonly side: 'BUY' | 'SELL'
  readonly price: string
  readonly quantity: string
  readonly reduceOnly: boolean
}

export function orderBody(order: OrderFields): string {
  return body({
    symbol: order.symbol,
    client_order_id: order.clientOrderId,
    order_type: order.type,
    order_price: raw(order.price),
    order_quantity: raw(order.quantity),
    side: order.side,
    reduce_only: order.reduceOnly,
  })
}

/** PUT /v1/order: the order to edit by its id, with every field of the order it becomes. */
export function editBody(orderId: string, order: OrderFields): string {
  return body({
    order_id: raw(orderId),
    symbol: order.symbol,
    client_order_id: order.clientOrderId,
    order_type: order.type,
    order_price: raw(order.price),
    order_quantity: raw(order.quantity),
    side: order.side,
    reduce_only: order.reduceOnly,
  })
}

export function batchBody(orders: readonly OrderFields[]): string {
  return `{"orders":[${orders.map(orderBody).join(',')}]}`
}

export const cancelPath = (symbol: string, orderId: number) => `/v1/order?order_id=${orderId}&symbol=${symbol}`

/** POST /v1/algo/order for a TP/SL that closes the whole position at market, so it carries no quantity. */
export function positionalBody(
  symbol: string,
  clientOrderId: string | undefined,
  legs: readonly {
    readonly type: 'TAKE_PROFIT' | 'STOP_LOSS'
    readonly side: 'BUY' | 'SELL'
    readonly triggerPrice: string
  }[],
): string {
  const children = legs.map((leg) =>
    body({
      symbol,
      algo_type: leg.type,
      side: leg.side,
      type: 'CLOSE_POSITION',
      trigger_price: raw(leg.triggerPrice),
      trigger_price_type: 'MARK_PRICE',
      reduce_only: true,
    }),
  )
  return `{${body({ symbol, client_order_id: clientOrderId, algo_type: 'POSITIONAL_TP_SL', trigger_price_type: 'MARK_PRICE' }).slice(1, -1)},"child_orders":[${children.join(',')}]}`
}

/** PUT /v1/algo/order: changes to the legs of one root, by their ids. */
export function algoEditBody(rootId: string, changes: readonly Readonly<Record<string, Raw | boolean>>[]): string {
  return `{"order_id":${raw(rootId).raw},"child_orders":[${changes.map((change) => body(change)).join(',')}]}`
}
