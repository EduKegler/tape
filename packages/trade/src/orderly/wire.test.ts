import { describe, expect, it } from 'vitest'
import { orderBody } from './wire'

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
    expect(JSON.parse(text, (_k, v, ctx?: { source?: string }) => ctx?.source ?? v).order_quantity).toBe('0.00001')
  })

  it('leaves the price out of a market order', () => {
    expect(
      orderBody({
        symbol: 'PERP_ETH_USDC',
        clientOrderId: 'x',
        type: 'MARKET',
        side: 'SELL',
        price: null,
        quantity: '1',
        reduceOnly: true,
      }),
    ).not.toContain('order_price')
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
