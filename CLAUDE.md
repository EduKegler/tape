@AGENTS.md

# Tape

Read-only multi-venue trading frontend. TanStack Start on TanStack Redact.

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
