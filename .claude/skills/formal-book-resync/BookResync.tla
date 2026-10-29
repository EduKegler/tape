------------------------------ MODULE BookResync ------------------------------
(***************************************************************************)
(* One Binance book in the hub: the venue socket, the sequenced diffs, the *)
(* REST snapshot, its 2 s retry, and stepBook's 'rest-snapshot-sequenced'  *)
(* branch. Each action is one JS task in the worker (a socket message, a   *)
(* fetch settling, a timer, a tab message plus its queued reconcile), so   *)
(* it runs to completion with no other hub code in between.                *)
(*                                                                         *)
(* Line numbers are at the sync commit named in SKILL.md.                  *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
  MaxId,      \* venue update ids go 0..MaxId
  MaxEpoch,   \* explore until BookSync.epoch passes this
  MaxFaults,  \* parse failures, failed fetches, socket drops and silences, in total
  MaxCtrl,    \* SUBSCRIBE / UNSUBSCRIBE frames waiting at the venue
  Mutant      \* "none" is the code. The others are known breaks, see SKILL.md.

\* The book's levels match no venue id.
Bad == -1

VARIABLES
  vid,         \* the venue's latest update id
  venueSub,    \* the venue streams <symbol>@depth@100ms on the current socket
  venueSent,   \* last update id the venue put on the current socket
  conn,        \* ConnState.s for binance, connection.ts:8-22
  subscribed,  \* the book stream is in ConnState.subscribed
  ctrl,        \* SUBSCRIBE / UNSUBSCRIBE frames sent, not yet read by the venue
  chan,        \* depthUpdate messages in flight to the hub, each <<U, u>>
  desired,     \* the book stream is in desiredFor('binance'), hub.ts:321-324
  others,      \* some other binance stream is desired, so the socket stays up
  sync,        \* MarketState.sync, plus `levels`: what the book's levels really equal
  fetches,     \* epochs with a REST snapshot in flight, hub.ts:214-216
  timers,      \* epochs with the 2 s retry timer pending, hub.ts:218
  faults

vars == <<vid, venueSub, venueSent, conn, subscribed, ctrl, chan, desired, others,
          sync, fetches, timers, faults>>

Ids == 0..MaxId
Diffs == {d \in Ids \X Ids : 1 <= d[1] /\ d[1] <= d[2]}

TypeOK ==
  /\ vid \in Ids /\ venueSent \in Ids
  /\ venueSub \in BOOLEAN /\ subscribed \in BOOLEAN
  /\ desired \in BOOLEAN /\ others \in BOOLEAN
  /\ conn \in {"idle", "connecting", "open", "backoff"}
  /\ ctrl \in Seq({"sub", "unsub"})
  /\ chan \in Seq(Diffs)
  /\ sync.phase \in {"awaiting-snapshot", "live"}
  /\ sync.epoch \in Nat
  /\ sync.buffer \in Seq(Diffs)
  /\ sync.lastSeq \in Ids
  /\ sync.levels \in Ids \cup {Bad}
  /\ fetches \subseteq Nat /\ timers \subseteq Nat
  /\ faults \in 0..MaxFaults

---------------------------------------------------------------------------
(* The truth. A depthUpdate <<U, u>> carries every level that changed in   *)
(* updates U..u, at its value after u. On a book that equals the venue at  *)
(* id c it gives the venue at u only when nothing is skipped (U <= c + 1)  *)
(* and nothing goes back (u >= c). This is Binance's rule, written         *)
(* independently of the code's checks so that a wrong check shows.         *)
Apply(levels, d) ==
  IF levels = Bad \/ d[1] > levels + 1 \/ d[2] < levels THEN Bad ELSE d[2]

(* stepBook, protocol 'rest-snapshot-sequenced'. A step is the next sync   *)
(* plus the epochs its effect asks feedBook to fetch (hub.ts:204).         *)
NoEffect(s) == [sync |-> s, fetch |-> {}]

\* input.kind 'reset', book.ts:192. awaiting() asks for nothing with an empty buffer, book.ts:174-177.
Reset(s) == [s EXCEPT !.phase = "awaiting-snapshot", !.epoch = s.epoch + 1, !.buffer = <<>>]

\* A live book takes one diff, book.ts:228-233.
LiveDelta(s, d) ==
  IF d[2] <= s.lastSeq                                            \* book.ts:229
  THEN NoEffect(s)
  ELSE IF d[1] > s.lastSeq + 1 /\ Mutant # "no-gap-check"        \* book.ts:230
  THEN [sync |-> [s EXCEPT !.phase = "awaiting-snapshot", !.epoch = s.epoch + 1, !.buffer = <<d>>],
        fetch |-> {s.epoch + 1}]                                  \* book.ts:172-177, buffer non-empty
  ELSE [sync |-> [s EXCEPT !.levels = Apply(s.levels, d), !.lastSeq = d[2]],
        fetch |-> {}]                                             \* book.ts:231-232

\* input.kind 'delta' with a seq, book.ts:221-233.
Delta(s, d) ==
  IF s.phase = "awaiting-snapshot"                                \* book.ts:223
  THEN [sync |-> [s EXCEPT !.buffer = Append(s.buffer, d)],
        fetch |-> IF s.buffer = <<>> THEN {s.epoch} ELSE {}]      \* book.ts:224-226
  ELSE LiveDelta(s, d)

\* merge(), book.ts:238-245: the later effect wins unless it is 'none'.
Merge(a, b) ==
  IF Mutant = "merge-keeps-first" THEN a
  ELSE IF b = {} THEN a ELSE b

\* The replay loop over the buffer, book.ts:212-218.
RECURSIVE Replay(_, _, _)
Replay(r, buf, i) ==
  IF i > Len(buf) THEN r                                          \* book.ts:219
  ELSE LET n == LiveDelta(r.sync, buf[i])
           m == [sync |-> n.sync, fetch |-> Merge(r.fetch, n.fetch)]   \* book.ts:213
       IN IF m.sync.phase # "live"                                \* book.ts:214
          THEN [m EXCEPT !.sync.buffer = SubSeq(buf, i, Len(buf))]  \* book.ts:215-216
          ELSE Replay(m, buf, i + 1)

\* input.kind 'rest-snapshot', book.ts:207-220. The snapshot equals the venue at L.
RestSnapshot(s, e, L) ==
  IF s.phase # "awaiting-snapshot" \/ e # s.epoch                 \* book.ts:208
  THEN NoEffect(s)
  ELSE Replay([sync |-> [s EXCEPT !.phase = "live", !.levels = L, !.lastSeq = L, !.buffer = <<>>],
               fetch |-> {}],                                     \* book.ts:209-211
              s.buffer, 1)

\* fetchSnapshot's `waiting()`, hub.ts:213.
Waiting(e) == sync.phase = "awaiting-snapshot" /\ sync.epoch = e

\* run({fx:'close'}) or onclose: the socket and everything on it are gone. hub.ts:285-298.
DropSocket ==
  /\ chan' = <<>> /\ ctrl' = <<>> /\ venueSub' = FALSE /\ subscribed' = FALSE

---------------------------------------------------------------------------
Init ==
  /\ vid = 0 /\ venueSub = FALSE /\ venueSent = 0
  /\ conn = "idle" /\ subscribed = FALSE /\ ctrl = <<>> /\ chan = <<>>
  /\ desired = FALSE /\ others = FALSE
  /\ sync = [phase |-> "awaiting-snapshot", epoch |-> 1, buffer |-> <<>>,
             lastSeq |-> 0, levels |-> Bad]                       \* initialSync, book.ts:164-166
  /\ fetches = {} /\ timers = {} /\ faults = 0

(* The venue *)

VenueUpdate ==
  /\ vid < MaxId
  /\ vid' = vid + 1
  /\ UNCHANGED <<venueSub, venueSent, conn, subscribed, ctrl, chan, desired, others, sync, fetches, timers, faults>>

\* One depthUpdate with every update since the last one. Any batching is reachable.
VenueSends ==
  /\ conn = "open" /\ venueSub /\ venueSent < vid
  /\ chan' = Append(chan, <<venueSent + 1, vid>>)
  /\ venueSent' = vid
  /\ UNCHANGED <<vid, venueSub, conn, subscribed, ctrl, desired, others, sync, fetches, timers, faults>>

\* The venue reads one SUBSCRIBE or UNSUBSCRIBE. A new stream starts after the current id.
VenueReadsControl ==
  /\ ctrl # <<>>
  /\ ctrl' = Tail(ctrl)
  /\ IF Head(ctrl) = "sub"
     THEN venueSub' = TRUE /\ venueSent' = vid
     ELSE venueSub' = FALSE /\ venueSent' = venueSent
  /\ UNCHANGED <<vid, conn, subscribed, chan, desired, others, sync, fetches, timers, faults>>

(* The hub *)

\* socket.onmessage -> ingest -> apply -> feedBook. hub.ts:286, 251-266, 231-233, 197-206.
ReceiveDiff ==
  /\ conn = "open" /\ chan # <<>>
  /\ LET r == Delta(sync, Head(chan)) IN
       /\ sync' = r.sync
       /\ fetches' = fetches \cup r.fetch                        \* hub.ts:204
  /\ chan' = Tail(chan)
  /\ UNCHANGED <<vid, venueSub, venueSent, conn, subscribed, ctrl, desired, others, timers, faults>>

\* A depthUpdate that throws DecimalError in toLevels (hub.ts:245-248) or VenueParseError
\* in parse (hub.ts:259). The diff is dropped and the book resets as corrupt.
ReceiveBadDiff ==
  /\ conn = "open" /\ chan # <<>> /\ faults < MaxFaults
  /\ sync' = Reset(sync)
  /\ chan' = Tail(chan)
  /\ faults' = faults + 1
  /\ UNCHANGED <<vid, venueSub, venueSent, conn, subscribed, ctrl, desired, others, fetches, timers>>

\* fetchSnapshot's .then, hub.ts:216. The REST book may lag the stream, so L is any id up to now.
SnapshotArrives ==
  \E e \in fetches, L \in 0..vid :
    LET r == RestSnapshot(sync, e, L) IN
      /\ sync' = r.sync
      /\ fetches' = (fetches \ {e}) \cup r.fetch
      /\ UNCHANGED <<vid, venueSub, venueSent, conn, subscribed, ctrl, chan, desired, others, timers, faults>>

\* fetchSnapshot's .catch, hub.ts:217-219: an HTTP error, the 8 s AbortSignal.timeout (hub.ts:215),
\* or a DecimalError from toLevels inside .then.
SnapshotFails ==
  \E e \in fetches :
    /\ faults < MaxFaults
    /\ fetches' = fetches \ {e}
    /\ timers' = IF Waiting(e) /\ Mutant # "no-retry" THEN timers \cup {e} ELSE timers   \* hub.ts:218
    /\ faults' = faults + 1
    /\ UNCHANGED <<vid, venueSub, venueSent, conn, subscribed, ctrl, chan, desired, others, sync>>

\* The setTimeout callback 2 s later, hub.ts:218.
RetryTimerFires ==
  \E e \in timers :
    /\ timers' = timers \ {e}
    /\ sync' = IF Waiting(e) THEN Reset(sync) ELSE sync
    /\ UNCHANGED <<vid, venueSub, venueSent, conn, subscribed, ctrl, chan, desired, others, fetches, faults>>

\* A tab's 'want' plus its queued reconcile (hub.ts:424-428, 371-378), or the 1 s tick
\* (hub.ts:392-393) when a stream's linger runs out. Either way reconcile() derives the
\* streams (topics.ts:162-178) and steps the connection with { e: 'tick' } (hub.ts:366).
Reconcile ==
  \E d, o \in BOOLEAN :
    /\ desired' = d /\ others' = o
    /\ UNCHANGED <<vid, venueSent, fetches, timers, faults>>
    /\ CASE conn = "idle" ->                                      \* connection.ts:151-152
              /\ conn' = IF d \/ o THEN "connecting" ELSE "idle"
              /\ UNCHANGED <<venueSub, subscribed, ctrl, chan, sync>>
         [] conn = "connecting" ->                                \* connection.ts:153-154
              UNCHANGED <<conn, venueSub, subscribed, ctrl, chan, sync>>
         [] conn = "backoff" ->                                   \* connection.ts:155-157, retryAt passed or not
              /\ conn' \in IF d \/ o THEN {"backoff", "connecting"} ELSE {"idle"}
              /\ UNCHANGED <<venueSub, subscribed, ctrl, chan, sync>>
         [] conn = "open" /\ ~(d \/ o) ->                         \* connection.ts:83
              /\ conn' = "idle"
              /\ DropSocket
              /\ UNCHANGED sync
         [] conn = "open" /\ o /\ subscribed /\ ~d ->              \* connection.ts:92-94
              /\ ctrl' = Append(ctrl, "unsub")
              /\ subscribed' = FALSE
              /\ UNCHANGED <<conn, venueSub, chan, sync>>
         [] conn = "open" /\ ~subscribed /\ d ->                  \* connection.ts:90-91, 95
              /\ ctrl' = Append(ctrl, "sub")
              /\ subscribed' = TRUE
              /\ sync' = Reset(sync)                              \* streams-reset, hub.ts:309-314
              /\ UNCHANGED <<conn, venueSub, chan>>
         [] OTHER ->
              UNCHANGED <<conn, venueSub, subscribed, ctrl, chan, sync>>

\* The silence watchdog inside a tick, connection.ts:84-87. The hub closes the socket.
Silence ==
  /\ conn = "open" /\ (desired \/ others) /\ faults < MaxFaults
  /\ conn' = "backoff"
  /\ DropSocket
  /\ faults' = faults + 1
  /\ UNCHANGED <<vid, venueSent, desired, others, sync, fetches, timers>>

\* socket.onopen -> stepVenue({ e: 'opened' }), hub.ts:285, connection.ts:106-113.
SocketOpened ==
  /\ conn = "connecting"
  /\ UNCHANGED <<vid, venueSent, desired, others, fetches, timers, faults>>
  /\ IF ~(desired \/ others)                                      \* connection.ts:83
     THEN conn' = "idle" /\ DropSocket /\ UNCHANGED sync
     ELSE /\ conn' = "open"
          /\ subscribed' = desired
          /\ ctrl' = IF desired THEN <<"sub">> ELSE <<>>
          /\ sync' = IF desired THEN Reset(sync) ELSE sync        \* streams-reset, hub.ts:309-314
          /\ UNCHANGED <<venueSub, chan>>

\* socket.onclose from the network or the venue, hub.ts:287-291, connection.ts:114-124.
\* Messages of a dead socket never reach the hub: the `v.socket === socket` guards, hub.ts:285-288.
SocketCloses ==
  /\ conn \in {"connecting", "open"} /\ faults < MaxFaults
  /\ conn' = "backoff"
  /\ DropSocket
  /\ faults' = faults + 1
  /\ UNCHANGED <<vid, venueSent, desired, others, sync, fetches, timers>>

Next ==
  \/ VenueUpdate \/ VenueSends \/ VenueReadsControl
  \/ ReceiveDiff \/ ReceiveBadDiff
  \/ SnapshotArrives \/ SnapshotFails \/ RetryTimerFires
  \/ Reconcile \/ Silence \/ SocketOpened \/ SocketCloses

Spec == Init /\ [][Next]_vars

Bounds == sync.epoch <= MaxEpoch /\ Len(ctrl) <= MaxCtrl

---------------------------------------------------------------------------
(* Properties *)

\* A Binance book the hub calls live has the venue's levels at its lastSeq.
\* Harm if broken: the ladder shows wrong prices or sizes under a 'live' status.
LiveBookMatchesVenue ==
  sync.phase = "live" => sync.levels = sync.lastSeq

\* A book waiting for its snapshot with diffs buffered always has a fetch or a retry
\* timer working for its epoch. Further diffs never fetch (book.ts:225), so without
\* one the book would read 'syncing' for as long as the socket stays up.
ResyncHasOwner ==
  (sync.phase = "awaiting-snapshot" /\ sync.buffer # <<>>)
    => (sync.epoch \in fetches \/ sync.epoch \in timers)
---------------------------------------------------------------------------
(* Reachability. run.sh self-test expects TLC to break each of these, which *)
(* shows the bounds reach the paths the two properties are about.           *)

\* A book goes live.
NeverLive == sync.phase # "live"
\* A live book drops back to a resync, with its old levels still on screen.
NeverResyncAfterLive == ~(sync.phase = "awaiting-snapshot" /\ sync.levels # Bad)
\* A snapshot for an older epoch is still in flight. RestSnapshot must drop it.
NeverLateSnapshot == ~(\E e \in fetches : e < sync.epoch)
=============================================================================
