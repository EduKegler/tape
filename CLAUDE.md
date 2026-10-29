@AGENTS.md

# Tape

Multi-venue trading frontend. TanStack Start on TanStack Redact.

## Workspace

pnpm workspace: the app at the root, `@tape/core`, `@tape/venues` and `@tape/trade` under `packages/`, consumed as TypeScript source through `workspace:*`. Packages import no React, no `#/` and nothing they don't declare. `pnpm verify` checks that first. See Layout in the README.

This repo is public. Research, competitor notes and decision logs never go here.

## TanStack docs and add-ons

Look up TanStack APIs with the CLI instead of guessing. Use `--json` when parsing the output.

```bash
pnpm dlx @tanstack/cli@latest libraries --json
pnpm dlx @tanstack/cli@latest doc redact compatibility --json
pnpm dlx @tanstack/cli@latest search-docs "throttle" --library pacer --framework react --json
pnpm dlx @tanstack/cli@latest create --list-add-ons --framework React --json
pnpm dlx @tanstack/cli@latest create --addon-details tanstack-query --framework React --json
```

The CLI has no MCP server anymore. Do not configure `@tanstack/cli mcp`.

Skills shipped inside the installed packages come from Intent: `pnpm exec intent list`, then `pnpm exec intent load <package>#<skill>`.
