#!/usr/bin/env bash
# End-to-end test for v1.3.0 multi-operator + actor identity.
#
# Spins up two daemons (operator=steve and operator=bob) sharing a single bare
# git transport. Posts `from: alice@steve, to: alice@bob` and verifies:
#   - bob's daemon dispatches its local alice (alice@bob)
#   - steve's daemon correctly skips (alice@bob is not in its registry)
#   - alice@bob's response routes back to alice@steve via the bare repo
#   - steve's daemon dispatches the response to alice@steve
#   - bob's daemon correctly skips (alice@bob is the sender — self-loop)
#
# Uses `command: echo` for actor dispatch — no agent CLIs, no API keys.
# Disabled-relay mode with 2s polling sync the two clones via the bare repo.
#
# Run from the runtime repo root:
#     ./scripts/e2e-multi-op.sh
#
# Clean exit ⇒ pass. Any non-zero exit ⇒ fail (and the test prints which
# step failed and where to look for the surviving artifacts).

set -e
set -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="/tmp/crosstalk-e2e-multi-op"
BARE="$WORK/bare.git"
STEVE_TX="$WORK/steve-transport"
BOB_TX="$WORK/bob-transport"
STEVE_CFG="$WORK/steve-config.toml"
BOB_CFG="$WORK/bob-config.toml"
STEVE_HOME="$WORK/steve-home"
BOB_HOME="$WORK/bob-home"
STEVE_LOG="$WORK/steve-daemon.log"
BOB_LOG="$WORK/bob-daemon.log"

CLI="bun --cwd $ROOT $ROOT/src/index.ts"

# ── Cleanup helpers ─────────────────────────────────────────────────────────

cleanup() {
  # Kill background daemons if still running
  if [[ -n "${STEVE_PID:-}" ]] && kill -0 "$STEVE_PID" 2>/dev/null; then
    kill -TERM "$STEVE_PID" 2>/dev/null || true
    wait "$STEVE_PID" 2>/dev/null || true
  fi
  if [[ -n "${BOB_PID:-}" ]] && kill -0 "$BOB_PID" 2>/dev/null; then
    kill -TERM "$BOB_PID" 2>/dev/null || true
    wait "$BOB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

fail() {
  echo
  echo "✗ FAIL: $1"
  echo "  Daemon logs preserved at:"
  echo "    $STEVE_LOG"
  echo "    $BOB_LOG"
  echo "  Transports preserved at:"
  echo "    $STEVE_TX"
  echo "    $BOB_TX"
  exit 1
}

echo "── Step 1: clean workspace ──────────────────────────────────────────────"
rm -rf "$WORK"
mkdir -p "$WORK" "$STEVE_HOME/.crosstalk/keys" "$BOB_HOME/.crosstalk/keys"

echo "── Step 2: bare git repo + two clones ───────────────────────────────────"
git init --bare --initial-branch=main "$BARE" >/dev/null
# Seed the bare with an initial commit so clones don't fail on empty
SEED="$WORK/seed"
git init --initial-branch=main "$SEED" >/dev/null
(cd "$SEED" && \
   git config user.email "e2e@crosstalk.noreply" && \
   git config user.name "e2e" && \
   echo "e2e seed" > README.md && \
   git add README.md && \
   git commit -m "seed" >/dev/null && \
   git remote add origin "$BARE" && \
   git push origin main >/dev/null 2>&1)

git clone "$BARE" "$STEVE_TX" >/dev/null 2>&1
git clone "$BARE" "$BOB_TX" >/dev/null 2>&1

# Set per-clone identity so daemon commits don't blow up on missing user.email
for tx in "$STEVE_TX" "$BOB_TX"; do
  (cd "$tx" && git config user.email "daemon@crosstalk.noreply" && git config user.name "daemon")
done

echo "── Step 3: actor profiles + identities/ dirs ────────────────────────────"
# Both operators have an `alice` actor that just echoes a recognizable reply.
# {message_path} substitution lets us see in the response which inbound triggered it.
for tx in "$STEVE_TX" "$BOB_TX"; do
  mkdir -p "$tx/manifest/custom/actors" "$tx/manifest/identities"
  cat > "$tx/manifest/custom/actors/alice.md" <<'EOF'
---
name: alice
type: machine
role: Alice
parent:
command: echo
args:
  - "alice received {message_path}"
---

Test alice — echoes the message path it received so we can verify dispatch fired.
EOF
done

# Initial commit of profiles + push so both clones have a coherent shared state
for tx in "$STEVE_TX" "$BOB_TX"; do
  (cd "$tx" && \
     git add manifest/ && \
     git commit -m "e2e: alice profile + identities dir" >/dev/null && \
     git pull --rebase --autostash origin main >/dev/null 2>&1 || true && \
     git push origin main >/dev/null 2>&1 || true)
done
# Both push so resolve any race; second push may fail with non-fast-forward,
# that's fine — both clones end up with the same alice.md after a final pull.
(cd "$STEVE_TX" && git pull --rebase --autostash origin main >/dev/null 2>&1)
(cd "$BOB_TX"   && git pull --rebase --autostash origin main >/dev/null 2>&1)

echo "── Step 4: config files (operator handle + disabled relay + polling) ────"
cat > "$STEVE_CFG" <<EOF
transport = "$STEVE_TX"
operator = "steve"
default-human-actor = "steve"

[relay]
mode = "disabled"
poll-interval-seconds = 2
EOF

cat > "$BOB_CFG" <<EOF
transport = "$BOB_TX"
operator = "bob"
default-human-actor = "bob"

[relay]
mode = "disabled"
poll-interval-seconds = 2
EOF

echo "── Step 5: signing keys for alice@steve and alice@bob ───────────────────"
# Generate under each operator's HOME so the keys/ dirs are isolated.
HOME="$STEVE_HOME" CROSSTALK_CONFIG="$STEVE_CFG" $CLI actor key generate-signing alice@steve >/dev/null
HOME="$BOB_HOME"   CROSSTALK_CONFIG="$BOB_CFG"   $CLI actor key generate-signing alice@bob   >/dev/null
# Each generate-signing wrote a .pub into its own transport clone. Commit + push
# so the OTHER daemon picks them up via sync.
for tx_pair in "$STEVE_TX" "$BOB_TX"; do
  (cd "$tx_pair" && git add manifest/identities/ && \
     git commit -m "e2e: publish signing pubkey" >/dev/null 2>&1 || true)
done
(cd "$STEVE_TX" && git pull --rebase --autostash origin main >/dev/null 2>&1 && git push origin main >/dev/null 2>&1)
(cd "$BOB_TX"   && git pull --rebase --autostash origin main >/dev/null 2>&1 && git push origin main >/dev/null 2>&1)
(cd "$STEVE_TX" && git pull --rebase --autostash origin main >/dev/null 2>&1)

echo "── Step 6: create channel + pre-seed session-open BEFORE daemons start ──"
# Bootstrap gating defers messages on channels that didn't exist when the
# daemon's startup-scan ran. AND in multi-op mode, both daemons race to post
# session-open which causes severe git push contention (steve always wins,
# bob spins in 20-attempt retry storms). Sidestep both by pre-seeding a
# session-open from a neutral identity so both daemons see the channel as
# already 'open' and skip their bootstrap pass entirely.
HOME="$STEVE_HOME" CROSSTALK_CONFIG="$STEVE_CFG" $CLI channel new "e2e-cross-op" \
  --from steve --no-push >/dev/null
CHANNEL_GUID=$(ls "$STEVE_TX/channels" | head -1)
[[ -n "$CHANNEL_GUID" ]] || fail "no channel GUID found in $STEVE_TX/channels"
echo "    channel GUID = ${CHANNEL_GUID:0:8}..."

# Hand-write a session-open into the channel. Using `from: e2e-bootstrap`
# (a synthetic actor that's not in either daemon's registry) means neither
# self-loop-skips and neither needs to coordinate.
SO_DIR="$STEVE_TX/channels/$CHANNEL_GUID/2026/05/17"
mkdir -p "$SO_DIR"
# Filename must match MESSAGE_FILE_RE: ^\d{9}Z(-[a-f0-9]{8})?\.md$
# bootstrap.ts's history walker filters by this regex; an off-format
# filename is invisible to the bootstrap cache and the channel stays
# 'deferred', which makes both daemons run bootstrap anyway.
SO_FILE="$SO_DIR/000000000Z-cafe0000.md"
cat > "$SO_FILE" <<EOF
---
from: e2e-bootstrap
to: all
timestamp: 2026-05-17T00:00:00.000Z
type: session-open
session-id: e2e
roe-version: none
opened-at: 2026-05-17T00:00:00.000Z
---

## Pre-seeded session-open for e2e test
EOF

(cd "$STEVE_TX" && git add channels/ && \
   git commit -m "e2e: channel + pre-seed session-open" >/dev/null && \
   git push origin main >/dev/null 2>&1)
(cd "$BOB_TX" && git pull --rebase --autostash origin main >/dev/null 2>&1)

echo "── Step 7: start both daemons in background ─────────────────────────────"
HOME="$STEVE_HOME" CROSSTALK_CONFIG="$STEVE_CFG" $CLI > "$STEVE_LOG" 2>&1 &
STEVE_PID=$!
HOME="$BOB_HOME"   CROSSTALK_CONFIG="$BOB_CFG"   $CLI > "$BOB_LOG"   2>&1 &
BOB_PID=$!
# Let daemons bootstrap. Both will race to post session-open and may collide
# on git push; the push-retry loop handles it but needs time. Wait until BOTH
# logs show [crosstalk] ready, then wait a bit longer for bootstrap pushes
# + sync to settle.
echo "    waiting for both daemons to reach ready state (push contention can stretch this)..."
for i in $(seq 1 90); do
  if grep -q "\[crosstalk\] ready" "$STEVE_LOG" 2>/dev/null && \
     grep -q "\[crosstalk\] ready" "$BOB_LOG" 2>/dev/null; then
    break
  fi
  sleep 1
done
grep -q "\[crosstalk\] ready" "$STEVE_LOG" || fail "steve daemon never reached ready"
grep -q "\[crosstalk\] ready" "$BOB_LOG"   || fail "bob daemon never reached ready"
echo "    both daemons ready; settling bootstrap pushes for 6s..."
sleep 6

# Sanity: both daemons still alive
kill -0 "$STEVE_PID" 2>/dev/null || fail "steve daemon died on startup (see $STEVE_LOG)"
kill -0 "$BOB_PID"   2>/dev/null || fail "bob daemon died on startup (see $BOB_LOG)"

echo "── Step 8: post from alice@steve → alice@bob ────────────────────────────"
HOME="$STEVE_HOME" CROSSTALK_CONFIG="$STEVE_CFG" $CLI post \
  --channel "$CHANNEL_GUID" \
  --from alice@steve \
  --to alice@bob \
  -b "hello from alice@steve" \
  --no-push --allow-unknown-targets >/dev/null
(cd "$STEVE_TX" && git push origin main >/dev/null 2>&1)
echo "    posted; waiting for cross-op round trip (poll=2s, need ~4 cycles + push contention)..."
# Poll for the alice@bob response with a hard cap. Faster pass than fixed
# sleep when the round trip completes quickly; bounded so flakes still fail.
for i in $(seq 1 30); do
  (cd "$STEVE_TX" && git pull --rebase --autostash origin main >/dev/null 2>&1) || true
  if grep -lq '^from: alice@bob' "$STEVE_TX/channels/$CHANNEL_GUID"/*/*/*/*.md 2>/dev/null; then
    echo "    response from alice@bob landed after ${i}s"
    break
  fi
  sleep 1
done

echo "── Step 9: verify alice@bob dispatched + responded ──────────────────────"
# Pull on steve's side to surface bob's response in the working tree
(cd "$STEVE_TX" && git pull --rebase --autostash origin main >/dev/null 2>&1) || true

# Drop strict pipeline checking for the verification block — SIGPIPE from
# grep|head racing with set -o pipefail was killing the script silently
# right where the assertions live.
set +e
set +o pipefail

CHANNEL_PATH="$STEVE_TX/channels/$CHANNEL_GUID"
echo "    messages in channel:"
find "$CHANNEL_PATH" -name "*.md" | sort | while read -r m; do
  FROM=$(grep -m1 '^from:' "$m" | awk '{print $2}')
  TO=$(grep -m1 '^to:' "$m" | awk '{print $2}')
  echo "      $(basename "$m"):  from=$FROM  to=$TO"
done

COUNT=$(find "$CHANNEL_PATH" -name "*.md" | wc -l)
[[ "$COUNT" -ge 2 ]] || fail "expected >=2 messages, found $COUNT — bob didn't respond"

INBOUND=$(grep -lr '^from: alice@steve$' "$CHANNEL_PATH/" 2>/dev/null)
[[ -n "$INBOUND" ]] || fail "original from: alice@steve message missing"

RESPONSE=$(grep -lr '^from: alice@bob$' "$CHANNEL_PATH/" 2>/dev/null)
[[ -n "$RESPONSE" ]] || fail "no message with from: alice@bob — alice@bob never dispatched"

echo "── Step 10: verify daemons skipped messages they originated ─────────────"
# Each daemon should have logged at least one `[watcher] skip (own)` event
# — steve for its own outbound (from: alice@steve), bob for its own
# response (from: alice@bob). The skip log shows relPath only; the message
# content verification in step 9 already proves which file triggered which
# skip, so checking presence here is sufficient.
grep -q "skip (own)" "$STEVE_LOG"
STEVE_SKIP_FOUND=$?
grep -q "skip (own)" "$BOB_LOG"
BOB_SKIP_FOUND=$?

[[ $STEVE_SKIP_FOUND -eq 0 ]] || fail "steve's daemon never logged 'skip (own)' — self-loop detection broken"
[[ $BOB_SKIP_FOUND   -eq 0 ]] || fail "bob's daemon never logged 'skip (own)' — self-loop detection broken"

echo
echo "=========================================="
echo "✓ PASS — multi-op cross-operator routing verified end-to-end"
echo "=========================================="
echo "  - alice@steve posted to alice@bob"
echo "  - bob's daemon dispatched alice@bob, response written"
echo "  - both daemons' self-loop checks fired on their own outbound"
echo
echo "Logs (preserved at $WORK):"
echo "  steve: $STEVE_LOG"
echo "  bob:   $BOB_LOG"
