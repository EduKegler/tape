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

The other build variables are in [docs/deploy.md](docs/deploy.md). [docs/internals/overview.md](docs/internals/overview.md) explains how the hub, the book and the trading modules work.

## Commands

```bash
pnpm verify   # package boundaries, typecheck of each package and the app, no notes in the public repo, import cycles, lint, format, unused code, tests
pnpm verify --docs # only the format check and check-public, what a markdown-only change runs
pnpm prove <test files> # a fix's Vitest tests fail on the merge base with origin/main and pass on your tree, --base <ref> picks another base
pnpm e2e # Playwright journeys on the production builds over the recorded replay, with all outside network blocked
pnpm dev:replay # pnpm dev on the recorded replay that pnpm e2e plays, with no venue traffic and the books looping
pnpm build
pnpm preview # serves the last build with wrangler dev, in workerd, the runtime Cloudflare runs
pnpm fixtures # re-record venue fixtures from mainnet, NETWORK=testnet for the testnets
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

One logical change per commit: one piece of work that a reviewer keeps or reverts as a whole, with a subject that names it with no "and" or list. A feature goes with its tests and a fix with its test, so a revert takes both. Three fixes are three commits, because a reviewer can revert each one alone, and a batch of new tests for one package is one. The same edit at many sites is also one commit, such as one `refactor: stop exporting symbols used only in their module` for every export knip flags.

The pre-push hook runs `pnpm verify` on the working tree, and the PR's CI runs it on the merge with `main`. A change of only docs or tests runs less, such as `pnpm verify --docs` or no e2e run, and [`scripts/change-kind.ts`](scripts/change-kind.ts) decides which. Never push with `--no-verify`.

## Pull requests

A PR carries one ticket. Tickets go in one PR only when they touch the same files. Branch each PR from `main`, never from another open PR. Each PR costs two CI runs of about 4 minutes, one per push to it and one for the merge to `main`, and a small PR is easier to review and to revert.

The PR template asks what changed, why, and how you checked it. A change on screen carries a screenshot. A fix for a purely visual bug carries screenshots before and after, and no test.

## Coding agents

You can write code with an agent. You answer for every line you submit: read it, run it, and write the PR description yourself. A test whose expected value an agent copied from the code under test proves nothing, as [Testing](docs/internals/testing.md#expected-values) explains.

## Comments

Our own code explains itself through names, types and tests. A comment stays only for a constraint from outside the repo that the code cannot show: a venue quirk, a browser or library limit, a protocol rule. It names that outside party. Doc comments on `packages/*/src` exports state the public contract, and a lint suppression carries its reason after `--`.

A why about our own design is a rename, an extracted function or a type instead. `/** Bids floor to the step and asks ceil to it, so grouping never collapses the spread. */` goes for that reason. `/** Not found comes back as success: false, sometimes with a 200, so reads treat it as rejected. */` stays, because Orderly decides it. Naming an outside party is not enough when the code already states that fact where it applies, as `src/router.tsx` does for TanStack Router. Read each comment you add against this rule before you commit.

## Docs

Most changes need no doc change. The code, its types and its tests already say what it does.

- `docs/internals/` holds what no single file shows: a decision and the outside constraint behind it, a rule that spans packages, a trap that is hard to find in the source. Before you add a paragraph, ask what a maintainer would get wrong without it. If the code answers that, leave the paragraph out.
- `docs/deploy.md` and `docs/history-csv.md` serve whoever runs a build or reads an export.
- Do not list files, fields, variables or steps that the code lists already, narrate control flow, or append a PR summary. Link to the source instead of copying it. [The glossary](docs/internals/glossary.md) defines shared words, and is not a feature index.
- When a decision changes, rewrite or delete the text that described it. Do not add a second account next to the old one.
- A new page in `docs/internals/` needs a distinct, lasting reason to exist and its name in `scripts/check-public.mjs`.
- A reason only one spot needs goes in a comment there, under the rules in Comments.

## Design

`DESIGN.md` describes the visual system: graphite cards on a darker ground, off-white only for what belongs to the trader, numbers in Inter with tabular figures, coral for failures and amber for old data, and the wash on a fill or a best-price lift as the one signature motion. The tokens live in `src/styles.css` and the controls in `src/ui/primitives/`. A screen uses those, and lint fails on a raw value.

## Tests

A test goes in the one layer that can catch its kind of mistake, the lowest one that fails on `main`. Its expected value comes from outside the code under test: a hand calculation, the venue's docs or a recording. A logic bug fix carries a test that fails on `main`, and a purely visual fix carries screenshots instead. [docs/internals/testing.md](docs/internals/testing.md) has the layers, the rules and what a new venue must prove.

## Rules

[docs/internals/rules.md](docs/internals/rules.md) lists each rule and the check or review that enforces it.
