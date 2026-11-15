import { describe, expect, it } from 'vitest'
import { SITEMAP_PATHS, robots, sitemap } from './seo'

describe('sitemap', () => {
  it('lists each path as an absolute URL on the origin it was asked from', () => {
    expect(sitemap('https://tape.example', ['/hyperliquid/BTC', '/dydx/ETH'])).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        '  <url><loc>https://tape.example/hyperliquid/BTC</loc></url>',
        '  <url><loc>https://tape.example/dydx/ETH</loc></url>',
        '</urlset>',
        '',
      ].join('\n'),
    )
  })

  it('points at BTC, ETH and SOL on each of the four venues', () => {
    expect(SITEMAP_PATHS).toEqual([
      '/binance/BTC',
      '/binance/ETH',
      '/binance/SOL',
      '/hyperliquid/BTC',
      '/hyperliquid/ETH',
      '/hyperliquid/SOL',
      '/dydx/BTC',
      '/dydx/ETH',
      '/dydx/SOL',
      '/orderly/BTC',
      '/orderly/ETH',
      '/orderly/SOL',
    ])
  })
})

describe('robots', () => {
  it('allows every crawler and names the sitemap on mainnet', () => {
    expect(robots('https://tape.example', 'mainnet')).toBe(
      'User-agent: *\nAllow: /\n\nSitemap: https://tape.example/sitemap.xml\n',
    )
  })

  it('names no sitemap on testnet', () => {
    expect(robots('https://testnet.tape.example', 'testnet')).toBe('User-agent: *\nAllow: /\n')
  })
})
