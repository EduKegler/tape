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

for (const path of ['/kraken/BTC', '/hyperliquid/btc'])
  test(`${path} is not found`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByText('Not Found')).toBeVisible()
    await expect(page).toHaveTitle('Tape')
    await expectAccessible(page)
  })
