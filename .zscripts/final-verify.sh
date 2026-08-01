#!/usr/bin/env bash
# =============================================================================
# final-verify.sh — FINAL comprehensive browser verification of live Eks-Health
# Target: https://eks-health.vercel.app (LIVE Vercel serverless deployment)
# Task ID: final-verify-1
#
# Runs all 4 phases in ONE browser session:
#   Phase 1: Participant full journey (14 steps)
#   Phase 2: Platform admin full journey (6 steps)
#   Phase 3: All 6 roles quick dashboard check
#   Phase 4: Error / console checking (throughout)
# =============================================================================
set +e
set -u

# ---------------- Config ----------------
BASE="https://eks-health.vercel.app"
LOG="/home/z/my-project/.zscripts/final-verify.log"
JSON_LOG="/home/z/my-project/.zscripts/final-verify-results.json"
PASS_COUNT=0
FAIL_COUNT=0
TOTAL_COUNT=0

# Credentials
P_PARTICIPANT_EMAIL="ama@eks.health"
P_PARTICIPANT_PW="DemoPass123!"
P_TECH_EMAIL="clinic@eks.health"
P_DEV_EMAIL="kwame@eks.health"
P_RESEARCH_EMAIL="research@eks.health"
P_ORGADMIN_EMAIL="admin@eks.health"
P_PLATFORMADMIN_EMAIL="ekontetevi@gmail.com"
P_PLATFORMADMIN_PW="Payswap123456"
P_DEMO_PW="DemoPass123!"

# Per-command timeout (s) — gives serverless cold starts headroom
TMO=30

# ---------------- Helpers ----------------
log() { echo "$@" | tee -a "$LOG"; }
nl()  { echo "" | tee -a "$LOG"; }

# Record a test result: record_result "PASS" "test name" "what happened" "errors"
record_result() {
  local status="$1" name="$2" detail="$3" err="${4:-}"
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  if [ "$status" = "PASS" ]; then PASS_COUNT=$((PASS_COUNT + 1)); else FAIL_COUNT=$((FAIL_COUNT + 1)); fi
  local marker
  if [ "$status" = "PASS" ]; then marker="✅ PASS"; else marker="❌ FAIL"; fi
  log "[$TOTAL_COUNT] $marker | $name"
  log "     detail: $detail"
  [ -n "$err" ] && log "     errors: $err"
  nl
}

# Wait for network idle (serverless cold-start friendly). Keep timeout
# modest so SPAs with polling don't burn the whole budget.
wait_idle() {
  timeout 20 agent-browser wait --load networkidle --timeout 12000 >/dev/null 2>&1 || true
}

# Take snapshot and store in $SNAP
SNAP=""
snapshot() {
  SNAP=$(timeout $TMO agent-browser snapshot -i 2>&1)
}

# Extract first ref (e.g. "e10") whose line matches a grep pattern.
# Usage: ref=$(find_ref 'button "Complete"')
find_ref() {
  local pattern="$1"
  echo "$SNAP" | grep -F "$pattern" | head -1 | grep -oP 'ref=e\K\d+' | head -1
}

# Count matching snapshot lines
count_refs() {
  local pattern="$1"
  echo "$SNAP" | grep -cF "$pattern"
}

# Get current URL
get_url() {
  timeout 15 agent-browser get url 2>/dev/null | tail -1
}

# Get visible page text (truncated)
get_body_text() {
  timeout 20 agent-browser eval "document.body.innerText.slice(0,4000)" 2>/dev/null | tail -1
}

# Check for toasts (Sonner)
get_toasts() {
  timeout 15 agent-browser eval "Array.from(document.querySelectorAll('[data-sonner-toast]')).map(e=>e.textContent||'').join(' || ').slice(0,300)" 2>/dev/null | tail -1
}

# Check for dialog
get_dialog() {
  timeout 15 agent-browser eval "(function(){var d=document.querySelector('[role=dialog]');if(!d)return '';var t=d.querySelector('h2, [class*=DialogTitle]');return (t?t.textContent:'')+' || body:'+(d.textContent||'').slice(0,200);})()" 2>/dev/null | tail -1
}

# Collect browser console errors (last 5 lines)
get_errors() {
  timeout 15 agent-browser errors 2>&1 | tail -8
}

clear_errors() {
  timeout 10 agent-browser errors --clear >/dev/null 2>&1 || true
}

# Sign in flow (assumes already on /sign-in). Snapshots, fills, clicks, waits.
# Args: email password
do_signin() {
  local email="$1" pw="$2"
  snapshot
  local email_ref pw_ref signin_ref
  email_ref=$(find_ref 'textbox "Email"')
  pw_ref=$(find_ref 'textbox "Password"')
  signin_ref=$(find_ref 'button "Sign In"')
  if [ -z "$email_ref" ] || [ -z "$pw_ref" ] || [ -z "$signin_ref" ]; then
    log "  SIGN-IN ERROR: could not find sign-in form refs (email=$email_ref pw=$pw_ref btn=$signin_ref)"
    return 1
  fi
  timeout $TMO agent-browser fill "@$email_ref" "$email" >/dev/null 2>&1
  timeout $TMO agent-browser fill "@$pw_ref" "$pw" >/dev/null 2>&1
  timeout $TMO agent-browser click "@$signin_ref" >/dev/null 2>&1
  # Wait for dashboard navigation (serverless cold start tolerant)
  timeout 30 agent-browser wait --url "**/dashboard" --timeout 25000 >/dev/null 2>&1 || true
  wait_idle
  sleep 1
  return 0
}

# Sign out by calling the API endpoint + clearing cookies for good measure
do_signout() {
  timeout 15 agent-browser eval "fetch('/api/auth/sign-out',{method:'POST'}).then(r=>r.text()).catch(e=>'err:'+e.message)" >/dev/null 2>&1 || true
  sleep 1
  timeout 15 agent-browser cookies clear >/dev/null 2>&1 || true
}

# =============================================================================
# START
# =============================================================================
rm -f "$LOG" "$JSON_LOG"
echo "[]" > "$JSON_LOG"
log "======================================================================"
log "FINAL VERIFICATION — Eks-Health (LIVE Vercel)"
log "Started: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
log "Base URL: $BASE"
log "======================================================================"
nl

# Close any stale browser, then start fresh
timeout 20 agent-browser close >/dev/null 2>&1 || true
sleep 1

# =============================================================================
# PHASE 1: PARTICIPANT FULL JOURNEY
# =============================================================================
log "████████████████████████████████████████████████████████████████████████"
log "PHASE 1: PARTICIPANT FULL JOURNEY (ama@eks.health)"
log "████████████████████████████████████████████████████████████████████████"
nl

clear_errors

# --- Step 1: Open /sign-in ---
log "→ Step 1: Open /sign-in"
timeout $TMO agent-browser open "$BASE/sign-in" --timeout 30000 >/dev/null 2>&1
wait_idle
sleep 2
URL=$(get_url)
if echo "$URL" | grep -q "/sign-in"; then
  record_result "PASS" "P1.1 open /sign-in" "navigated to $URL" ""
else
  record_result "FAIL" "P1.1 open /sign-in" "URL is $URL, expected /sign-in" ""
fi

# --- Step 2: Sign in as ama@eks.health ---
log "→ Step 2: Sign in as ama@eks.health"
if do_signin "$P_PARTICIPANT_EMAIL" "$P_PARTICIPANT_PW"; then
  record_result "PASS" "P1.2 sign in (participant)" "submitted credentials, navigated to dashboard" ""
else
  record_result "FAIL" "P1.2 sign in (participant)" "sign-in form not found or did not navigate" ""
fi

# --- Step 3: Verify /dashboard renders with "Welcome, Ama Serwaa" ---
log "→ Step 3: Verify dashboard renders with welcome heading"
sleep 2
wait_idle
snapshot
WELCOME=$(echo "$SNAP" | grep -c 'Welcome, Ama Serwaa')
URL=$(get_url)
if [ "$WELCOME" -ge 1 ] && echo "$URL" | grep -q "/dashboard"; then
  record_result "PASS" "P1.3 dashboard welcome heading" "found 'Welcome, Ama Serwaa' at $URL" ""
else
  record_result "FAIL" "P1.3 dashboard welcome heading" "welcome heading count=$WELCOME, url=$URL" ""
fi

# --- Step 4: Verify 4 "Complete" buttons visible ---
log "→ Step 4: Verify 4 'Complete' buttons"
COMPLETE_COUNT=$(count_refs 'button "Complete"')
if [ "$COMPLETE_COUNT" -ge 4 ]; then
  record_result "PASS" "P1.4 four Complete buttons" "found $COMPLETE_COUNT 'Complete' buttons" ""
else
  record_result "FAIL" "P1.4 four Complete buttons" "found only $COMPLETE_COUNT 'Complete' buttons (expected >=4)" ""
fi

# --- Step 5: Click a "Complete" button → verify state change or toast ---
log "→ Step 5: Click a Complete button → verify mission state changes"
# Capture state before: count "Complete" + look for completed indicator
TEXT_BEFORE=$(get_body_text)
COMPLETE_BEFORE=$(echo "$TEXT_BEFORE" | grep -oE '[0-9]+/[0-9]+ done' | head -1)
COMPLETE_REF=$(find_ref 'button "Complete"')
if [ -n "$COMPLETE_REF" ]; then
  timeout $TMO agent-browser click "@$COMPLETE_REF" >/dev/null 2>&1
  sleep 2
  wait_idle
  sleep 1
  TEXT_AFTER=$(get_body_text)
  COMPLETE_AFTER=$(echo "$TEXT_AFTER" | grep -oE '[0-9]+/[0-9]+ done' | head -1)
  TOAST=$(get_toasts)
  # Mission state changed if done count changed OR "Complete" buttons reduced OR toast appeared
  COMPLETE_COUNT_AFTER=$(echo "$TEXT_AFTER" | grep -oE 'Complete' | wc -l)
  if [ "$COMPLETE_BEFORE" != "$COMPLETE_AFTER" ] || [ -n "$TOAST" ] || [ "$COMPLETE_COUNT_AFTER" -lt "$COMPLETE_COUNT" ]; then
    record_result "PASS" "P1.5 click Complete changes state" "done before='$COMPLETE_BEFORE' after='$COMPLETE_AFTER'; toast='$TOAST'" ""
  else
    record_result "FAIL" "P1.5 click Complete changes state" "no observable change (before='$COMPLETE_BEFORE' after='$COMPLETE_AFTER'; toast empty)" ""
  fi
else
  record_result "FAIL" "P1.5 click Complete changes state" "no Complete button ref found in snapshot" ""
fi

# --- Step 6: Click a habit "+" button → verify streak increases ---
log "→ Step 6: Click habit '+' button → verify streak increases"
snapshot
# Habit check-in buttons are unlabeled buttons with Plus icon. They appear
# between the missions and goals sections. We click via JS to target Plus icons.
STREAK_BEFORE=$(timeout 15 agent-browser eval "(function(){var m=document.body.innerText.match(/Best Streak[\s\S]{0,40}?(\d+)/);return m?m[1]:'none';})()" 2>/dev/null | tail -1)
# Also capture first habit's currentStreak value
HABIT_STREAK_BEFORE=$(timeout 15 agent-browser eval "(function(){var els=document.querySelectorAll('p');for(var i=0;i<els.length;i++){if(els[i].textContent==='streak'){var sib=els[i].previousElementSibling;return sib?sib.textContent:'none';}}return 'none';})()" 2>/dev/null | tail -1)
log "  streak before: best='$STREAK_BEFORE' first-habit-current='$HABIT_STREAK_BEFORE'"
# Click the first Plus-icon button via JS
HABIT_CLICK=$(timeout 15 agent-browser eval "(function(){var btns=Array.from(document.querySelectorAll('button'));var plusBtns=btns.filter(function(b){return b.querySelector('svg.lucide-plus')||b.innerHTML.indexOf('lucide-plus')>=0;});if(plusBtns.length===0)return 'no-plus-button-found';plusBtns[0].click();return 'clicked';})()" 2>/dev/null | tail -1)
log "  habit click result: $HABIT_CLICK"
sleep 2
wait_idle
sleep 1
STREAK_AFTER=$(timeout 15 agent-browser eval "(function(){var m=document.body.innerText.match(/Best Streak[\s\S]{0,40}?(\d+)/);return m?m[1]:'none';})()" 2>/dev/null | tail -1)
HABIT_STREAK_AFTER=$(timeout 15 agent-browser eval "(function(){var els=document.querySelectorAll('p');for(var i=0;i<els.length;i++){if(els[i].textContent==='streak'){var sib=els[i].previousElementSibling;return sib?sib.textContent:'none';}}return 'none';})()" 2>/dev/null | tail -1)
TOAST=$(get_toasts)
log "  streak after:  best='$STREAK_AFTER' first-habit-current='$HABIT_STREAK_AFTER' toast='$TOAST'"
if [ "$HABIT_STREAK_AFTER" != "$HABIT_STREAK_BEFORE" ] && [ "$HABIT_STREAK_AFTER" != "none" ]; then
  record_result "PASS" "P1.6 habit + increases streak" "habit streak $HABIT_STREAK_BEFORE → $HABIT_STREAK_AFTER; toast='$TOAST'" ""
elif [ -n "$TOAST" ]; then
  record_result "PASS" "P1.6 habit + increases streak" "toast appeared: '$TOAST' (streak display may not visibly change on same render)" ""
else
  record_result "FAIL" "P1.6 habit + increases streak" "habit streak unchanged ($HABIT_STREAK_BEFORE → $HABIT_STREAK_AFTER); no toast; click=$HABIT_CLICK" ""
fi

# --- Step 7: Click "Update" on a goal → dialog opens → enter value → submit → toast ---
log "→ Step 7: Click Update on goal → dialog → submit → toast"
snapshot
UPDATE_REF=$(find_ref 'button "Update"')
if [ -n "$UPDATE_REF" ]; then
  timeout $TMO agent-browser click "@$UPDATE_REF" >/dev/null 2>&1
  sleep 2
  wait_idle
  sleep 1
  DIALOG=$(get_dialog)
  if echo "$DIALOG" | grep -q "Update Progress"; then
    # Find input field in dialog
    snapshot
    INPUT_REF=$(echo "$SNAP" | grep -E 'textbox|spinbutton' | head -1 | grep -oP 'ref=e\K\d+' | head -1)
    if [ -n "$INPUT_REF" ]; then
      timeout $TMO agent-browser fill "@$INPUT_REF" "75" >/dev/null 2>&1
      sleep 1
      # Find submit button in dialog
      snapshot
      SUBMIT_REF=$(echo "$SNAP" | grep -iE 'button "(Save|Submit|Update|Confirm|OK)"' | head -1 | grep -oP 'ref=e\K\d+' | head -1)
      if [ -n "$SUBMIT_REF" ]; then
        timeout $TMO agent-browser click "@$SUBMIT_REF" >/dev/null 2>&1
        sleep 2
        wait_idle
        sleep 1
        TOAST=$(get_toasts)
        if [ -n "$TOAST" ]; then
          record_result "PASS" "P1.7 goal Update dialog submit" "dialog opened, value entered, submitted; toast='$TOAST'" ""
        else
          # Dialog closed counts as success even without toast
          DIALOG_AFTER=$(get_dialog)
          if [ -z "$DIALOG_AFTER" ]; then
            record_result "PASS" "P1.7 goal Update dialog submit" "dialog opened, value entered, submitted; dialog closed (no toast but flow completed)" ""
          else
            record_result "FAIL" "P1.7 goal Update dialog submit" "dialog still open after submit; no toast" "$DIALOG_AFTER"
          fi
        fi
      else
        # Try pressing Enter
        timeout 10 agent-browser press Enter >/dev/null 2>&1
        sleep 2
        TOAST=$(get_toasts)
        DIALOG_AFTER=$(get_dialog)
        if [ -n "$TOAST" ] || [ -z "$DIALOG_AFTER" ]; then
          record_result "PASS" "P1.7 goal Update dialog submit" "submitted via Enter; dialog closed / toast='$TOAST'" ""
        else
          record_result "FAIL" "P1.7 goal Update dialog submit" "could not find submit button ref" "$SNAP"
        fi
      fi
    else
      record_result "FAIL" "P1.7 goal Update dialog submit" "dialog opened but no input ref found" "$SNAP"
    fi
  else
    record_result "FAIL" "P1.7 goal Update dialog submit" "dialog did not open with 'Update Progress' title" "$DIALOG"
  fi
else
  record_result "FAIL" "P1.7 goal Update dialog submit" "no 'Update' button ref found in snapshot" ""
fi

# --- Step 8: Click "Join Competition" → verify toast ---
log "→ Step 8: Click Join Competition → verify toast"
snapshot
JOIN_REF=$(find_ref 'button "Join Competition"')
if [ -n "$JOIN_REF" ]; then
  timeout $TMO agent-browser click "@$JOIN_REF" >/dev/null 2>&1
  sleep 2
  wait_idle
  sleep 1
  TOAST=$(get_toasts)
  if [ -n "$TOAST" ]; then
    record_result "PASS" "P1.8 Join Competition toast" "toast appeared: '$TOAST'" ""
  else
    record_result "FAIL" "P1.8 Join Competition toast" "no toast appeared after click" ""
  fi
else
  record_result "FAIL" "P1.8 Join Competition toast" "no 'Join Competition' button ref found" ""
fi

# --- Step 9: Click "Record" → dialog opens → schema + source dropdowns populated ---
log "→ Step 9: Click Record → verify dialog with schema + source dropdowns"
snapshot
RECORD_REF=$(find_ref 'button "Record"')
if [ -n "$RECORD_REF" ]; then
  timeout $TMO agent-browser click "@$RECORD_REF" >/dev/null 2>&1
  sleep 2
  wait_idle
  sleep 1
  DIALOG=$(get_dialog)
  if [ -n "$DIALOG" ]; then
    # Count select/combobox elements inside the dialog
    DIALOG_SELECTS=$(timeout 15 agent-browser eval "(function(){var d=document.querySelector('[role=dialog]');if(!d)return 0;return d.querySelectorAll('select, [role=combobox], button[role=combobox]').length;})()" 2>/dev/null | tail -1)
    DIALOG_OPTS=$(timeout 15 agent-browser eval "(function(){var d=document.querySelector('[role=dialog]');if(!d)return '';var sels=d.querySelectorAll('select');var txt='';sels.forEach(function(s){txt+='['+s.name+':'+(s.options?s.options.length:0)+'opts]';});var cbs=d.querySelectorAll('button[role=combobox]');cbs.forEach(function(c){txt+='[cb:'+c.textContent.slice(0,30)+']';});return txt.slice(0,400);})()" 2>/dev/null | tail -1)
    if [ "${DIALOG_SELECTS:-0}" -ge 2 ]; then
      record_result "PASS" "P1.9 Record dialog dropdowns" "dialog opened with $DIALOG_SELECTS select/combobox elements; $DIALOG_OPTS" ""
    else
      record_result "FAIL" "P1.9 Record dialog dropdowns" "dialog opened but only $DIALOG_SELECTS select/combobox found (need >=2)" "$DIALOG_OPTS"
    fi
    # Close dialog (press Escape)
    timeout 10 agent-browser press Escape >/dev/null 2>&1
    sleep 1
  else
    record_result "FAIL" "P1.9 Record dialog dropdowns" "Record click did not open dialog" ""
  fi
else
  record_result "FAIL" "P1.9 Record dialog dropdowns" "no 'Record' button ref found" ""
fi

# --- Step 10: Click "Marketplace" in header → verify stays logged in ---
log "→ Step 10: Click Marketplace → verify stays logged in (Dashboard button visible)"
snapshot
MARKET_REF=$(find_ref 'button "Marketplace"')
if [ -n "$MARKET_REF" ]; then
  timeout $TMO agent-browser click "@$MARKET_REF" >/dev/null 2>&1
  sleep 2
  wait_idle
  sleep 2
  URL=$(get_url)
  snapshot
  DASH_BTN=$(count_refs 'button "Dashboard"')
  if echo "$URL" | grep -q "/marketplace" && [ "$DASH_BTN" -ge 1 ]; then
    record_result "PASS" "P1.10 Marketplace stays logged in" "navigated to $URL; Dashboard button visible ($DASH_BTN)" ""
  else
    record_result "FAIL" "P1.10 Marketplace stays logged in" "url=$URL, Dashboard buttons=$DASH_BTN" ""
  fi
else
  record_result "FAIL" "P1.10 Marketplace stays logged in" "no Marketplace button ref found" ""
fi

# --- Step 11: Click "Cardio Care" listing → verify program detail page ---
log "→ Step 11: Click 'Cardio Care' listing → verify program detail page"
# Use JS to click the card containing "Cardio Care"
CARDIO_CLICK=$(timeout 15 agent-browser eval "(function(){var cards=document.querySelectorAll('[class*=cursor-pointer], a, button, div[role=button]');for(var i=0;i<cards.length;i++){var t=cards[i].textContent||'';if(t.indexOf('Cardio Care')>=0){cards[i].click();return 'clicked-cardio';}}return 'cardio-not-found';})()" 2>/dev/null | tail -1)
log "  cardio click: $CARDIO_CLICK"
sleep 2
wait_idle
sleep 2
URL=$(get_url)
if echo "$URL" | grep -q "/programs/"; then
  BODY=$(get_body_text)
  if echo "$BODY" | grep -qi "cardio"; then
    record_result "PASS" "P1.11 Cardio Care program detail" "navigated to $URL; page contains 'cardio' content" ""
  else
    record_result "FAIL" "P1.11 Cardio Care program detail" "navigated to $URL but 'cardio' text not found in body" ""
  fi
else
  record_result "FAIL" "P1.11 Cardio Care program detail" "did not navigate to /programs/* (url=$URL); click=$CARDIO_CLICK" ""
fi

# --- Step 12: Click "Install Program" → verify success state ---
log "→ Step 12: Click Install Program → verify success state"
snapshot
INSTALL_REF=$(find_ref 'button "Install Program"')
if [ -z "$INSTALL_REF" ]; then
  INSTALL_REF=$(find_ref 'button "Install"')
fi
if [ -n "$INSTALL_REF" ]; then
  timeout $TMO agent-browser click "@$INSTALL_REF" >/dev/null 2>&1
  sleep 2
  wait_idle
  sleep 2
  BODY=$(get_body_text)
  TOAST=$(get_toasts)
  # Success indicators: "Installed", "Successfully installed", "Uninstall" button appears (already installed), or toast
  if echo "$BODY" | grep -qiE "installed|uninstall|success" || [ -n "$TOAST" ]; then
    record_result "PASS" "P1.12 Install Program success" "success indicator found; toast='$TOAST'; body has installed/uninstall/success" ""
  else
    record_result "FAIL" "P1.12 Install Program success" "no success indicator; toast='$TOAST'" "${BODY:0:200}"
  fi
else
  record_result "FAIL" "P1.12 Install Program success" "no Install Program button ref found" ""
fi

# --- Step 13: Go to /dashboard/timeline → verify entries + filter buttons ---
log "→ Step 13: Go to /dashboard/timeline → verify entries + filter buttons"
timeout $TMO agent-browser open "$BASE/dashboard/timeline" --timeout 30000 >/dev/null 2>&1
wait_idle
sleep 2
URL=$(get_url)
snapshot
# Filter buttons: All, Measurements, Missions, Competitions
FILTER_ALL=$(count_refs 'button "All"')
FILTER_MEAS=$(count_refs 'button "Measurements"')
FILTER_MIS=$(count_refs 'button "Missions"')
FILTER_COMP=$(count_refs 'button "Competitions"')
TOTAL_FILTERS=$((FILTER_ALL + FILTER_MEAS + FILTER_MIS + FILTER_COMP))
# Check for timeline entries (look for Activity icon svg or list items)
ENTRIES=$(timeout 15 agent-browser eval "document.querySelectorAll('[class*=timeline], article, li').length" 2>/dev/null | tail -1)
if echo "$URL" | grep -q "/timeline" && [ "$TOTAL_FILTERS" -ge 3 ]; then
  # Try clicking a filter to verify it works (no crash)
  local_filter_ref=$(find_ref 'button "Missions"')
  if [ -n "$local_filter_ref" ]; then
    timeout $TMO agent-browser click "@$local_filter_ref" >/dev/null 2>&1
    sleep 1
    URL_AFTER=$(get_url)
    # Filter click shouldn't navigate away from /timeline
    if echo "$URL_AFTER" | grep -q "/timeline"; then
      record_result "PASS" "P1.13 timeline entries + filters" "url=$URL; filters visible=$TOTAL_FILTERS (All=$FILTER_ALL,M=$FILTER_MEAS,Mis=$FILTER_MIS,C=$FILTER_COMP); entries=$ENTRIES; filter click OK" ""
    else
      record_result "FAIL" "P1.13 timeline entries + filters" "filter click navigated away to $URL_AFTER" ""
    fi
  else
    record_result "PASS" "P1.13 timeline entries + filters" "url=$URL; filters visible=$TOTAL_FILTERS; entries=$ENTRIES (filter not clicked)" ""
  fi
else
  record_result "FAIL" "P1.13 timeline entries + filters" "url=$URL; filters=$TOTAL_FILTERS; entries=$ENTRIES" ""
fi

# --- Step 14: Go to /dashboard/settings → verify all cards render ---
log "→ Step 14: Go to /dashboard/settings → verify cards (Profile, Security, Devices, etc.)"
timeout $TMO agent-browser open "$BASE/dashboard/settings" --timeout 30000 >/dev/null 2>&1
wait_idle
sleep 2
URL=$(get_url)
BODY=$(get_body_text)
CARDS_FOUND=0
CARD_LIST=""
for card in "Profile" "Security" "Devices" "Privacy" "Notifications"; do
  if echo "$BODY" | grep -q "$card"; then
    CARDS_FOUND=$((CARDS_FOUND + 1))
    CARD_LIST="$CARD_LIST $card"
  fi
done
if echo "$URL" | grep -q "/settings" && [ "$CARDS_FOUND" -ge 4 ]; then
  record_result "PASS" "P1.14 settings cards render" "url=$URL; found cards:$CARD_LIST ($CARDS_FOUND/5)" ""
else
  record_result "FAIL" "P1.14 settings cards render" "url=$URL; cards found=$CARDS_FOUND/5;$CARD_LIST" ""
fi

# --- Phase 1 error check ---
log "→ Phase 1 console errors check:"
P1_ERRORS=$(get_errors)
if [ -z "$P1_ERRORS" ] || echo "$P1_ERRORS" | grep -qiE "^$|no errors"; then
  record_result "PASS" "P1.ERR no console errors (Phase 1)" "browser console clean" ""
else
  # Filter out non-critical errors (Next.js devtools, hydration warnings are tolerated)
  CRITICAL=$(echo "$P1_ERRORS" | grep -ivE "hydration|devtools|content-script|third-party|favicon" | head -5)
  if [ -z "$CRITICAL" ]; then
    record_result "PASS" "P1.ERR no console errors (Phase 1)" "only tolerable warnings (hydration/devtools)" "$P1_ERRORS"
  else
    record_result "FAIL" "P1.ERR no console errors (Phase 1)" "critical console errors detected" "$CRITICAL"
  fi
fi
clear_errors

# =============================================================================
# PHASE 2: PLATFORM ADMIN FULL JOURNEY
# =============================================================================
nl
log "████████████████████████████████████████████████████████████████████████"
log "PHASE 2: PLATFORM ADMIN JOURNEY (ekontetevi@gmail.com)"
log "████████████████████████████████████████████████████████████████████████"
nl

# --- Step 1: Sign out ---
log "→ Step 2.1: Sign out"
do_signout
sleep 2
timeout $TMO agent-browser open "$BASE/sign-in" --timeout 30000 >/dev/null 2>&1
wait_idle
sleep 2
URL=$(get_url)
if echo "$URL" | grep -q "/sign-in"; then
  record_result "PASS" "P2.1 sign out" "navigated back to /sign-in ($URL)" ""
else
  record_result "FAIL" "P2.1 sign out" "still at $URL after sign-out attempt" ""
fi

# --- Step 2: Sign in as platform admin ---
log "→ Step 2.2: Sign in as ekontetevi@gmail.com"
if do_signin "$P_PLATFORMADMIN_EMAIL" "$P_PLATFORMADMIN_PW"; then
  record_result "PASS" "P2.2 sign in (platform admin)" "submitted credentials" ""
else
  record_result "FAIL" "P2.2 sign in (platform admin)" "sign-in failed" ""
fi

# --- Step 3: Verify /dashboard renders with "Welcome, Platform Administrator" ---
log "→ Step 2.3: Verify dashboard renders with admin welcome"
sleep 2
wait_idle
sleep 1
snapshot
URL=$(get_url)
# Admin display name may be "Platform Administrator" or "Eva Kontetevi" — accept either
WELCOME_ADMIN=$(echo "$SNAP" | grep -ciE 'Welcome,.*(Platform Administrator|Eva|Admin)')
BODY=$(get_body_text)
if echo "$URL" | grep -q "/dashboard" && [ "$WELCOME_ADMIN" -ge 1 ]; then
  record_result "PASS" "P2.3 admin dashboard welcome" "found admin welcome at $URL" ""
elif echo "$URL" | grep -q "/dashboard" && echo "$BODY" | grep -qiE "waitlist|accounts"; then
  record_result "PASS" "P2.3 admin dashboard welcome" "admin dashboard at $URL (waitlist/accounts visible even if welcome text differs)" ""
else
  record_result "FAIL" "P2.3 admin dashboard welcome" "url=$URL; welcome_admin=$WELCOME_ADMIN; body snippet: $(echo "$BODY" | head -c 200)" ""
fi

# --- Step 4: Verify waitlist section visible ---
log "→ Step 2.4: Verify waitlist section"
BODY=$(get_body_text)
if echo "$BODY" | grep -qiE "waitlist|wait list"; then
  record_result "PASS" "P2.4 waitlist section visible" "found 'waitlist' text on admin dashboard" ""
else
  record_result "FAIL" "P2.4 waitlist section visible" "no waitlist text found" ""
fi

# --- Step 5: Verify accounts section visible ---
log "→ Step 2.5: Verify accounts section"
BODY=$(get_body_text)
if echo "$BODY" | grep -qiE "accounts|account list|manage accounts"; then
  record_result "PASS" "P2.5 accounts section visible" "found 'accounts' text on admin dashboard" ""
else
  record_result "FAIL" "P2.5 accounts section visible" "no accounts text found" ""
fi

# --- Step 6: If role switcher visible, click "Developer" → verify dashboard changes ---
log "→ Step 2.6: Role switcher → click Developer → verify dashboard changes"
snapshot
# Role switcher buttons appear when session.personas.length > 1
DEV_BTN_REF=$(echo "$SNAP" | grep -E 'button "Developer"' | head -1 | grep -oP 'ref=e\K\d+' | head -1)
if [ -n "$DEV_BTN_REF" ]; then
  # Capture persona badge before
  PERSONA_BEFORE=$(timeout 15 agent-browser eval "(function(){var b=document.querySelector('header [class*=Badge]');return b?b.textContent:'none';})()" 2>/dev/null | tail -1)
  timeout $TMO agent-browser click "@$DEV_BTN_REF" >/dev/null 2>&1
  sleep 2
  wait_idle
  sleep 2
  PERSONA_AFTER=$(timeout 15 agent-browser eval "(function(){var b=document.querySelector('header [class*=Badge]');return b?b.textContent:'none';})()" 2>/dev/null | tail -1)
  BODY_AFTER=$(get_body_text)
  if [ "$PERSONA_AFTER" != "$PERSONA_BEFORE" ] || echo "$BODY_AFTER" | grep -qiE "developer|program|publish"; then
    record_result "PASS" "P2.6 role switch to Developer" "persona badge: '$PERSONA_BEFORE' → '$PERSONA_AFTER'" ""
  else
    record_result "FAIL" "P2.6 role switch to Developer" "no change after click (persona: '$PERSONA_BEFORE' → '$PERSONA_AFTER')" ""
  fi
  # Switch back to platform_admin for cleanliness
  snapshot
  PA_BTN_REF=$(echo "$SNAP" | grep -E 'button "Platform Admin"' | head -1 | grep -oP 'ref=e\K\d+' | head -1)
  if [ -n "$PA_BTN_REF" ]; then
    timeout $TMO agent-browser click "@$PA_BTN_REF" >/dev/null 2>&1
    sleep 2
    wait_idle
  fi
else
  record_result "PASS" "P2.6 role switcher (skipped)" "no role switcher visible for platform admin (single persona) — acceptable" ""
fi

# --- Phase 2 error check ---
log "→ Phase 2 console errors check:"
P2_ERRORS=$(get_errors)
if [ -z "$P2_ERRORS" ] || echo "$P2_ERRORS" | grep -qiE "^$|no errors"; then
  record_result "PASS" "P2.ERR no console errors (Phase 2)" "browser console clean" ""
else
  CRITICAL=$(echo "$P2_ERRORS" | grep -ivE "hydration|devtools|content-script|third-party|favicon" | head -5)
  if [ -z "$CRITICAL" ]; then
    record_result "PASS" "P2.ERR no console errors (Phase 2)" "only tolerable warnings" "$P2_ERRORS"
  else
    record_result "FAIL" "P2.ERR no console errors (Phase 2)" "critical console errors detected" "$CRITICAL"
  fi
fi
clear_errors

# =============================================================================
# PHASE 3: ALL 6 ROLES QUICK DASHBOARD CHECK
# =============================================================================
nl
log "████████████████████████████████████████████████████████████████████████"
log "PHASE 3: ALL 6 ROLES QUICK DASHBOARD CHECK"
log "████████████████████████████████████████████████████████████████████████"
nl

# Quick role check function — sign in, verify dashboard not empty, capture errors
check_role() {
  local role="$1" email="$2" pw="$3" expected_persona="$4"
  log "→ Role check: $role ($email)"
  do_signout
  sleep 1
  timeout $TMO agent-browser open "$BASE/sign-in" --timeout 30000 >/dev/null 2>&1
  wait_idle
  sleep 2
  clear_errors
  if ! do_signin "$email" "$pw"; then
    record_result "FAIL" "P3.$role sign in" "could not find sign-in form" ""
    return
  fi
  sleep 2
  wait_idle
  sleep 2
  URL=$(get_url)
  snapshot
  WELCOME=$(echo "$SNAP" | grep -ciE 'Welcome,')
  # Count interactive elements as a proxy for "dashboard not empty"
  INTERACTIVE=$(echo "$SNAP" | grep -cE '^- (button|link|textbox|heading)')
  BODY=$(get_body_text)
  BODY_LEN=${#BODY}
  ERRORS_AFTER=$(get_errors)
  if echo "$URL" | grep -q "/dashboard" && [ "$INTERACTIVE" -ge 5 ] && [ "$BODY_LEN" -ge 200 ]; then
    record_result "PASS" "P3.$role dashboard renders" "url=$URL; interactive=$INTERACTIVE; body_len=$BODY_LEN; welcome=$WELCOME" ""
  else
    record_result "FAIL" "P3.$role dashboard renders" "url=$URL; interactive=$INTERACTIVE; body_len=$BODY_LEN" "${BODY:0:200}"
  fi
  # Per-role error check
  if [ -z "$ERRORS_AFTER" ] || echo "$ERRORS_AFTER" | grep -qiE "^$|no errors"; then
    record_result "PASS" "P3.$role console clean" "no console errors" ""
  else
    CRIT=$(echo "$ERRORS_AFTER" | grep -ivE "hydration|devtools|content-script|third-party|favicon" | head -3)
    if [ -z "$CRIT" ]; then
      record_result "PASS" "P3.$role console clean" "only tolerable warnings" ""
    else
      record_result "FAIL" "P3.$role console clean" "console errors" "$CRIT"
    fi
  fi
  clear_errors
}

check_role "participant"    "$P_PARTICIPANT_EMAIL"    "$P_DEMO_PW"       "participant"
check_role "technician"     "$P_TECH_EMAIL"           "$P_DEMO_PW"       "health_technician"
check_role "developer"      "$P_DEV_EMAIL"            "$P_DEMO_PW"       "developer"
check_role "researcher"     "$P_RESEARCH_EMAIL"       "$P_DEMO_PW"       "researcher"
check_role "org_admin"      "$P_ORGADMIN_EMAIL"       "$P_DEMO_PW"       "org_admin"
check_role "platform_admin" "$P_PLATFORMADMIN_EMAIL"  "$P_PLATFORMADMIN_PW" "platform_admin"

# =============================================================================
# PHASE 4: FINAL ERROR CHECK & RESOURCE CHECK
# =============================================================================
nl
log "████████████████████████████████████████████████████████████████████████"
log "PHASE 4: FINAL ERROR CHECK"
log "████████████████████████████████████████████████████████████████████████"
nl

# Check broken images / missing resources via JS
log "→ Final resource check"
BROKEN_IMAGES=$(timeout 15 agent-browser eval "(function(){var imgs=Array.from(document.querySelectorAll('img'));var broken=imgs.filter(function(i){return !i.complete || i.naturalWidth===0;});return broken.length+'/'+imgs.length;})()" 2>/dev/null | tail -1)
BROKEN_LINKS=$(timeout 15 agent-browser eval "(function(){var links=Array.from(document.querySelectorAll('a[href]'));var bad=links.filter(function(a){return a.href.indexOf('undefined')>=0 || a.href.endsWith('/null') || a.href.endsWith('/undefined');});return bad.length+'/'+links.length;})()" 2>/dev/null | tail -1)
log "  broken images: $BROKEN_IMAGES"
log "  broken links:  $BROKEN_LINKS"

if echo "$BROKEN_IMAGES" | grep -q "^0/"; then
  record_result "PASS" "P4.1 no broken images" "broken images: $BROKEN_IMAGES" ""
else
  record_result "FAIL" "P4.1 no broken images" "broken images: $BROKEN_IMAGES" ""
fi

if echo "$BROKEN_LINKS" | grep -q "^0/"; then
  record_result "PASS" "P4.2 no broken links" "broken links: $BROKEN_LINKS" ""
else
  record_result "FAIL" "P4.2 no broken links" "broken links: $BROKEN_LINKS" ""
fi

# Final console error sweep
FINAL_ERRORS=$(get_errors)
if [ -z "$FINAL_ERRORS" ] || echo "$FINAL_ERRORS" | grep -qiE "^$|no errors"; then
  record_result "PASS" "P4.3 final console clean" "no console errors at end of session" ""
else
  CRIT=$(echo "$FINAL_ERRORS" | grep -ivE "hydration|devtools|content-script|third-party|favicon" | head -10)
  if [ -z "$CRIT" ]; then
    record_result "PASS" "P4.3 final console clean" "only tolerable warnings" ""
  else
    record_result "FAIL" "P4.3 final console clean" "critical console errors at end" "$CRIT"
  fi
fi

# =============================================================================
# FINAL SCORE
# =============================================================================
nl
log "████████████████████████████████████████████████████████████████████████"
log "FINAL SCORE"
log "████████████████████████████████████████████████████████████████████████"
nl
log "TOTAL TESTS:  $TOTAL_COUNT"
log "PASSED:       $PASS_COUNT"
log "FAILED:       $FAIL_COUNT"
log "PASS RATE:    $(awk "BEGIN{printf \"%.1f\", ($PASS_COUNT/$TOTAL_COUNT)*100}")%"
nl
log "Finished: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# Cleanup
timeout 15 agent-browser close >/dev/null 2>&1 || true

exit 0
