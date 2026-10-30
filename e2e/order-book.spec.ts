import type { Locator } from '@playwright/test'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'

const priceOf = async (row: Locator) => (await row.innerText()).split('\n')[0] ?? ''
const filledRows = (book: Locator) => book.getByRole('button', { name: /\d/ })

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
  await expect(book.getByText(/^Spread .* bps$/)).toBeVisible()
  const prices = (await filledRows(book).allInnerTexts()).map((row) => Number(row.split('\n')[0]?.replaceAll(',', '')))
  expect(prices.length).toBeGreaterThan(0)
  expect(prices.filter((px) => px % 10 !== 0)).toEqual([])
})

test('clicking the best bid puts its price into the ticket', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  const price = ticket.getByRole('textbox', { name: 'Price (USDC)' })
  await expect(price).toHaveValue('')
  const rows = panel(page, 'Order book').getByRole('button')
  const bestBid = rows.nth((await rows.count()) / 2)
  const clicked = await priceOf(bestBid)
  const plain = clicked.replaceAll(',', '')
  await expect(ticket.getByRole('button', { name: `Bid ${plain}`, exact: true })).toBeVisible()
  await bestBid.click()
  await expect(price).toHaveValue(plain)
  await expectAccessible(page)
})
