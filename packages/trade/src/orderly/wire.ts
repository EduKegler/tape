/**
 * Orderly takes prices and sizes as JSON numbers, and the ed25519 signature covers the body
 * text. So the body is written by hand with the exact decimal as the number literal, never
 * through a float.
 */

export type OrderType = 'LIMIT' | 'MARKET' | 'IOC' | 'FOK' | 'POST_ONLY'

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
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${JSON.stringify(k)}:${typeof v === 'object' ? v.raw : JSON.stringify(v)}`)
  return `{${parts.join(',')}}`
}

export interface OrderFields {
  readonly symbol: string
  readonly clientOrderId: string
  readonly type: OrderType
  readonly side: 'BUY' | 'SELL'
  readonly price: string | null
  readonly quantity: string
  readonly reduceOnly: boolean
}

export function orderBody(o: OrderFields): string {
  return body({
    symbol: o.symbol,
    client_order_id: o.clientOrderId,
    order_type: o.type,
    order_price: o.price === null ? undefined : raw(o.price),
    order_quantity: raw(o.quantity),
    side: o.side,
    reduce_only: o.reduceOnly,
  })
}

export function batchBody(orders: readonly OrderFields[]): string {
  return `{"orders":[${orders.map(orderBody).join(',')}]}`
}

export const cancelPath = (symbol: string, orderId: number) => `/v1/order?order_id=${orderId}&symbol=${symbol}`
