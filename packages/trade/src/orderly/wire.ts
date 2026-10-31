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

export function batchBody(orders: readonly OrderFields[]): string {
  return `{"orders":[${orders.map(orderBody).join(',')}]}`
}

export const cancelPath = (symbol: string, orderId: number) => `/v1/order?order_id=${orderId}&symbol=${symbol}`
