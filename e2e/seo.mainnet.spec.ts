import { expect, test } from './fixtures'

test('robots.txt names the sitemap, which lists the pinned markets of each venue', async ({ request, baseURL }) => {
  const robots = await request.get('/robots.txt')
  expect(await robots.text()).toContain(`Sitemap: ${baseURL}/sitemap.xml`)

  const sitemap = await request.get('/sitemap.xml')
  expect(sitemap.headers()['content-type']).toContain('application/xml')
  const body = await sitemap.text()
  expect(body).toContain(`<loc>${baseURL}/hyperliquid/BTC</loc>`)
  expect(body).toContain(`<loc>${baseURL}/orderly/SOL</loc>`)
})
