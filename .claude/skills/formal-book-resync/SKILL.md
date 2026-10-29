---
name: formal-book-resync
description: "Model-check how the hub keeps a Binance order book in sync: sequenced diffs, the REST snapshot, its retry, resets on subscribe and reconnect. Use when a change touches stepBook's rest-snapshot-sequenced branch in packages/core/src/book.ts, feedBook, fetchSnapshot, apply, ingest or the socket handlers in src/hub/hub.ts, stepConnection in src/hub/connection.ts, or the Binance adapter's book feed. Also use to ask whether a resync order can show wrong prices or leave a book stuck on syncing."
---

# Binance book resync, model-checked

A TLA+ model of one Binance book in the hub, checked with TLC. It explores every order of venue updates, depthUpdate messages, REST snapshots, failed fetches, retry timers, tab wants, socket drops and silence, within small bounds. Tests replay one recorded order. This checks all of them.

## The two properties

- `LiveBookMatchesVenue`: a Binance book the hub calls live has the venue's levels at its `lastSeq`. If broken, the ladder shows wrong prices or sizes under a live status.
- `ResyncHasOwner`: a book waiting for its snapshot with diffs buffered always has a snapshot fetch or a retry timer working for its epoch. If broken, the book reads syncing until the socket drops, because later diffs never ask for a snapshot (`book.ts:249`).

## Run it

```bash
.claude/skills/formal-book-resync/run.sh             # check, then list covered files changed since the sync commit
.claude/skills/formal-book-resync/run.sh self-test   # each known break and each reachability witness must fail
.claude/skills/formal-book-resync/run.sh drift       # only the drift list
```

Run from the repo root. `check` takes about 13 s on 12 cores and explores about 2.3 million distinct states. `self-test` takes a few seconds.

Tool: TLC from `tla2tools.jar` v1.7.4, the latest stable release of github.com/tlaplus/tlaplus. The script downloads it on first use to `~/.cache/tape-formal/tla2tools-1.7.4/tla2tools.jar` and checks its sha256. Set `TAPE_TLA_JAR` to use another copy of the same file. It needs `java` 11 or newer on `PATH`. Nothing goes in `package.json` and nothing lands in the repo. TLC runs on a copy of the spec in a temp dir.

## When to use it

Run `check` when your change touches a row of the coverage table below. Run `drift` first if you are not sure: it lists covered files that differ from the sync commit, committed or not. A file in that list does not mean the model is wrong. It means you must read the change against the table.

## Coverage

Line numbers are at the sync commit. The model's comments carry the same numbers on each condition.

| Model (`BookResync.tla`) | Code |
| --- | --- |
| `sync`, `Reset`, `Delta`, `LiveDelta`, `RestSnapshot`, `Replay`, `Merge` | `stepBook` branch `rest-snapshot-sequenced`, `awaiting`, `merge`, `initialSync` in `packages/core/src/book.ts:169-269` |
| `ReceiveDiff` | `socket.onmessage` to `ingest`, `apply` case `book-delta`, `feedBook` in `src/hub/hub.ts:331, 295-311, 269-277, 226-236` |
| `ReceiveBadDiff` | `DecimalError` catch in `apply` and `VenueParseError` in `ingest`, `src/hub/hub.ts:289-292, 303-304` |
| `fetches`, `SnapshotArrives` | `fetchSnapshot` and its `.then`, `src/hub/hub.ts:238-254`; `binance.book.fetchSnapshot` in `packages/venues/src/binance.ts:45-50` |
| `SnapshotFails`, `timers`, `RetryTimerFires`, `Waiting` | `fetchSnapshot` `.catch`, `waiting()`, the 2 s `setTimeout`, `AbortSignal.timeout`, `src/hub/hub.ts:243-257` |
| `Reconcile` | `want` handler, `queueReconcile`, `reconcile`, the 1 s timer, `desiredFor`, `stepVenue`, `src/hub/hub.ts:478-482, 425-432, 409-423, 446-447, 366-388`; `stepConnection` tick and `reconcile` in `src/hub/connection.ts:170-185, 82-112`; `deriveStreams` in `src/core/topics.ts:165-181` |
| `Reconcile` add branch, `SocketOpened` | the `streams-reset` effect that resets each subscribed book, `src/hub/hub.ts:354-359` |
| `SocketOpened` | `socket.onopen`, `stepConnection` case `opened`, `src/hub/hub.ts:330`, `src/hub/connection.ts:116-131` |
| `SocketCloses`, `Silence`, `DropSocket` | `socket.onclose` and the `v.socket === socket` guards, `run` case `close`, `src/hub/hub.ts:330-343`; `closed` and the silence check in `src/hub/connection.ts:132-145, 84-94` |
| `chan`, `VenueSends` | `depthUpdate` with `seq: { from: U, to: u }` in `binance.parse`, `packages/venues/src/binance.ts:93` |

Each action is one JS task in the worker: a socket message, a fetch settling, a timer, or a tab message with the reconcile it queues as a microtask. Nothing else in the hub runs inside one of them, so each is one TLA+ step.

Sync commit: `588b1dcda8029ed6dd0a5446653bf2e747e28561` (2026-10-29). The model describes the covered code at this commit.

## Bounds and assumptions

Bounds in `BookResync.cfg`: venue update ids up to 5, book epochs up to 6, 3 faults in total (bad diffs, failed fetches, socket drops, silences), 3 control frames waiting at the venue. A pass covers these bounds, not every run.

Assumptions:

- The venue's truth is `Apply` in the model: a diff `<<U, u>>` carries each level changed in U..u at its value after u. A book equal to the venue at c becomes the venue at u when `U <= c + 1` and `u >= c`. Anything else counts as wrong levels.
- A REST snapshot can be older than the stream. The model lets it equal the venue at any id up to the current one.
- A new subscription streams updates after the current id. TCP keeps one socket's messages in order. Messages from a closed socket never reach `ingest`.
- Every fetch settles, because of `AbortSignal.timeout(8_000)`, and every timer fires. The model checks that someone owns the resync, not how long it takes.
- Binance specs are loaded. Before that, `desiredFor` leaves the stream out, so nothing is subscribed.
- Holds never apply to Binance. `resubscribe` only comes from the `snapshot-then-deltas` protocol (`book.ts:194`), so `holds` stays empty.
- Uncrossing in `fromSnapshot` and `applyDelta` is out of the model. A Binance spot book does not cross.

## Not covered

- dYdX and Hyperliquid books, crossed-book eviction, the resubscribe hold and its doubling in `connection.ts:146-169`.
- Backoff timing, jitter, keepalive and `STABLE_MS`. The model only knows that backoff ends some time.
- More than one market or one book stream. Other Binance streams appear only as `others`, which keeps the socket open.
- Tabs, ports, Web Locks, linger timing and frames. A want change is one nondeterministic flip of `desired`.
- Whether the book ever goes live. That needs fairness and an endless venue, and the model has neither. `ResyncHasOwner` is the safety half of it.
- The level arithmetic itself: `write`, `seek`, `fixed.ts` parsing.

## Read a result

Read every TLC result with the pstack `/statechart` skill, run from `BookResync.tla` and `BookResync.cfg`. On a failure it tells each violation as its shortest path in plain words, and it can show which violations a change fixes. On a pass it draws how the book moves between states.

On `FAIL`, decide whether the trace is a real bug or a modeling error. Walk the trace one action at a time against the coverage table. For each step, open the code and confirm it can happen in that order with those values.

- If every step can happen in the code, it is a bug. Report it as steps in the code's words, for example "socket opens and subscribes, the depthUpdate 4..4 is buffered and asks for a snapshot, update 5 happens, the snapshot at 5 arrives, replay applies 4..4 over it". Do not weaken the property or the model to make it pass.
- If a step cannot happen, the model is wrong. Fix the model to match the code, cite the line, and rerun.

On `PASS`, still read the drift list. A pass on a model that no longer describes the code proves nothing.

## When you change covered code

1. Read your diff against the coverage table. For each changed condition, branch or effect, find the model line that carries the same file and line in its comment.
2. Change the model to do what the code now does, before you rerun. Keep one JS task as one action. Keep names from the code.
3. Run `check`. If it fails, read the trace as above. A fail on an intended change is still a bug unless the promise changed on purpose. Then change the property and say why in the commit.
4. Run `self-test`. Every line must say `ok`. A `MISS` means the model lost the ability to catch that break, or a witness path is no longer reachable. Fix the model, not the test. If you removed the code a mutant stands for, replace the mutant with one for the new code.
5. Update the line numbers in the model comments and in the coverage table.
6. Move the sync commit forward only after you have confirmed the model describes the code at the new commit. Write the full SHA and the date on the `Sync commit:` line. `run.sh drift` reads it from there.

For changes that skipped this skill, such as merges, use the pstack `/maintain-formal-verification-skill` skill.

## Known breaks the self-test checks

`Mutant` in the config switches the model to a known broken variant of the code. `"none"` is the code as it is.

- `no-gap-check`: drop the gap rule in `book.ts:254`. Breaks `LiveBookMatchesVenue`.
- `merge-keeps-first`: `merge` keeps the earlier effect, so a gap during replay asks for no snapshot (`book.ts:265`). Breaks `ResyncHasOwner`.
- `no-retry`: a failed fetch sets no timer (`hub.ts:255-257`). Breaks `ResyncHasOwner`.

The witnesses `NeverLive`, `NeverResyncAfterLive` and `NeverLateSnapshot` must also fail. They show the bounds reach a live book, a resync after live, and a stale snapshot still in flight.

Proven at the sync commit: in a scratch worktree, deleting the drop rule in `book.ts:253` and mirroring it in `LiveDelta` made `check` fail `LiveBookMatchesVenue` with the story above. The same story run through the real `stepBook` left bid 100 at its size from update 4 with `lastSeq` 4, where the code at the sync commit shows the size from update 5.
