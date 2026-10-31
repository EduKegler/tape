import { defineConfig, devices } from '@playwright/test'
import { NETWORKS } from '@tape/core/ids'
import type { Network } from '@tape/core/ids'

const origin = (network: Network) => `http://127.0.0.1:${4610 + NETWORKS.indexOf(network)}`

const BROWSERS = {
  chromium: {
    ...devices['Desktop Chrome'],
    launchOptions: { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] },
  },
  firefox: {
    ...devices['Desktop Firefox'],
    launchOptions: { proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1' } },
  },
  webkit: {
    ...devices['Desktop Safari'],
    launchOptions: { proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1' } },
  },
}
const browser = process.env.E2E_BROWSER ?? 'chromium'
if (!(browser in BROWSERS)) throw new Error(`E2E_BROWSER must be one of ${Object.keys(BROWSERS).join(', ')}`)

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/results',
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  use: {
    ...BROWSERS[browser as keyof typeof BROWSERS],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: NETWORKS.map((network) => ({ name: network, use: { baseURL: origin(network), network } })),
  webServer: NETWORKS.map((network) => ({
    command: `wrangler dev -c e2e/.cache/${network}/output/server/wrangler.json --ip 127.0.0.1 --port ${new URL(origin(network)).port}`,
    url: `${origin(network)}/`,
    reuseExistingServer: false,
  })),
})
