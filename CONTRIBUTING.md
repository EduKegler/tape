# Contributing to Tape

Bug reports, fixes and new venues are welcome. Before a large change, such as a new venue or a new panel, open an issue so we agree on the scope first. To report a vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Set up

You need Node 24 and pnpm 10. `corepack enable` gives you the pnpm version that `package.json` pins.

```bash
pnpm install
pnpm dev
```

`pnpm install` also installs the lefthook hooks. `pnpm dev` serves a mainnet build on port 3000, which only reads. For a build that trades on the testnets:

```bash
VITE_NETWORK=testnet pnpm dev
```

The other build variables are in [docs/deploy.md](docs/deploy.md). [docs/architecture.md](docs/architecture.md) explains how the hub, the book and the trading modules work.

## Commands

```bash
pnpm verify   # package boundaries, typecheck of each package and the app, no notes in the public repo, import cycles, lint, format, unused code, tests
pnpm verify --docs # only the format check and check-public, what a markdown-only change runs
pnpm verify:commits # pnpm verify on each commit since origin/main, as the pre-push hook and CI run it, or pnpm verify --docs on a markdown-only commit
pnpm e2e # Playwright journeys on the testnet and mainnet production builds over the recorded replay, with all outside network blocked
pnpm build
pnpm preview # serves the last build with wrangler dev, in workerd, the runtime Cloudflare runs
pnpm fixtures # re-record venue fixtures
pnpm fixtures:history # re-record trade history fixtures
RECORD_WRITES=dydx pnpm fixtures:writes # re-record one venue's testnet write replies, Hyperliquid also takes RECORD_WRITES_HL_KEY_FILE
node scripts/capture.mjs # screenshot and social preview from a running preview server
```

Every night `.github/workflows/nightly.yml` records each venue on mainnet and testnet and replays it through the parsers, opens the testnet build against the live venues, and runs `pnpm e2e` in Firefox and WebKit.

## Layout

A pnpm workspace. The app sits at the root and imports three packages through `workspace:*`. The packages ship TypeScript source with no build step, so Vite and Vitest read them like app code and HMR reaches them.

```
packages/core     @tape/core: ids, fixed point, market rules, book sync
packages/venues   @tape/venues: one market data adapter per venue, plus recorded fixtures
packages/trade    @tape/trade: one trading module per venue behind TradingVenue
src/core          the hub protocol: topics, frames, projections
src/hub           the worker: sockets, connection state machine, projections
src/client        the tab side: hub connection, store registry, hooks
src/trade         React hooks, key storage and env config for @tape/trade
src/ui            screen components
src/wallet        wagmi config and the wallet button
```

Packages never import React or the app. `scripts/check-packages.mjs` runs first in `pnpm verify` and fails on an import a package does not declare, an import of `#/`, or a cycle between packages. A package reads no env: the app passes `TradeConfig` in the venue context.

To add a package, create `packages/<name>` with a `package.json` named `@tape/<name>` (`private: true`, `exports` pointing at `src`), a `tsconfig.json` that extends `../../tsconfig.base.json`, and add its `tsc -p` to the `typecheck` script.

The repo is public and holds code and the docs that `scripts/check-public.mjs` allows. Research, competitor notes and decision logs stay out.

Some files are read by tools more than by people. `DESIGN.md` and `PRODUCT.md` feed the Impeccable design tool, `.impeccable/` holds its notes on each screen, and `CLAUDE.md`, `AGENTS.md` and `.claude/skills/` give coding agents these same rules.

## Commits

Conventional Commits, checked by commitlint in the lefthook `commit-msg` hook. Never skip the hook.

One logical change per commit: one piece of work that a reviewer keeps or reverts as a whole, with a subject that names it with no "and" or list. Size a commit by the work, not by the edit: a feature with its tests, a fix with its test, a batch of new tests for one package. Bundled: `fix: no TP/SL on market orders, unknown outcomes on dYdX timeouts and close guards` is three commits, because a reviewer can revert each fix alone. Split: #36 has 36 commits, one per test, and is two, one `test(trade)` for the dYdX gaps the mutation run found and one `test(core)` for the core ones. The same edit at many sites is also one commit, so the 13 exports knip flags go in one `refactor: stop exporting symbols used only in their module`, not one commit per symbol.

Every commit passes `pnpm verify` on its own, which sets the order: the cleanup lands before the check that enforces it, and a fix shares a commit with its Vitest test, because a red test fails `pnpm verify`. `pnpm verify:commits` runs it on each commit since `origin/main` in the pre-push hook, and the PR's CI runs it on each commit and the merge in a job of its own, up to 8 at a time, skipping trees an earlier run of the PR verified. A commit that changes only `.md` files runs `pnpm verify --docs` instead, which is the format check and `check-public.mjs`. A PR or push whose whole diff is `.md` files, or `.md` files and `*.test.ts` or `*.test.tsx` files outside `e2e/` and `__fixtures__/`, skips the e2e run and the deploy. `scripts/change-kind.ts` decides both, and any other file, an empty diff or a range git cannot read counts as code. Never push with `--no-verify`.

## Pull requests

A PR carries one ticket. Tickets go in one PR only when they touch the same files. Branch each PR from `main`, never from another open PR. Each PR costs two CI runs of about 4 minutes, one per push to it and one for the merge to `main`, and a small PR is easier to review and to revert.

The PR template asks what changed, why, and how you checked it. A change on screen carries a screenshot.

## Coding agents

You can write code with an agent. You answer for every line you submit: read it, run it, and write the PR description yourself. A test whose expected value an agent copied from the code under test proves nothing, as Tests explains.

## Comments

Our own code explains itself through names, types and tests. A comment stays only for a constraint from outside the repo that the code cannot show: a venue quirk, a browser or library limit, a protocol rule. It names that outside party. Doc comments on `packages/*/src` exports state the public contract, and a lint suppression carries its reason after `--`.

A why about our own design is a rename, an extracted function or a type instead. `/** Bids floor to the step and asks ceil to it, so grouping never collapses the spread. */` was deleted for that. `/** Not found comes back as success: false, sometimes with a 200, so reads treat it as rejected. */` stays, because Orderly decides it. Naming the outside party is not enough on its own: the four comments #5 added and #7 deleted named TanStack Router, Vite, Safari and Firefox, but `src/router.tsx` already states the Router fact where it applies, and `V8_STACK`, `JSC_STACK` and `GECKO_STACK` already say which engine wrote each stack. No lint can tell these apart, so read each comment you add against this rule before you commit.

## Design

`DESIGN.md` describes the visual system: graphite cards on a darker ground, off-white only for what belongs to the trader, numbers in Inter with tabular figures, coral for failures and amber for old data, and the wash on a fill or a best-price lift as the one signature motion. The tokens live in `src/styles.css` and the controls in `src/ui/primitives/`. A screen uses those, and lint fails on a raw value.

## Tests

A test goes in the one layer that can catch its kind of mistake. A test that repeats another layer's proof stays out.

| What it proves | Layer | Expected value comes from |
| --- | --- | --- |
| Decimal math, ticks and steps, order building, book sync | Vitest in Node, examples and fast-check properties | A hand calculation, the venue's docs, or a plain model written in the test |
| Venue parsers and adapters | Vitest in Node over `packages/venues/src/__fixtures__/` | Frames recorded from the venue |
| Signing | Vitest in Node | A published vector, such as RFC 8032 in `orderly/sign.test.ts`, or viem's `hashTypedData` |
| History and PnL | Vitest in Node | The venue's own numbers, such as Hyperliquid's `closedPnl` |
| UI wiring and journeys | Playwright in `e2e/`, run by `pnpm e2e` on the testnet and mainnet production builds, with no network. `e2e/replay/worker.ts` wraps the real hub worker and feeds it the recorded frames through its `WebSocket` and `fetch`, and starts its clock at the recording's time, because Playwright's `routeWebSocket` and `page.clock` do not reach a SharedWorker. Chromium runs on each PR, Firefox and WebKit run nightly | What the user reads on screen |
| Each venue still serves the book the testnet build reads | Playwright in `e2e/live.smoke.ts`, run only by the nightly, against the live venues | A live book on screen |
| Components, visual regression, Storybook | None | Rules live in packages and get Node tests |
| The Node tests catch a broken rule in `packages/core` and `packages/trade` | StrykerJS with the Vitest runner, run by hand once per batch of new tests | Each surviving mutant is judged a missing test, which gets one, or an equivalent mutant |

The `verify-tape` skill explores and reproduces bugs against live data. Regressions belong to `pnpm e2e`. A spec finds elements by role and accessible name, and a `data-testid` goes in only where neither is reliable.

The expected value never comes from a run of the code under test. Another model writing the test does not fix that, because it reads the same code and guesses the same value.

A property's generators stay inside its valid domain, and invalid input gets its own refusal test. Use `fast-check` with `fc.assert` inside a Vitest `it`. The `it` and `test` from `@fast-check/vitest` rerun every example test `numRuns` times.

Before a venue ships, its tests prove these:

- The recorded replay yields a live, uncrossed book, a reconnect resyncs it, and a stale snapshot is ignored.
- A 5xx, a timeout or an unreadable reply on a write is an unknown outcome, and the order is then found by client id.
- A missing order is told apart from a missing key, and cancelling a filled order is not an error.
- A cancel the venue says it already holds, such as dYdX's `already exists` codes 9 and 32, is a done cancel, not a refused one.
- A 5xx, a timeout or an unreadable reply on a read means the venue is unreachable, never a missing order or account.
- Trading stays off on mainnet unless the build turns mainnet trading on for that venue.

## Rules and what enforces them

| Rule | Enforced by |
| --- | --- |
| Conventional Commits | commitlint in the lefthook `commit-msg` hook |
| No AI attribution in commits or PRs | the `commit-msg` hook, `attribution` in `.claude/settings.json` |
| Every commit passes `pnpm verify` on its own, or `pnpm verify --docs` if it changes only `.md` files | `scripts/verify-commits.mjs` with `scripts/change-kind.ts`, in the `pre-push` hook and `.github/workflows/verify.yml` |
| No research, competitor notes or decision logs in the repo | `scripts/check-public.mjs` in `pnpm verify` |
| Packages import no React, no `#/` and nothing undeclared | `scripts/check-packages.mjs` in `pnpm verify` |
| No runtime import cycles | `scripts/check-cycles.mjs` in `pnpm verify` |
| No unused files, exports or dependencies | knip in `pnpm verify` |
| Storage only through `src/trade/vault.ts`, key libraries only in `packages/trade`, `Math.random` only for jitter | `no-restricted-*` rules in `eslint.config.js` |
| Color, type, weight, radius, z-index, duration and animation come from the tokens in `src/styles.css`, padding, margin and gap from `SPACING_STEPS`, motion plays only under `motion-safe:`, except the `wash` utility and its reduced-motion still, and buttons, fields, links, tables, dialogs and Base UI only from `src/ui/primitives` | `better-tailwindcss/no-unknown-classes` and `no-restricted-classes`, and the `no-restricted-*` rules in `eslint.config.js` |
| A failed read says what it could not read, never what was sent | `src/ui/trade-errors.test.ts`, and the read failure tests in `e2e/history.mainnet.spec.ts` and `e2e/trading.testnet.spec.ts` |
| The `bid` and `ask` colors appear only in the files that show a side | `SIDE_FILES` and `no-restricted-classes` in `eslint.config.js` |
| Every text and control color pair the primitives and the panel state use meets WCAG 2.2 contrast | `scripts/check-contrast.mjs` in `pnpm verify` |
| Every lint suppression gives its reason after `--` | `eslint-comments/require-description`, and `oxlint-comments/directive` in `eslint.config.js` for Oxlint, which also takes only a one-line `oxlint-disable` that names its rule |
| Imports grouped by origin | `import/order`, fixed by `eslint --fix` |
| No one-letter names | `id-length` in `eslint.config.js` |
| No casts that narrow a type outside the constructor that owns it | `typescript/no-unsafe-type-assertion` in `.oxlintrc.json`, off in tests |
| A lint rule that needs types runs in Oxlint, or in `TYPED_RULES` when Oxlint lacks it, so ESLint builds the TypeScript program only for those | `eslint.config.js` turns `projectService` on only in `eslint.typed.config.js`, so a typed rule anywhere else fails `pnpm verify` |
| Every trading venue reports mainnet unavailable unless the build turns mainnet trading on for that venue | `packages/trade/src/index.test.ts` |
| UI journeys work on the production build | the `e2e` job in `.github/workflows/verify.yml`, green only when its three shards pass |
| UI journeys work in Firefox and WebKit | the `browsers` job in `.github/workflows/nightly.yml` |
| The venue parsers read what each venue sends today, on mainnet and testnet | `.github/workflows/nightly.yml` |
| The testnet build shows each venue's live book | the `smoke` job in `.github/workflows/nightly.yml` |
| One logical change per commit | review only |
| A PR carries one ticket, and tickets that touch the same files share one | review only |
| A test's expected value comes from outside the code under test | review only |
| Comments only for constraints from outside the repo | review only |
| StrykerJS runs only in its own worktree, with `.claude/worktrees/**` in `ignorePatterns`, and the mode of `.claude/skills/verify-tape/scripts/verify-tape.mjs` is restored after each `inPlace` run | review only |

A rule enforced by review only that breaks again gets a check in the same change, unless no check can tell the mistake apart. Drop a row once its mistake can no longer be written.
