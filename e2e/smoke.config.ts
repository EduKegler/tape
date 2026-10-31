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
    command: `wrangler dev -c .output/server/wrangler.json --ip 127.0.0.1 --port ${new URL(origin).port}`,
    cwd: '..',
    url: `${origin}/`,
    reuseExistingServer: false,
  },
})
