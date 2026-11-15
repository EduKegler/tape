# Rules and what enforces them

The rules a change follows, and the check or review that catches a change that breaks one.

| Rule | Enforced by |
| --- | --- |
| Conventional Commits | commitlint in the lefthook `commit-msg` hook |
| No AI attribution in commits or PRs | the `commit-msg` hook, `attribution` in `.claude/settings.json` |
| A push and a PR's merge pass `pnpm verify`, or `pnpm verify --docs` if they change only `.md` files | `scripts/change-kind.ts`, in the `pre-push` hook and the `verify` job of `.github/workflows/verify.yml` |
| No research, competitor notes or decision logs in the repo | `scripts/check-public.mjs` in `pnpm verify` |
| Packages import no React, no `#/` and nothing undeclared | `scripts/check-packages.mjs` in `pnpm verify` |
| No runtime import cycles | `scripts/check-cycles.mjs` in `pnpm verify` |
| No unused files, exports or dependencies | knip in `pnpm verify` |
| Storage only through `src/trade/vault.ts`, key libraries only in `packages/trade`, `Math.random` only for jitter, wagmi's connection only through `useWalletConnection` | `no-restricted-*` rules in `eslint.config.js` |
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
| A test that needs a longer timeout to pass is wrong, so no spec raises a timeout, marks a test slow or waits a fixed time | `no-restricted-syntax` for `e2e/**/*.spec.ts` in `eslint.config.js` |
| UI journeys work on the production build | the `e2e` job in `.github/workflows/verify.yml`, green only when its three shards pass |
| UI journeys work in Firefox and WebKit | the `browsers` job in `.github/workflows/nightly.yml` |
| The venue parsers read what each venue sends today, on mainnet and testnet | `.github/workflows/nightly.yml` |
| The testnet build shows each venue's live book | the `smoke` job in `.github/workflows/nightly.yml` |
| One logical change per commit | review only |
| A PR carries one ticket, and tickets that touch the same files share one | review only |
| A test's expected value comes from outside the code under test | review only |
| Comments only for constraints from outside the repo | `tape/low-value-comments` in `eslint.config.js` for section dividers, commented-out code, PR numbers, JSDoc types, a comment that repeats the name below it and a comment over 4 lines, and review for the rest |

A rule enforced by review only that breaks again gets a check in the same change, unless no check can tell the mistake apart. Drop a row once its mistake can no longer be written.
