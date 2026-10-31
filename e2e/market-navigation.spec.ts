import type { Network } from '@tape/core/ids'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'

const TITLE_SUFFIX: Record<Network, string> = { mainnet: '', testnet: ' testnet' }

test('the root opens Hyperliquid BTC on the 1m chart', async ({ page, network }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/hyperliquid\/BTC\?interval=1m$/)
  await expect(page).toHaveTitle(`BTC on Hyperliquid · Tape${TITLE_SUFFIX[network]}`)
})

test('the interval, venues table, market and venue move around and keep the search params', async ({
  page,
  network,
}) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m&group=1')

  const chart = panel(page, 'Chart')
  await chart.getByRole('radio', { name: '5m', exact: true }).click()
  await expect(page).toHaveURL(/[?&]interval=5m(&|$)/)
  await expect(chart.getByRole('radio', { name: '5m', exact: true })).toBeChecked()
  await expectAccessible(page)

  await panel(page, 'Venues').getByRole('row', { name: /^dYdX/ }).click()
  await expect(page).toHaveURL(/\/dydx\/BTC\?/)
  await expect(page).toHaveTitle(`BTC on dYdX · Tape${TITLE_SUFFIX[network]}`)

  const market = page.getByRole('navigation', { name: 'Market' })
  await market.getByRole('link', { name: 'ETH', exact: true }).click()
  await expect(page).toHaveURL(/\/dydx\/ETH\?/)
  await expect(page).toHaveTitle(`ETH on dYdX · Tape${TITLE_SUFFIX[network]}`)
  await expect(market.getByRole('link', { name: 'ETH', exact: true })).toHaveAttribute('aria-current', 'page')

  await page.getByRole('navigation', { name: 'Venue' }).getByRole('link', { name: 'Binance' }).click()
  await expect(page).toHaveURL(/\/binance\/ETH\?/)
  await expect(page).toHaveTitle(`ETH on Binance · Tape${TITLE_SUFFIX[network]}`)

  const search = new URL(page.url()).searchParams
  expect(search.get('interval')).toBe('5m')
  expect(search.get('group')).toBe('1')
})

for (const path of ['/kraken/BTC', '/hyperliquid/a b'])
  test(`${path} is not found`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByText('Not Found')).toBeVisible()
    await expect(page).toHaveTitle('Tape')
    await expectAccessible(page)
  })

test('a market the venue does not list says so', async ({ page }) => {
  await page.goto('/hyperliquid/NOTAMARKET')
  await expect(page.getByRole('heading', { name: 'NOTAMARKET is not listed on Hyperliquid' })).toBeVisible()
  await expect(panel(page, 'Order book')).toHaveCount(0)
  await expectAccessible(page)
})

test('the venues table marks the venues that do not list the market', async ({ page }) => {
  await page.goto('/hyperliquid/kPEPE')
  const venues = panel(page, 'Venues')
  for (const venue of ['Binance', 'dYdX', 'Orderly'])
    await expect(venues.getByRole('row', { name: new RegExp(`^${venue}`) })).toContainText('Not listed')
  await venues.getByRole('row', { name: /^Binance/ }).click()
  await expect(page).toHaveURL(/\/hyperliquid\/kPEPE/)
})
