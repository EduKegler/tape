import { expect, test } from '@playwright/test'
import { VENUE_IDS } from '@tape/core/ids'

const BINANCE_TESTNET_PING = 'https://testnet.binance.vision/api/v3/ping'

for (const venue of VENUE_IDS)
  test.describe(venue, () => {
    if (venue === 'binance')
      test.beforeEach(async ({ request }) => {
        const ping = await request.get(BINANCE_TESTNET_PING)
        // eslint-disable-next-line playwright/no-skipped-test -- Binance refuses testnet REST from some GitHub runner locations with 451
        test.skip(ping.status() === 451, 'testnet.binance.vision answered 451, restricted location, to this runner')
      })

    test('the testnet book goes live', async ({ page }) => {
      await page.goto(`/${venue}/BTC?interval=1m`)
      const book = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Order book', exact: true }) })
      await expect(book.getByText(/^Spread .* bps$/), `${venue} testnet never went live`).toBeVisible()
    })
  })
