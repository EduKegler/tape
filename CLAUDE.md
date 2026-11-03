@AGENTS.md
@CONTRIBUTING.md

# Tape for agents

CONTRIBUTING.md holds the rules. These notes add what only an agent session needs.

## Private notes

Research, competitor notes and decision logs go to the private tape-notes repo, never here.

## Design

Load the `tape-design` skill before changing how a screen looks or reads. The skill's tokens and primitives win over any other design skill.

## Rules

When the operator corrects a mistake, fix it and add its row to Rules and what enforces them in CONTRIBUTING.md.

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
