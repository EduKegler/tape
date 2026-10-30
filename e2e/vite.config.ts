import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vite'
import base from '../vite.config'

const cache = `e2e/.cache/${process.env.VITE_NETWORK ?? 'mainnet'}`

export default defineConfig((env) =>
  mergeConfig(base(env), {
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
