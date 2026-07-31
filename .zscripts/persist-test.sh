#!/usr/bin/env bash
# Verify DB persistence: sign up -> restart -> confirm waitlist survived.
set -u
cd /home/z/my-project
pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; sleep 2; rm -f dev.log

# Reset DB to a clean state for a deterministic test
rm -f db/custom.db db/custom.db-journal
bun x prisma db push --accept-data-loss >/dev/null 2>&1
echo "[p] db reset"

setsid bash -c 'exec bun x next dev -p 3000 > dev.log 2>&1' < /dev/null > /dev/null 2>&1 &
disown
for i in $(seq 1 30); do
  c=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo 000)
  [ "$c" = "200" ] && break; sleep 1
done
echo "[p] server ready"

B="http://21.0.3.203:81"
EMAIL="persist_test_$$_$(date +%s)@example.com"

echo ""
echo "===== STEP 1: sign up a new waitlist entry ====="
RESP=$(curl -s -X POST "$B/api/auth/sign-up" -H "Content-Type: application/json" -d "{\"name\":\"Persist Test\",\"email\":\"$EMAIL\",\"country\":\"Ghana\",\"interestedRoles\":[\"participant\"],\"reason\":\"persistence test\"}")
echo "$RESP"
ENTRY_ID=$(echo "$RESP" | grep -oE '"id":"[^"]+"' | head -1 | cut -d'"' -f4)
echo "entry id: $ENTRY_ID"

echo ""
echo "===== STEP 2: confirm it appears in the waitlist API (unauth, but route may be open) ====="
curl -s "$B/api/auth/waitlist" | head -c 400
echo ""

echo ""
echo "===== STEP 3: restart the server ====="
pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; sleep 3
rm -f dev.log
setsid bash -c 'exec bun x next dev -p 3000 > dev.log 2>&1' < /dev/null > /dev/null 2>&1 &
disown
for i in $(seq 1 30); do
  c=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo 000)
  [ "$c" = "200" ] && break; sleep 1
done
echo "[p] server restarted"

echo ""
echo "===== STEP 4: confirm the waitlist entry SURVIVED the restart ====="
RESP2=$(curl -s "$B/api/auth/waitlist")
echo "$RESP2" | head -c 600
echo ""
if echo "$RESP2" | grep -q "$EMAIL"; then
  echo ""
  echo "PASS: waitlist entry for $EMAIL survived server restart (DB-backed)."
else
  echo ""
  echo "FAIL: waitlist entry for $EMAIL NOT found after restart."
fi

echo ""
echo "===== STEP 5: also confirm a direct DB read ====="
bun -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.eksWaitlistEntry.findMany().then(r=>{console.log('DB rows:',r.length);r.forEach(x=>console.log(' -',x.email,x.status));}).finally(()=>p.\$disconnect());" 2>&1 | tail -10

pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null
echo "[p] done"
