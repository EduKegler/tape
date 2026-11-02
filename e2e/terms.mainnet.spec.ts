import { expect, expectAccessible, openMarket, test } from './fixtures'
import { fakeHyperliquid } from './hyperliquid'

test('the footer opens the terms, which state the builder fee and point to the terms of Hyperliquid', async ({
  page,
}) => {
  await fakeHyperliquid(page, 'mainnet')
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await page.getByRole('contentinfo').getByRole('link', { name: 'Terms' }).click()

  await expect(page).toHaveURL(/\/terms$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Terms' })).toBeVisible()
  await expect(page.getByText('It holds none of your funds')).toBeVisible()
  await expect(page.getByText('builder fee of 1 bp (0.01%)')).toBeVisible()
  await expect(page.getByText('section 1.6 of Hyperliquid')).toBeVisible()
  await expect(page.getByRole('link', { name: "Hyperliquid's terms" })).toHaveAttribute(
    'href',
    'https://app.hyperliquid.xyz/terms',
  )
  await expectAccessible(page)

  await page.getByRole('link', { name: 'Back to trading' }).click()
  await expect(page).not.toHaveURL(/\/terms$/)
})
