#!/usr/bin/env bash
# Model-checks the status the hub puts on dYdX book frames. See SKILL.md next to this file.
#
#   run.sh            check the property, then list covered files changed since the sync commit
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

COVERED=(src/hub/hub.ts src/hub/connection.ts src/core/topics.ts packages/core/src/book.ts packages/venues/src/dydx.ts)

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

# tlc <work dir>: runs TLC on a copy of the spec and the run.cfg in that dir, so nothing lands next to the skill.
tlc() {
  local work="$1"
  cp "$HERE/LiveStatus.tla" "$work/"
  java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -deadlock -workers auto -cleanup \
    -metadir "$work/states" -config run.cfg "$work/LiveStatus.tla" >"$work/tlc.out" 2>&1 || true
}

# variant <work dir> <mutant> <invariant...>: writes run.cfg for that variant, checking only the named invariants.
variant() {
  local work="$1" mutant="$2"; shift 2
  sed -e "s/Mutant = \"none\"/Mutant = \"$mutant\"/" -e '/^INVARIANTS/,$d' \
    "$HERE/LiveStatus.cfg" >"$work/run.cfg"
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

# expect_break <label> <mutant> <invariant>: TLC must report that invariant violated.
expect_break() {
  local label="$1" mutant="$2" inv="$3" work; work="$(mktemp -d)"
  variant "$work" "$mutant" "$inv"
  tlc "$work"
  if grep -q "Invariant $inv is violated" "$work/tlc.out"; then
    echo "ok    $label breaks $inv ($(grep -c '^State [0-9]*:' "$work/tlc.out") steps)"
    rm -rf "$work"
  else
    echo "MISS  $label did not break $inv. Output in $work/tlc.out"
    return 1
  fi
}

check() {
  local work; work="$(mktemp -d)"
  variant "$work" none TypeOK LiveMeansFollowing
  tlc "$work"
  if grep -q "Model checking completed. No error has been found." "$work/tlc.out"; then
    grep -E "distinct states found|depth of the complete" "$work/tlc.out" | tail -2
    echo "PASS: LiveMeansFollowing holds within the bounds in LiveStatus.cfg."
    rm -rf "$work"
  elif grep -qE "Invariant .* is violated" "$work/tlc.out"; then
    grep -E "Invariant .* is violated" "$work/tlc.out"
    echo "FAIL: counterexample in $work/tlc.out."
    echo "      Read it with /statechart before you change anything."
    return 1
  else
    echo "TLC did not finish. Output in $work/tlc.out"
    return 1
  fi
}

self_test() {
  local bad=0
  expect_break "apply without the followsBook guard (hub.ts:264)" no-follows-guard LiveMeansFollowing || bad=1
  expect_break "unsubscribe without stopBooks (hub.ts:348)" no-stop-on-unsubscribe LiveMeansFollowing || bad=1
  expect_break "streams-stale without stopBooks (hub.ts:360)" no-stop-on-stale LiveMeansFollowing || bad=1
  expect_break "close without the stopped resets (hub.ts:340)" no-stop-on-close LiveMeansFollowing || bad=1
  expect_break "witness: a book frame goes out live" none NeverLivePost || bad=1
  expect_break "witness: a book follows again after a drop" none NeverLiveAgain || bad=1
  expect_break "witness: a wanted stream sits out its hold" none NeverHeldOut || bad=1
  return $bad
}

case "${1:-check}" in
  check) ensure_tools; status=0; check || status=1; drift; exit $status ;;
  self-test) ensure_tools; self_test ;;
  drift) drift ;;
  *) echo "usage: run.sh [check|self-test|drift]" >&2; exit 2 ;;
esac
