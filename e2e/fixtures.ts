import { existsSync, readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { test as base, expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Network } from '@tape/core/ids'
import { RECORDED_AT } from './replay/clock'
import { restRecording } from './replay/feed'
import { installWallet } from './wallet'
import type { Wallet } from './wallet'

export const TEST_WALLET = 'Test Wallet'

const fixtures = new URL('../packages/venues/src/__fixtures__/', import.meta.url)

export const test = base.extend<{
  network: Network
  walletNames: readonly string[]
  escaped: string[]
  consoleErrors: string[]
  wallet: Wallet
}>({
  network: ['mainnet', { option: true }],
  walletNames: [[TEST_WALLET], { option: true }],
  escaped: [
    async ({ context }, use) => {
      const escaped: string[] = []
      await context.route('**/*', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        if (url.hostname === '127.0.0.1') return route.continue()
        const name = restRecording(request.url(), request.postData())
        const recording = name ? new URL(name, fixtures) : null
        if (recording && existsSync(recording))
          return route.fulfill({
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: readFileSync(recording, 'utf8'),
          })
        escaped.push(`${request.method()} ${url.origin}${url.pathname}`)
        return route.abort('blockedbyclient')
      })
      await use(escaped)
      expect(escaped, 'requests that left for the network').toEqual([])
    },
    { auto: true },
  ],
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
          errors.push(message.text())
      })
      await use(errors)
      expect(errors, 'console errors').toEqual([])
    },
    { auto: true },
  ],
  wallet: async ({ context, walletNames }, use) => {
    const wallet = await installWallet(context, walletNames)
    await use(wallet)
    expect(wallet.unanswered(), 'wallet methods the app called that the test wallet does not answer').toEqual([])
  },
  page: async ({ page }, use) => {
    await page.clock.install({ time: RECORDED_AT })
    await use(page)
  },
})

export const panel = (page: Page, title: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) })

export async function openMarket(page: Page, path: string) {
  await page.goto(path)
  await expect(panel(page, 'Order book').getByText(/^Spread .* bps$/)).toBeVisible()
}

export const connectPanel = (page: Page) => page.getByRole('dialog', { name: 'Connect a wallet' })

export async function connectWallet(page: Page, opener: Locator) {
  await opener.click()
  await connectPanel(page)
    .getByRole('button', { name: new RegExp(`^${TEST_WALLET}`) })
    .click()
  await expect(connectPanel(page)).toHaveCount(0)
  const chip = page.getByRole('banner').getByRole('button', { name: /^0x/ })
  await expect(chip).toHaveText((await chip.getAttribute('aria-label')) ?? '')
}

/** Resolves once every finite animation on the page has ended. */
export const settled = (page: Page) =>
  page.waitForFunction(() =>
    document
      .getAnimations()
      .every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
  )

const BLOCKING_IMPACT = new Set(['serious', 'critical'])

export async function expectAccessible(page: Page) {
  // Base UI keeps focus in order around a non-modal popup with focusable spans it hides from screen readers.
  const { violations } = await new AxeBuilder({ page })
    .exclude('canvas')
    .exclude('[data-base-ui-focus-guard]')
    .analyze()
  const blocking = violations
    .filter((violation) => BLOCKING_IMPACT.has(violation.impact ?? ''))
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)
  expect(blocking, 'serious and critical axe violations').toEqual([])
}

export { expect }
