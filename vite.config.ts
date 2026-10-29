import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'
import { redact } from '@tanstack/redact/vite'

export default defineConfig(({ command }) => ({
  resolve: { tsconfigPaths: true, alias: { 'https-proxy-agent': new URL('./packages/trade/src/dydx/no-proxy-agent.ts', import.meta.url).pathname } },
  // eventemitter3 (under wagmi) is CommonJS behind an ESM wrapper, and the dev SSR runner can't inline it.
  // The build bundles it fine, and can't resolve it as an external, so only dev leaves it to Node.
  ssr: { noExternal: true, external: command === 'serve' ? ['eventemitter3'] : [] },
  plugins: [devtools(), nitro(), tailwindcss(), tanstackStart(), viteReact(), redact()],
}))
