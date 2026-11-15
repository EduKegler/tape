import { describe, expect, it } from 'vitest'
import { toBase } from '@tape/core/ids'
import { SITEMAP_PATHS, marketHead, robots, sitemap } from './seo'

const btc = { venue: 'hyperliquid', venueLabel: 'Hyperliquid', base: toBase('BTC') } as const

describe('marketHead', () => {
  it('names the market and the venue, and points the canonical and og:url at the path without search params', () => {
    expect(marketHead({ ...btc, network: 'mainnet', site: 'https://tape.example' })).toEqual({
      meta: [
        { title: 'BTC on Hyperliquid · Live order book · Tape' },
        {
          name: 'description',
          content:
            'Live BTC order book, trades, depth and candles on Hyperliquid, beside the best bid and ask on the other venues.',
        },
        { property: 'og:type', content: 'website' },
        { property: 'og:site_name', content: 'Tape' },
        { property: 'og:title', content: 'BTC on Hyperliquid · Live order book · Tape' },
        {
          property: 'og:description',
          content:
            'Live BTC order book, trades, depth and candles on Hyperliquid, beside the best bid and ask on the other venues.',
        },
        { property: 'og:url', content: 'https://tape.example/hyperliquid/BTC' },
        { name: 'twitter:card', content: 'summary' },
      ],
      links: [{ rel: 'canonical', href: 'https://tape.example/hyperliquid/BTC' }],
    })
  })

  it('leaves out the canonical and og:url when the build names no site', () => {
    const head = marketHead({ ...btc, network: 'mainnet', site: undefined })
    expect(head.links).toEqual([])
    expect(head.meta).not.toContainEqual(expect.objectContaining({ property: 'og:url' }))
  })

  it('asks search engines not to index a testnet page and says testnet in its title', () => {
    const head = marketHead({ ...btc, network: 'testnet', site: 'https://testnet.tape.example' })
    expect(head.meta).toContainEqual({ name: 'robots', content: 'noindex' })
    expect(head.meta).toContainEqual({ title: 'BTC on Hyperliquid · Live order book · Tape testnet' })
  })

  it('lets a mainnet page be indexed', () => {
    expect(marketHead({ ...btc, network: 'mainnet', site: undefined }).meta).not.toContainEqual(
      expect.objectContaining({ name: 'robots' }),
    )
  })
})

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
