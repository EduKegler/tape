---
name: verify-tape
description: Drive the real Tape web app (TanStack Start trading screen with order book, trades, depth, candles, venues table, order ticket and hub status bar) in headless Chrome and capture evidence. Use to prove a UI change works in the running app, to reproduce a UI bug, or when asked to run, screenshot or check Tape in a browser. Tests alone (pnpm verify) are not this.
---

# Verify Tape

Tape is one browser screen at `/$venue/$base`, fed live by public Binance, Hyperliquid, dYdX and Orderly websockets through a SharedWorker hub. Hyperliquid, dYdX and Orderly also trade. Each build is one network: `up` builds mainnet, which only reads, and `up --network testnet` builds testnet, where market data and trading both run on the testnets. This skill builds the app, serves the build on its own port, starts its own headless Chrome, and drives both with one helper script. Read `features/README.md` before driving, then the feature file that matches the change.

Everything below runs from the repo root. The helper is:

```bash
node .claude/skills/verify-tape/scripts/verify-tape.mjs <command> [flags]
```

The examples below call it `vt`. Shell functions do not carry over between Bash tool calls, so start each call with:

```bash
vt() { node .claude/skills/verify-tape/scripts/verify-tape.mjs "$@"; }
```

Run it with no command for the full flag list.

## Launch

```bash
node .claude/skills/verify-tape/scripts/verify-tape.mjs up
```

`up` does five things and fails loudly on each:

1. Refuses if port 4391 (app) or 9391 (Chrome CDP) is in use, or if a run from this harness is still up. It never attaches to a server it did not start. Port 3000 is the user's `pnpm dev` and is never touched.
2. Runs `vite build` with `scripts/vite.verify.config.ts`, which is the repo's `vite.config.ts` with all output moved to `.claude/skills/verify-tape/.cache/`. The user's `.output/` and Vite cache are not touched. The build takes about 2 s and includes uncommitted changes in `src/`.
3. Starts the built Nitro server (`.cache/output/server/index.mjs`) on `127.0.0.1:4391`, and headless Chrome with a throwaway profile in `.state/chrome`.
4. Waits until `GET /hyperliquid/BTC?interval=1m` returns 200 with the title `BTC on Hyperliquid`, and the CDP port answers.
5. Starts the test wallet on `127.0.0.1:4392`. It attaches to Chrome over CDP, injects an EIP-1193 provider into every page, signs with a fresh throwaway key, and blocks mainnet order writes and Orderly registration with a 451. Every request it signs or blocks lands in `artifacts/<run-id>/wallet.jsonl`. The provider calls `/__tape-test-wallet` on the app's own origin and the wallet answers over CDP, so the app's Content Security Policy applies as it does in production.

`VERIFY_TAPE_WATCH=<address>` makes the test wallet watch-only: it connects as that address, so the app reads its real balances, and it refuses every signature and transaction. A refused `eth_sendTransaction` still lands in `wallet.jsonl` with the transaction the app asked for. Use it for journeys that need funds, such as deposits.

Ready prints the run id, both pids and the evidence folder. Server ready is not data ready. Live data arrives in the browser a few seconds later. Each feature file says what to wait for.

`up --network testnet` builds with `VITE_NETWORK=testnet`. Trading journeys need it. `up --reuse-build` skips the build and serves the last one when it was built for the same network. Only use it when `src/` has not changed since that build.

`up --replay` builds the hub worker of `pnpm e2e`, from `e2e/replay/`, which plays the frames recorded in `packages/venues/src/__fixtures__/` instead of opening the venues' sockets, and starts Chrome with no host but 127.0.0.1 resolvable. Book and trade rows end the same on every run. The page still fetches candles, 24h stats and market rules itself, and only `parity.mjs` serves those from the recordings, so `open` and `shot` on a replay run show `Could not load history.` and `Market rules unavailable.`

Override ports with `VERIFY_TAPE_PORT` and `VERIFY_TAPE_CDP_PORT`, and the browser with `CHROME` (default `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`). No Playwright browser download is needed. The script uses `playwright-core` from the repo's devDependencies.

Why not `pnpm dev`: the user runs it on port 3000, and this harness never drives an instance it did not start. A build also proves the production bundle. `pnpm dev` works too, if a journey needs hot reload.

## Doctor

```bash
node .claude/skills/verify-tape/scripts/verify-tape.mjs doctor
```

Read-only. Run it first, and again whenever something looks off. It checks:

- the run state file exists and both pids are alive
- the only listener on port 4391 is this run's server pid
- `/` redirects to `/hyperliquid/BTC?interval=1m` with a `Tape` title
- Chrome CDP answers, with its version and page count
- the commit the build came from against `HEAD`, and uncommitted files under `src/` then and now
- each venue's public REST endpoint answers from this machine

Exit 0 means drive it. Exit 1 means the instance is broken: run `down`, then `up`. Exit 2 means the instance is fine but a venue is unreachable, so journeys that need that venue will stall. Say which venue in the report and do not count it as a product failure.

## Network and fixtures

Verification needs the network, except on a replay run. `packages/venues/src/fixtures.ts` reads recorded frames with `node:fs` and only feeds the Vitest suites. Outside a replay run, the hub in the browser opens the real sockets:

- `wss://data-stream.binance.vision/ws` and `https://data-api.binance.vision/api/v3`
- `wss://api.hyperliquid.xyz/ws` and `https://api.hyperliquid.xyz/info`
- `wss://indexer.dydx.trade/v4/ws` and `https://indexer.dydx.trade/v4`
- `wss://ws-evm.orderly.org/ws/stream/…` and `https://api.orderly.org/v1`

A testnet build opens the testnets instead: `stream.testnet.binance.vision` and `testnet.binance.vision`, `api.hyperliquid-testnet.xyz`, `indexer.v4testnet.dydx.exchange` with `test-dydx-rpc.kingnodes.com` for orders, and `testnet-ws-evm.orderly.org` with `testnet-api.orderly.org`. `doctor` probes the hosts of the network the run was built for.

Testnet books are thin. The Orderly testnet sometimes sends a book with no asks for a few seconds, so wait for the state you need rather than reading the first frame.

A venue outage shows up like this: `doctor` exits 2 for that venue, the book panel stays at `Syncing…` (or `Reconnecting…` after it was live), the `Sockets` count in the status bar is below 4, the Venues row for that venue shows `—`, the ticket says `Market rules unavailable.`, and the chart says `Could not load history.`. Prove the feature on another venue and report the outage.

## Drive

Browser commands act on the current tab. The first command uses the tab Chrome opened. `open <path> --new` opens a second tab and makes it current. `pages` lists tabs with short ids, and `--page <id>` switches. Ids are CDP target ids, so they stay stable when another tab closes.

```bash
vt open "/hyperliquid/BTC?interval=1m"
vt wait --js "document.querySelector('section div[data-status]')?.dataset.status === 'live'"
vt select --panel "Order book" --role combobox --name Group --value 10
vt wait --url "group=10"
vt text --panel "Order ticket" --role status
vt click --nav Market --role link --name ETH --exact
vt fill --panel "Order ticket" --role textbox --name Size --value 0.001 --blur
vt aria --panel "Order book" --path order-book/after.aria.txt
vt shot --panel "Order book" --path order-book/after.png
```

Locators, in order of preference:

- `--panel "<h2 text>"` scopes to one panel. Panel titles: `Chart`, `Order book`, `Trades`, `Order ticket`, `Depth`, `Venues`, `Account`.
- `--nav Market` (BTC, ETH, SOL) and `--nav Venue` (Binance, Hyperliquid, dYdX, Orderly) scope to the header navs.
- `--role <role> --name <name>` with `--exact`, or `--regex` to treat the name as a regular expression. Names are substring, case-insensitive matches without `--exact`.
- `--text`, `--label`, then `--css` as the last resort. Each feature file names the CSS it needs and why.

`wait` takes `--js <expression>`, `--url <regex>`, or a locator with optional `--state hidden`. Default timeout is 30 s for `wait` and 15 s for the rest. Never use a fixed sleep to wait for data. Wait for the state you need.

`eval <expression>` reads page state. Use it to read values, never to change them. Changing state through `eval` is not a user path and does not count as proof.

## Parity

`scripts/parity.mjs` proves that a change leaves every computed style as it was, which a PR that swaps classes for tokens or markup for primitives must show. It needs a replay run.

```bash
node .claude/skills/verify-tape/scripts/verify-tape.mjs up --replay
node .claude/skills/verify-tape/scripts/parity.mjs capture --out /tmp/parity/before.json
node .claude/skills/verify-tape/scripts/verify-tape.mjs down
# switch to the change, then:
node .claude/skills/verify-tape/scripts/verify-tape.mjs up --replay
node .claude/skills/verify-tape/scripts/parity.mjs capture --out /tmp/parity/after.json
node .claude/skills/verify-tape/scripts/verify-tape.mjs down
node .claude/skills/verify-tape/scripts/parity.mjs diff /tmp/parity/before.json /tmp/parity/after.json
```

`capture` opens each view in a fresh browser context, in UTC and en-US, with the page clock at the recording time and REST served from the recordings, as `pnpm e2e` does. It waits until the replay has played the last frame of every socket and four reads 500 ms apart agree. Then it writes every rendered element and pseudo-element with all its computed longhands and its box. The views are the trading screen of each venue at 1440×900, Hyperliquid at 1280×800, the ticket in Market mode, and `/history`. Add a view to `VIEWS` when a change touches a state they do not show.

An element's key is its panel, the nearest ancestor with an ARIA role and an accessible name as Chrome computes them, and the tag path below that ancestor, as in `Order book › button "80,609 2.31856 119.89322" › span[2]`. The panel is the `h2` or `aria-label` of the enclosing `section`, or the banner, navigation, contentinfo or dialog landmark.

`diff` prints every element added or removed and every property and box that changed, and exits 1 on any change. An empty diff prints `diff: no change in <n> elements across <m> views`.

A capture does not see:

- hover, focus and active states, since nothing hovers or holds focus while it reads
- the text of an element with no accessible name, only its style and box
- views outside `VIEWS`, such as the Deposit dialog
- a different Chrome, which `diff` warns about, so compare captures from the same machine

## Evidence

Every command appends one line to `.claude/skills/verify-tape/artifacts/<run-id>/steps.jsonl`: the command, its flags and its result. Relative `--path` values for `aria` and `shot` land in the same folder. The build log is there too. The folder is gitignored by the skill's own `.gitignore` and survives `down`.

Proof standards:

- Drive the path a user takes: clicks, selects, typing, navigation. No internal setters, no `eval` writes, no test-only routes.
- Capture the state before and after the action, not only the final screen. An ARIA snapshot of the panel is the main proof. A screenshot backs it up.
- Check the second view the feature affects. Grouping changes the URL and the ticket's touch prices. A tab change moves the status bar of every tab.
- Live data moves between commands. Assert properties that hold across frames (every price is a multiple of 10, `Tabs 2`, a status text) rather than one exact number.
- Report the feature file and sub-feature ids you covered, the evidence folder, and every entry point you skipped with the reason.

## Cleanup

```bash
node .claude/skills/verify-tape/scripts/verify-tape.mjs down
```

`down` sends SIGTERM to the process groups of the three pids in `.state/run.json`, then SIGKILL if they are still alive after 5 s. It never kills by name. It removes `.state/` (run file, server log, Chrome profile) and keeps `artifacts/` and `.cache/`. It warns if port 4391 still has a listener afterwards, and leaves that process alone. Run `down` after every run, including failed ones, before you report.

To drop the build cache too: `rm -rf .claude/skills/verify-tape/.cache`. To drop old evidence: delete folders under `artifacts/` by hand.

## Helpers

- `scripts/verify-tape.mjs` is the harness. Commands: `up`, `doctor`, `down`, `open`, `click`, `fill`, `select`, `press`, `wait`, `text`, `attr`, `eval`, `aria`, `shot`, `pages`, `close`.
- `scripts/parity.mjs` captures and diffs computed styles on a replay run. Commands: `capture`, `diff`.
- `scripts/replay-routes.mjs` serves a replay page's REST calls from the recordings, for `parity.mjs`.
- `scripts/vite.verify.config.ts` is verification scaffolding. It only moves build output, and with `--replay` swaps in the E2E hub worker. It is never used by the product.

## Gotchas

- TanStack Router links carry `data-status="active"`. Select the book's status with `section div[data-status]`, never a bare `[data-status]`.
- The status bar text arrives a few seconds after load and changes as sockets open. Wait for the value you need, such as `Sockets 4`.
- Leaving a market for 10 s closes its streams. A tab on `Not Found` holds no wants, so `Sockets` can drop to 0 and recover when another tab subscribes.
- Every tab of this Chrome shares one SharedWorker hub. Open extra tabs only when the journey needs them, and `close` them after, or the `Tabs` count is off for the next journey.
- The wallet is the harness test wallet, never an extension. Branded Chrome ignores `--load-extension`. It has no funds, so trading proof is the venue's rejection naming the recovered address. See `features/trading.md`.
- Each `up` makes a new wallet key. Compare addresses within one run only. A watch-only run keeps the watched address.
- Another run, from another worktree, can hold ports 4391, 9391 and 4392. Set `VERIFY_TAPE_PORT`, `VERIFY_TAPE_CDP_PORT` and `VERIFY_TAPE_WALLET_PORT` to free ones, and export them for every later command.
- The build sends a Content Security Policy. A blocked script or host shows in the console as `violates the following Content Security Policy directive`, and the feature stalls without an error on screen. Read the console before blaming the venue.
- `steps.jsonl` records commands that failed too, with the error. Read it when a journey stops halfway.
