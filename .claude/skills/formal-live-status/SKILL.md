---
name: formal-live-status
description: "Model-check the status the hub puts on dYdX book frames: a frame posted as live must show a book that still follows the venue. Covers socket drops and reconnects, subscribe and unsubscribe, the resubscribe hold, the in-band snapshot, corrupt messages, the tab's wants with their linger, and the 100 ms flush throttle. Use when a change touches statusOf, project, flushNow, flush, touch, feedBook, ingest, apply, run, stepVenue or reconcile in src/hub/hub.ts, stepConnection, reconcile or the holds in src/hub/connection.ts, deriveStreams in src/core/topics.ts, the snapshot-then-deltas branch of stepBook in packages/core/src/book.ts, or the dYdX book feed. Also use to ask whether the ladder can show a frozen book as live."
---

# Live status on dYdX book frames, model-checked

A TLA+ model of two dYdX markets on one hub socket, checked with TLC. It explores every order of tab wants, linger expiry, subscribe and unsubscribe frames reaching dYdX, snapshots, corrupt messages, resubscribe holds, socket drops, reconnects and flush timing, within small bounds. Tests replay one order. This checks all of them.

The Binance resync has its own model in `formal-book-resync`. This one is about what the tab is told, not about the levels.

## The property

`LiveMeansFollowing`: a book frame the hub posts as `live` shows a book that still follows the venue. Its socket is the current one, and the stream is subscribed on it or a fresh snapshot is on its way. If broken, the ladder shows frozen or pre-outage prices under a live status, and a click on a level fills the ticket from them.

## Known findings

The code at the sync commit breaks the property three ways. Each was replayed through the real `createHub` with fake sockets and the recorded dYdX and Hyperliquid frames, as described under each one.

1. **Reconnect** (fix switch `reset-first`). The socket drops with two books live. When a new socket opens, `stepVenue` sets the state to `open` (`hub.ts:367`) and then runs `streams-reset` one book at a time (`hub.ts:337-342`). The first reset touches its market, and the throttle's leading edge runs `flushNow` right there (`hub.ts:207`). That flush sees the second book still in phase `live` on an open socket, so it posts the book from before the drop as `live`. The next flush, up to 100 ms later, says `syncing`. The same happens when a tab wants two streams again after their linger ran out. Replayed with Hyperliquid BTC and ETH: after the reopen, BTC went out as `live` at its pre-drop bid.
2. **Snapshot during a hold** (fix switch `ignore-unsubscribed`). A corrupt message resets the book and resubscribes, which sets a 2 s hold (`connection.ts:61-73`). A second corrupt message, still from the old subscription, arrives inside the hold, so the hub only unsubscribes and drops the stream from `subscribed` (`connection.ts:153-155`). Then the snapshot of the earlier subscribe arrives, and `ingest` applies it with no check on the subscription (`hub.ts:280-296`, `book.ts:211-215`). The book is `live` with no stream behind it until a tick after the hold. The hold doubles with each repeat, up to 60 s. Replayed with dYdX BTC: `live` for 4.6 s with `unsubscribe` as the last frame sent.
3. **Back during a hold** (fix switch `reset-on-unsubscribe`). A stream whose linger ran out is unsubscribed, and its book stays in phase `live` (`connection.ts:101-103`, nothing resets it). If the tab wants it again while the stream's hold is still on, `reconcile` leaves it out (`connection.ts:99`), so there is no subscribe and no reset. The next flush posts the frozen book as `live` until the hold ends. Replayed with dYdX BTC: `live` for 1.5 s with the stream unsubscribed.

The fix switches in the model are hypothetical fixes that set each finding aside, so the check can look for anything else. They are not product changes. One change in the code, a book that leaves `live` as soon as the hub stops following its stream, would likely cover 1 and 3. The model has not checked that change.

## Run it

```bash
.claude/skills/formal-live-status/run.sh             # each finding must reproduce, then the rest must pass, then the drift list
.claude/skills/formal-live-status/run.sh self-test   # each known break and each reachability witness must fail
.claude/skills/formal-live-status/run.sh drift       # only the drift list
```

Run from the repo root. `check` takes about 20 s on 12 cores. The pass with all three findings set aside explores about 3.7 million distinct states. `self-test` takes about 10 s.

Tool: TLC from `tla2tools.jar` v1.7.4, the same copy `formal-book-resync` uses. The script downloads it on first use to `~/.cache/tape-formal/tla2tools-1.7.4/tla2tools.jar` and checks its sha256. Set `TAPE_TLA_JAR` to use another copy of the same file. It needs `java` 11 or newer on `PATH`. Nothing goes in `package.json` and nothing lands in the repo. TLC runs on a copy of the spec in a temp dir.

`check` prints one line per known finding, then `PASS` or `FAIL`. Exit 0 means every finding still reproduces and nothing else breaks.

## When to use it

Run `check` when your change touches a row of the coverage table below. Run `drift` first if you are not sure: it lists covered files that differ from the sync commit, committed or not. A file in that list does not mean the model is wrong. It means you must read the change against the table.

## Coverage

Line numbers are at the sync commit. The model's comments carry the same numbers.

| Model (`LiveStatus.tla`) | Code |
| --- | --- |
| `StatusOf` | `statusOf`, `src/hub/hub.ts:135-139` |
| `PostFrames`, `posted`, `dirty` | `flushNow`, `tab.sent`, the signature in `project`, `src/hub/hub.ts:189-204, 160-164` |
| `quiet`, `trailing`, the `flush` item of `Continue`, `TrailingFires`, `WaitPasses` | `throttle(flushNow, { wait: FLUSH_MS, leading: true, trailing: true })`, `src/hub/hub.ts:207`; Pacer 0.23.1 `Throttler.maybeExecute` |
| the `reset` item of `Continue`, `ResetItems` | `streams-reset` in `run`, `feedBook`, `touch`, `src/hub/hub.ts:337-342, 214-224, 209-212`; `stepBook` reset, `book.ts:207` |
| the `touch-all` item of `Continue` | `stepVenue` touching every market when the state changed, `src/hub/hub.ts:370` |
| `Reconcile`, `Tick`, `Want`, `linger` | `reconcile`, the 1 s `setInterval`, the `want` handler and `queueReconcile`, `src/hub/hub.ts:392-406, 427-428, 459-463, 408-415`; `deriveStreams`, `src/core/topics.ts:150-168`; `stepConnection` tick and `reconcile`, `src/hub/connection.ts:158-173, 84-114` |
| `SocketOpened` | `socket.onopen`, `stepVenue`, `src/hub/hub.ts:313, 354-371`; `stepConnection` case `opened`, `src/hub/connection.ts:118-133` |
| `ConnectFails`, `SocketLost`, `DropSocket` | `socket.onclose` and the `v.socket === socket` guards, `run` case `close`, `src/hub/hub.ts:313-327`; `closed` and the silence check, `src/hub/connection.ts:134-146, 86-96` |
| `ReceiveSnapshot` | `socket.onmessage`, `ingest`, `apply` case `book-snapshot`, `src/hub/hub.ts:314, 280-296, 247-278`; `stepBook` `snapshot-then-deltas`, `packages/core/src/book.ts:211-215`; the `subscribed` message in `events`, `packages/venues/src/dydx.ts:68-73` |
| `ReceiveBad`, `VenueSendsBad` | the `VenueParseError` and `DecimalError` resets, `src/hub/hub.ts:288-289, 274-276`; `awaiting` asking to resubscribe, `book.ts:194-195`; `feedBook` stepping `resubscribe`, `hub.ts:222-223`; `stepConnection` case `resubscribe` and `deferRepeatResubscribes`, `src/hub/connection.ts:148-157, 61-73` |
| `held`, `HoldEnds` | `ConnState.holds`, the `held` filter, `src/hub/connection.ts:66, 97-99` |
| `ctrl`, `venueSub`, `chan`, `VenueReadsControl` | dYdX's socket: it reads frames in order and sends the book after each subscribe |

Each action is the first part of one JS task in the worker: a socket event, a timer, or a tab message with the reconcile it queues as a microtask. The throttle's leading edge runs `flushNow` inside the task that calls `flush`, so the rest of the task is a queue of sub-steps in `todo`, run by `Continue`, and nothing else runs until it is empty.

The ghost variables `hubSub`, `follows`, `postedFollows` and `dropped` are not in the code. They carry the truth the property compares against.

Sync commit: `ae87c3f45be62ead4c18b5dad9e6e0f4c8158928` (2026-10-29). The model describes the covered code at this commit.

## Bounds and assumptions

Bounds in `LiveStatus.cfg`: two markets, 3 faults in total (socket drops, silences and corrupt messages), 3 frames waiting at dYdX, 2 messages in flight to the hub. `SYMMETRY` treats the two markets as interchangeable. A pass covers these bounds, not every run.

Assumptions:

- A book follows the venue when it came from a snapshot on the current socket while the hub had the stream subscribed, and the hub has not unsubscribed it or lost the socket since. Deltas that parse change levels, not phase or status, so the model has none.
- dYdX reads frames in order and sends the book in its `subscribed` message after each subscribe. TCP keeps one socket's messages in order. Messages of a closed socket never reach `ingest`.
- Specs are loaded. Before that, `desiredFor` leaves the streams out.
- The tab is visible. A lingering stream can expire in any reconcile after the one in which the tab let it go, never in that one, because `lastWanted` is at most one tick old then.
- The order of a JS `Set` is any order. Backoff ends some time, and a hold ends some time.

## Not covered

- Binance and its REST resync, which `formal-book-resync` covers, and Hyperliquid's `snapshots` protocol. Finding 1 also hits them, since `statusOf` and the reset loop are shared. Replay 1 used Hyperliquid.
- More than one venue. `reconcile` steps venues in order, and a flush during one venue's resets can post another venue's books. Same root cause as finding 1, not checked.
- More than one tab, hidden tabs, `visible` messages, ports and Web Locks.
- Trades, candles, depth and compare frames. The compare frame's status comes from the same `statusOf` and is not checked.
- Levels and uncrossing. `formal-book-resync` checks Binance levels. dYdX levels are not checked.
- Backoff and hold timing, jitter, keepalive and the 10 s and 60 s constants.
- Whether a book ever goes live again. That needs fairness, and the model has none.

## Read a result

Read every TLC result with the pstack `/statechart` skill, run from `LiveStatus.tla` and `LiveStatus.cfg` with the `Fixes` line set to the variant you are reading. On a failure it tells the violation as its shortest path in plain words. On a pass it draws how the books move between states. The state space is far over its chart budget, so expect only the bug paths in the chart.

On `FAIL`, decide whether the trace is a real bug or a modeling error. Walk the trace one action at a time against the coverage table. For each step, open the code and confirm it can happen in that order. Then replay it through the real hub: `src/hub/hub.test.ts` builds `createHub` with fake sockets, and the recorded frames in `packages/venues/src/__fixtures__` give real snapshots. A corrupt dYdX delta is a recorded `channel_data` line with a price that does not parse.

- If every step happens in the code, it is a bug. Report it as steps in the code's words, like the known findings above. Do not weaken the property or the model to make it pass.
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

## When a finding goes away

`check` says `CHANGED` when a known finding no longer reproduces. If the code fixed it, model the fix in place of its switch: delete the switch from the actions, from `FINDINGS` and `ALL_FIXES` in `run.sh`, and from the list above, then rerun. If the code did not change there, the model drifted. Find the step that no longer happens and fix the model.

## Known breaks the self-test checks

Each runs with all three findings set aside. `Mutant` in the config switches the model to a known broken variant. `"none"` is the code as it is.

- `no-streams-reset`: subscribe with no `streams-reset` (`connection.ts:104, 155`). A reconnected book keeps its pre-drop levels as live.
- `status-ignores-conn`: `statusOf` without the socket check (`hub.ts:137`). A book from a dropped socket shows live.

The witnesses `NeverLivePost`, `NeverLiveAgain` and `NeverHeldOut` must also fail. They show the bounds reach a live frame, a book that follows again after a reconnect, and a wanted stream held out of its subscription.

Proven at the sync commit: as a scratch change, `statusOf` returned `live` whenever `visibleBook(m.sync)` held, so a resync over the previous book would still read live. Following this skill, `drift` listed `hub.ts`, the model got a `hasBook` variable for `visibleBook`, and `check` failed beyond the known findings: a BTC snapshot, a corrupt message that resets and resubscribes, then a flush that posts the old book as live. The same steps through the real hub posted `live` after the corrupt delta, where the code at the sync commit posts `syncing`. With the scratch change dropped, `check` passed again.
