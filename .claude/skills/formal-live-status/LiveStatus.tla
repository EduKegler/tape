------------------------------ MODULE LiveStatus ------------------------------
(***************************************************************************)
(* What the hub tells a tab about a dYdX book: the 'live', 'syncing' or    *)
(* 'stale' status on each book frame, and whether a book posted as live    *)
(* still follows the venue. Two markets share one dYdX socket. The model  *)
(* has the socket's life (connection.ts), the subscribe and unsubscribe    *)
(* frames, the resubscribe hold, the in-band snapshot and corrupt          *)
(* messages (stepBook 'snapshot-then-deltas'), the tab's wants with their  *)
(* 10 s linger, and the 100 ms throttle on flushNow.                       *)
(*                                                                         *)
(* A JS task in the worker runs to completion, but the throttle's leading  *)
(* edge calls flushNow synchronously from inside it (Pacer's               *)
(* Throttler.maybeExecute). So a task is one action for its first part,    *)
(* then a queue of sub-steps in `todo`: each reset of a stopBooks loop    *)
(* and each flush() call. While `todo` is not empty only Continue runs.    *)
(*                                                                         *)
(* Line numbers are at the sync commit named in SKILL.md.                  *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
  Markets,    \* market keys on the one dYdX socket
  MaxFaults,  \* socket drops, silences and corrupt messages, in total
  MaxCtrl,    \* subscribe / unsubscribe frames waiting at the venue
  MaxChan,    \* messages in flight to the hub
  Mutant      \* "none" is the code. The others are known breaks, see SKILL.md.

VARIABLES
  conn,          \* ConnState.s, connection.ts:3-15
  subscribed,    \* ConnState.subscribed
  held,          \* streams whose ConnState.holds entry still holds them (until > now), connection.ts:97
  hubSub,        \* ghost: the hub's last frame for the stream on this socket was a subscribe
  ctrl,          \* subscribe / unsubscribe frames sent, not yet read by the venue
  venueSub,      \* the venue streams the market's v4_orderbook on the current socket
  chan,          \* messages in flight to the hub, each <<market, "snapshot" | "bad">>
  wanted,        \* the tab's book topics, TabState.wants
  linger,        \* streams deriveStreams keeps for LINGER_MS after the last want, topics.ts:150-168
  phase,         \* MarketState.sync.phase
  follows,       \* ghost: the book keeps up with the venue, or a fresh snapshot is on its way
  dirty,         \* the market's version moved since its frame was last posted to the tab
  quiet,         \* the throttle's wait has passed since flushNow last ran
  trailing,      \* the throttle has a trailing flushNow scheduled
  posted,        \* status of the last book frame posted to the tab
  postedFollows, \* whether that book followed the venue when it was posted
  todo,          \* the rest of the current JS task
  dropped,       \* ghost: a socket has been lost at least once
  faults

vars == <<conn, subscribed, held, hubSub, ctrl, venueSub, chan, wanted, linger, phase,
          follows, dirty, quiet, trailing, posted, postedFollows, todo, dropped, faults>>

Status == {"none", "live", "syncing", "stale"}
Op(o, m) == [op |-> o, m |-> m]
FlushCall == Op("flush", "none")
TouchAll == Op("touch-all", "none")

TypeOK ==
  /\ conn \in {"idle", "connecting", "open", "backoff"}
  /\ subscribed \subseteq Markets /\ held \subseteq Markets
  /\ hubSub \in [Markets -> BOOLEAN] /\ venueSub \in [Markets -> BOOLEAN]
  /\ ctrl \in Seq({"sub", "unsub"} \X Markets)
  /\ chan \in Seq(Markets \X {"snapshot", "bad"})
  /\ wanted \subseteq Markets /\ linger \subseteq Markets
  /\ phase \in [Markets -> {"awaiting-snapshot", "live"}]
  /\ follows \in [Markets -> BOOLEAN] /\ dirty \in [Markets -> BOOLEAN]
  /\ quiet \in BOOLEAN /\ trailing \in BOOLEAN
  /\ posted \in [Markets -> Status] /\ postedFollows \in [Markets -> BOOLEAN]
  /\ todo \in Seq([op : {"flush", "reset", "touch-all"}, m : Markets \cup {"none"}])
  /\ dropped \in BOOLEAN
  /\ faults \in 0..MaxFaults

Idle == todo = <<>>

\* Every order of a set, for the order of a Set the code iterates.
Orders(S) == {f \in [1..Cardinality(S) -> S] : \A i, j \in DOMAIN f : i # j => f[i] # f[j]}

\* statusOf, hub.ts:138-142.
StatusOf(m) ==
  IF conn # "open" THEN "stale"
  ELSE IF phase[m] = "live" THEN "live" ELSE "syncing"

\* flushNow, hub.ts:192-207, for the one visible tab. A frame goes out when its version
\* moved or its status changed (the signature in project, hub.ts:163-167).
PostFrames ==
  LET out(m) == m \in wanted /\ (dirty[m] \/ StatusOf(m) # posted[m]) IN
    /\ posted' = [m \in Markets |-> IF out(m) THEN StatusOf(m) ELSE posted[m]]
    /\ postedFollows' = [m \in Markets |-> IF out(m) THEN follows[m] ELSE postedFollows[m]]
    /\ dirty' = [m \in Markets |-> IF m \in wanted THEN FALSE ELSE dirty[m]]

\* run({fx:'close'}) or onclose: the socket and all it carried are gone, hub.ts:332-345.
\* Messages of a dead socket never reach ingest: the `v.socket === socket` guards, hub.ts:330-331.
DropSocket ==
  /\ ctrl' = <<>> /\ chan' = <<>>
  /\ venueSub' = [m \in Markets |-> FALSE]
  /\ hubSub' = [m \in Markets |-> FALSE]
  /\ follows' = [m \in Markets |-> FALSE]

\* The Continue items of a loop that feeds a reset to each book of `order`, one at a time.
Resets(order) == [i \in DOMAIN order |-> Op("reset", order[i])]

\* run({fx:'close'}) resets every book of the venue, reason 'stopped', hub.ts:343.
CloseResets(order) == IF Mutant = "no-stop-on-close" THEN <<>> ELSE Resets(order)

\* stopBooks in run({fx:'unsubscribe'}) and run({fx:'streams-stale'}), hub.ts:222-227, 351, 357.
UnsubResets(order) == IF Mutant = "no-stop-on-unsubscribe" THEN <<>> ELSE Resets(order)
StaleResets(order) == IF Mutant = "no-stop-on-stale" THEN <<>> ELSE Resets(order)

Subscribes(order) == [i \in DOMAIN order |-> <<"sub", order[i]>>]
Unsubscribes(order) == [i \in DOMAIN order |-> <<"unsub", order[i]>>]

---------------------------------------------------------------------------
Init ==
  /\ conn = "idle" /\ subscribed = {} /\ held = {}
  /\ hubSub = [m \in Markets |-> FALSE] /\ venueSub = [m \in Markets |-> FALSE]
  /\ ctrl = <<>> /\ chan = <<>>
  /\ wanted = {} /\ linger = {}
  /\ phase = [m \in Markets |-> "awaiting-snapshot"]             \* initialSync, book.ts:171-178
  /\ follows = [m \in Markets |-> FALSE] /\ dirty = [m \in Markets |-> FALSE]
  /\ quiet = TRUE /\ trailing = FALSE
  /\ posted = [m \in Markets |-> "none"] /\ postedFollows = [m \in Markets |-> FALSE]
  /\ todo = <<>> /\ dropped = FALSE /\ faults = 0

(* The rest of a task, one item at a time *)

Continue ==
  /\ ~Idle
  /\ LET it == Head(todo) IN
     CASE it.op = "flush" ->
            \* Pacer's maybeExecute: run now if the wait has passed, else schedule the trailing run.
            IF quiet
            THEN /\ PostFrames /\ quiet' = FALSE /\ todo' = Tail(todo)
                 /\ UNCHANGED <<trailing, phase>>
            ELSE /\ trailing' = TRUE /\ todo' = Tail(todo)
                 /\ UNCHANGED <<quiet, phase, posted, postedFollows, dirty>>
       [] it.op = "reset" ->
            \* feedBook(m, { kind: 'reset', reason }), hub.ts:229-239, book.ts:209. A phase change
            \* touches the market, and touch calls flush, hub.ts:212-215, 235.
            /\ phase' = [phase EXCEPT ![it.m] = "awaiting-snapshot"]
            /\ dirty' = IF phase[it.m] = "live" THEN [dirty EXCEPT ![it.m] = TRUE] ELSE dirty
            /\ todo' = IF phase[it.m] = "live" THEN <<FlushCall>> \o Tail(todo) ELSE Tail(todo)
            /\ UNCHANGED <<quiet, trailing, posted, postedFollows>>
       [] it.op = "touch-all" ->
            \* stepVenue touches every market of the venue when ConnState.s changed, hub.ts:384.
            /\ dirty' = [m \in Markets |-> TRUE]
            /\ todo' = [i \in 1..Cardinality(Markets) |-> FlushCall] \o Tail(todo)
            /\ UNCHANGED <<quiet, trailing, phase, posted, postedFollows>>
  /\ UNCHANGED <<conn, subscribed, held, hubSub, ctrl, venueSub, chan, wanted, linger,
                 follows, dropped, faults>>

(* The throttle's timers *)

\* The trailing setTimeout, Pacer's Throttler.maybeExecute.
TrailingFires ==
  /\ Idle /\ trailing
  /\ PostFrames /\ trailing' = FALSE
  /\ UNCHANGED <<conn, subscribed, held, hubSub, ctrl, venueSub, chan, wanted, linger, phase,
                 follows, quiet, todo, dropped, faults>>

\* FLUSH_MS pass with no flushNow, so the next flush() runs at once.
WaitPasses ==
  /\ Idle /\ ~quiet /\ ~trailing
  /\ quiet' = TRUE
  /\ UNCHANGED <<conn, subscribed, held, hubSub, ctrl, venueSub, chan, wanted, linger, phase,
                 follows, dirty, trailing, posted, postedFollows, todo, dropped, faults>>

(* The venue *)

\* The venue reads one frame. After a subscribe it sends the book in the 'subscribed' message.
VenueReadsControl ==
  /\ Idle /\ ctrl # <<>>
  /\ LET f == Head(ctrl) IN
       /\ venueSub' = [venueSub EXCEPT ![f[2]] = (f[1] = "sub")]
       /\ chan' = IF f[1] = "sub" THEN Append(chan, <<f[2], "snapshot">>) ELSE chan
  /\ ctrl' = Tail(ctrl)
  /\ UNCHANGED <<conn, subscribed, held, hubSub, wanted, linger, phase, follows, dirty,
                 quiet, trailing, posted, postedFollows, todo, dropped, faults>>

\* A message on a streamed book that the hub cannot read: a VenueParseError naming the market
\* (hub.ts:305-306) or a DecimalError in toLevels (hub.ts:291-293). Deltas that parse leave
\* the phase and the status alone, so the model has no others.
VenueSendsBad ==
  /\ Idle /\ faults < MaxFaults
  /\ \E m \in Markets :
       /\ venueSub[m]
       /\ chan' = Append(chan, <<m, "bad">>)
  /\ faults' = faults + 1
  /\ UNCHANGED <<conn, subscribed, held, hubSub, ctrl, venueSub, wanted, linger, phase, follows,
                 dirty, quiet, trailing, posted, postedFollows, todo, dropped>>

(* The hub *)

\* reconcile(), hub.ts:406-420: deriveStreams with linger (topics.ts:152-168), then stepVenue
\* with { e: 'tick' } (connection.ts:157-172, 83-113), then flush(). `gone` are lingering
\* streams whose LINGER_MS ran out, from `expirable`: a stream wanted at the last reconcile has
\* lastWanted under 1 s old. A tab's 'want' (hub.ts:480-485) runs it as a microtask right after
\* the message, so the two are one task.
Reconcile(w, l, expirable) ==
  \E gone \in SUBSET expirable :
    LET desired == w \cup (l \ gone) IN
    /\ linger' = l \ gone
    /\ CASE conn = "idle" ->
              IF desired # {}
              THEN /\ conn' = "connecting"                         \* run 'open', hub.ts:326-338
                   /\ DropSocket
                   /\ todo' = <<TouchAll, FlushCall>>
                   /\ UNCHANGED <<subscribed, held, phase, dirty>>
              ELSE /\ todo' = <<FlushCall>>
                   /\ UNCHANGED <<conn, subscribed, held, hubSub, ctrl, venueSub, chan, phase,
                                  follows, dirty>>
         [] conn = "connecting" ->
              /\ todo' = <<FlushCall>>
              /\ UNCHANGED <<conn, subscribed, held, hubSub, ctrl, venueSub, chan, phase,
                             follows, dirty>>
         [] conn = "backoff" ->
              \* retryAt passed or not, connection.ts:165-169.
              \E retry \in BOOLEAN :
                IF desired = {}
                THEN /\ conn' = "idle"
                     /\ todo' = <<TouchAll, FlushCall>>
                     /\ UNCHANGED <<subscribed, held, hubSub, ctrl, venueSub, chan, phase,
                                    follows, dirty>>
                ELSE IF retry
                THEN /\ conn' = "connecting"
                     /\ DropSocket
                     /\ todo' = <<TouchAll, FlushCall>>
                     /\ UNCHANGED <<subscribed, held, phase, dirty>>
                ELSE /\ todo' = <<FlushCall>>
                     /\ UNCHANGED <<conn, subscribed, held, hubSub, ctrl, venueSub, chan, phase,
                                    follows, dirty>>
         [] conn = "open" /\ desired = {} ->
              \* connection.ts:84, then run 'close', hub.ts:339-345.
              \E morder \in Orders(Markets) :
                /\ conn' = "idle" /\ subscribed' = {} /\ held' = {}
                /\ DropSocket
                /\ todo' = CloseResets(morder) \o <<TouchAll, FlushCall>>
                /\ UNCHANGED <<phase, dirty>>
         [] conn = "open" ->
              LET keep == {s \in desired : s \in subscribed \/ s \notin held}   \* connection.ts:98
                  add == keep \ subscribed                                    \* connection.ts:99
                  drop == subscribed \ desired                                \* connection.ts:100
              IN \E order \in Orders(add), dorder \in Orders(drop) :
                   /\ subscribed' = keep
                   /\ ctrl' = ctrl \o Unsubscribes(dorder) \o Subscribes(order)   \* connection.ts:102-103
                   /\ hubSub' = [m \in Markets |-> IF m \in add THEN TRUE
                                                   ELSE IF m \in drop THEN FALSE ELSE hubSub[m]]
                   /\ follows' = [m \in Markets |-> IF m \in drop THEN FALSE ELSE follows[m]]
                   /\ todo' = UnsubResets(dorder) \o <<FlushCall>>
                   /\ UNCHANGED <<conn, held, venueSub, chan, phase, dirty>>

\* The tab sends its full want set, hub.ts:480-485. Dropped topics leave tab.sent (hub.ts:482),
\* so the tab holds no frame for them and one wanted again gets a frame on the next flush.
Want ==
  /\ Idle
  /\ \E w \in SUBSET Markets :
       /\ w # wanted
       /\ wanted' = w
       /\ posted' = [m \in Markets |-> IF m \in w THEN posted[m] ELSE "none"]
       /\ Reconcile(w, (linger \cup (wanted \ w)) \ w, linger \ w)
  /\ UNCHANGED <<quiet, trailing, postedFollows, dropped, faults>>

\* The 1 s setInterval, hub.ts:447-448.
Tick ==
  /\ Idle
  /\ Reconcile(wanted, linger, linger)
  /\ UNCHANGED <<wanted, quiet, trailing, posted, postedFollows, dropped, faults>>

\* socket.onopen -> stepVenue({ e: 'opened' }), hub.ts:330, connection.ts:117-132. The new
\* ConnState starts with no subscriptions and no holds, then reconciles.
SocketOpened ==
  /\ Idle /\ conn = "connecting"
  /\ LET desired == wanted \cup linger IN
       IF desired = {}
       THEN \E morder \in Orders(Markets) :
            /\ conn' = "idle" /\ subscribed' = {} /\ held' = {}
            /\ DropSocket
            /\ todo' = CloseResets(morder) \o <<TouchAll>>
       ELSE \E order \in Orders(desired) :
            /\ conn' = "open"                                     \* v.conn = state, hub.ts:381
            /\ subscribed' = desired /\ held' = {}
            /\ ctrl' = ctrl \o Subscribes(order)                  \* run 'subscribe', hub.ts:346-348
            /\ hubSub' = [m \in Markets |-> m \in desired]
            /\ todo' = <<TouchAll>>
            /\ UNCHANGED <<venueSub, chan, follows>>
  /\ UNCHANGED <<wanted, linger, phase, dirty, quiet, trailing, posted, postedFollows, dropped,
                 faults>>

\* The connect fails: onclose while connecting, connection.ts:140-143.
ConnectFails ==
  /\ Idle /\ conn = "connecting"
  /\ conn' = "backoff"
  /\ DropSocket
  /\ todo' = <<TouchAll>>
  /\ UNCHANGED <<subscribed, held, wanted, linger, phase, dirty, quiet, trailing, posted,
                 postedFollows, dropped, faults>>

\* An open socket is lost: onclose (hub.ts:332-336, connection.ts:133-139) or the silence
\* check in a tick (connection.ts:85-95), which runs 'close' first and flushes at the end of
\* reconcile. Backoff keeps no subscriptions or holds. streams-stale stops each subscribed book
\* and touches its market (hub.ts:356-359), then stepVenue touches them all. The touches of
\* streams-stale fold into the touch-all: the socket is gone, so every wanted frame's status
\* changes and the first flush posts them all.
SocketLost ==
  /\ Idle /\ conn = "open" /\ faults < MaxFaults
  /\ \E silence \in BOOLEAN, morder \in Orders(Markets), sorder \in Orders(subscribed) :
       todo' = (IF silence THEN CloseResets(morder) ELSE <<>>) \o StaleResets(sorder) \o <<TouchAll>>
               \o (IF silence THEN <<FlushCall>> ELSE <<>>)
  /\ conn' = "backoff" /\ subscribed' = {} /\ held' = {}
  /\ DropSocket
  /\ dropped' = TRUE
  /\ faults' = faults + 1
  /\ UNCHANGED <<wanted, linger, phase, dirty, quiet, trailing, posted, postedFollows>>

\* socket.onmessage -> ingest -> apply -> feedBook, hub.ts:331, 297-313, 262-295, 229-239.
\* apply drops a book message unless followsBook, the stream subscribed on an open socket
\* (hub.ts:217-220, 267). A snapshot makes the book live from any phase, book.ts:214-216.
ReceiveSnapshot ==
  /\ Idle /\ conn = "open" /\ chan # <<>> /\ Head(chan)[2] = "snapshot"
  /\ LET m == Head(chan)[1] IN
     IF m \notin subscribed /\ Mutant # "no-follows-guard"
     THEN /\ chan' = Tail(chan)
          /\ UNCHANGED <<phase, follows, dirty, todo>>
     ELSE /\ chan' = Tail(chan)
          /\ phase' = [phase EXCEPT ![m] = "live"]
          /\ follows' = [follows EXCEPT ![m] = hubSub[m]]
          /\ dirty' = [dirty EXCEPT ![m] = TRUE]
          /\ todo' = <<FlushCall>>
  /\ UNCHANGED <<conn, subscribed, held, hubSub, ctrl, venueSub, wanted, linger, quiet, trailing,
                 posted, postedFollows, dropped, faults>>

\* A corrupt message resets the book (book.ts:209, awaiting() asks to resubscribe,
\* book.ts:196-197) and feedBook steps the venue with { e: 'resubscribe' } (hub.ts:237-238,
\* connection.ts:147-156). A stream resubscribed within its hold is unsubscribed and left out
\* until a tick after the hold. The touch's flush runs before the resubscribe, but the
\* resubscribe changes nothing a frame shows, so the flush is the last item. Its unsubscribe
\* stops a book already awaiting a snapshot, which changes nothing.
ReceiveBad ==
  /\ Idle /\ conn = "open" /\ chan # <<>> /\ Head(chan)[2] = "bad"
  /\ LET m == Head(chan)[1]
         resub == m \in subscribed                                \* connection.ts:149-150
         later == resub /\ m \in held                             \* deferRepeatResubscribes, connection.ts:60-72
     IN /\ chan' = Tail(chan)
        /\ phase' = [phase EXCEPT ![m] = "awaiting-snapshot"]
        /\ follows' = [follows EXCEPT ![m] = FALSE]
        /\ ctrl' = IF ~resub THEN ctrl
                   ELSE IF later THEN Append(ctrl, <<"unsub", m>>)
                   ELSE ctrl \o <<<<"unsub", m>>, <<"sub", m>>>>      \* connection.ts:153-154
        /\ hubSub' = IF resub THEN [hubSub EXCEPT ![m] = ~later] ELSE hubSub
        /\ subscribed' = IF later THEN subscribed \ {m} ELSE subscribed
        /\ held' = IF resub THEN held \cup {m} ELSE held
        /\ dirty' = IF phase[m] = "live" THEN [dirty EXCEPT ![m] = TRUE] ELSE dirty
        /\ todo' = IF phase[m] = "live" THEN <<FlushCall>> ELSE <<>>
  /\ UNCHANGED <<conn, venueSub, wanted, linger, quiet, trailing, posted, postedFollows,
                 dropped, faults>>

\* A hold's `until` passes, so the stream is no longer held, connection.ts:65, 97.
HoldEnds ==
  /\ Idle
  /\ \E m \in held : held' = held \ {m}
  /\ UNCHANGED <<conn, subscribed, hubSub, ctrl, venueSub, chan, wanted, linger, phase, follows,
                 dirty, quiet, trailing, posted, postedFollows, todo, dropped, faults>>

Next ==
  \/ Continue \/ TrailingFires \/ WaitPasses
  \/ VenueReadsControl \/ VenueSendsBad
  \/ Want \/ Tick \/ SocketOpened \/ ConnectFails \/ SocketLost
  \/ ReceiveSnapshot \/ ReceiveBad \/ HoldEnds

Spec == Init /\ [][Next]_vars

Bounds == Len(ctrl) <= MaxCtrl /\ Len(chan) <= MaxChan

\* The two markets act the same, so TLC checks one of each pair of mirrored states.
Symmetry == Permutations(Markets)

---------------------------------------------------------------------------
(* Property *)

\* A book frame the hub posts as live shows a book that still follows the venue: its socket
\* is the current one, and the stream is subscribed on it or a fresh snapshot is on its way.
\* Harm if broken: the ladder shows frozen or pre-outage prices under a 'live' status.
LiveMeansFollowing ==
  \A m \in Markets : posted[m] = "live" => postedFollows[m]

\* Between tasks, a book is live only while its stream is subscribed on an open socket. So a
\* subscribe always finds its book awaiting a snapshot, and needs no reset of its own.
LiveOnlyWhileSubscribed ==
  Idle => \A m \in Markets : phase[m] = "live" => conn = "open" /\ m \in subscribed

---------------------------------------------------------------------------
(* Reachability. run.sh self-test expects TLC to break each of these, which *)
(* shows the bounds reach the paths the property is about.                  *)

\* A book frame goes out as live.
NeverLivePost == \A m \in Markets : posted[m] # "live"
\* A book follows the venue again on a socket opened after a drop.
NeverLiveAgain == ~(dropped /\ conn = "open" /\ \E m \in Markets : phase[m] = "live" /\ follows[m])
\* A wanted stream sits out its resubscribe hold, unsubscribed.
NeverHeldOut == ~(conn = "open" /\ \E m \in wanted : m \in held /\ m \notin subscribed)
=============================================================================
