@AGENTS.md

# Tape

Multi-venue trading frontend. TanStack Start on TanStack Redact.

## Workspace

pnpm workspace: the app at the root, `@tape/core`, `@tape/venues` and `@tape/trade` under `packages/`, consumed as TypeScript source through `workspace:*`. Packages import no React, no `#/` and nothing they don't declare. `pnpm verify` checks that first. See Layout in the README.

This repo is public. Research, competitor notes and decision logs never go here.

## Commits

Conventional Commits, checked by commitlint in the lefthook `commit-msg` hook. Never skip the hook.

One logical change per commit: one reason to change, which a reviewer keeps or reverts as a whole, and a subject that names it with no "and" or list. Bundled: `fix: no TP/SL on market orders, unknown outcomes on dYdX timeouts and close guards` is three commits. Split: the same edit at many sites is one commit, so the 13 exports knip flags go in one `refactor: stop exporting symbols used only in their module`, not one commit per symbol. Every commit passes `pnpm verify` on its own, which sets the order: the cleanup lands before the check that enforces it.

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
