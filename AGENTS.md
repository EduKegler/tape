# Tape

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you change anything. Its rules apply to agents as they do to people.

## Keep it small

Find the real constraint, then make the smallest change that makes the right behavior obvious. Remove complexity that no longer earns its place, and add no machinery because it looks thorough. Measure before you optimize, and say what you measured.

## Three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, or `kill` a PID you found by matching a name or path. Your own process and other worktrees' servers match too. Kill only a PID you captured when you started it. Port 3000 is the developer's `pnpm dev`, so start your own servers on other ports.
2. **Trading for real.** A mainnet build with `VITE_TRADE_MAINNET` signs real orders with real money. Trade on a testnet build. A funded testnet key stays outside every git work tree and never reaches a log, a fixture or a commit.
3. **Re-recording to get green.** `pnpm fixtures` overwrites the recordings that the parser tests and `pnpm e2e` read. Re-record when a venue changed what it sends, and read the diff. A failing test is never the reason.

## Hit every surface

A change that works on the path you tried is often missing from the others. Before you call UI work done, walk this list and say which entries applied:

- **Venues.** Binance only reads. Hyperliquid, dYdX and Orderly trade, each through its own module in `packages/trade`. A trading feature needs a decision for each venue, even when the decision is that its capabilities turn it off.
- **Networks.** A testnet build trades and reads the testnets. A mainnet build reads, and trades only on the venues `VITE_TRADE_MAINNET` names. Each venue tab must say the right thing on both.
- **Entry points.** A price reaches the ticket from the book and from the trade feed, by pointer and by keyboard. A market opens from the header, the search, which `/` focuses, and the URL. A position closes from its own row and from Close all.
- **States.** Loading, live, old, reconnecting, a failed read and empty. Say what could not be read, as CONTRIBUTING requires.
- **Reverse states.** A way in needs a way out: connect and disconnect, arm and remove a TP/SL, open and cancel an order.
- **Tabs and browsers.** Every tab shares one hub, so a change to what a tab subscribes to shows in the others. Chromium runs on each PR, Firefox and WebKit run nightly.
- **Docs.** Check whether the change makes a doc wrong, and follow the documentation rules in CONTRIBUTING before you add text.

<!-- intent-skills:start -->
## Skill Loading

Use the repository’s installed Intent. If it is unavailable, report the missing dependency instead of downloading a replacement.
Before editing files for a substantial task:
- Run `pnpm exec intent list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm exec intent load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->
