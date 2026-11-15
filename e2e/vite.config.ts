import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vite'
import type { Plugin } from 'vite'
import base from '../vite.config'

const cache = `e2e/.cache/${process.env.VITE_NETWORK ?? 'mainnet'}`
const router = fileURLToPath(new URL('../src/router.tsx', import.meta.url))
const page = fileURLToPath(new URL('./replay/page.ts', import.meta.url))
const retryDelay = fileURLToPath(new URL('../src/integrations/tanstack-query/retry-delay.ts', import.meta.url))

const replayRetryDelay: Plugin = {
  name: 'tape:replay-retry-delay',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!source.endsWith('/retry-delay')) return null
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    return resolved?.id === retryDelay ? fileURLToPath(new URL('./replay/retry-delay.ts', import.meta.url)) : resolved
  },
}

const replayPage: Plugin = {
  name: 'tape:replay-page',
  apply: 'serve',
  applyToEnvironment: (environment) => environment.name === 'client',
  transform: (code, id) => (id === router ? { code: `import ${JSON.stringify(page)}\n${code}`, map: null } : undefined),
}

export default defineConfig((env) =>
  mergeConfig(base(env), {
    plugins: [replayPage, replayRetryDelay],
    resolve: {
      alias: [
        {
          find: fileURLToPath(new URL('../src/hub/worker.ts', import.meta.url)),
          replacement: fileURLToPath(new URL('./replay/worker.ts', import.meta.url)),
        },
      ],
    },
    cacheDir: `${cache}/vite`,
    nitro: { buildDir: `${cache}/nitro`, output: { dir: `${cache}/output` } },
  }),
)
