import { expect, openMarket, test } from './fixtures'

test('testnet asks engines not to index its pages and serves no sitemap', async ({ page, request }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex')

  expect(await (await request.get('/robots.txt')).text()).not.toContain('Sitemap:')
  expect((await request.get('/sitemap.xml')).status()).toBe(404)
})
