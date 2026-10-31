import { describe, expect, it } from 'vitest'
import { batchBody, orderBody } from './wire'

describe('orderly wire', () => {
  it('writes exact decimals as JSON numbers', () => {
    const text = orderBody({
      symbol: 'PERP_BTC_USDC',
      clientOrderId: 'tape-1',
      type: 'LIMIT',
      side: 'BUY',
      price: '80000.1',
      quantity: '0.00001',
      reduceOnly: false,
    })
    expect(text).toBe(
      '{"symbol":"PERP_BTC_USDC","client_order_id":"tape-1","order_type":"LIMIT","order_price":80000.1,"order_quantity":0.00001,"side":"BUY","reduce_only":false}',
    )
    expect(JSON.parse(text, (_k, value, ctx?: { source?: string }) => ctx?.source ?? value).order_quantity).toBe(
      '0.00001',
    )
  })

  it('wraps orders for the batch endpoint with each body as single orders write it', () => {
    const leg = {
      symbol: 'PERP_BTC_USDC',
      clientOrderId: 'a',
      type: 'POST_ONLY',
      side: 'BUY',
      price: '79000',
      quantity: '0.001',
      reduceOnly: false,
    } as const
    expect(batchBody([leg, { ...leg, clientOrderId: 'b', price: '78000' }])).toBe(
      `{"orders":[${orderBody(leg)},${orderBody({ ...leg, clientOrderId: 'b', price: '78000' })}]}`,
    )
  })

  it('refuses anything that is not a plain decimal', () => {
    expect(() =>
      orderBody({
        symbol: 'S',
        clientOrderId: 'x',
        type: 'LIMIT',
        side: 'BUY',
        price: '1e5',
        quantity: '1',
        reduceOnly: false,
      }),
    ).toThrow('not a decimal')
  })
})
