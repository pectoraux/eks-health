#!/usr/bin/env bash
# Single-session verification: start dev server, run browser checks, teardown.
set -u
cd /home/z/my-project

# 1. Kill any stale server
pkill -f "next dev" 2>/dev/null
pkill -f "next-server" 2>/dev/null
sleep 2
rm -f dev.log

# 2. Start dev server detached in its own session
setsid bash -c 'exec bun x next dev -p 3000 > dev.log 2>&1' < /dev/null > /dev/null 2>&1 &
disown
SRV_PID=$!
echo "[verify] launched server launcher pid=$SRV_PID"

# 3. Wait for server to be ready (max ~30s)
ready=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "[verify] SERVER FAILED TO START. dev.log:"
  cat dev.log
  exit 1
fi
echo "[verify] server ready (attempt $i)"

# 4. Close any prior browser session
agent-browser close >/dev/null 2>&1 || true

# 5. Helper: the browser can't reach localhost, so go through Caddy on :81
#    (Caddy reverse-proxies to localhost:3000 by default).
BASE="http://21.0.3.203:81"

run_check () {
  local name="$1"; shift
  echo ""
  echo "=============================================="
  echo "CHECK: $name"
  echo "=============================================="
  "$@"
}

# CHECK 1: Landing page renders
run_check "Landing page renders" bash -c '
  agent-browser open "$0" 2>&1 | tail -2
  sleep 2
  echo "--- interactive elements (first 30) ---"
  agent-browser snapshot -i 2>&1 | head -30
  echo "--- page title ---"
  agent-browser get title 2>&1 | tail -1
  echo "--- errors ---"
  agent-browser errors 2>&1 | head -10
' "$BASE/"

sleep 1

# CHECK 2: Sign-in page renders
run_check "Sign-in page renders" bash -c '
  agent-browser open "$0/sign-in" 2>&1 | tail -2
  sleep 2
  echo "--- interactive elements ---"
  agent-browser snapshot -i 2>&1 | head -25
  echo "--- errors ---"
  agent-browser errors 2>&1 | head -10
' "$BASE"

sleep 1

# CHECK 3: Sign-up page renders
run_check "Sign-up page renders" bash -c '
  agent-browser open "$0/sign-up" 2>&1 | tail -2
  sleep 2
  echo "--- interactive elements ---"
  agent-browser snapshot -i 2>&1 | head -25
' "$BASE"

sleep 1

# CHECK 4: Marketplace renders (public)
run_check "Marketplace page renders" bash -c '
  agent-browser open "$0/marketplace" 2>&1 | tail -2
  sleep 3
  echo "--- interactive elements (first 30) ---"
  agent-browser snapshot -i 2>&1 | head -30
  echo "--- text content sample ---"
  agent-browser snapshot 2>&1 | head -40
' "$BASE"

sleep 1

# CHECK 5: API health
run_check "API /api/dashboard returns 401 unauth" bash -c '
  code=$(curl -s -o /dev/null -w "%{http_code}" "$0/api/dashboard" 2>/dev/null)
  echo "HTTP $code"
  curl -s "$0/api/dashboard" 2>/dev/null | head -c 300
  echo ""
' "$BASE"

run_check "API /api/marketplace/listings returns data" bash -c '
  code=$(curl -s -o /dev/null -w "%{http_code}" "$0/api/marketplace/listings" 2>/dev/null)
  echo "HTTP $code"
  curl -s "$0/api/marketplace/listings" 2>/dev/null | head -c 500
  echo ""
' "$BASE"

# 6. Teardown
echo ""
echo "[verify] closing browser"
agent-browser close >/dev/null 2>&1 || true
echo "[verify] done (leaving server running for further manual checks)"
