# Hub and status bar

One hub owns the venue sockets for every tab of the origin. The status bar at the bottom shows the hub's own numbers: mode, tabs, open sockets, streams, messages in and frames out per second. Opening a second tab raises `Tabs` without raising `Sockets`. `?hub=dedicated` runs one hub per tab instead.

## Sub-features

- `hub-stats` shows `Hub shared`, `Tabs 1`, `Sockets 3` and live rates on one tab.
- `hub-share` shows `Tabs 2` and still `Sockets 3` in both tabs after a second tab opens.
- `hub-close` drops back to `Tabs 1` after a tab closes.
- `hub-dedicated` shows `Hub dedicated` and counts only its own tab with `?hub=dedicated`.

## How to get to it (user POV)

- Look at the footer of any market page.
- Open the same app in a second tab.
- Close a tab.
- Add `?hub=dedicated` to a market URL.

## Driving it with verify-tape

Preconditions:

- Baseline from `features/README.md`. Only one tab is open. Check with `vt pages`.

- **One tab.** Run `vt wait --js "/Sockets 3/.test(document.querySelector('footer')?.innerText ?? '')"` and `vt text --css footer`. It reads `Hub shared`, `Tabs 1`, `Sockets 3`.
- **Second tab.** Run `vt open "/hyperliquid/BTC" --new` and `vt wait --js "/Tabs 2/.test(document.querySelector('footer')?.innerText ?? '')"`. Then `vt text --css footer` reads `Tabs 2` and `Sockets 3`. Switch to the first tab with `vt pages` and `vt text --css footer --page <id>`. It reads `Tabs 2` too.
- **Close a tab.** Run `vt close --page <second id>`, then `vt wait --js "/Tabs 1/.test(document.querySelector('footer')?.innerText ?? '')" --page <first id>`. The count drops within a few seconds.
- **Dedicated.** Run `vt open "/binance/BTC?hub=dedicated" --new` and `vt wait --js "/Hub dedicated/.test(document.querySelector('footer')?.innerText ?? '')"`. Its footer reads `Hub dedicated` and `Tabs 1` while the shared tab still reads `Tabs 1`.
- **Proof.** Run `vt shot --css footer --path hub/footer-two-tabs.png` while two shared tabs are open, and save `vt text --css footer` output from each tab. The steps file keeps both.

## Gotchas

- `Sockets` counts open venue sockets across all three venues, because the `Venues` table subscribes to every venue. One market page already opens 3.
- Streams linger 10 s after the last tab lets go. `Streams` can read higher than expected right after a market change.
- After a tab sat on `Not Found` for 10 s, the hub closes idle sockets. `Sockets 0` then recovers when a market page subscribes again. Wait for the count, do not read it once.
- `--new` makes the new tab current. Pass `--page <id>` to act on the other one.
- `hub=dedicated` is read once at page load. Header links keep it in the URL. Removing it from the URL needs a reload to bring back the shared hub.
- Tab death through Web Locks is the slow path. `close` triggers `pagehide`, the fast path. Killing the renderer is not covered here.
