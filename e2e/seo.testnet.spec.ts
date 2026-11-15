import { expect, test } from './fixtures'

test('testnet serves no sitemap', async ({ request }) => {
  expect(await (await request.get('/robots.txt')).text()).not.toContain('Sitemap:')
  expect((await request.get('/sitemap.xml')).status()).toBe(404)
})
