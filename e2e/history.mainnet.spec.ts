import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, expectAccessible, panel, test } from './fixtures'

type Venue = 'hyperliquid' | 'dydx' | 'orderly'
interface Recording {
  readonly address: string
  readonly exchanges: readonly { url: string; body: { type: string } | null; response: unknown }[]
}

const recorded = (venue: Venue) =>
  JSON.parse(
    readFileSync(new URL(`../packages/trade/src/__fixtures__/history.${venue}.json`, import.meta.url), 'utf8'),
  ) as Recording
const HISTORY = { hyperliquid: recorded('hyperliquid'), dydx: recorded('dydx'), orderly: recorded('orderly') }
const HOSTS: Record<Venue, string> = {
  hyperliquid: 'https://api.hyperliquid.xyz/**',
  dydx: 'https://indexer.dydx.trade/**',
  orderly: 'https://api.orderly.org/**',
}

async function openHistory(page: Page, { timeout = [], period = '' }: { timeout?: Venue[]; period?: string }) {
  for (const venue of Object.keys(HOSTS) as Venue[])
    await page.route(HOSTS[venue], async (route) => {
      if (timeout.includes(venue)) return route.abort('timedout')
      const request = route.request()
      const type = (request.postDataJSON() as { type?: string } | null)?.type ?? null
      const hit = HISTORY[venue].exchanges.find(
        (exchange) => exchange.url === request.url() && (exchange.body?.type ?? null) === type,
      )
      return hit
        ? route.fulfill({ json: hit.response, headers: { 'access-control-allow-origin': '*' } })
        : route.fallback()
    })
  await page.goto(`/history?address=${HISTORY.hyperliquid.address}&dydx=${HISTORY.dydx.address}${period}`)
}

const totals = (page: Page) => panel(page, 'Totals')
const rows = (page: Page) => panel(page, 'Fills and funding')

test('a venue that does not answer reads as a failed read, and the totals say they leave it out', async ({ page }) => {
  await openHistory(page, { timeout: ['hyperliquid'] })
  const venue = panel(page, 'Accounts').locator('[data-history-venue="hyperliquid"]')
  await expect(venue.getByRole('alert')).toHaveText(
    'Could not read Hyperliquid history. The venue did not answer. Retry',
  )
  await expect(totals(page).getByText('Could not read Hyperliquid. These totals leave it out.')).toBeVisible()
  await expect(totals(page).getByRole('row', { name: /^dYdX / })).toBeVisible()
  await expect(page.getByText('Nothing was sent')).toHaveCount(0)
  await expectAccessible(page)
})

test('when no venue answers, neither the totals nor the rows read as an empty period', async ({ page }) => {
  await openHistory(page, { timeout: ['hyperliquid', 'dydx', 'orderly'] })
  await expect(panel(page, 'Accounts').getByRole('alert')).toHaveCount(3)
  await expect(
    totals(page).getByText('No totals to show. Hyperliquid, dYdX, and Orderly could not be read.'),
  ).toBeVisible()
  await expect(rows(page).getByText('Nothing to show. Hyperliquid, dYdX, and Orderly could not be read.')).toBeVisible()
  await expect(page.getByText(/in this period/)).toHaveCount(0)
  await expectAccessible(page)
})

test('a period with nothing in it says so, with no read failure beside it', async ({ page }) => {
  await openHistory(page, { period: '&from=2020-01-01&to=2020-01-31' })
  await expect(panel(page, 'Accounts').getByText('24 fills · 112 funding payments')).toBeVisible()
  await expect(totals(page).getByText('Nothing in this period.')).toBeVisible()
  await expect(rows(page).getByText('No fills or funding in this period.')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
