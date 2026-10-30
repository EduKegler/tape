import { VENUE_IDS } from '@tape/core/ids'
import { expect, openMarket, panel, test } from './fixtures'

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false })

  test('the server renders the market screen', async ({ page }) => {
    await page.goto('/hyperliquid/BTC?interval=1m')
    for (const title of ['Order book', 'Trades', 'Order ticket'])
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  })
})

test('the market screen hydrates and answers a click', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await page.getByRole('radio', { name: 'Market', exact: true }).click()
  await expect(page.getByText('Max slippage')).toBeVisible()
})

for (const venue of VENUE_IDS)
  test(`the ${venue} book goes live from the replay with every bid below every ask`, async ({ page }) => {
    await openMarket(page, `/${venue}/BTC?interval=1m`)
    const rows = await panel(page, 'Order book').getByRole('button').allInnerTexts()
    const prices = rows.map((row) => Number(row.split(/\s+/)[0]?.replaceAll(',', '')))
    const asks = prices.slice(0, prices.length / 2).filter(Boolean)
    const bids = prices.slice(prices.length / 2).filter(Boolean)
    expect(asks.length).toBeGreaterThan(0)
    expect(bids.length).toBeGreaterThan(0)
    expect(Math.max(...bids)).toBeLessThan(Math.min(...asks))
  })
