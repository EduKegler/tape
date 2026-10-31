import type { Page } from '@playwright/test'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'

test.use({ timezoneId: 'UTC' })

const ticker = (page: Page) => page.getByRole('banner').getByRole('definition')

test('the ticker shows the last trade and the perp stats Hyperliquid recorded', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await expect(page.getByRole('banner').getByRole('term')).toHaveText([
    'Last price',
    '24h',
    'Volume',
    'Funding 1h',
    'Index',
  ])
  await expect(ticker(page)).toHaveText(['▲Buy 80,589', '-0.40%', '2.11B', '+0.0013%', '80,641.2'])
  await expectAccessible(page)
})

test('a spot ticker has no funding or index', async ({ page }) => {
  await openMarket(page, '/binance/BTC?interval=1m')
  await expect(page.getByRole('banner').getByRole('term')).toHaveText(['Last price', '24h', 'Volume'])
})

test("the trade feed lists the newest trade first in the browser's time zone", async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const trades = panel(page, 'Trades')
  await expect(trades.getByText('Loading…')).toBeHidden()
  await expect(trades.getByRole('button').first()).toHaveAccessibleName('Buy 80,589 size 0.00062 at 01:40:06')
})

test('the depth chart draws the book', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const depth = panel(page, 'Depth').getByRole('img', { name: 'Cumulative order book depth' })
  await expect
    .poll(() =>
      depth.evaluate((canvas: HTMLCanvasElement) =>
        canvas.width > 0 && canvas.height > 0
          ? (canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data.some(Boolean) ?? false)
          : false,
      ),
    )
    .toBe(true)
})

test('changing the interval reloads the candle history for it', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const chart = panel(page, 'Chart')
  const history = page.waitForRequest(
    (request) =>
      request.url().endsWith('/info')
      && request.postData()?.includes('"candleSnapshot"') === true
      && request.postData()?.includes('"interval":"1h"') === true,
    { timeout: 5_000 },
  )
  await chart.getByRole('radio', { name: '1h', exact: true }).click()
  await history
  await expect(page).toHaveURL(/[?&]interval=1h(&|$)/)
  await expect(chart.getByRole('radio', { name: '1h', exact: true })).toBeChecked()
  await expect(chart.getByText('Could not load history.')).toBeHidden()
  await expectAccessible(page)
})
