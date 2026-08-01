#!/usr/bin/env bash
# Focused participant action tests using @refs directly (fixed ref extraction).
set +e
set -u
cd /home/z/my-project

LOG=/home/z/my-project/.zscripts/participant-actions2.log
echo "=== Participant action tests v2 started $(date) ===" | tee "$LOG"
log() { echo "$@" | tee -a "$LOG"; }

# Helper: extract first @eN ref from a snapshot line
extract_ref() {
  # $1 = the grep pattern (e.g. 'button "Complete"')
  # $2 = the snapshot text
  echo "$2" | grep "$1" | head -1 | sed -n 's/.*\(@e[0-9][0-9]*\).*/\1/p'
}

# Start dev server
pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null
pkill -9 -f "chrome" 2>/dev/null; pkill -9 -f "agent-browser" 2>/dev/null
sleep 2
rm -f db/custom.db db/custom.db-journal dev.log
bun x prisma db push --accept-data-loss >>"$LOG" 2>&1
setsid bash -c 'exec bun x next dev -p 3000 > dev.log 2>&1' < /dev/null > /dev/null 2>&1 &
disown
for i in $(seq 1 60); do
  c=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo 000)
  [ "$c" = "200" ] && break; sleep 1
done
log "server ready (HTTP $c)"

B="http://localhost:81"
timeout 30 agent-browser close >/dev/null 2>&1 || true
timeout 30 agent-browser cookies clear >/dev/null 2>&1 || true
timeout 60 agent-browser open "$B/sign-in" --timeout 30000 2>&1 | tee -a "$LOG" | head -3
sleep 2
timeout 30 agent-browser snapshot -i >/dev/null 2>&1 || true
timeout 30 agent-browser fill @e1 "ama@eks.health" 2>&1 | tee -a "$LOG"
timeout 30 agent-browser fill @e2 "DemoPass123!"   2>&1 | tee -a "$LOG"
timeout 30 agent-browser click @e3                 2>&1 | tee -a "$LOG"
timeout 30 agent-browser wait --url "**/dashboard" --timeout 20000 2>&1 | tee -a "$LOG"
timeout 30 agent-browser wait --text "Welcome" --timeout 20000 2>&1 | tee -a "$LOG"
sleep 3
timeout 20 agent-browser wait --load networkidle --timeout 12000 2>&1 | tee -a "$LOG"

url=$(timeout 15 agent-browser get url 2>/dev/null | tail -1)
log "Logged in URL: $url"

# Take snapshot to get refs
log ""
log "=== Initial dashboard snapshot ==="
snap=$(timeout 30 agent-browser snapshot -i 2>&1)
echo "$snap" | tee -a "$LOG"

# Parse refs using sed (more reliable than grep -oE)
complete_ref=$(extract_ref 'button "Complete"' "$snap")
record_ref=$(extract_ref 'button "Record"' "$snap")
# Plus buttons: lines like '- button [ref=e14]' (no text)
plus_ref=$(echo "$snap" | grep -E '^\- button \[ref=' | head -1 | sed -n 's/.*\(@e[0-9][0-9]*\).*/\1/p')
log ""
log "Parsed refs:"
log "  Complete button ref: $complete_ref"
log "  Record button ref:   $record_ref"
log "  Plus-button ref:     $plus_ref"

# ------- ACTION 1: Click "Complete" on a mission -------
log ""
log "========================================"
log "ACTION 1: Click 'Complete' on a mission"
log "========================================"
timeout 15 agent-browser errors --clear >/dev/null 2>&1 || true

# Count "Complete" buttons via JS
n_before=$(timeout 15 agent-browser eval "Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='Complete'||b.textContent.includes('Complete')).length" 2>&1 | tail -1)
log "Complete buttons before (via JS): $n_before"

if [ -n "$complete_ref" ]; then
  log "Clicking $complete_ref ..."
  click_out=$(timeout 30 agent-browser click "$complete_ref" 2>&1)
  log "click result: $click_out"
else
  log "No Complete ref found - skipping"
fi

sleep 5
timeout 15 agent-browser wait --load networkidle --timeout 10000 2>&1 | tee -a "$LOG"

# Check for toast
toast1=$(timeout 15 agent-browser eval "Array.from(document.querySelectorAll('[data-sonner-toast]')).map(e=>e.textContent||'').join(' || ').slice(0,300)" 2>&1 | tail -1)
log "Toast after Complete: '$toast1'"

# Check mission state - look for "Done" badges
done_count=$(timeout 15 agent-browser eval "Array.from(document.querySelectorAll('button,span,div')).filter(e=>e.textContent.trim()==='Done').length" 2>&1 | tail -1)
log "'Done' elements after: $done_count"

n_after=$(timeout 15 agent-browser eval "Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='Complete'||b.textContent.includes('Complete')).length" 2>&1 | tail -1)
log "Complete buttons after (via JS): $n_after"

log "Errors after Complete:"
timeout 15 agent-browser errors 2>&1 | tee -a "$LOG"

# Re-snapshot
log ""
log "Snapshot after Complete click:"
snap2=$(timeout 30 agent-browser snapshot -i 2>&1)
echo "$snap2" | tee -a "$LOG"

# ------- ACTION 2: Click habit check-in (+) button -------
log ""
log "========================================"
log "ACTION 2: Click habit check-in (+) button"
log "========================================"
timeout 15 agent-browser errors --clear >/dev/null 2>&1 || true

# Re-parse plus button ref from snap2
plus_ref2=$(echo "$snap2" | grep -E '^\- button \[ref=' | head -1 | sed -n 's/.*\(@e[0-9][0-9]*\).*/\1/p')
log "Plus-button ref (from snap2): $plus_ref2"

if [ -n "$plus_ref2" ]; then
  log "Clicking plus button $plus_ref2 ..."
  click_out=$(timeout 30 agent-browser click "$plus_ref2" 2>&1)
  log "click result: $click_out"
else
  log "No plus ref - trying JS"
  habit_click=$(timeout 15 agent-browser eval "(function(){var btns=Array.from(document.querySelectorAll('button'));var plusBtns=btns.filter(function(b){return b.querySelector('svg.lucide-plus')||b.innerHTML.indexOf('lucide-plus')>=0;});if(plusBtns.length===0)return 'no-plus-button-found';plusBtns[0].click();return 'clicked-plus-via-js';})()" 2>&1 | tail -1)
  log "JS click result: $habit_click"
fi

sleep 5
timeout 15 agent-browser wait --load networkidle --timeout 10000 2>&1 | tee -a "$LOG"

toast2=$(timeout 15 agent-browser eval "Array.from(document.querySelectorAll('[data-sonner-toast]')).map(e=>e.textContent||'').join(' || ').slice(0,300)" 2>&1 | tail -1)
log "Toast after habit check-in: '$toast2'"

log "Errors after habit check-in:"
timeout 15 agent-browser errors 2>&1 | tee -a "$LOG"

# ------- ACTION 3: Click "Record" to open measurement dialog -------
log ""
log "========================================"
log "ACTION 3: Click 'Record' to open measurement dialog"
log "========================================"
timeout 15 agent-browser errors --clear >/dev/null 2>&1 || true

# Re-snapshot to get fresh Record ref
snap3=$(timeout 30 agent-browser snapshot -i 2>&1)
record_ref3=$(extract_ref 'button "Record"' "$snap3")
log "Record button ref (fresh): $record_ref3"

if [ -n "$record_ref3" ]; then
  log "Clicking Record button $record_ref3 ..."
  click_out=$(timeout 30 agent-browser click "$record_ref3" 2>&1)
  log "click result: $click_out"
else
  log "No Record ref - trying CSS selector"
  timeout 30 agent-browser click "button:has-text('Record')" --timeout 10000 2>&1 | tee -a "$LOG"
fi

sleep 4
timeout 15 agent-browser wait --load networkidle --timeout 10000 2>&1 | tee -a "$LOG"

# Check dialog
dialog=$(timeout 15 agent-browser eval "(function(){var dlg=document.querySelector('[role=\"dialog\"]');if(!dlg)return 'NO DIALOG';var title=dlg.querySelector('h2, [class*=\"DialogTitle\"]');return 'DIALOG OPEN: title='+(title?title.textContent:'(no-title)')+' body='+dlg.textContent.slice(0,250);})()" 2>&1 | tail -1)
log "Dialog status: $dialog"

log "Errors after Record click:"
timeout 15 agent-browser errors 2>&1 | tee -a "$LOG"

# Snapshot dialog contents
log ""
log "=== Snapshot with dialog open ==="
snap4=$(timeout 30 agent-browser snapshot -i 2>&1)
echo "$snap4" | tee -a "$LOG"

# Cleanup
log ""
log "=== Cleanup ==="
timeout 15 agent-browser close >/dev/null 2>&1 || true
pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null
pkill -9 -f "chrome" 2>/dev/null
log "=== TEST COMPLETE $(date) ==="
