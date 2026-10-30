import { defineConfig, devices } from '@playwright/test'

const origin = 'http://127.0.0.1:4620'

export default defineConfig({
  testDir: '.',
  testMatch: 'live.smoke.ts',
  outputDir: 'results/smoke',
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 30_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: origin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node .output/server/index.mjs',
    cwd: '..',
    url: `${origin}/`,
    env: {
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      PORT: new URL(origin).port,
      NITRO_PORT: new URL(origin).port,
      POSTHOG_KEY: '',
    },
    reuseExistingServer: false,
  },
})
