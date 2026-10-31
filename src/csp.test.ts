import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@tape/core/ids'
import type { Base, Network } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { venues } from '@tape/venues/index'
import { DEPOSITS } from '@tape/trade'
import type { DepositVenue } from '@tape/trade/deposit'
import type { TradeConfig, TradeVenueId } from '@tape/trade/types'
import { CONNECT, contentSecurityPolicy, workerSecurityPolicy } from './csp'

async function originsReached(network: Network) {
  const origins = new Set<string>()
  const offline: typeof fetch = (input) => {
    origins.add(new URL(input instanceof Request ? input.url : input).origin)
    return Promise.reject(new Error('offline'))
  }
  for (const adapter of Object.values(venues(network))) {
    origins.add(new URL(adapter.url).origin)
    await Promise.allSettled([
      adapter.fetchMarkets(offline),
      adapter.fetchMarket('BTC' as Base, offline),
      adapter.fetchStats('BTC' as Base, offline),
      adapter.fetchCandles('BTC' as Base, '1m', offline),
      adapter.book.protocol === 'rest-snapshot-sequenced'
        ? adapter.book.fetchSnapshot({ venueSymbol: 'BTCUSDT' } as MarketSpec, offline)
        : null,
    ])
  }
  return origins
}

const config: TradeConfig = {
  mainnet: true,
  hyperliquid: { builder: null },
  dydx: { builder: null },
  orderly: { brokerId: { mainnet: 'tape', testnet: 'demo' } },
}

const connectSrc = (policy: string) =>
  policy
    .split('; ')
    .find((directive) => directive.startsWith('connect-src '))!
    .split(' ')
    .slice(1)

describe('content security policy', () => {
  it.each(NETWORKS)('lets the %s page reach every venue it streams from', async (network) => {
    const reached = await originsReached(network)
    expect(reached.size).toBeGreaterThanOrEqual(8)
    expect([...reached].filter((origin) => !CONNECT[network].includes(origin))).toEqual([])
  })

  it.each(NETWORKS)('lets the %s page quote and follow every deposit route', async (network) => {
    const origins = new Set<string>()
    const offline: typeof fetch = (input) => {
      origins.add(new URL(input instanceof Request ? input.url : input).origin)
      return Promise.reject(new Error('offline'))
    }
    const owner = '0x2e5346477b01397553df3ec9a637f3e535325d6d'
    const chain = { readContract: () => Promise.reject(new Error('offline')) }
    const keys = {
      read: () => ({ status: 'linked', public: {}, secret: `0x${'01'.repeat(32)}` }) as const,
      write: () => {},
      clear: () => {},
    }
    for (const [venue, deposits] of Object.entries(DEPOSITS) as [TradeVenueId, DepositVenue][])
      for (const route of deposits.routes(network, config))
        await Promise.allSettled([
          route.terms({ fetch: offline, chain }, owner, 10_000_000n),
          route.progress(
            { fetch: offline, keys },
            {
              ref: { venue, network, owner },
              chainId: route.chainId,
              amount: 1n,
              hash: '0x01',
              sentAt: 0,
              claimed: new Set(),
            },
          ),
        ])
    expect(origins.size).toBeGreaterThan(0)
    expect([...origins].filter((origin) => !CONNECT[network].includes(origin))).toEqual([])
  })

  it('keeps every testnet origin off mainnet', () => {
    expect(CONNECT.testnet.filter((origin) => CONNECT.mainnet.includes(origin))).toEqual([])
  })

  it('runs only scripts that carry the nonce', () => {
    const script = contentSecurityPolicy('abc', 'testnet', false)
      .split('; ')
      .find((directive) => directive.startsWith('script-src'))
    expect(script).toBe("script-src 'self' 'nonce-abc' 'wasm-unsafe-eval'")
  })

  it('opens the WalletConnect relay and verify frame only to builds that offer it', () => {
    const directive = (wc: boolean, name: string) =>
      contentSecurityPolicy('abc', 'testnet', wc)
        .split('; ')
        .find((candidate) => candidate.startsWith(name))
    expect(directive(false, 'connect-src')).not.toContain('walletconnect')
    expect(directive(false, 'frame-src')).toBe("frame-src 'none'")
    expect(directive(true, 'connect-src')).toContain('wss://relay.walletconnect.org')
    expect(directive(true, 'frame-src')).toBe('frame-src https://verify.walletconnect.org')
  })

  it.each(NETWORKS)('lets the %s hub worker reach every venue it streams from', async (network) => {
    const reached = await originsReached(network)
    const allowed = connectSrc(workerSecurityPolicy(network))
    expect([...reached].filter((origin) => !allowed.includes(origin))).toEqual([])
  })

  it.each(NETWORKS)('keeps the other network out of the %s hub worker', async (network) => {
    const other = await originsReached(network === 'mainnet' ? 'testnet' : 'mainnet')
    const allowed = connectSrc(workerSecurityPolicy(network))
    expect(allowed.filter((origin) => other.has(origin))).toEqual([])
  })

  it.each(NETWORKS)('gives the %s hub worker no nonce, since its header is fixed at build time', (network) => {
    expect(workerSecurityPolicy(network)).not.toContain('nonce')
  })
})
