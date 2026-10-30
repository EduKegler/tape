// Verification scaffolding. The repo's own Vite config with every build path moved under the
// skill's .cache/, so a verification build never overwrites the user's .output or Vite cache.
import { defineConfig, mergeConfig } from 'vite'
import replay from '../../../../e2e/vite.config'
import base from '../../../../vite.config'

const cache = '.claude/skills/verify-tape/.cache'

export default defineConfig((env) =>
  mergeConfig((process.env.VERIFY_TAPE_REPLAY ? replay : base)(env), {
    cacheDir: `${cache}/vite`,
    nitro: { buildDir: `${cache}/nitro`, output: { dir: `${cache}/output` } },
  }),
)
