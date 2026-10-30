import { execFileSync } from 'node:child_process'

for (const network of ['testnet', 'mainnet'])
  execFileSync('pnpm', ['exec', 'vite', 'build', '--config', 'e2e/vite.config.ts', '--logLevel', 'warn'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_NETWORK: network, POSTHOG_PERSONAL_API_KEY: '' },
  })
