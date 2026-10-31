import type { BrowserContext, Page } from '@playwright/test'
import { RECORDED_AT } from './replay/clock'
import { CONTROL } from './replay/control'
import type { Command } from './replay/control'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'

const footer = (page: Page) => page.getByRole('contentinfo')
const spread = (page: Page) => panel(page, 'Order book').getByText(/^Spread .* bps$/)

const send = (page: Page, command: Command) =>
  page.evaluate(
    ({ control, message }) => {
      const channel = new BroadcastChannel(control)
      channel.postMessage(message)
      channel.close()
    },
    { control: CONTROL, message: command },
  )

const swallowPageHide = () =>
  window.addEventListener('pagehide', (event) => event.stopImmediatePropagation(), { capture: true })

async function openTab(context: BrowserContext, path: string, { pagehide = true } = {}) {
  const tab = await context.newPage()
  if (!pagehide) await tab.addInitScript(swallowPageHide)
  await tab.clock.install({ time: RECORDED_AT })
  await openMarket(tab, path)
  return tab
}

async function expectBookRecovers(page: Page) {
  await send(page, { drop: 'hyperliquid' })
  await expect(panel(page, 'Order book').getByText(/^Reconnecting · \d+ s old$/)).toBeVisible()
  await send(page, { restore: 'hyperliquid' })
  await expect(spread(page)).toBeVisible()
}

test('one tab shows the shared hub with a socket per venue', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await expect(footer(page).getByText('Hub shared')).toBeVisible()
  await expect(footer(page).getByText('Tabs 1', { exact: true })).toBeVisible()
  await expect(footer(page).getByText('Sockets 4', { exact: true })).toBeVisible()
  await expectAccessible(page)
})

test('the book goes stale when its socket drops and live again after the replay reconnects', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await expectBookRecovers(page)
  await expect(footer(page).getByText('Sockets 4', { exact: true })).toBeVisible()
})

test('a market opened after its venue dropped shows the last book the hub had, with its age', async ({ page }) => {
  await openMarket(page, '/binance/BTC?interval=1m')
  await expect(panel(page, 'Venues').getByRole('row', { name: /^Hyperliquid .*\d/ })).toBeVisible()
  await send(page, { drop: 'hyperliquid' })
  await page
    .getByRole('navigation', { name: 'Venue' })
    .getByRole('link', { name: /Hyperliquid/ })
    .click()
  const book = panel(page, 'Order book')
  await expect(book.getByRole('button', { name: /^Bid / }).first()).toBeVisible()
  await expect(book.getByText(/^Reconnecting · \d+ s old$/)).toBeVisible()
  await expect(book.getByText('Waiting for Hyperliquid')).toHaveCount(0)
})

test('a second tab shares the hub and its sockets', async ({ page, context }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const second = await openTab(context, '/hyperliquid/BTC')
  for (const tab of [page, second]) {
    await expect(footer(tab).getByText('Tabs 2', { exact: true })).toBeVisible()
    await expect(footer(tab).getByText('Sockets 4', { exact: true })).toBeVisible()
  }
  await expectAccessible(second)
})

test('closing a tab leaves the other one counted alone and still fed', async ({ page, context }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const second = await openTab(context, '/hyperliquid/BTC')
  await expect(footer(page).getByText('Tabs 2', { exact: true })).toBeVisible()
  await second.close()
  await expect(footer(page).getByText('Tabs 1', { exact: true })).toBeVisible()
  await expectBookRecovers(page)
})

test('a tab that dies without its pagehide leaves the other one counted alone and still fed', async ({
  page,
  context,
}) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const second = await openTab(context, '/hyperliquid/BTC', { pagehide: false })
  await expect(footer(page).getByText('Tabs 2', { exact: true })).toBeVisible()
  await second.close()
  await expect(footer(page).getByText('Tabs 1', { exact: true })).toBeVisible()
  await expectBookRecovers(page)
})

test('a dedicated hub counts only its own tab and stays out of the shared one', async ({ page, context }) => {
  await openMarket(page, '/binance/BTC?hub=dedicated')
  const shared = await openTab(context, '/hyperliquid/BTC?interval=1m')
  await expect(footer(page).getByText('Hub dedicated')).toBeVisible()
  await expect(footer(page).getByText('Tabs 1', { exact: true })).toBeVisible()
  await expect(footer(shared).getByText('Hub shared')).toBeVisible()
  await expect(footer(shared).getByText('Tabs 1', { exact: true })).toBeVisible()
  await expectAccessible(page)
})

test('with every socket down the status bar says prices are frozen, in its own height', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const box = () => footer(page).boundingBox()
  const live = await box()
  for (const venue of ['binance', 'hyperliquid', 'dydx', 'orderly'] as const) await send(page, { drop: venue })
  await expect(footer(page).getByText('Sockets 0', { exact: true })).toBeVisible()
  await expect(
    footer(page).getByText(
      'Offline. No venue socket is open, so every price on screen is frozen. Tape keeps retrying.',
    ),
  ).toBeVisible()
  expect(await box()).toEqual(live)
  await expectAccessible(page)
})
