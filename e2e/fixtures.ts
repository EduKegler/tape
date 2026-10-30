import { existsSync, readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { test as base, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { Network } from '@tape/core/ids'
import { RECORDED_AT } from './replay/clock'
import { restRecording } from './replay/feed'

const fixtures = new URL('../packages/venues/src/__fixtures__/', import.meta.url)

export const test = base.extend<{ network: Network; escaped: string[]; consoleErrors: string[] }>({
  network: ['mainnet', { option: true }],
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
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('console', (m) => {
        if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text())
      })
      await use(errors)
      expect(errors, 'console errors').toEqual([])
    },
    { auto: true },
  ],
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

const BLOCKING_IMPACT = new Set(['serious', 'critical'])
const LOW_CONTRAST_UNTIL_THE_DESIGN_PROGRAM = [
  'nav[aria-label="Market"] a[aria-current="page"]',
  'section div[data-status] button > span:last-child',
]

export async function expectAccessible(page: Page) {
  const rest = await new AxeBuilder({ page }).exclude('canvas').disableRules(['color-contrast']).analyze()
  const contrast = await LOW_CONTRAST_UNTIL_THE_DESIGN_PROGRAM.reduce(
    (axe, selector) => axe.exclude(selector),
    new AxeBuilder({ page }).withRules(['color-contrast']).exclude('canvas'),
  ).analyze()
  const blocking = [...rest.violations, ...contrast.violations]
    .filter((v) => BLOCKING_IMPACT.has(v.impact ?? ''))
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(blocking, 'serious and critical axe violations').toEqual([])
}

export { expect }
