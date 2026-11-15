import type { Page } from '@playwright/test'
import type { Batch } from '#/analytics/events'
import { expect, openMarket, test } from './fixtures'

const FLUSH_MS = 5_000

test('a landing link keeps its UTM tags through the root redirect and the first pageview carries them', async ({
  page,
}) => {
  await openMarket(page, '/?utm_source=reddit&utm_campaign=launch&ref=abc')
  await expect(page).toHaveURL(/\/hyperliquid\/BTC\?/)
  const url = new URL(page.url())
  expect(url.searchParams.get('utm_source')).toBe('reddit')
  expect(url.searchParams.get('utm_campaign')).toBe('launch')

  expect(await firstBeacon(page)).toMatchObject({
    events: [
      [
        expect.any(Number),
        { event: '$pageview', path: '/hyperliquid/BTC', utm_source: 'reddit', utm_campaign: 'launch' },
      ],
    ],
  })
})

async function firstBeacon(page: Page): Promise<Batch> {
  const beacon = page.waitForRequest((request) => new URL(request.url()).pathname === '/r1')
  await page.clock.runFor(FLUSH_MS)
  return (await beacon).postDataJSON() as Batch
}
