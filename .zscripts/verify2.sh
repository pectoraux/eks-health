#!/usr/bin/env bash
# Authenticated flow verification.
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
if [ "$ready" != "1" ]; then echo "SERVER FAILED"; cat dev.log; exit 1; fi
echo "[verify2] server ready"

agent-browser close >/dev/null 2>&1 || true
BASE="http://21.0.3.203:81"

echo ""
echo "===== RE-CHECK LANDING (longer wait) ====="
agent-browser open "$BASE/" 2>&1 | tail -2
sleep 5
echo "--- interactive elements (first 40) ---"
agent-browser snapshot -i 2>&1 | head -40
echo "--- errors ---"
agent-browser errors 2>&1 | head -10

echo ""
echo "===== SIGN IN AS PARTICIPANT (ama@eks.health) ====="
agent-browser open "$BASE/sign-in" 2>&1 | tail -2
sleep 2
agent-browser snapshot -i 2>&1 | head -20
echo "--- filling email ---"
agent-browser fill @e1 "ama@eks.health" 2>&1 | tail -1
echo "--- filling password ---"
agent-browser fill @e2 "DemoPass123!" 2>&1 | tail -1
echo "--- clicking Sign In ---"
agent-browser click @e3 2>&1 | tail -1
sleep 4
echo "--- url after sign in ---"
agent-browser get url 2>&1 | tail -1
echo "--- dashboard interactive (first 40) ---"
agent-browser snapshot -i 2>&1 | head -40
echo "--- errors ---"
agent-browser errors 2>&1 | head -15

echo ""
echo "===== DASHBOARD API (with session cookie) ====="
# Capture cookies from the browser session
COOKIES=$(agent-browser cookies 2>&1)
echo "cookies present: $(echo "$COOKIES" | grep -c eks_)"
# Try the dashboard API via curl using the cookie
SESS=$(echo "$COOKIES" | grep eks_session | awk '{print $2}' | cut -d= -f2 | cut -d\; -f1)
ACC=$(echo "$COOKIES" | grep eks_access | awk '{print $2}' | cut -d= -f2 | cut -d\; -f1)
echo "session cookie length: ${#SESS}"
echo "access cookie length: ${#ACC}"
if [ -n "$SESS" ] && [ -n "$ACC" ]; then
  echo "--- /api/dashboard with cookies ---"
  curl -s -H "Cookie: eks_session=$SESS; eks_access=$ACC" "$BASE/api/dashboard" 2>/dev/null | head -c 1500
  echo ""
fi

echo ""
echo "===== CONSOLE PAGE ====="
agent-browser open "$BASE/console" 2>&1 | tail -2
sleep 3
agent-browser snapshot -i 2>&1 | head -30
agent-browser errors 2>&1 | head -10

echo ""
echo "===== DASHBOARD > TIMELINE ====="
agent-browser open "$BASE/dashboard/timeline" 2>&1 | tail -2
sleep 2
agent-browser snapshot -i 2>&1 | head -20
agent-browser errors 2>&1 | head -10

echo ""
echo "===== DASHBOARD > SETTINGS ====="
agent-browser open "$BASE/dashboard/settings" 2>&1 | tail -2
sleep 2
agent-browser snapshot -i 2>&1 | head -20
agent-browser errors 2>&1 | head -10

echo ""
echo "[verify2] closing"
agent-browser close >/dev/null 2>&1 || true
echo "[verify2] done"
