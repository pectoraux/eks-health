#!/usr/bin/env bash
set -u
cd /home/z/my-project
pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; sleep 2; rm -f dev.log
setsid bash -c 'exec bun x next dev -p 3000 > dev.log 2>&1' < /dev/null > /dev/null 2>&1 &
disown
for i in $(seq 1 30); do
  c=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo 000)
  [ "$c" = "200" ] && break; sleep 1
done
echo "[v5] server ready"
agent-browser close >/dev/null 2>&1
B="http://21.0.3.203:81"
agent-browser open "$B/sign-in" >/dev/null 2>&1; sleep 2
agent-browser snapshot -i >/dev/null 2>&1
agent-browser fill @e1 "ama@eks.health" >/dev/null 2>&1
agent-browser fill @e2 "DemoPass123!" >/dev/null 2>&1
agent-browser click @e3 >/dev/null 2>&1
sleep 6
echo "URL: $(agent-browser get url 2>&1 | tail -1)"
echo "=== DASHBOARD COMPACT (100 lines) ==="
agent-browser snapshot -c 2>&1 | head -100
echo "=== ERRORS ==="
agent-browser errors 2>&1 | head -20
echo "=== API status via eval ==="
agent-browser eval "fetch('/api/dashboard',{credentials:'include'}).then(r=>r.status).catch(e=>String(e))" 2>&1 | tail -3
agent-browser close >/dev/null 2>&1
echo "[v5] done"
