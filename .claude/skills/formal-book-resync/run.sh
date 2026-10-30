#!/usr/bin/env bash
# Model-checks the Binance book resync. See SKILL.md next to this file.
#
#   run.sh            check the model as the code is (expect a pass), then list covered files changed since the sync commit
#   run.sh self-test  check that each known break and each reachability witness fails, as they must
#   run.sh drift      only list covered files changed since the sync commit
#
# Exit 0 when everything came out as expected, 1 when not, 2 when the tool could not run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
TLA_VERSION="1.7.4"
TLA_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar"
JAR="${TAPE_TLA_JAR:-$HOME/.cache/tape-formal/tla2tools-${TLA_VERSION}/tla2tools.jar}"

COVERED=(packages/core/src/book.ts src/hub/hub.ts src/hub/connection.ts src/core/topics.ts packages/venues/src/binance.ts)

ensure_tools() {
  command -v java >/dev/null || { echo "java not found. TLC needs Java 11 or newer." >&2; exit 2; }
  if [[ ! -f "$JAR" ]]; then
    echo "Downloading tla2tools.jar v${TLA_VERSION} to $JAR"
    mkdir -p "$(dirname "$JAR")"
    curl -fsSL -o "$JAR.part" "$TLA_URL"
    mv "$JAR.part" "$JAR"
  fi
  local sum
  sum="$(shasum -a 256 "$JAR" | cut -d' ' -f1)"
  [[ "$sum" == "$TLA_SHA256" ]] || { echo "$JAR has sha256 $sum, expected $TLA_SHA256" >&2; exit 2; }
}

# tlc <work dir> <cfg>: runs TLC on copies of the spec and cfg, so nothing lands next to the skill.
# TLC looks for the cfg next to the spec, so both go in the work dir.
tlc() {
  local work="$1" cfg="$2"
  cp "$HERE/BookResync.tla" "$work/"
  [[ "$cfg" == "$work/run.cfg" ]] || cp "$cfg" "$work/run.cfg"
  java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -deadlock -workers auto -cleanup \
    -metadir "$work/states" -config run.cfg "$work/BookResync.tla" >"$work/tlc.out" 2>&1 || true
}

# variant <work dir> <mutant> <invariant...>: writes a cfg for that mutant that checks only the named invariants.
variant() {
  local work="$1" mutant="$2"; shift 2
  sed -e "s/Mutant = \"none\"/Mutant = \"$mutant\"/" -e '/^INVARIANTS/,$d' "$HERE/BookResync.cfg" >"$work/run.cfg"
  printf 'INVARIANTS\n' >>"$work/run.cfg"
  for inv in "$@"; do printf '  %s\n' "$inv" >>"$work/run.cfg"; done
}

drift() {
  local sync
  sync="$(sed -n 's/^Sync commit: `\([0-9a-f]*\)`.*/\1/p' "$HERE/SKILL.md" | head -1)"
  [[ -n "$sync" ]] || { echo "No sync commit in SKILL.md" >&2; exit 2; }
  local changed
  changed="$(git -C "$REPO" diff --stat "$sync" -- "${COVERED[@]}")"
  if [[ -z "$changed" ]]; then
    echo "Drift: no covered file changed since sync commit $sync."
  else
    echo "Drift: covered files changed since sync commit $sync (committed or not):"
    echo "$changed"
    echo "Read each change against the coverage table in SKILL.md before you trust a pass."
  fi
}

check() {
  local work; work="$(mktemp -d)"
  tlc "$work" "$HERE/BookResync.cfg"
  if grep -q "Model checking completed. No error has been found." "$work/tlc.out"; then
    grep -E "^[0-9]+ states generated|depth of the complete" "$work/tlc.out"
    echo "PASS: LiveBookMatchesVenue, ResyncHasOwner and UnfollowedWaits hold within the bounds in BookResync.cfg."
    rm -rf "$work"
    return 0
  fi
  if grep -qE "Invariant .* is violated" "$work/tlc.out"; then
    grep -E "Invariant .* is violated" "$work/tlc.out"
    echo "FAIL: counterexample in $work/tlc.out. Read it with /statechart before you change anything."
  else
    echo "TLC did not finish. Output in $work/tlc.out"
  fi
  return 1
}

# expect_break <label> <mutant> <invariant>: TLC must report that invariant violated.
expect_break() {
  local label="$1" mutant="$2" inv="$3" work; work="$(mktemp -d)"
  variant "$work" "$mutant" "$inv"
  tlc "$work" "$work/run.cfg"
  if grep -q "Invariant $inv is violated" "$work/tlc.out"; then
    echo "ok    $label breaks $inv ($(grep -c '^State [0-9]*:' "$work/tlc.out") steps)"
    rm -rf "$work"
  else
    echo "MISS  $label did not break $inv. Output in $work/tlc.out"
    return 1
  fi
}

self_test() {
  local bad=0
  expect_break "gap check removed (book.ts:255)" no-gap-check LiveBookMatchesVenue || bad=1
  expect_break "merge keeps the first effect (book.ts:266)" merge-keeps-first ResyncHasOwner || bad=1
  expect_break "no retry after a failed fetch (hub.ts:257-259)" no-retry ResyncHasOwner || bad=1
  expect_break "witness: a book goes live" none NeverLive || bad=1
  expect_break "witness: a live book resyncs" none NeverResyncAfterLive || bad=1
  expect_break "witness: a late snapshot is in flight" none NeverLateSnapshot || bad=1
  return $bad
}

case "${1:-check}" in
  check) ensure_tools; status=0; check || status=1; drift; exit $status ;;
  self-test) ensure_tools; self_test ;;
  drift) drift ;;
  *) echo "usage: run.sh [check|self-test|drift]" >&2; exit 2 ;;
esac
