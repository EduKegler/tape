// Verification scaffolding. The repo's own Vite config with every build path moved under the
// skill's .cache/, so a verification build never overwrites the user's .output or Vite cache.
import { defineConfig, mergeConfig } from 'vite'
import base from '../../../../vite.config'

const cache = '.claude/skills/verify-tape/.cache'

export default defineConfig((env) =>
  mergeConfig(base(env), {
    cacheDir: `${cache}/vite`,
    nitro: { buildDir: `${cache}/nitro`, output: { dir: `${cache}/output` } },
  }),
)
