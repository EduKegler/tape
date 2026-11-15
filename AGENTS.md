# Tape

Live order books from four venues on one screen, with orders signed in the browser and sent straight to the venue. This file holds what every session needs and points at the rest. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the commands and the rules for commits, PRs, comments and docs, and they apply to agents as they do to people.

## Keep it small

Find the real constraint, then make the smallest change that makes the right behavior obvious. Remove complexity that no longer earns its place, and add no machinery because it looks thorough. Measure before you optimize, and say what you measured.

## Three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, or `kill` a PID you found by matching a name or path. Your own process and other worktrees' servers match too. Kill only a PID you captured when you started it. Port 3000 is the developer's `pnpm dev`, so start your own servers on other ports.
2. **Trading for real.** A mainnet build with `VITE_TRADE_MAINNET` signs real orders with real money. Trade on a testnet build. A funded testnet key lives only in the environment or in the git-ignored `.env`, and never reaches a log, a fixture or a commit.
3. **Re-recording to get green.** `pnpm fixtures` overwrites the recordings that the parser tests and `pnpm e2e` read. Re-record when a venue changed what it sends, and read the diff. A failing test is never the reason.

## Hit every surface

A change that works on the path you tried is often missing from the others. Before you call UI work done, walk this list and say which entries applied:

- **Venues.** Binance only reads. Hyperliquid, dYdX and Orderly trade, each through its own module in `packages/trade`. A trading feature needs a decision for each venue, even when the decision is that its capabilities turn it off.
- **Networks.** A testnet build trades and reads the testnets. A mainnet build reads, and trades only on the venues `VITE_TRADE_MAINNET` names. Each venue tab must say the right thing on both.
- **Entry points.** A price reaches the ticket from the book and from the trade feed, by pointer and by keyboard. A market opens from the header, the search, which `/` focuses, and the URL. A position closes from its own row and from Close all.
- **States.** Loading, live, old, reconnecting, a failed read and empty. Say what could not be read, as [the rules](docs/internals/rules.md) require.
- **Reverse states.** A way in needs a way out: connect and disconnect, arm and remove a TP/SL, open and cancel an order.
- **Tabs and browsers.** Every tab shares one hub, so a change to what a tab subscribes to shows in the others. Chromium runs on each PR, Firefox and WebKit run nightly.
- **Docs.** Check whether the change makes a doc wrong, and follow [the docs rules](CONTRIBUTING.md#docs) before you add text.

## Where code lives

- `packages/core`: ids, fixed point, market rules, book sync. `packages/venues`: one market data adapter per venue, with recorded fixtures. `packages/trade`: one trading module per venue. Packages import no React and nothing from the app.
- `src/hub` is the worker that owns the sockets, `src/core` its protocol with the tabs, `src/client` the tab side.
- `src/ui` holds the screens, with the controls in `src/ui/primitives`. `src/trade` and `src/wallet` connect them to `packages/trade` and the wallet.
- `e2e` holds the Playwright journeys and the recorded replay they run on.

## Verify, commit and open a PR

- `pnpm verify` runs every check and the tests, and `pnpm verify --docs` is enough for a change of only `.md` files. Run `pnpm e2e` when a change reaches what the screen shows. The pre-push hook runs the verify that fits.
- Write tests by [the testing rules](docs/internals/testing.md). A logic bug fix carries a test that fails on `main`, which `pnpm prove` shows, a purely visual fix carries screenshots before and after and no test.
- Conventional Commits, one logical change per commit, no AI attribution. Never skip a hook or push with `--no-verify`. A PR carries one ticket and branches from `main`. See [Commits](CONTRIBUTING.md#commits) and [Pull requests](CONTRIBUTING.md#pull-requests).
- A comment stays only for a constraint from outside the repo, and names that party. See [Comments](CONTRIBUTING.md#comments).

## Read on demand

Read a page when the task touches what it covers.

- [docs/internals/overview.md](docs/internals/overview.md): how the hub, the book, decimals, the venues, trading and history work, and the replay the journeys run on. Read it before changing one of them.
- [docs/internals/glossary.md](docs/internals/glossary.md): what hub, topic, stream, frame, old data, unknown outcome and the other shared words mean. Read it when a word in the code or the screen is unclear, or before naming something new.
- [docs/internals/testing.md](docs/internals/testing.md): which layer a test goes in, where its expected value comes from, and what a new venue must prove. Read it before writing or asking for a test.
- [docs/internals/rules.md](docs/internals/rules.md): each rule and what enforces it. Read it before adding a rule or a check.
- [docs/deploy.md](docs/deploy.md): build and Worker variables, and how a deploy runs. [DESIGN.md](DESIGN.md) and the `tape-design` skill: the visual system.

<!-- intent-skills:start -->
## Skill Loading

Use the repository’s installed Intent. If it is unavailable, report the missing dependency instead of downloading a replacement.
Before editing files for a substantial task:
- Run `pnpm exec intent list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm exec intent load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->
