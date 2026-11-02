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
  const later = new Map<string, unknown>()
  for (const venue of Object.keys(HOSTS) as Venue[])
    await page.route(HOSTS[venue], async (route) => {
      if (timeout.includes(venue)) return route.abort('timedout')
      const request = route.request()
      const type = (request.postDataJSON() as { type?: string } | null)?.type ?? null
      const hit = HISTORY[venue].exchanges.find(
        (exchange) => exchange.url === request.url() && (exchange.body?.type ?? null) === type,
      )
      if (!hit) return route.fallback()
      const response = later.get(`${venue} ${type}`) ?? hit.response
      return route.fulfill({ json: response, headers: { 'access-control-allow-origin': '*' } })
    })
  await page.goto(`/history?address=${HISTORY.hyperliquid.address}&dydx=${HISTORY.dydx.address}${period}`)
  return {
    answerLater: (venue: Venue, type: string, response: unknown) => later.set(`${venue} ${type}`, response),
  }
}

const recordedFills = () =>
  HISTORY.hyperliquid.exchanges.find((exchange) => exchange.body?.type === 'userFillsByTime')!.response as Record<
    string,
    unknown
  >[]

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

test('History read again from the header shows a fill made after the first read, on screen and in the CSV', async ({
  page,
}) => {
  const fills = recordedFills()
  const last = fills.at(-1)!
  const close = {
    ...last,
    px: '94.112',
    sz: '0.7',
    side: 'A',
    time: Number(last.time) + 60_000,
    startPosition: '0.7',
    dir: 'Close Long',
    closedPnl: '1.234',
    tid: 900000000000001,
    oid: 900000000001,
    cloid: undefined,
  }
  const history = await openHistory(page, {})
  const hyperliquid = panel(page, 'Accounts').locator('[data-history-venue="hyperliquid"]')
  await expect(hyperliquid.getByText(`${fills.length} fills`, { exact: false })).toBeVisible()
  await expect(totals(page).getByText(/^Read \d{2}:\d{2}:\d{2} UTC$/)).toBeVisible()

  await page.getByRole('link', { name: 'Back to trading' }).click()
  await expect(panel(page, 'Order book').getByText(/^Spread .* bps$/)).toBeVisible()
  history.answerLater('hyperliquid', 'userFillsByTime', [...fills, close])
  await page.getByRole('banner').getByRole('link', { name: 'History' }).click()

  await expect(hyperliquid.getByText(`${fills.length + 1} fills`, { exact: false })).toBeVisible()
  const fill = rows(page).getByRole('row').filter({ hasText: '94.112' })
  await expect(fill).toContainText('2026-10-30 02:06:16')
  await expect(fill).toContainText('Sell')
  const read = await totals(page)
    .getByText(/^Read /)
    .textContent()
  const stamp = read!.slice(5, 13).replaceAll(':', '')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    rows(page).getByRole('button', { name: 'Export CSV' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(new RegExp(`-read-\\d{8}T${stamp}Z\\.csv$`))
  const csv = readFileSync(await download.path(), 'utf8')
  expect(csv).toContain(',sell,0.7,94.112,65.8784,0.130708,USDC,1.234,venue,,,false,900000000000001')
})
