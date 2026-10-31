import type { Page, Route } from '@playwright/test'
import { CONTROL } from './replay/control'
import type { Command } from './replay/control'
import { expect, openMarket, panel, test } from './fixtures'

// Chromium's IntersectionObserver reports a row that sits on a fractional pixel as 0.995 visible.
const WHOLE = { ratio: 0.99 }

for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
])
  test(`at ${size.width}×${size.height} the market fits the window, with every book level and venue in view`, async ({
    page,
  }) => {
    await page.setViewportSize(size)
    await openMarket(page, '/hyperliquid/BTC?interval=1m')
    const levels = panel(page, 'Order book').getByRole('button', { name: /^(?:Bid|Ask) / })
    await expect(levels).toHaveCount(28)
    for (const level of await levels.all()) await expect(level).toBeInViewport(WHOLE)
    for (const venue of ['Binance', 'Hyperliquid', 'dYdX', 'Orderly'])
      await expect(panel(page, 'Venues').getByRole('row', { name: new RegExp(`^${venue}`) })).toBeInViewport(WHOLE)
    await expect(page.getByRole('contentinfo')).toBeInViewport(WHOLE)
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(size.height)
    const ticket = await panel(page, 'Order ticket').boundingBox()
    const book = await panel(page, 'Order book').boundingBox()
    expect(ticket && [ticket.y, ticket.y + ticket.height]).toEqual(book && [book.y, book.y + book.height])
  })

const send = (page: Page, command: Command) =>
  page.evaluate(
    ({ control, message }) => {
      const channel = new BroadcastChannel(control)
      channel.postMessage(message)
      channel.close()
    },
    { control: CONTROL, message: command },
  )

const centerY = (box: { y: number; height: number } | null) => (box ? box.y + box.height / 2 : null)

async function expectOneLine(page: Page) {
  const header = page.getByRole('banner')
  const brand = centerY(await header.getByRole('img', { name: 'Tape' }).boundingBox())
  const wallet = centerY(await header.getByRole('button', { name: 'Connect wallet' }).boundingBox())
  expect(Math.abs(brand! - wallet!)).toBeLessThan(1)
}

test('at 1280×800 the header keeps one line, also while the ticker says it is reconnecting', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const header = page.getByRole('banner')
  const live = await header.boundingBox()
  await expectOneLine(page)
  await send(page, { drop: 'hyperliquid' })
  await expect(header.getByText(/^Reconnecting · \d+ s old$/)).toBeVisible()
  await expectOneLine(page)
  expect(await header.boundingBox()).toEqual(live)
})

const failRead = (route: Route) => route.fulfill({ status: 503, body: '' })

const barHeights = (page: Page) =>
  page.locator('section > header').evaluateAll((bars) => bars.map((b) => b.getBoundingClientRect().height))

test('every panel title bar keeps one height while a panel says a read failed or its data is old', async ({ page }) => {
  await page.route('**/info', failRead)
  await page.goto('/hyperliquid/BTC?interval=1m')
  const book = panel(page, 'Order book')
  await expect(book.getByText(/^Spread .* bps$/)).toBeVisible()
  const ticket = panel(page, 'Order ticket')
  await expect(ticket.getByText('Could not load market rules.')).toBeVisible({ timeout: 20_000 })
  await expect(ticket.getByRole('button', { name: 'Retry' })).toBeVisible()
  expect(new Set(await barHeights(page)).size).toBe(1)
  await send(page, { drop: 'hyperliquid' })
  await expect(book.getByText(/^Reconnecting · \d+ s old$/)).toBeVisible()
  expect(new Set(await barHeights(page)).size).toBe(1)
})
