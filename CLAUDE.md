@AGENTS.md

# Tape for Claude

- Research, competitor notes and decision logs go to the private tape-notes repo, never here.
- Load the `tape-design` skill before changing how a screen looks or reads. Its tokens and primitives win over any other design skill.
- When the operator corrects a mistake, fix it and add its row to [docs/internals/rules.md](docs/internals/rules.md).
- Look up TanStack APIs with the CLI instead of guessing: `pnpm exec tanstack search-docs "throttle" --library pacer --framework react --json`, or `pnpm exec tanstack doc <library> <path> --json`. It has no MCP server, so do not configure `@tanstack/cli mcp`.
