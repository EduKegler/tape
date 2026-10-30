import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@tape/core/ids'
import type { Network } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { venues } from '@tape/venues/index'
import { DEPOSITS } from '@tape/trade'
import { CONNECT, contentSecurityPolicy } from './csp'

async function originsReached(network: Network) {
  const origins = new Set<string>()
  const offline: typeof fetch = (input) => {
    origins.add(new URL(input instanceof Request ? input.url : input).origin)
    return Promise.reject(new Error('offline'))
  }
  for (const adapter of Object.values(venues(network))) {
    origins.add(new URL(adapter.url).origin)
    await Promise.allSettled([
      adapter.fetchSpecs(offline),
      adapter.fetchStats('BTC', offline),
      adapter.fetchCandles('BTC', '1m', offline),
      adapter.book.protocol === 'rest-snapshot-sequenced'
        ? adapter.book.fetchSnapshot({ venueSymbol: 'BTCUSDT' } as MarketSpec, offline)
        : null,
    ])
  }
  return origins
}

describe('content security policy', () => {
  it.each(NETWORKS)('lets the %s page reach every venue it streams from', async (network) => {
    const reached = await originsReached(network)
    expect(reached.size).toBeGreaterThanOrEqual(8)
    expect([...reached].filter((o) => !CONNECT[network].includes(o))).toEqual([])
  })

  it.each(NETWORKS)('lets the %s page quote and follow every deposit route', async (network) => {
    const origins = new Set<string>()
    const offline: typeof fetch = (input) => {
      origins.add(new URL(input instanceof Request ? input.url : input).origin)
      return Promise.reject(new Error('offline'))
    }
    const sent = { ref: { venue: 'hyperliquid', network, owner: '0x01' }, amount: 1n, hash: '0x01', sentAt: 0 } as const
    for (const route of Object.values(DEPOSITS).flatMap((v) => v.routes(network)))
      await Promise.allSettled([
        route.fee(offline, 10_000_000n),
        route.progress(offline, { ...sent, chainId: route.chainId }),
      ])
    expect(origins.size).toBeGreaterThan(0)
    expect([...origins].filter((o) => !CONNECT[network].includes(o))).toEqual([])
  })

  it('keeps every testnet origin off mainnet', () => {
    expect(CONNECT.testnet.filter((o) => CONNECT.mainnet.includes(o))).toEqual([])
  })

  it('runs only scripts that carry the nonce', () => {
    const script = contentSecurityPolicy('abc', 'testnet', false)
      .split('; ')
      .find((d) => d.startsWith('script-src'))
    expect(script).toBe("script-src 'self' 'nonce-abc' 'wasm-unsafe-eval'")
  })

  it('opens the WalletConnect relay and verify frame only to builds that offer it', () => {
    const directive = (wc: boolean, name: string) =>
      contentSecurityPolicy('abc', 'testnet', wc)
        .split('; ')
        .find((d) => d.startsWith(name))
    expect(directive(false, 'connect-src')).not.toContain('walletconnect')
    expect(directive(false, 'frame-src')).toBe("frame-src 'none'")
    expect(directive(true, 'connect-src')).toContain('wss://relay.walletconnect.org')
    expect(directive(true, 'frame-src')).toBe('frame-src https://verify.walletconnect.org')
  })
})
