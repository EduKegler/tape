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
