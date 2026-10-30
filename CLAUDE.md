@AGENTS.md

# Tape

Multi-venue trading frontend. TanStack Start on TanStack Redact.

## Workspace

pnpm workspace: the app at the root, `@tape/core`, `@tape/venues` and `@tape/trade` under `packages/`, consumed as TypeScript source through `workspace:*`. Packages import no React, no `#/` and nothing they don't declare. `pnpm verify` checks that first. See Layout in the README.

This repo is public. Research, competitor notes and decision logs go to the private tape-notes repo, never here.

## Commits

Conventional Commits, checked by commitlint in the lefthook `commit-msg` hook. Never skip the hook.

One logical change per commit: one reason to change, which a reviewer keeps or reverts as a whole, and a subject that names it with no "and" or list. Bundled: `fix: no TP/SL on market orders, unknown outcomes on dYdX timeouts and close guards` is three commits. Split: the same edit at many sites is one commit, so the 13 exports knip flags go in one `refactor: stop exporting symbols used only in their module`, not one commit per symbol. Every commit passes `pnpm verify` on its own, which sets the order: the cleanup lands before the check that enforces it. `pnpm verify:commits` runs it on each commit since `origin/main`, in the pre-push hook and in CI. Never push with `--no-verify`.

## Comments

Our own code explains itself through names, types and tests. A comment stays only for a constraint from outside the repo that the code cannot show: a venue quirk, a browser or library limit, a protocol rule. It names that outside party. Doc comments on `packages/*/src` exports state the public contract, and a lint suppression carries its reason after `--`.

A why about our own design is a rename, an extracted function or a type instead. `/** Bids floor to the step and asks ceil to it, so grouping never collapses the spread. */` was deleted for that. `/** Not found comes back as success: false, sometimes with a 200, so reads treat it as rejected. */` stays, because Orderly decides it. Naming the outside party is not enough on its own: the four comments #5 added and #7 deleted named TanStack Router, Vite, Safari and Firefox, but `src/router.tsx` already states the Router fact where it applies, and `V8_STACK`, `JSC_STACK` and `GECKO_STACK` already say which engine wrote each stack. No lint can tell these apart, so read each comment you add against this rule before you commit.

## Rules and what enforces them

| Rule | Enforced by |
| --- | --- |
| Conventional Commits | commitlint in the lefthook `commit-msg` hook |
| No AI attribution in commits or PRs | the `commit-msg` hook, `attribution` in `.claude/settings.json` |
| Every commit passes `pnpm verify` on its own | `scripts/verify-commits.mjs`, in the `pre-push` hook and `.github/workflows/verify.yml` |
| No research, competitor notes or decision logs in the repo | `scripts/check-public.mjs` in `pnpm verify` |
| Packages import no React, no `#/` and nothing undeclared | `scripts/check-packages.mjs` in `pnpm verify` |
| No runtime import cycles | `scripts/check-cycles.mjs` in `pnpm verify` |
| No unused files, exports or dependencies | knip in `pnpm verify` |
| Storage only through `src/trade/vault.ts`, key libraries only in `packages/trade`, `Math.random` only for jitter | `no-restricted-*` rules in `eslint.config.js` |
| Every lint suppression gives its reason after `--` | `eslint-comments/require-description` |
| Imports grouped by origin | `import/order`, fixed by `eslint --fix` |
| One logical change per commit | review only |
| Comments only for constraints from outside the repo | review only |

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
