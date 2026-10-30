import { defineConfig, devices } from '@playwright/test'
import { NETWORKS } from '@tape/core/ids'
import type { Network } from '@tape/core/ids'

const origin = (network: Network) => `http://127.0.0.1:${4610 + NETWORKS.indexOf(network)}`

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/results',
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    launchOptions: { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: NETWORKS.map((network) => ({ name: network, use: { baseURL: origin(network), network } })),
  webServer: NETWORKS.map((network) => ({
    command: `node e2e/.cache/${network}/output/server/index.mjs`,
    url: `${origin(network)}/`,
    env: {
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      PORT: new URL(origin(network)).port,
      NITRO_PORT: new URL(origin(network)).port,
      POSTHOG_KEY: '',
    },
    reuseExistingServer: false,
  })),
})
