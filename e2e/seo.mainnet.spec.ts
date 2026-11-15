import { expect, openMarket, test } from './fixtures'

test('robots.txt names the sitemap, which lists the pinned markets of each venue', async ({ request, baseURL }) => {
  const robots = await request.get('/robots.txt')
  expect(await robots.text()).toContain(`Sitemap: ${baseURL}/sitemap.xml`)

  const sitemap = await request.get('/sitemap.xml')
  expect(sitemap.headers()['content-type']).toContain('application/xml')
  const body = await sitemap.text()
  expect(body).toContain(`<loc>${baseURL}/hyperliquid/BTC</loc>`)
  expect(body).toContain(`<loc>${baseURL}/orderly/SOL</loc>`)
})

test('a market page names its market in an H1 and describes it, with nothing asking engines to skip it', async ({
  page,
}) => {
  await openMarket(page, '/dydx/BTC?interval=1m')
  await expect(page.getByRole('heading', { level: 1, name: 'BTC order book on dYdX' })).toBeAttached()
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'Live BTC order book, trades, depth and candles on dYdX, beside the best bid and ask on the other venues.',
  )
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    'BTC on dYdX · Live order book · Tape',
  )
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0)
})

test('each sitemap URL answers itself, and the default interval redirects to it', async ({ request, baseURL }) => {
  const market = await request.get('/hyperliquid/BTC', { maxRedirects: 0 })
  expect(market.status()).toBe(200)

  const withDefault = await request.get('/hyperliquid/BTC?interval=1m', { maxRedirects: 0 })
  expect(withDefault.status()).toBe(307)
  const target = new URL(withDefault.headers().location ?? '', baseURL)
  expect(`${target.pathname}${target.search}`).toBe('/hyperliquid/BTC')
})
