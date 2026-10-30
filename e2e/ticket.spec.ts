import { expect, expectAccessible, openMarket, panel, test } from './fixtures'

test('the ticket refuses a price with more decimals than the market has', async ({ page }) => {
  await openMarket(page, '/binance/BTC?interval=1m')
  const price = panel(page, 'Order ticket').getByRole('textbox', { name: 'Price (USDT)' })
  await price.fill('1.234')
  await price.blur()
  await expect(panel(page, 'Order ticket').getByText('At most 2 decimals')).toBeVisible()
  await expect(price).toHaveAttribute('aria-invalid', 'true')
  await expectAccessible(page)
})
