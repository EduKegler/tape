import { readFileSync } from 'node:fs'
import type { Route } from '@playwright/test'
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

test('a market the venue does not list says Tape does not show it', async ({ page }) => {
  await page.goto('/hyperliquid/NOTAMARKET')
  await expect(page.getByRole('heading', { name: 'Tape does not show NOTAMARKET on Hyperliquid' })).toBeVisible()
  await expect(page.getByText('Hyperliquid does not list it, or Tape leaves it out.')).toBeVisible()
  await expect(panel(page, 'Order book')).toHaveCount(0)
  await expectAccessible(page)
})

test('a market the venue lists but Tape leaves out never reads as unlisted', async ({ page }) => {
  await page.goto('/dydx/PEPE')
  await expect(page.getByRole('heading', { name: 'Tape does not show PEPE on dYdX' })).toBeVisible()
  await expect(page.getByText('dYdX does not list it, or Tape leaves it out.')).toBeVisible()
})

test('the venues table marks the venues where Tape does not show the market', async ({ page }) => {
  await page.goto('/hyperliquid/kPEPE')
  const venues = panel(page, 'Venues')
  for (const venue of ['Binance', 'dYdX', 'Orderly'])
    await expect(venues.getByRole('row', { name: new RegExp(`^${venue}`) })).toContainText('Not shown')
  await venues.getByRole('row', { name: /^Binance/ }).click()
  await expect(page).toHaveURL(/\/hyperliquid\/kPEPE/)
})

test('the header search filters markets as you type and opens one by keyboard', async ({ page, network }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=5m')
  const search = page.getByRole('combobox', { name: 'Search markets' })
  await search.pressSequentially('eth')
  const options = page.getByRole('listbox').getByRole('option')
  await expect(options.nth(0)).toHaveText('ETH')
  await expect(options.nth(1)).toHaveText('ETHFI')

  await search.press('ArrowDown')
  await search.press('Enter')
  await expect(page).toHaveURL(/\/hyperliquid\/ETHFI\?interval=5m$/)
  await expect(page).toHaveTitle(`ETHFI on Hyperliquid · Tape${TITLE_SUFFIX[network]}`)
  await expect(search).toHaveValue('')
  await expectAccessible(page)

  await search.pressSequentially('zzzz')
  await expect(page.getByText('No market matches')).toBeVisible()
  await search.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(page).toHaveURL(/\/hyperliquid\/ETHFI\?interval=5m$/)
})

test('the search lists each dex once when two dexes share a full name', async ({ page }) => {
  const dexes = JSON.parse(
    readFileSync(new URL('../packages/venues/src/__fixtures__/hyperliquid.perpDexs.json', import.meta.url), 'utf8'),
  ) as ({ fullName: string } | null)[]
  await page.route('**/info', (route) =>
    route.request().postData()?.includes('"perpDexs"')
      ? route.fulfill({
          json: dexes.map((d) => d && { ...d, fullName: 'Same' }),
          headers: { 'access-control-allow-origin': '*' },
        })
      : route.fallback(),
  )
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const search = page.getByRole('combobox', { name: 'Search markets' })
  await search.pressSequentially('t')
  await expect(page.getByRole('group', { name: 'Same' }).first()).toBeVisible()
  await search.pressSequentially('r')
  await expect(page.getByRole('option').first()).toContainText(/TR/i)
  const options = await page.getByRole('option').allInnerTexts()
  expect(options.every((o) => /TR/i.test(o))).toBe(true)
  expect(new Set(options).size).toBe(options.length)
  const dexesShown = new Set(options.map((o) => (o.includes(':') ? o.split(':')[0] : '')))
  await expect(page.getByRole('group')).toHaveCount(dexesShown.size)
})

const failMarketList = (route: Route) =>
  route.request().postData()?.includes('"allPerpMetas"') ? route.fulfill({ status: 503, body: '' }) : route.fallback()

test('the search says when the market list fails and tries again when it opens', async ({ page }) => {
  await page.route('**/info', failMarketList)
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const search = page.getByRole('combobox', { name: 'Search markets' })
  await search.click()
  await expect(page.getByText('Could not load markets.')).toBeVisible({ timeout: 15_000 })
  await page.unroute('**/info', failMarketList)
  await page.keyboard.press('Escape')
  await search.click()
  await expect(page.getByRole('option', { name: 'BTC', exact: true })).toBeVisible()
})

for (const path of ['/dydx/xyz:TSLA', '/dydx/xyz%3ATSLA'])
  test(`${path} marks its market and venue as current`, async ({ page }) => {
    await page.goto(path)
    await expect(
      page.getByRole('navigation', { name: 'Market' }).getByRole('link', { name: 'xyz:TSLA', exact: true }),
    ).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('navigation', { name: 'Venue' }).getByRole('link', { name: /^dYdX/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })
