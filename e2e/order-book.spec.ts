import type { Locator } from '@playwright/test'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'

const rowPrices = async (book: Locator) =>
  [...(await book.ariaSnapshot()).matchAll(/button "([\d,.]+) /g)].map((m) => Number(m[1]?.replaceAll(',', '')))

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false })

  test('the book says it is syncing before any data', async ({ page }) => {
    await page.goto('/hyperliquid/BTC?interval=1m')
    await expect(panel(page, 'Order book').getByText('Syncing…')).toBeVisible()
  })

  test('a group in the URL is selected on first paint', async ({ page }) => {
    await page.goto('/hyperliquid/BTC?interval=1m&group=10')
    await expect(panel(page, 'Order book').getByRole('combobox', { name: 'Group' })).toHaveValue('10')
  })
})

test('grouping the book rounds every price to the group and writes it into the URL', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const book = panel(page, 'Order book')
  const group = book.getByRole('combobox', { name: 'Group' })
  await expect(group.getByRole('option')).toHaveText(['1', '2', '5', '10', '25', '50'])
  await group.selectOption('10')
  await expect(page).toHaveURL(/[?&]group=10(&|$)/)
  await expect(book.getByRole('button', { name: /^80,590 / })).toBeVisible()
  await expect(book.getByRole('button', { name: /^80,600 / })).toBeVisible()
  const prices = await rowPrices(book)
  expect(prices.length).toBeGreaterThan(0)
  expect(prices.filter((px) => px % 10 !== 0)).toEqual([])
  await expectAccessible(page)
})

test('clicking the best bid puts its price into the ticket', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  const price = ticket.getByRole('textbox', { name: 'Price (USDC)' })
  await expect(price).toHaveValue('')
  await expect(ticket.getByRole('button', { name: 'Bid 80595', exact: true })).toBeVisible()
  await panel(page, 'Order book')
    .getByRole('button', { name: /^80,595 / })
    .click()
  await expect(price).toHaveValue('80595')
  await expectAccessible(page)
})
