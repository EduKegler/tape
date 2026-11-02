import type { Page } from '@playwright/test'
import type { Network } from '@tape/core/ids'
import { recordedWrite } from '@tape/trade/fixtures'

const INDEXER: Record<Network, string> = {
  mainnet: 'https://indexer.dydx.trade/v4',
  testnet: 'https://indexer.v4testnet.dydx.exchange/v4',
}

/** The dYdX testnet indexer's recorded answer for an address it has never seen. */
const UNSEEN = recordedWrite('dydx', 'unknownAddress').exchanges[0]!

const CORS = { 'access-control-allow-origin': '*' }

/**
 * Answers the indexer as for an address it has never seen, or, given `subaccount`, as for one holding it
 * with no open orders and no fills, in the shapes of the dYdX indexer API docs.
 */
export async function fakeDydx(page: Page, network: Network, subaccount?: Record<string, unknown>) {
  const asked: string[] = []
  await page.route(`${INDEXER[network]}/addresses/**`, (route) => {
    asked.push(new URL(route.request().url()).pathname)
    return subaccount
      ? route.fulfill({ json: { subaccount }, headers: CORS })
      : route.fulfill({ status: UNSEEN.status, json: UNSEEN.response, headers: CORS })
  })
  if (subaccount) {
    await page.route(`${INDEXER[network]}/orders?**`, (route) => route.fulfill({ json: [], headers: CORS }))
    await page.route(`${INDEXER[network]}/fills?**`, (route) => route.fulfill({ json: { fills: [] }, headers: CORS }))
  }
  return { asked }
}
