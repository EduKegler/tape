import { execFileSync } from 'node:child_process'
import { BUILD_ENV } from './builds.ts'

const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITE_')))

for (const network of ['testnet', 'mainnet'])
  execFileSync('pnpm', ['exec', 'vite', 'build', '--config', 'e2e/vite.config.ts', '--logLevel', 'warn'], {
    stdio: 'inherit',
    env: { ...inherited, ...BUILD_ENV[network], VITE_NETWORK: network, POSTHOG_PERSONAL_API_KEY: '' },
  })
