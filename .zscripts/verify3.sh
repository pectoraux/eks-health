#!/usr/bin/env bash
# Deep dashboard inspection.
set -u
cd /home/z/my-project

pkill -f "next dev" 2>/dev/null
pkill -f "next-server" 2>/dev/null
sleep 2
rm -f dev.log

setsid bash -c 'exec bun x next dev -p 3000 > dev.log 2>&1' < /dev/null > /dev/null 2>&1 &
disown

ready=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 1
done
[ "$ready" != "1" ] && { echo "SERVER FAILED"; cat dev.log; exit 1; }
echo "[verify3] server ready"

agent-browser close >/dev/null 2>&1 || true
BASE="http://21.0.3.203:81"

echo ""
echo "===== SIGN IN AS PARTICIPANT ====="
agent-browser open "$BASE/sign-in" 2>&1 | tail -1
sleep 2
agent-browser snapshot -i >/dev/null 2>&1
agent-browser fill @e1 "ama@eks.health" 2>&1 | tail -1
agent-browser fill @e2 "DemoPass123!" 2>&1 | tail -1
agent-browser click @e3 2>&1 | tail -1
agent-browser wait --url "/dashboard" 2>&1 | tail -1
sleep 5

echo ""
echo "===== DASHBOARD: FULL SNAPSHOT (compact) ====="
agent-browser snapshot -c 2>&1 | head -120

echo ""
echo "===== DASHBOARD: CONSOLE ERRORS ====="
agent-browser errors 2>&1 | head -30

echo ""
echo "===== DASHBOARD: NETWORK REQUESTS (filter api) ====="
agent-browser network requests --filter api 2>&1 | head -40

echo ""
echo "===== DASHBOARD API via browser eval (fetch with credentials) ====="
agent-browser eval "fetch('/api/dashboard', {credentials:'include'}).then(r=>r.text()).then(t=>t.slice(0,2000))" 2>&1 | head -60

echo ""
echo "===== DEV LOG (requests during this session) ====="
tail -40 dev.log

echo ""
echo "[verify3] closing"
agent-browser close >/dev/null 2>&1 || true
echo "[verify3] done"
