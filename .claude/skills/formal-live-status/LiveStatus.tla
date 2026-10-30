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
(* then a queue of sub-steps in `todo`: each reset of a streams-reset loop *)
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
  Fixes,      \* hypothetical fixes for the known findings, see SKILL.md. {} is the code.
  Mutant      \* "none" is the code. The others are known breaks, see SKILL.md.

VARIABLES
  conn,          \* ConnState.s, connection.ts:3-15
  subscribed,    \* ConnState.subscribed
  held,          \* streams whose ConnState.holds entry still holds them (until > now), connection.ts:98
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

Range(f) == {f[i] : i \in DOMAIN f}

\* statusOf, hub.ts:135-139.
StatusOf(m) ==
  IF conn # "open" /\ Mutant # "status-ignores-conn" THEN "stale"
  ELSE IF phase[m] = "live" THEN "live" ELSE "syncing"

\* flushNow, hub.ts:189-204, for the one visible tab. A frame goes out when its version
\* moved or its status changed (the signature in project, hub.ts:160-164).
PostFrames ==
  LET out(m) == m \in wanted /\ (dirty[m] \/ StatusOf(m) # posted[m]) IN
    /\ posted' = [m \in Markets |-> IF out(m) THEN StatusOf(m) ELSE posted[m]]
    /\ postedFollows' = [m \in Markets |-> IF out(m) THEN follows[m] ELSE postedFollows[m]]
    /\ dirty' = [m \in Markets |-> IF m \in wanted THEN FALSE ELSE dirty[m]]

\* run({fx:'close'}) or onclose: the socket and all it carried are gone, hub.ts:315-327.
\* Messages of a dead socket never reach ingest: the `v.socket === socket` guards, hub.ts:313-314.
DropSocket ==
  /\ ctrl' = <<>> /\ chan' = <<>>
  /\ venueSub' = [m \in Markets |-> FALSE]
  /\ hubSub' = [m \in Markets |-> FALSE]
  /\ follows' = [m \in Markets |-> FALSE]

\* The order of Continue items a streams-reset over `order` leaves, hub.ts:337-342.
\* With the reset-first fix every book resets before anything can flush.
ResetItems(order) ==
  IF "reset-first" \in Fixes \/ Mutant = "no-streams-reset" THEN <<>>
  ELSE [i \in DOMAIN order |-> Op("reset", order[i])]

ResetAtOnce(order, ph) ==
  IF "reset-first" \in Fixes /\ Mutant # "no-streams-reset"
  THEN [m \in Markets |-> IF m \in Range(order) THEN "awaiting-snapshot" ELSE ph[m]]
  ELSE ph

\* A reset that moves the phase touches the market (hub.ts:219), which marks it dirty.
ResetDirty(order, ph) ==
  IF "reset-first" \in Fixes /\ Mutant # "no-streams-reset"
  THEN [m \in Markets |-> dirty[m] \/ (m \in Range(order) /\ ph[m] = "live")]
  ELSE dirty

ResetFlushes(order, ph) ==
  IF "reset-first" \in Fixes /\ Mutant # "no-streams-reset" /\ \E i \in DOMAIN order : ph[order[i]] = "live"
  THEN <<FlushCall>> ELSE <<>>

Subscribes(order) == [i \in DOMAIN order |-> <<"sub", order[i]>>]
Unsubscribes(order) == [i \in DOMAIN order |-> <<"unsub", order[i]>>]

---------------------------------------------------------------------------
Init ==
  /\ conn = "idle" /\ subscribed = {} /\ held = {}
  /\ hubSub = [m \in Markets |-> FALSE] /\ venueSub = [m \in Markets |-> FALSE]
  /\ ctrl = <<>> /\ chan = <<>>
  /\ wanted = {} /\ linger = {}
  /\ phase = [m \in Markets |-> "awaiting-snapshot"]             \* initialSync, book.ts:169-176
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
            \* feedBook(m, { kind: 'reset', reason: 'subscribed' }), hub.ts:214-224, book.ts:207.
            \* A phase change touches the market, and touch calls flush, hub.ts:209-212.
            /\ phase' = [phase EXCEPT ![it.m] = "awaiting-snapshot"]
            /\ dirty' = IF phase[it.m] = "live" THEN [dirty EXCEPT ![it.m] = TRUE] ELSE dirty
            /\ todo' = IF phase[it.m] = "live" THEN <<FlushCall>> \o Tail(todo) ELSE Tail(todo)
            /\ UNCHANGED <<quiet, trailing, posted, postedFollows>>
       [] it.op = "touch-all" ->
            \* stepVenue touches every market of the venue when ConnState.s changed, hub.ts:370.
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
\* (hub.ts:288-289) or a DecimalError in toLevels (hub.ts:274-276). Deltas that parse leave
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

\* reconcile(), hub.ts:392-406: deriveStreams with linger (topics.ts:152-168), then stepVenue
\* with { e: 'tick' } (connection.ts:158-173, 84-114), then flush(). `gone` are lingering
\* streams whose LINGER_MS ran out, from `expirable`: a stream wanted at the last reconcile has
\* lastWanted under 1 s old. A tab's 'want' (hub.ts:459-463) runs it as a microtask right after
\* the message, so the two are one task.
Reconcile(w, l, expirable) ==
  \E gone \in SUBSET expirable :
    LET desired == w \cup (l \ gone) IN
    /\ linger' = l \ gone
    /\ CASE conn = "idle" ->
              IF desired # {}
              THEN /\ conn' = "connecting"                         \* run 'open', hub.ts:309-321
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
              \* retryAt passed or not, connection.ts:166-170.
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
              \* connection.ts:85, then run 'close', hub.ts:322-327.
              /\ conn' = "idle" /\ subscribed' = {} /\ held' = {}
              /\ DropSocket
              /\ todo' = <<TouchAll, FlushCall>>
              /\ UNCHANGED <<phase, dirty>>
         [] conn = "open" ->
              LET keep == {s \in desired : s \in subscribed \/ s \notin held}   \* connection.ts:99
                  add == keep \ subscribed                                    \* connection.ts:100
                  drop == subscribed \ desired                                \* connection.ts:101
              IN \E order \in Orders(add), dorder \in Orders(drop) :
                   /\ subscribed' = keep
                   /\ ctrl' = ctrl \o Unsubscribes(dorder) \o Subscribes(order)   \* connection.ts:103-104
                   /\ hubSub' = [m \in Markets |-> IF m \in add THEN TRUE
                                                   ELSE IF m \in drop THEN FALSE ELSE hubSub[m]]
                   /\ follows' = [m \in Markets |-> IF m \in drop THEN FALSE ELSE follows[m]]
                   /\ phase' = [m \in Markets |->
                                 IF "reset-on-unsubscribe" \in Fixes /\ m \in drop THEN "awaiting-snapshot"
                                 ELSE ResetAtOnce(order, phase)[m]]
                   /\ dirty' = ResetDirty(order, phase)
                   /\ todo' = ResetItems(order) \o ResetFlushes(order, phase) \o <<FlushCall>>
                   /\ UNCHANGED <<conn, held, venueSub, chan>>

\* The tab sends its full want set, hub.ts:459-463. Dropped topics leave tab.sent (hub.ts:461),
\* so the tab holds no frame for them and one wanted again gets a frame on the next flush.
Want ==
  /\ Idle
  /\ \E w \in SUBSET Markets :
       /\ w # wanted
       /\ wanted' = w
       /\ posted' = [m \in Markets |-> IF m \in w THEN posted[m] ELSE "none"]
       /\ Reconcile(w, (linger \cup (wanted \ w)) \ w, linger \ w)
  /\ UNCHANGED <<quiet, trailing, postedFollows, dropped, faults>>

\* The 1 s setInterval, hub.ts:427-428.
Tick ==
  /\ Idle
  /\ Reconcile(wanted, linger, linger)
  /\ UNCHANGED <<wanted, quiet, trailing, posted, postedFollows, dropped, faults>>

\* socket.onopen -> stepVenue({ e: 'opened' }), hub.ts:313, connection.ts:118-133. The new
\* ConnState starts with no subscriptions and no holds, then reconciles.
SocketOpened ==
  /\ Idle /\ conn = "connecting"
  /\ LET desired == wanted \cup linger IN
       IF desired = {}
       THEN /\ conn' = "idle" /\ subscribed' = {} /\ held' = {}
            /\ DropSocket
            /\ todo' = <<TouchAll>>
            /\ UNCHANGED <<phase, dirty>>
       ELSE \E order \in Orders(desired) :
            /\ conn' = "open"                                     \* v.conn = state, hub.ts:367
            /\ subscribed' = desired /\ held' = {}
            /\ ctrl' = ctrl \o Subscribes(order)                  \* run 'subscribe', hub.ts:328-330
            /\ hubSub' = [m \in Markets |-> m \in desired]
            /\ phase' = ResetAtOnce(order, phase)
            /\ dirty' = ResetDirty(order, phase)
            /\ todo' = ResetItems(order) \o ResetFlushes(order, phase) \o <<TouchAll>>
            /\ UNCHANGED <<venueSub, chan, follows>>
  /\ UNCHANGED <<wanted, linger, quiet, trailing, posted, postedFollows, dropped, faults>>

\* The connect fails: onclose while connecting, connection.ts:141-144.
ConnectFails ==
  /\ Idle /\ conn = "connecting"
  /\ conn' = "backoff"
  /\ DropSocket
  /\ todo' = <<TouchAll>>
  /\ UNCHANGED <<subscribed, held, wanted, linger, phase, dirty, quiet, trailing, posted,
                 postedFollows, dropped, faults>>

\* An open socket is lost: onclose (hub.ts:315-320, connection.ts:134-140) or the silence
\* check in a tick (connection.ts:86-96, which also closes it). Backoff keeps no subscriptions
\* or holds. streams-stale touches each subscribed market, then stepVenue touches them all.
SocketLost ==
  /\ Idle /\ conn = "open" /\ faults < MaxFaults
  /\ conn' = "backoff" /\ subscribed' = {} /\ held' = {}
  /\ DropSocket
  /\ todo' = <<TouchAll>>
  /\ dropped' = TRUE
  /\ faults' = faults + 1
  /\ UNCHANGED <<wanted, linger, phase, dirty, quiet, trailing, posted, postedFollows>>

\* socket.onmessage -> ingest -> apply -> feedBook, hub.ts:314, 280-296, 247-278, 214-224.
\* A snapshot makes the book live from any phase, book.ts:211-215. It keeps following the venue
\* only if the hub still has the stream subscribed on this socket.
ReceiveSnapshot ==
  /\ Idle /\ conn = "open" /\ chan # <<>> /\ Head(chan)[2] = "snapshot"
  /\ LET m == Head(chan)[1] IN
     IF "ignore-unsubscribed" \in Fixes /\ ~hubSub[m]
     THEN /\ chan' = Tail(chan)
          /\ UNCHANGED <<phase, follows, dirty, todo>>
     ELSE /\ chan' = Tail(chan)
          /\ phase' = [phase EXCEPT ![m] = "live"]
          /\ follows' = [follows EXCEPT ![m] = hubSub[m]]
          /\ dirty' = [dirty EXCEPT ![m] = TRUE]
          /\ todo' = <<FlushCall>>
  /\ UNCHANGED <<conn, subscribed, held, hubSub, ctrl, venueSub, wanted, linger, quiet, trailing,
                 posted, postedFollows, dropped, faults>>

\* A corrupt message resets the book (book.ts:207, awaiting() asks to resubscribe,
\* book.ts:194-195) and feedBook steps the venue with { e: 'resubscribe' } (hub.ts:222-223,
\* connection.ts:148-157). A stream resubscribed within its hold is unsubscribed and left out
\* until a tick after the hold. The touch's flush runs before the resubscribe, but the
\* resubscribe changes nothing a frame shows, so the flush is the last item.
ReceiveBad ==
  /\ Idle /\ conn = "open" /\ chan # <<>> /\ Head(chan)[2] = "bad"
  /\ LET m == Head(chan)[1]
         resub == m \in subscribed                                \* connection.ts:150-151
         later == resub /\ m \in held                             \* deferRepeatResubscribes, connection.ts:61-73
     IN /\ chan' = Tail(chan)
        /\ phase' = [phase EXCEPT ![m] = "awaiting-snapshot"]
        /\ follows' = [follows EXCEPT ![m] = FALSE]
        /\ ctrl' = IF ~resub THEN ctrl
                   ELSE IF later THEN Append(ctrl, <<"unsub", m>>)
                   ELSE ctrl \o <<<<"unsub", m>>, <<"sub", m>>>>      \* connection.ts:154-155
        /\ hubSub' = IF resub THEN [hubSub EXCEPT ![m] = ~later] ELSE hubSub
        /\ subscribed' = IF later THEN subscribed \ {m} ELSE subscribed
        /\ held' = IF resub THEN held \cup {m} ELSE held
        /\ dirty' = IF phase[m] = "live" THEN [dirty EXCEPT ![m] = TRUE] ELSE dirty
        /\ todo' = IF phase[m] = "live" THEN <<FlushCall>> ELSE <<>>
  /\ UNCHANGED <<conn, venueSub, wanted, linger, quiet, trailing, posted, postedFollows,
                 dropped, faults>>

\* A hold's `until` passes, so the stream is no longer held, connection.ts:66, 98.
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
