---
name: formal-live-status
description: "Model-check the status the hub puts on dYdX book frames: a frame posted as live must show a book that still follows the venue. Covers socket drops and reconnects, subscribe and unsubscribe, the resubscribe hold, the in-band snapshot, corrupt messages, the tab's wants with their linger, and the 100 ms flush throttle. Use when a change touches statusOf, project, flushNow, flush, touch, followsBook, stopBooks, feedBook, ingest, apply, run, stepVenue or reconcile in src/hub/hub.ts, stepConnection, reconcile or the holds in src/hub/connection.ts, deriveStreams in src/core/topics.ts, the snapshot-then-deltas branch of stepBook in packages/core/src/book.ts, or the dYdX book feed. Also use to ask whether the ladder can show a frozen book as live."
---

# Live status on dYdX book frames, model-checked

A TLA+ model of two dYdX markets on one hub socket, checked with TLC. It explores every order of tab wants, linger expiry, subscribe and unsubscribe frames reaching dYdX, snapshots, corrupt messages, resubscribe holds, socket drops, reconnects and flush timing, within small bounds. Tests replay one order. This checks all of them.

The Binance resync has its own model in `formal-book-resync`. This one is about what the tab is told, not about the levels.

## The properties

`LiveMeansFollowing`: a book frame the hub posts as `live` shows a book that still follows the venue. Its socket is the current one, and the stream is subscribed on it or a fresh snapshot is on its way. If broken, the ladder shows frozen or pre-outage prices under a live status, and a click on a level fills the ticket from them.

`LiveOnlyWhileSubscribed`: between JS tasks, a book is `live` only while its stream is subscribed on an open socket. If broken, a subscribe can find a live book from before and must reset it, or the first case above comes back.

## Findings, fixed

The model found three ways the code at `ae87c3f` broke the property. Each was replayed through the real `createHub` with fake sockets and the recorded dYdX and Hyperliquid frames, then fixed. `src/hub/hub.test.ts` keeps each replay as a test.

1. **Reconnect.** The socket dropped with two books live. On the new socket, `streams-reset` reset one book at a time, and the first reset's flush posted the second book from before the drop as `live`. The same happened when a tab wanted two streams again after their linger ran out. Fixed in `777261f`: losing or closing the socket stops every book (`hub.ts:343, 357`), so no book is `live` while its socket is down.
2. **Snapshot during a hold.** A second corrupt message inside a resubscribe hold dropped the stream from `subscribed`, then the snapshot of the earlier subscribe arrived and made the book `live` with no stream behind it, for up to 60 s. Fixed in `5ad75c2`: `apply` drops book messages unless `followsBook` (`hub.ts:217-220, 267, 271`).
3. **Back during a hold.** An unsubscribed book stayed `live`. When the tab wanted it again during the stream's hold, nothing subscribed or reset it, so the frozen book went out as `live`. Fixed in `777261f`: `unsubscribe` stops the book (`hub.ts:351`).

`stopBooks` and the close loop feed `{ kind: 'reset', reason: 'stopped' }`, which moves the book to `awaiting-snapshot` and asks for nothing (`book.ts:196-197`).

## Run it

```bash
.claude/skills/formal-live-status/run.sh             # the property must pass, then the drift list
.claude/skills/formal-live-status/run.sh self-test   # each known break and each reachability witness must fail
.claude/skills/formal-live-status/run.sh drift       # only the drift list
```

Run from the repo root. `check` takes about 15 s on 12 cores and explores about 3.2 million distinct states. `self-test` takes about 15 s.

Tool: TLC from `tla2tools.jar` v1.7.4, the same copy `formal-book-resync` uses. The script downloads it on first use to `~/.cache/tape-formal/tla2tools-1.7.4/tla2tools.jar` and checks its sha256. Set `TAPE_TLA_JAR` to use another copy of the same file. It needs `java` 11 or newer on `PATH`. Nothing goes in `package.json` and nothing lands in the repo. TLC runs on a copy of the spec in a temp dir.

`check` prints `PASS` or `FAIL`. Exit 0 means the property holds within the bounds.

## When to use it

Run `check` when your change touches a row of the coverage table below. Run `drift` first if you are not sure: it lists covered files that differ from the sync commit, committed or not. A file in that list does not mean the model is wrong. It means you must read the change against the table.

## Coverage

Line numbers are at the sync commit. The model's comments carry the same numbers.

| Model (`LiveStatus.tla`) | Code |
| --- | --- |
| `StatusOf` | `statusOf`, `src/hub/hub.ts:138-142` |
| `PostFrames`, `posted`, `dirty` | `flushNow`, `tab.sent`, the signature in `project`, `src/hub/hub.ts:192-207, 163-167` |
| `quiet`, `trailing`, the `flush` item of `Continue`, `TrailingFires`, `WaitPasses` | `throttle(flushNow, { wait: FLUSH_MS, leading: true, trailing: true })`, `src/hub/hub.ts:210`; Pacer 0.23.1 `Throttler.maybeExecute` |
| the `reset` item of `Continue`, `Resets` | `feedBook`, `touch`, `src/hub/hub.ts:229-239, 212-215`; `stepBook` reset, `book.ts:209` |
| `UnsubResets`, `StaleResets`, `CloseResets` | `stopBooks` in `run` cases `unsubscribe` and `streams-stale`, the `stopped` loop in case `close`, `src/hub/hub.ts:222-227, 351, 357, 343` |
| the `touch-all` item of `Continue` | `stepVenue` touching every market when the state changed, `src/hub/hub.ts:384` |
| `Reconcile`, `Tick`, `Want`, `linger` | `reconcile`, the 1 s `setInterval`, the `want` handler and `queueReconcile`, `src/hub/hub.ts:406-420, 447-448, 480-485, 422-429`; `deriveStreams`, `src/core/topics.ts:150-168`; `stepConnection` tick and `reconcile`, `src/hub/connection.ts:155-170, 82-112` |
| `SocketOpened` | `socket.onopen`, `stepVenue`, `src/hub/hub.ts:330, 368-385`; `stepConnection` case `opened`, `src/hub/connection.ts:116-130` |
| `ConnectFails`, `SocketLost`, `DropSocket` | `socket.onclose` and the `v.socket === socket` guards, `run` case `close`, `src/hub/hub.ts:330-345`; `closed` and the silence check, `src/hub/connection.ts:131-143, 84-94` |
| `ReceiveSnapshot` | `socket.onmessage`, `ingest`, `apply` case `book-snapshot` with its `followsBook` guard, `src/hub/hub.ts:331, 297-313, 262-295, 217-220`; `stepBook` `snapshot-then-deltas`, `packages/core/src/book.ts:214-216`; the `subscribed` message in `events`, `packages/venues/src/dydx.ts:68-73` |
| `ReceiveBad`, `VenueSendsBad` | the `VenueParseError` and `DecimalError` resets, `src/hub/hub.ts:305-306, 291-293`; `awaiting` asking to resubscribe, `book.ts:196-197`; `feedBook` stepping `resubscribe`, `hub.ts:237-238`; `stepConnection` case `resubscribe` and `deferRepeatResubscribes`, `src/hub/connection.ts:145-154, 59-71` |
| `held`, `HoldEnds` | `ConnState.holds`, the `held` filter, `src/hub/connection.ts:64, 95-97` |
| `ctrl`, `venueSub`, `chan`, `VenueReadsControl` | dYdX's socket: it reads frames in order and sends the book after each subscribe |

Each action is the first part of one JS task in the worker: a socket event, a timer, or a tab message with the reconcile it queues as a microtask. The throttle's leading edge runs `flushNow` inside the task that calls `flush`, so the rest of the task is a queue of sub-steps in `todo`, run by `Continue`, and nothing else runs until it is empty.

The ghost variables `hubSub`, `follows`, `postedFollows` and `dropped` are not in the code. They carry the truth the property compares against.

Sync commit: `2b49d57047141a5003f6647aebcf4121e4e1b602` (2026-10-29). The model describes the covered code at this commit.

## Bounds and assumptions

Bounds in `LiveStatus.cfg`: two markets, 3 faults in total (socket drops, silences and corrupt messages), 3 frames waiting at dYdX, 2 messages in flight to the hub. `SYMMETRY` treats the two markets as interchangeable. A pass covers these bounds, not every run.

Assumptions:

- A book follows the venue when it came from a snapshot on the current socket while the hub had the stream subscribed, and the hub has not unsubscribed it or lost the socket since. Deltas that parse change levels, not phase or status, so the model has none. The `followsBook` guard on deltas is not checked.
- dYdX reads frames in order and sends the book in its `subscribed` message after each subscribe. TCP keeps one socket's messages in order. Messages of a closed socket never reach `ingest`.
- Specs are loaded. Before that, `desiredFor` leaves the streams out.
- The tab is visible. A lingering stream can expire in any reconcile after the one in which the tab let it go, never in that one, because `lastWanted` is at most one tick old then.
- The order of a JS `Set` is any order. Backoff ends some time, and a hold ends some time.

## Not covered

- Binance and its REST resync, which `formal-book-resync` covers, and Hyperliquid's `snapshots` protocol. The fixes are in shared hub code, so they apply there too. Replay 1 used Hyperliquid.
- More than one venue. `reconcile` steps venues in order, and a flush during one venue's resets can post another venue's books. Not checked.
- More than one tab, hidden tabs, `visible` messages, ports and Web Locks.
- Trades, candles, depth and compare frames. The compare frame's status comes from the same `statusOf` and is not checked.
- Levels and uncrossing. `formal-book-resync` checks Binance levels. dYdX levels are not checked.
- Backoff and hold timing, jitter, keepalive and the 10 s and 60 s constants.
- Whether a book ever goes live again. That needs fairness, and the model has none.

## Read a result

Read every TLC result with the pstack `/statechart` skill, run from `LiveStatus.tla` and `LiveStatus.cfg` with the `Mutant` line set to the variant you are reading. On a failure it tells the violation as its shortest path in plain words. On a pass it draws how the books move between states. The state space is far over its chart budget, so expect only the bug paths in the chart.

On `FAIL`, decide whether the trace is a real bug or a modeling error. Walk the trace one action at a time against the coverage table. For each step, open the code and confirm it can happen in that order. Then replay it through the real hub: `src/hub/hub.test.ts` builds `createHub` with fake sockets, and the recorded frames in `packages/venues/src/__fixtures__` give real snapshots. A corrupt dYdX delta is a recorded `channel_data` line with a price that does not parse.

- If every step happens in the code, it is a bug. Report it as steps in the code's words, like the findings above. Do not weaken the property or the model to make it pass.
- If a step cannot happen, the model is wrong. Fix the model to match the code, cite the line, and rerun.

On `PASS`, still read the drift list. A pass on a model that no longer describes the code proves nothing.

## When you change covered code

1. Read your diff against the coverage table. For each changed condition, branch or effect, find the model line that carries the same file and line in its comment.
2. Change the model to do what the code now does, before you rerun. Keep one JS task as one action plus its `todo` sub-steps. Keep names from the code.
3. Run `check`. If it fails, read the trace as above. A fail on an intended change is still a bug unless the promise changed on purpose. Then change the property and say why in the commit.
4. Run `self-test`. Every line must say `ok`. A `MISS` means the model lost the ability to catch that break, or a witness path is no longer reachable. Fix the model, not the test. If you removed the code a mutant stands for, replace the mutant with one for the new code.
5. Update the line numbers in the model comments and in the coverage table.
6. Move the sync commit forward only after you have confirmed the model describes the code at the new commit. Write the full SHA and the date on the `Sync commit:` line. `run.sh drift` reads it from there.

For changes that skipped this skill, such as merges, use the pstack `/maintain-formal-verification-skill` skill.

## Known breaks the self-test checks

`Mutant` in the config switches the model to a known broken variant. `"none"` is the code as it is. Each one undoes one of the fixes above.

- `no-follows-guard`: `apply` without `if (!followsBook(m)) return` (`hub.ts:267`). Finding 2 comes back.
- `no-stop-on-unsubscribe`: `unsubscribe` without `stopBooks` (`hub.ts:351`). Finding 3 comes back.
- `no-stop-on-stale`: `streams-stale` without `stopBooks` (`hub.ts:357`). Finding 1 comes back after `onclose`.
- `no-stop-on-close`: `close` without the `stopped` loop (`hub.ts:343`). Finding 1 comes back after the tab lets every stream go and wants them back.

Removing the socket check in `statusOf` (`hub.ts:140`) leaves `LiveMeansFollowing` passing, because no book is `live` while its socket is down. That check still decides `stale`, which this model does not check, and the hub test "reconnects a dropped socket, resubscribes and resyncs the Binance book" kills it.

`LiveOnlyWhileSubscribed` is why the hub has no reset on subscribe. A `streams-reset` effect used to reset each book after its subscribe. With the stops, every book a subscribe finds is already awaiting a snapshot, so that reset changed nothing and was removed.

The witnesses `NeverLivePost`, `NeverLiveAgain` and `NeverHeldOut` must also fail. They show the bounds reach a live frame, a book that follows again after a reconnect, and a wanted stream held out of its subscription.

Proven at `ae87c3f`, before the fixes: as a scratch change, `statusOf` returned `live` whenever `visibleBook(m.sync)` held, so a resync over the previous book would still read live. Following this skill, `drift` listed `hub.ts`, the model got a `hasBook` variable for `visibleBook`, and `check` failed beyond the known findings: a BTC snapshot, a corrupt message that resets and resubscribes, then a flush that posts the old book as live. The same steps through the real hub posted `live` after the corrupt delta, where the code at that commit posts `syncing`. With the scratch change dropped, `check` was back to the three findings. Resynced at `777261f`: the findings' switches became the fixes, and each fix undone in the model brings its finding back.
