import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@tape/core/ids'
import { DEPOSITS, TRADING } from '@tape/trade'
import type { TradeConfig } from '@tape/trade/types'
import { CHAINS } from './chains'

const config: TradeConfig = {
  mainnet: true,
  hyperliquid: { builder: null },
  dydx: { builder: null },
  orderly: { brokerId: { mainnet: 'tape', testnet: 'demo' } },
}

describe('wallet chains', () => {
  it.each(NETWORKS)('offers every chain a venue switches to on %s', (network) => {
    const offered = CHAINS[network].map((chain) => chain.id as number)
    const wanted = Object.values(TRADING).flatMap((venue) => (venue.walletChain ? [venue.walletChain[network]] : []))
    expect(offered).toEqual(expect.arrayContaining(wanted))
  })

  it.each(NETWORKS)('offers every chain a deposit leaves from on %s', (network) => {
    const offered = CHAINS[network].map((chain) => chain.id as number)
    const sources = Object.values(DEPOSITS).flatMap((venue) =>
      venue.routes(network, config).map((route) => route.chainId),
    )
    expect(offered).toEqual(expect.arrayContaining(sources))
  })
})
