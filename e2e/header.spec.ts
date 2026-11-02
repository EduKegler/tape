import { fakeChains } from './chain'
import { connectWallet, expect, panel, test } from './fixtures'
import { fakeHyperliquid } from './hyperliquid'

for (const width of [1024, 1280])
  test(`the header keeps its height at ${width} px when the 24h stats land`, async ({
    page,
    network,
    wallet: _wallet,
  }) => {
    await fakeHyperliquid(page, network)
    await fakeChains(page, network)
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    await page.route(
      (url) => url.hostname !== '127.0.0.1',
      async (route) => {
        await held
        await route.fallback()
      },
    )
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/hyperliquid/BTC?interval=1m')
    await expect(panel(page, 'Order book').getByText(/^Spread .* bps$/)).toBeVisible()
    const header = page.getByRole('banner')
    await connectWallet(page, header.getByRole('button', { name: 'Connect', exact: true }))
    const waiting = header.getByRole('definition').filter({ hasText: /^—$/ })
    await expect(waiting).toHaveCount(2)
    const before = (await header.boundingBox())?.height

    release()
    await expect(waiting).toHaveCount(0)
    expect((await header.boundingBox())?.height).toBe(before)
  })
