#!/usr/bin/env bash
# Browser verification of all 6 role dashboards
set -u
cd /home/z/my-project
pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; pkill -f "agent-browser" 2>/dev/null
sleep 2; rm -f dev.log
rm -f db/custom.db db/custom.db-journal
bun x prisma db push --accept-data-loss >/dev/null 2>&1

setsid bash -c 'exec bun x next dev -p 3000 > dev.log 2>&1' < /dev/null > /dev/null 2>&1 &
disown
for i in $(seq 1 30); do
  c=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo 000)
  [ "$c" = "200" ] && break; sleep 1
done
echo "server ready ${i}s"

agent-browser close >/dev/null 2>&1
B="http://21.0.3.203:81"

test_role() {
  local role="$1" email="$2" pw="$3"
  echo ""
  echo "=============================================="
  echo "TESTING: $role ($email)"
  echo "=============================================="
  agent-browser open "$B/sign-in" >/dev/null 2>&1
  sleep 2
  agent-browser snapshot -i >/dev/null 2>&1
  agent-browser fill @e1 "$email" >/dev/null 2>&1
  agent-browser fill @e2 "$pw" >/dev/null 2>&1
  agent-browser click @e3 >/dev/null 2>&1
  sleep 4
  local url=$(agent-browser get url 2>&1 | tail -1)
  echo "URL: $url"
  echo "--- interactive elements (first 25) ---"
  agent-browser snapshot -i 2>&1 | head -25
  echo "--- errors ---"
  agent-browser errors 2>&1 | head -5
}

test_role "PARTICIPANT" "ama@eks.health" "DemoPass123!"
test_role "TECHNICIAN" "clinic@eks.health" "DemoPass123!"
test_role "DEVELOPER" "kwame@eks.health" "DemoPass123!"
test_role "RESEARCHER" "research@eks.health" "DemoPass123!"
test_role "ORG ADMIN" "admin@eks.health" "DemoPass123!"
test_role "PLATFORM ADMIN" "ekontetevi@gmail.com" "Payswap123456"

echo ""
echo "=============================================="
echo "DONE - closing browser"
echo "=============================================="
agent-browser close >/dev/null 2>&1
pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null
