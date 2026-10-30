import type { Page } from '@playwright/test'
import type { Network } from '@tape/core/ids'

const INDEXER: Record<Network, string> = {
  mainnet: 'https://indexer.dydx.trade/v4',
  testnet: 'https://indexer.v4testnet.dydx.exchange/v4',
}

/** dYdX's indexer answers 404 for an address it has never seen. */
export async function fakeDydx(page: Page, network: Network) {
  const asked: string[] = []
  await page.route(`${INDEXER[network]}/addresses/**`, (route) => {
    asked.push(new URL(route.request().url()).pathname)
    return route.fulfill({
      status: 404,
      json: { errors: [{ msg: 'No subaccount found with address' }] },
      headers: { 'access-control-allow-origin': '*' },
    })
  })
  return { asked }
}
