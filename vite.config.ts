import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'
import { redact } from '@tanstack/redact/vite'
import posthog from '@posthog/rollup-plugin'
import { workerSecurityPolicy } from './src/csp'
import { env } from './src/env'

const personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY
const projectId = process.env.POSTHOG_PROJECT_ID

type Bundle = Parameters<Extract<NonNullable<Plugin['writeBundle']>, { handler: unknown }>['handler']>[1]

function sourceMaps(): Plugin {
  // The PostHog plugin's config hook turns maps on for every environment, and the server bundles need none.
  const {
    config: _,
    writeBundle,
    ...plugin
  } = posthog({
    personalApiKey: personalApiKey!,
    projectId,
    host: process.env.POSTHOG_HOST || undefined,
    sourcemaps: {
      releaseName: 'tape',
      releaseVersion: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
      releaseMode: 'symbol-set',
    },
  }) as unknown as Plugin
  const upload = writeBundle as Extract<Plugin['writeBundle'], { handler: unknown }>
  return {
    ...plugin,
    applyToEnvironment: (environment) => environment.name === 'client',
    writeBundle: {
      sequential: true,
      handler(options, bundle) {
        // Vite hands the hub worker to this bundle as an asset, which the PostHog plugin skips, so its map would stay and never upload.
        const workers: Bundle = {}
        for (const file of Object.values(bundle))
          if (file.type === 'asset' && file.fileName.endsWith('.js'))
            workers[file.fileName] = {
              type: 'chunk',
              fileName: file.fileName,
              code: typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source),
            } as Bundle[string]
        return upload.handler.call(this, options, { ...bundle, ...workers })
      },
    },
  }
}

export default defineConfig(({ command, mode }) => {
  const uploadMaps = command === 'build' && Boolean(personalApiKey && projectId)
  const { VITE_NETWORK } = env.parse(loadEnv(mode, process.cwd(), 'VITE_'))
  return {
    resolve: {
      tsconfigPaths: true,
      alias: {
        'https-proxy-agent': new URL('./packages/trade/src/dydx/no-proxy-agent.ts', import.meta.url).pathname,
        '@reown/appkit/core': new URL('./src/wallet/no-appkit.ts', import.meta.url).pathname,
      },
    },
    // eventemitter3 (under wagmi) is CommonJS behind an ESM wrapper, and the dev SSR runner can't inline it.
    // The build bundles it fine, and can't resolve it as an external, so only dev leaves it to Node.
    ssr: { noExternal: true, external: command === 'serve' ? ['eventemitter3'] : [] },
    ...(uploadMaps && {
      environments: { client: { build: { sourcemap: 'hidden' } } },
      worker: { plugins: () => [sourceMaps()] },
    }),
    plugins: [
      devtools(),
      nitro({
        preset: 'cloudflare-module',
        compatibilityDate: '2026-10-23',
        cloudflare: {
          wrangler: {
            name: VITE_NETWORK === 'mainnet' ? 'tape' : 'tape-testnet',
            // `wrangler deploy` deletes the variables set in the dashboard unless this keeps them.
            keep_vars: true,
          },
        },
        routeRules: {
          // Cloudflare applies every `_headers` rule that matches, so the hub worker keeps the immutable caching Nitro sets on `/assets/**`.
          '/assets/worker-*.js': { headers: { 'content-security-policy': workerSecurityPolicy(VITE_NETWORK) } },
        },
      }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
      redact(),
      uploadMaps && sourceMaps(),
    ],
  }
})
