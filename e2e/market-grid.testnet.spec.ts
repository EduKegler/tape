import type { Page } from '@playwright/test'
import { expect, openMarket, panel, test } from './fixtures'
import { fakeHyperliquid } from './hyperliquid'

const PANELS = ['Order ticket', 'Account', 'Chart', 'Order book', 'Trades', 'Depth', 'Venues']

async function focusedRegion(page: Page) {
  if (await page.getByRole('banner').locator(':focus').count()) return 'header'
  if (await page.getByRole('navigation', { name: 'Venue' }).locator(':focus').count()) return 'venue strip'
  if (await page.getByRole('contentinfo').locator(':focus').count()) return 'status bar'
  for (const title of PANELS) if (await panel(page, title).locator(':focus').count()) return title
  return null
}

async function regionsFromHeaderToStatusBar(page: Page) {
  await page.getByRole('banner').getByRole('link').first().focus()
  const stops = [await focusedRegion(page)]
  while (stops.at(-1) !== 'status bar' && stops.length < 60) {
    await page.keyboard.press('Tab')
    stops.push(await focusedRegion(page))
  }
  return stops
}

test('Tab walks the header, the venue strip, the ticket, the account, the market panels and the status bar', async ({
  page,
  wallet: _wallet,
}) => {
  await fakeHyperliquid(page, 'testnet')
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await panel(page, 'Order ticket').getByRole('button', { name: 'Connect wallet' }).click()
  await expect(panel(page, 'Account').getByRole('button', { name: 'Deposit', exact: true })).toBeVisible()
  const stops = await regionsFromHeaderToStatusBar(page)
  expect(stops.filter((region, index) => region !== stops[index - 1])).toEqual([
    'header',
    'venue strip',
    'Order ticket',
    'Account',
    'Chart',
    'Order book',
    'Trades',
    'Venues',
    'status bar',
  ])
  expect(stops.indexOf('Order ticket') + 1).toBeLessThanOrEqual(15)
})
