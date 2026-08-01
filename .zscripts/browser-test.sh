#!/usr/bin/env bash
# Browser verification of all 6 role dashboards + participant action tests.
# Runs entirely in one bash session: starts dev server, runs tests, kills server.
set +e
set -u
cd /home/z/my-project

LOG=/home/z/my-project/.zscripts/browser-test-output.log
TRACE=/home/z/my-project/.zscripts/browser-test-trace.log
SNAP_DIR=/tmp/zsnap
mkdir -p "$SNAP_DIR"
: > "$TRACE"
echo "=== Browser test started $(date) ===" | tee "$LOG"

# Trace all commands to a separate file (stderr)
exec 2>>"$TRACE"

log() { echo "$@" | tee -a "$LOG"; }

# ---------------- 1. Reset DB & start dev server ----------------
log ""
log "[1] Resetting DB and starting dev server..."
pkill -f "next dev" 2>/dev/null
pkill -f "next-server" 2>/dev/null
pkill -9 -f "chrome" 2>/dev/null
pkill -9 -f "agent-browser" 2>/dev/null
sleep 2
rm -f db/custom.db db/custom.db-journal dev.log
bun x prisma db push --accept-data-loss >>"$LOG" 2>&1
log "prisma done"

setsid bash -c 'exec bun x next dev -p 3000 > dev.log 2>&1' < /dev/null > /dev/null 2>&1 &
disown
log "dev server starting..."

c="000"
i=0
for i in $(seq 1 60); do
  c=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo 000)
  [ "$c" = "200" ] && break
  sleep 1
done
log "server ready after ${i}s (HTTP $c)"

B="http://localhost:81"
log "Base URL: $B"
GATE_CHECK=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "$B/sign-in" 2>/dev/null || echo 000)
log "Gateway /sign-in check: $GATE_CHECK"

timeout --kill-after=2s 30s agent-browser close >/dev/null 2>&1 || true
log "browser closed (pre-test)"

# ---------------- 2. Per-role dashboard test ----------------
test_role() {
  local role="$1" email="$2" pw="$3"
  local safe="${role// /_}"
  log ""
  log "=============================================="
  log "TESTING: $role ($email)"
  log "=============================================="

  timeout --kill-after=2s 30s agent-browser cookies clear >/dev/null 2>&1 || true
  log "cookies cleared"

  timeout --kill-after=2s 60s agent-browser open "$B/sign-in" --timeout 30000 2>&1 | tee -a "$LOG" | head -5
  log "opened sign-in page"

  sleep 2
  timeout --kill-after=2s 30s agent-browser snapshot -i 2>&1 | tee -a "$LOG" | head -20
  log "snapshot taken"

  timeout --kill-after=2s 30s agent-browser fill @e1 "$email" 2>&1 | tee -a "$LOG"
  timeout --kill-after=2s 30s agent-browser fill @e2 "$pw"   2>&1 | tee -a "$LOG"
  timeout --kill-after=2s 30s agent-browser click @e3        2>&1 | tee -a "$LOG"
  log "filled form & clicked sign in"

  # Wait for redirect to /dashboard
  timeout --kill-after=2s 30s agent-browser wait --url "**/dashboard" --timeout 20000 2>&1 | tee -a "$LOG"
  # Wait for dashboard content
  timeout --kill-after=2s 30s agent-browser wait --text "Welcome" --timeout 20000 2>&1 | tee -a "$LOG"
  sleep 2
  timeout --kill-after=2s 20s agent-browser wait --load networkidle --timeout 12000 2>&1 | tee -a "$LOG"
  log "waits done"

  local url
  url=$(timeout --kill-after=2s 15s agent-browser get url 2>/dev/null | tail -1)
  log "URL after login: $url"

  log ""
  log "--- interactive elements (snapshot -i) ---"
  local snap
  snap=$(timeout --kill-after=2s 30s agent-browser snapshot -i 2>&1)
  echo "$snap" | tee -a "$LOG"
  echo "$snap" > "$SNAP_DIR/snap_${safe}.txt"

  local count
  count=$(echo "$snap" | grep -c "ref=" 2>/dev/null || true)
  log ""
  log "Interactive element count: $count"

  log ""
  log "--- console errors ---"
  timeout --kill-after=2s 15s agent-browser errors 2>&1 | tee -a "$LOG"

  log ""
  log "--- console messages (last 15) ---"
  timeout --kill-after=2s 15s agent-browser console 2>&1 | tail -15 | tee -a "$LOG"
}

# ---------------- 3. Participant-specific action tests ----------------
test_participant_actions() {
  log ""
  log "##############################################"
  log "PARTICIPANT ACTION TESTS"
  log "##############################################"

  timeout --kill-after=2s 30s agent-browser cookies clear >/dev/null 2>&1 || true
  timeout --kill-after=2s 60s agent-browser open "$B/sign-in" --timeout 30000 2>&1 | tee -a "$LOG" | head -3
  sleep 2
  timeout --kill-after=2s 30s agent-browser snapshot -i >/dev/null 2>&1 || true
  timeout --kill-after=2s 30s agent-browser fill @e1 "ama@eks.health" 2>&1 | tee -a "$LOG"
  timeout --kill-after=2s 30s agent-browser fill @e2 "DemoPass123!"   2>&1 | tee -a "$LOG"
  timeout --kill-after=2s 30s agent-browser click @e3                 2>&1 | tee -a "$LOG"
  timeout --kill-after=2s 30s agent-browser wait --url "**/dashboard" --timeout 20000 2>&1 | tee -a "$LOG"
  timeout --kill-after=2s 30s agent-browser wait --text "Welcome" --timeout 20000 2>&1 | tee -a "$LOG"
  sleep 3
  timeout --kill-after=2s 20s agent-browser wait --load networkidle --timeout 12000 2>&1 | tee -a "$LOG"

  local url
  url=$(timeout --kill-after=2s 15s agent-browser get url 2>/dev/null | tail -1)
  log "Logged in URL: $url"

  local snap0
  snap0=$(timeout --kill-after=2s 30s agent-browser snapshot -i 2>&1)
  echo "$snap0" > "$SNAP_DIR/snap_participant_actions.txt"
  log ""
  log "Pre-action snapshot (interactive elements):"
  echo "$snap0" | tee -a "$LOG"

  # ------- Action 1: Click "Complete" on a mission -------
  log ""
  log "--- ACTION 1: Click 'Complete' on a mission ---"
  timeout --kill-after=2s 15s agent-browser errors --clear >/dev/null 2>&1 || true

  local n_complete_before
  n_complete_before=$(timeout --kill-after=2s 15s agent-browser get count "button:has-text('Complete')" 2>/dev/null | tail -1 | tr -d -c '0-9')
  log "Complete buttons before: ${n_complete_before:-0}"

  local complete_out
  complete_out=$(timeout --kill-after=2s 30s agent-browser find text "Complete" click --timeout 10000 2>&1)
  log "find text 'Complete' click -> $complete_out"

  sleep 4
  timeout --kill-after=2s 15s agent-browser wait --load networkidle --timeout 8000 2>&1 | tee -a "$LOG"

  local toast1
  toast1=$(timeout --kill-after=2s 15s agent-browser eval "Array.from(document.querySelectorAll('[data-sonner-toast], [role=\"status\"]')).map(e=>e.textContent||'').join(' || ').slice(0,300)" 2>&1 | tail -1)
  log "Toast after Complete: $toast1"

  local n_complete_after
  n_complete_after=$(timeout --kill-after=2s 15s agent-browser get count "button:has-text('Complete')" 2>/dev/null | tail -1 | tr -d -c '0-9')
  log "Complete buttons after: ${n_complete_after:-0}"

  log "Errors after Complete:"
  timeout --kill-after=2s 15s agent-browser errors 2>&1 | tee -a "$LOG"

  # ------- Action 2: Click habit check-in (+) button -------
  log ""
  log "--- ACTION 2: Click habit check-in (+) button ---"
  timeout --kill-after=2s 15s agent-browser errors --clear >/dev/null 2>&1 || true

  # Click the first non-disabled button inside the Habit Streaks card via JS eval
  local habit_click
  habit_click=$(timeout --kill-after=2s 15s agent-browser eval "(function(){var cards=Array.from(document.querySelectorAll('div'));var habitCard=cards.find(function(c){var h=c.querySelector('h3');return h&&h.textContent.indexOf('Habit Streaks')>=0;});if(!habitCard)return 'no-habit-card';var btns=Array.from(habitCard.querySelectorAll('button:not([disabled])')).filter(function(b){return !b.textContent.trim()||b.innerHTML.indexOf('lucide-plus')>=0;});if(btns.length===0)return 'no-plus-button-in-habit-card';btns[0].click();return 'clicked-first-plus';})()" 2>&1 | tail -1)
  log "Habit + click result: $habit_click"

  sleep 4
  timeout --kill-after=2s 15s agent-browser wait --load networkidle --timeout 8000 2>&1 | tee -a "$LOG"

  local toast2
  toast2=$(timeout --kill-after=2s 15s agent-browser eval "Array.from(document.querySelectorAll('[data-sonner-toast], [role=\"status\"]')).map(e=>e.textContent||'').join(' || ').slice(0,300)" 2>&1 | tail -1)
  log "Toast after habit check-in: $toast2"

  log "Errors after habit check-in:"
  timeout --kill-after=2s 15s agent-browser errors 2>&1 | tee -a "$LOG"

  # ------- Action 3: Click "Record" to open measurement dialog -------
  log ""
  log "--- ACTION 3: Click 'Record' to open measurement dialog ---"
  timeout --kill-after=2s 15s agent-browser errors --clear >/dev/null 2>&1 || true

  local record_out
  record_out=$(timeout --kill-after=2s 30s agent-browser find text "Record" click --timeout 10000 2>&1)
  log "find text 'Record' click -> $record_out"

  sleep 3
  timeout --kill-after=2s 15s agent-browser wait --load networkidle --timeout 8000 2>&1 | tee -a "$LOG"

  local dialog
  dialog=$(timeout --kill-after=2s 15s agent-browser eval "(function(){var dlg=document.querySelector('[role=\"dialog\"]');if(!dlg)return 'NO DIALOG';var title=dlg.querySelector('h2, [class*=\"DialogTitle\"]');return 'DIALOG OPEN: title='+(title?title.textContent:'(no-title)')+' body='+dlg.textContent.slice(0,200);})()" 2>&1 | tail -1)
  log "Dialog status: $dialog"

  log "Errors after Record click:"
  timeout --kill-after=2s 15s agent-browser errors 2>&1 | tee -a "$LOG"

  local dlg_snap
  dlg_snap=$(timeout --kill-after=2s 30s agent-browser snapshot -i 2>&1)
  log ""
  log "--- interactive elements inside dialog ---"
  echo "$dlg_snap" | tee -a "$LOG"
  echo "$dlg_snap" > "$SNAP_DIR/snap_participant_dialog.txt"

  timeout --kill-after=2s 10s agent-browser press Escape >/dev/null 2>&1 || true
  sleep 1
}

# ---------------- 4. Run all role tests ----------------
test_role "PARTICIPANT"       "ama@eks.health"        "DemoPass123!"
test_role "TECHNICIAN"        "clinic@eks.health"     "DemoPass123!"
test_role "DEVELOPER"         "kwame@eks.health"      "DemoPass123!"
test_role "RESEARCHER"        "research@eks.health"   "DemoPass123!"
test_role "ORG_ADMIN"         "admin@eks.health"      "DemoPass123!"
test_role "PLATFORM_ADMIN"    "ekontetevi@gmail.com"  "Payswap123456"

# ---------------- 5. Run participant action tests ----------------
test_participant_actions

# ---------------- 6. Cleanup ----------------
log ""
log "=== Cleanup ==="
timeout --kill-after=2s 15s agent-browser close >/dev/null 2>&1 || true
pkill -f "next dev" 2>/dev/null
pkill -f "next-server" 2>/dev/null
pkill -9 -f "chrome" 2>/dev/null

log ""
log "=== TEST COMPLETE $(date) ==="
