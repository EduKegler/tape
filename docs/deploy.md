# Deploy

Mainnet is the Worker `tape` and testnet is `tape-testnet`. A push to `main` that passes `verify` and `e2e` runs the `deploy` job in `.github/workflows/verify.yml`, which builds each network and runs `wrangler deploy` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The build reads every `VITE_` variable of the GitHub environment named after the network. A changed variable reaches the site only through a deploy, so the `deploy` workflow also runs by hand for one network and builds `main` with that environment. Both keep the check that `main` still points at the built commit. The Worker reads `POSTHOG_KEY` and `POSTHOG_HOST` from its own variables in Cloudflare, which a deploy keeps. Cloudflare's version URLs are off, so a rollback leaves no older build reachable.

## Build variables

The build reads these from the environment or a `.env` file. `src/env.ts`, `src/trade/env.ts` and `vite.config.ts` parse them, and a value they refuse fails the build.

| Variable | Default | What it does |
| --- | --- | --- |
| `VITE_NETWORK` | `mainnet` | `mainnet` or `testnet`. Picks the venues' hosts for market data and trading |
| `VITE_TRADE_MAINNET` | empty | Comma list of venue ids that send orders on a mainnet build, such as `hyperliquid`. Empty means the build only reads |
| `VITE_WALLETCONNECT_PROJECT_ID` | none | A [Reown](https://cloud.reown.com) project id. Adds the WalletConnect button |
| `VITE_ORDERLY_BROKER_ID` | none | Orderly broker for mainnet. Orderly trading and deposits on mainnet need it |
| `VITE_ORDERLY_BROKER_ID_TESTNET` | `demo` | Orderly broker for testnet |
| `VITE_HL_BUILDER_ADDRESS` | none | Hyperliquid builder address. Adds a builder fee to each Hyperliquid order |
| `VITE_HL_BUILDER_FEE_TENTHS_BP` | `10` | That fee in tenths of a basis point, 1 to 100 |
| `VITE_DYDX_BUILDER_ADDRESS` | none | dYdX builder address, a `dydx1` address. Adds a builder fee to each dYdX order |
| `VITE_DYDX_BUILDER_FEE_PPM` | `100` | That fee in parts per million, 1 to 10,000 |
| `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` | none | With both, the build uploads source maps to PostHog error tracking and deletes them. Without them the build has no source maps |
| `POSTHOG_HOST` | US cloud for source maps | PostHog host for the source map upload |

## Worker variables

The Worker reads these at runtime, from its variables in Cloudflare.

| Variable | Default | What it does |
| --- | --- | --- |
| `POSTHOG_KEY` | none | PostHog project key. Without it `/r1` drops every analytics event and error |
| `POSTHOG_HOST` | `https://eu.i.posthog.com` | PostHog host that `/r1` forwards to |
