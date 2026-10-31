@AGENTS.md

# Tape

Multi-venue trading frontend. TanStack Start on TanStack Redact.

## Workspace

pnpm workspace: the app at the root, `@tape/core`, `@tape/venues` and `@tape/trade` under `packages/`, consumed as TypeScript source through `workspace:*`. Packages import no React, no `#/` and nothing they don't declare. `pnpm verify` checks that first. See Layout in the README.

This repo is public. Research, competitor notes and decision logs go to the private tape-notes repo, never here.

## Commits

Conventional Commits, checked by commitlint in the lefthook `commit-msg` hook. Never skip the hook.

One logical change per commit: one piece of work that a reviewer keeps or reverts as a whole, with a subject that names it with no "and" or list. Size a commit by the work, not by the edit: a feature with its tests, a fix with its test, a batch of new tests for one package. Bundled: `fix: no TP/SL on market orders, unknown outcomes on dYdX timeouts and close guards` is three commits, because a reviewer can revert each fix alone. Split: #36 has 36 commits, one per test, and is two, one `test(trade)` for the dYdX gaps the mutation run found and one `test(core)` for the core ones. The same edit at many sites is also one commit, so the 13 exports knip flags go in one `refactor: stop exporting symbols used only in their module`, not one commit per symbol.

Every commit passes `pnpm verify` on its own, which sets the order: the cleanup lands before the check that enforces it, and a fix shares a commit with its Vitest test, because a red test fails `pnpm verify`. `pnpm verify:commits` runs it on each commit since `origin/main`, in the pre-push hook and in CI, so each commit adds a full `pnpm verify` to the PR's CI run. A commit that changes only `.md` files runs `pnpm verify --docs` instead, which is the format check and `check-public.mjs`. A PR or push whose whole diff is `.md` files, or `.md` files and `*.test.ts` or `*.test.tsx` files outside `e2e/` and `__fixtures__/`, skips the e2e run and the deploy. `scripts/change-kind.mjs` decides both, and any other file, an empty diff or a range git cannot read counts as code. Never push with `--no-verify`.

## Pull requests

A PR carries a whole ticket or plan block, and tickets on the same area go in one PR. A PR goes out on its own only when it fixes a red `main` or a broken workflow. Branch each PR from `main`, never from another open PR. Each PR costs at least two CI runs with the e2e job, one per push to it and one for the merge to `main`. This overrides the pstack Opening a PR playbook, which prefers narrow PRs and treats each commit as a future PR.

## Comments

Our own code explains itself through names, types and tests. A comment stays only for a constraint from outside the repo that the code cannot show: a venue quirk, a browser or library limit, a protocol rule. It names that outside party. Doc comments on `packages/*/src` exports state the public contract, and a lint suppression carries its reason after `--`.

A why about our own design is a rename, an extracted function or a type instead. `/** Bids floor to the step and asks ceil to it, so grouping never collapses the spread. */` was deleted for that. `/** Not found comes back as success: false, sometimes with a 200, so reads treat it as rejected. */` stays, because Orderly decides it. Naming the outside party is not enough on its own: the four comments #5 added and #7 deleted named TanStack Router, Vite, Safari and Firefox, but `src/router.tsx` already states the Router fact where it applies, and `V8_STACK`, `JSC_STACK` and `GECKO_STACK` already say which engine wrote each stack. No lint can tell these apart, so read each comment you add against this rule before you commit.

## Design

Load the `tape-design` skill before changing how a screen looks or reads. Its tokens and primitives win over any other design skill.

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
- Trading stays off on mainnet unless the build turns it on.

## Rules and what enforces them

| Rule | Enforced by |
| --- | --- |
| Conventional Commits | commitlint in the lefthook `commit-msg` hook |
| No AI attribution in commits or PRs | the `commit-msg` hook, `attribution` in `.claude/settings.json` |
| Every commit passes `pnpm verify` on its own, or `pnpm verify --docs` if it changes only `.md` files | `scripts/verify-commits.mjs` with `scripts/change-kind.mjs`, in the `pre-push` hook and `.github/workflows/verify.yml` |
| No research, competitor notes or decision logs in the repo | `scripts/check-public.mjs` in `pnpm verify` |
| Packages import no React, no `#/` and nothing undeclared | `scripts/check-packages.mjs` in `pnpm verify` |
| No runtime import cycles | `scripts/check-cycles.mjs` in `pnpm verify` |
| No unused files, exports or dependencies | knip in `pnpm verify` |
| Storage only through `src/trade/vault.ts`, key libraries only in `packages/trade`, `Math.random` only for jitter | `no-restricted-*` rules in `eslint.config.js` |
| Color, type, weight, spacing, radius, z-index, duration and animation come from the tokens in `src/styles.css`, motion plays only under `motion-safe:`, and buttons, tables, dialogs and Base UI only from `src/ui/primitives` | `better-tailwindcss/no-unknown-classes` and `no-restricted-classes`, and the `no-restricted-*` rules in `eslint.config.js` |
| Every text and control color pair the primitives and the panel state use meets WCAG 2.2 contrast | `scripts/check-contrast.mjs` in `pnpm verify` |
| Every lint suppression gives its reason after `--` | `eslint-comments/require-description` |
| Imports grouped by origin | `import/order`, fixed by `eslint --fix` |
| No one-letter names | `id-length` in `eslint.config.js` |
| No casts that narrow a type outside the constructor that owns it | `@typescript-eslint/no-unsafe-type-assertion` in `eslint.config.js`, off in tests |
| Every trading venue reports mainnet unavailable unless the build turns mainnet trading on | `packages/trade/src/index.test.ts` |
| UI journeys work on the production build | the `e2e` job in `.github/workflows/verify.yml` |
| UI journeys work in Firefox and WebKit | the `browsers` job in `.github/workflows/nightly.yml` |
| The venue parsers read what each venue sends today, on mainnet and testnet | `.github/workflows/nightly.yml` |
| The testnet build shows each venue's live book | the `smoke` job in `.github/workflows/nightly.yml` |
| One logical change per commit | review only |
| A PR carries a whole ticket or plan block | review only |
| A test's expected value comes from outside the code under test | review only |
| Comments only for constraints from outside the repo | review only |
| StrykerJS runs only in its own worktree, with `.claude/worktrees/**` in `ignorePatterns`, and the mode of `.claude/skills/verify-tape/scripts/verify-tape.mjs` is restored after each `inPlace` run | review only |

When the operator corrects a mistake, fix it and add its row. A rule enforced by review only that breaks again gets a check in the same change, unless no check can tell the mistake apart. Drop a row once its mistake can no longer be written.

## TanStack docs and add-ons

Look up TanStack APIs with the CLI instead of guessing. It is a dev dependency (`@tanstack/cli`), so run it with `pnpm exec tanstack`. Use `--json` when parsing the output.

```bash
pnpm exec tanstack libraries --json
pnpm exec tanstack doc redact compatibility --json
pnpm exec tanstack search-docs "throttle" --library pacer --framework react --json
pnpm exec tanstack create --list-add-ons --framework React --json
pnpm exec tanstack create --addon-details tanstack-query --framework React --json
```

The CLI has no MCP server anymore. Do not configure `@tanstack/cli mcp`.

Skills shipped inside the installed packages come from Intent: `pnpm exec intent list`, then `pnpm exec intent load <package>#<skill>`.
