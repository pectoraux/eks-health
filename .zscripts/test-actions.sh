#!/usr/bin/env bash
set -u
cd /home/z/my-project
pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; sleep 1; rm -f dev.log
setsid bash -c 'exec bun x next dev -p 3000 > dev.log 2>&1' < /dev/null > /dev/null 2>&1 &
disown
for i in $(seq 1 30); do
  c=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo 000)
  [ "$c" = "200" ] && break; sleep 1
done
echo "server ready ${i}s"

# Sign in as participant
curl -s -c /tmp/p.txt -X POST "http://localhost:3000/api/auth/sign-in" -H "Content-Type: application/json" -d '{"email":"ama@eks.health","password":"DemoPass123!"}' -o /dev/null
echo "participant signed in"

# Get habit ID
HABIT_ID=$(curl -s -b /tmp/p.txt "http://localhost:3000/api/missions/habits" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['habits'][0]['id'])" 2>/dev/null)
echo "habit id: $HABIT_ID"

# Test habit check-in
echo "=== HABIT CHECK-IN ==="
curl -s -b /tmp/p.txt -X POST "http://localhost:3000/api/missions/habits" -H "Content-Type: application/json" -d "{\"habitId\":\"$HABIT_ID\",\"action\":\"complete\"}"
echo ""

# Get goal ID
GOAL_ID=$(curl -s -b /tmp/p.txt "http://localhost:3000/api/missions/goals" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['goals'][0]['id'])" 2>/dev/null)
echo "goal id: $GOAL_ID"

# Test goal update progress
echo "=== GOAL UPDATE PROGRESS ==="
curl -s -b /tmp/p.txt -X POST "http://localhost:3000/api/missions/goals" -H "Content-Type: application/json" -d "{\"goalId\":\"$GOAL_ID\",\"action\":\"updateProgress\",\"currentValue\":62}"
echo ""

# Get competition ID
COMP_ID=$(curl -s "http://localhost:3000/api/competitions/list" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['competitions'][0]['id'])" 2>/dev/null)
echo "competition id: $COMP_ID"

# Test competition join
echo "=== COMPETITION JOIN ==="
curl -s -b /tmp/p.txt -X POST "http://localhost:3000/api/competitions/join" -H "Content-Type: application/json" -d "{\"competitionId\":\"$COMP_ID\"}"
echo ""

# Get schema + source IDs
SCHEMA_ID=$(curl -s "http://localhost:3000/api/health/schemas" | python3 -c "import sys,json; d=json.load(sys.stdin); ss=d['data'] if isinstance(d.get('data'),list) else d['data'].get('schemas',[]); print(ss[0]['id'])" 2>/dev/null)
echo "schema id: $SCHEMA_ID"

# Test record measurement
echo "=== RECORD MEASUREMENT ==="
curl -s -b /tmp/p.txt -X POST "http://localhost:3000/api/health/measurements" -H "Content-Type: application/json" -d "{\"schemaId\":\"$SCHEMA_ID\",\"profileId\":\"prof_demo_1\",\"value\":72,\"unitId\":\"bpm\",\"sourceId\":\"src_wearable\",\"collectedBy\":\"self\",\"tags\":[\"test\"]}"
echo ""

# Test waitlist sign-up
echo "=== WAITLIST SIGN-UP ==="
curl -s -X POST "http://localhost:3000/api/auth/sign-up" -H "Content-Type: application/json" -d '{"name":"Test User","email":"testuser@example.com","country":"Ghana","interestedRoles":["participant"],"reason":"testing"}'
echo ""

# Sign in as admin and approve waitlist
curl -s -c /tmp/a.txt -X POST "http://localhost:3000/api/auth/sign-in" -H "Content-Type: application/json" -d '{"email":"ekontetevi@gmail.com","password":"Payswap123456"}' -o /dev/null
WL_ID=$(curl -s -b /tmp/a.txt "http://localhost:3000/api/auth/waitlist" | python3 -c "import sys,json; d=json.load(sys.stdin); wl=d['data']; print(wl[0]['id'] if wl else '')" 2>/dev/null)
echo "waitlist id: $WL_ID"

if [ -n "$WL_ID" ]; then
  echo "=== WAITLIST APPROVE ==="
  curl -s -b /tmp/a.txt -X POST "http://localhost:3000/api/auth/waitlist/$WL_ID/approve" -w "\nHTTP: %{http_code}\n"
fi

# Check for errors
echo ""
echo "=== DEV LOG ERRORS ==="
grep -cE "error|fail|cannot" dev.log | xargs echo "count:"
grep -iE "error|fail" dev.log | grep -v "compile\|node_modules" | tail -5 || echo "none"

pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null
echo "done"
