import { describe, expect, it } from 'vitest'
import { NETWORKS } from '@tape/core/ids'
import { DEPOSITS, TRADING } from '@tape/trade'
import { CHAINS } from './config'

describe('wallet chains', () => {
  it.each(NETWORKS)('offers every chain a venue switches to on %s', (network) => {
    const offered = CHAINS[network].map((c) => c.id as number)
    const wanted = Object.values(TRADING).flatMap((venue) => (venue.walletChain ? [venue.walletChain[network]] : []))
    expect(offered).toEqual(expect.arrayContaining(wanted))
  })

  it.each(NETWORKS)('offers every chain a deposit leaves from on %s', (network) => {
    const offered = CHAINS[network].map((c) => c.id as number)
    const sources = Object.values(DEPOSITS).flatMap((venue) => venue.routes(network).map((r) => r.chainId))
    expect(offered).toEqual(expect.arrayContaining(sources))
  })
})
