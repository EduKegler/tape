import type { Page } from '@playwright/test'
import type { Network } from '@tape/core/ids'
import { recordedWrite } from '@tape/trade/fixtures'

const INDEXER: Record<Network, string> = {
  mainnet: 'https://indexer.dydx.trade/v4',
  testnet: 'https://indexer.v4testnet.dydx.exchange/v4',
}

/** The dYdX testnet indexer's recorded answer for an address it has never seen. */
const UNSEEN = recordedWrite('dydx', 'unknownAddress').exchanges[0]!

export async function fakeDydx(page: Page, network: Network) {
  const asked: string[] = []
  await page.route(`${INDEXER[network]}/addresses/**`, (route) => {
    asked.push(new URL(route.request().url()).pathname)
    return route.fulfill({
      status: UNSEEN.status,
      json: UNSEEN.response,
      headers: { 'access-control-allow-origin': '*' },
    })
  })
  return { asked }
}
