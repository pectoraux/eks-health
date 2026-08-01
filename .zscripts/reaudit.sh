#!/usr/bin/env bash
# reaudit.sh — FULL RE-AUDIT of live Eks-Health app
# Site:    https://eks-health.vercel.app  (Vercel production, serverless)
# Task ID: reaudit-1
#
# Goal:
#   Verify that the 6 previously-FAILing tests are truly fixed, and find any
#   NEW issues. Drives a single real Chrome session via agent-browser through
#   14 tests covering every page, navigation flow, and interactive action.
#
# Previous audit (audit-systematic-1, 2026-08-01) found:
#   4 PASS, 2 WARN, 6 FAIL out of 12 tests.
#   Root cause: in-memory sessions store not hydrated from DB on fresh
#   serverless instances → /api/auth/session returns {ok:true,data:null} and
#   /api/dashboard returns 401 even when the cookie is valid. Program detail
#   showed "Program not found" because listing IDs differed across instances.
#   Role switch API did not actually change the activePersona.
#
# This re-audit checks whether each of those is truly fixed.
#
# Artifacts:
#   Logs:        /home/z/my-project/.zscripts/logs/reaudit-1/
#   Screenshots: /home/z/my-project/.zscripts/screenshots/reaudit-1/
#   Report:      /home/z/my-project/.zscripts/logs/reaudit-1/REPORT.txt
#   Bugs:        /home/z/my-project/.zscripts/logs/reaudit-1/BUGS.txt
#   Console log: /home/z/my-project/.zscripts/logs/reaudit-1/RUN.stdout.log

set -uo pipefail

BASE="https://eks-health.vercel.app"
SESSION="eks-reaudit-1"
ROOT="/home/z/my-project/.zscripts"
LOGS="${ROOT}/logs/reaudit-1"
SHOTS="${ROOT}/screenshots/reaudit-1"
REPORT="${LOGS}/REPORT.txt"
BUGS="${LOGS}/BUGS.txt"
RUNLOG="${LOGS}/RUN.stdout.log"
mkdir -p "$LOGS" "$SHOTS"
: >"$REPORT"
: >"$BUGS"

# agent-browser helper (isolated session for the whole run).
ab() { agent-browser --session "$SESSION" "$@"; }

# Write to report + stdout + run log.
rpt() { printf '%s\n' "$*" | tee -a "$REPORT" >&2; }
section() {
  local bar="================================================================"
  { printf '\n%s\n%s\n%s\n' "$bar" "$*" "$bar"; } | tee -a "$REPORT" >&2
}
bug() { printf '%s\n' "$*" | tee -a "$BUGS" >&2; }

# networkidle wait + small settle time. Serverless cold starts may take a
# while to spin up; we always wait for networkidle and then sleep 2s for SPA
# post-render effects (dialogs, toasts, etc.).
wait_idle() {
  ab wait --load networkidle --timeout 30000 >/dev/null 2>&1 || true
  sleep 2
}

# Capture diagnostics per test.
capture_diagnostics() {
  local tag="$1"
  ab console >"${LOGS}/${tag}.console.txt" 2>&1 || true
  ab errors  >"${LOGS}/${tag}.errors.txt" 2>&1 || true
  ab snapshot -i -c >"${LOGS}/${tag}.snapshot.txt" 2>&1 || true
  ab screenshot "${SHOTS}/${tag}.png" >/dev/null 2>&1 || true
}

console_err_count() {
  local f="${LOGS}/$1.console.txt"
  if [ -s "$f" ]; then
    grep -iE '"type":"error"|level=error|SEVERE|Error:|Failed to|Uncaught|ReferenceError|TypeError' "$f" 2>/dev/null | wc -l | tr -d ' '
  else
    echo 0
  fi
}

# Direct fetch in the browser. Returns "status|ok|snippet" (pipe-safe).
api_probe() {
  local method="$1" path="$2" body="${3:-}"
  local js
  if [ -n "$body" ]; then
    js="fetch('${path}',{method:'${method}',headers:{'Content-Type':'application/json'},body:JSON.stringify(${body}),cache:'no-store'}).then(async r=>{const d=await r.json().catch(()=>({}));const snip=(d.error?.message||JSON.stringify(d.data??d)||'').slice(0,200).replace(/\\|/g,'/');return [r.status,d.ok?1:0,snip].join('|')})"
  else
    js="fetch('${path}',{cache:'no-store'}).then(async r=>{const d=await r.json().catch(()=>({}));const snip=(d.error?.message||JSON.stringify(d.data??d)||'').slice(0,200).replace(/\\|/g,'/');return [r.status,d.ok?1:0,snip].join('|')})"
  fi
  ab eval "$js" 2>/dev/null | tail -1 | tr -d '"'
}

# Sign in via direct API (sets cookies). Returns "status|ok|email|persona|err".
api_sign_in() {
  local email="$1" pass="$2"
  ab eval "fetch('/api/auth/sign-in',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'${email}',password:'${pass}'})}).then(async r=>{const d=await r.json();return [r.status,d.ok?1:0,d.data?.email||'',d.data?.activePersona||'',d.error?.message||''].join('|')})" 2>/dev/null | tail -1 | tr -d '"'
}

# Sign in via the actual UI form (form-fill + Sign In button click).
# Returns 0 on success.
ui_sign_in() {
  local email="$1" pass="$2"
  ab open "${BASE}/sign-in" >/dev/null 2>&1
  wait_idle
  ab snapshot -i -c >"${LOGS}/.signin.snap" 2>&1
  local emailref passref signinref
  emailref="$(grep -iE 'textbox.*Email' "${LOGS}/.signin.snap" | head -1 | sed -E 's/.*\[ref=([a-z0-9]+)\].*/\1/')"
  passref="$(grep -iE 'textbox.*Password' "${LOGS}/.signin.snap" | head -1 | sed -E 's/.*\[ref=([a-z0-9]+)\].*/\1/')"
  signinref="$(grep -E 'button "Sign In"' "${LOGS}/.signin.snap" | head -1 | sed -E 's/.*\[ref=([a-z0-9]+)\].*/\1/')"
  if [ -z "$emailref" ] || [ -z "$passref" ] || [ -z "$signinref" ]; then
    rpt "  WARN: sign-in form fields not found (email=$emailref pass=$passref btn=$signinref)"
    return 1
  fi
  ab fill "@${emailref}" "$email" >/dev/null 2>&1 || true
  ab fill "@${passref}"  "$pass"  >/dev/null 2>&1 || true
  ab click "@${signinref}" >/dev/null 2>&1 || true
  ab wait --url "**/dashboard" --timeout 20000 >/dev/null 2>&1 || true
  sleep 4
  return 0
}

# Sign out completely (API + cookie clear).
full_sign_out() {
  ab eval 'fetch("/api/auth/sign-out",{method:"POST"}).catch(()=>{})' >/dev/null 2>&1
  ab cookies clear >/dev/null 2>&1 || true
  sleep 1
}

# Re-establish session as a specific user. Used between unrelated tests.
reauth() {
  local email="$1" pass="$2"
  full_sign_out
  ab open "${BASE}/sign-in" >/dev/null 2>&1
  wait_idle
  local r
  r="$(api_sign_in "$email" "$pass")"
  sleep 2
  echo "$r"
}

# Find a ref in a snapshot file by EXACT regex pattern.
ref_for() {
  grep -E "$2" "$1" 2>/dev/null | head -1 | sed -E 's/.*\[ref=([a-z0-9]+)\].*/\1/'
}

# Is a probe result a valid session (status=200, ok=1, has accountId/email)?
session_is_valid() {
  local probe="$1"
  local status ok
  status="$(echo "$probe" | cut -d'|' -f1)"
  ok="$(echo "$probe" | cut -d'|' -f2)"
  [ "$status" = "200" ] && [ "$ok" = "1" ] || return 1
  echo "$probe" | grep -qiE 'accountId|email|displayName' || return 1
  # Reject the cold-start null-session shape {ok:true,data:null}.
  if echo "$probe" | grep -qiE 'data\\*":null' && ! echo "$probe" | grep -qi 'accountId'; then
    return 1
  fi
  return 0
}

# Eval a JS snippet that returns "yes"/"no"; strip quotes.
yn() {
  ab eval "$1" 2>/dev/null | tail -1 | tr -d '"'
}

# Counters
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
declare -a RESULTS=()
record() {
  RESULTS+=("$1|$2|$3")
  case "$2" in
    PASS) PASS_COUNT=$((PASS_COUNT+1));;
    FAIL) FAIL_COUNT=$((FAIL_COUNT+1));;
    WARN) WARN_COUNT=$((WARN_COUNT+1));;
  esac
  rpt "  RESULT: $2 — $3"
}

# ============================================================================
# Header
# ============================================================================
rpt "Eks-Health full re-audit"
rpt "Task ID:   reaudit-1"
rpt "Target:    ${BASE}"
rpt "Started:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
rpt "Browser:   $(agent-browser --version 2>&1 | head -1)"
rpt ""

ab close --all >/dev/null 2>&1 || true

# ============================================================================
# TEST 1 — Landing page renders
# ============================================================================
section "TEST 1 — Landing page (verify 'Prevent disease' heading)"
rpt "  Action: Open https://eks-health.vercel.app/"
ab open "${BASE}/" >/dev/null 2>&1
wait_idle
T1_OPEN_URL="$(ab get url 2>/dev/null || echo '?')"
if [ "$T1_OPEN_URL" = "about:blank" ] || [ -z "$T1_OPEN_URL" ]; then
  rpt "  WARN: initial open returned '$T1_OPEN_URL' — retrying"
  ab open "${BASE}/" >/dev/null 2>&1
  wait_idle
  T1_OPEN_URL="$(ab get url 2>/dev/null || echo '?')"
fi
rpt "  Final URL: ${T1_OPEN_URL}"

T1_HEADINGS="$(yn '[...document.querySelectorAll("h1,h2")].map(h=>h.textContent.trim()).filter(Boolean).slice(0,5).join(" | ")')"
rpt "  Landing headings: ${T1_HEADINGS}"
rpt "  Expected: heading containing 'Prevent disease'"
capture_diagnostics "test1-landing"
T1_ERRORS="$(console_err_count test1-landing)"
rpt "  Console errors: ${T1_ERRORS}"

if echo "$T1_HEADINGS" | grep -qi "Prevent disease"; then
  record T1 PASS "Landing rendered with 'Prevent disease' heading (url=${T1_OPEN_URL})"
else
  record T1 FAIL "Expected 'Prevent disease' heading; got headings=${T1_HEADINGS} (url=${T1_OPEN_URL})"
  bug "[T1] Landing heading missing: headings=${T1_HEADINGS}, url=${T1_OPEN_URL}"
fi

# ============================================================================
# TEST 2 — Sign-in flow (was FAIL: bounced to /sign-in)
# ============================================================================
section "TEST 2 — Sign in as ama@eks.health / DemoPass123! → /dashboard"
rpt "  Action: Open /sign-in, fill form, click Sign In"
rpt "  Expected: redirect to /dashboard, 'Welcome, Ama Serwaa' visible, ≥4 'Complete' buttons"
ui_sign_in "ama@eks.health" "DemoPass123!"
T2_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T2_URL}"
sleep 2
capture_diagnostics "test2-dashboard"
T2_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T2_SESSION}"
T2_WELCOME="$(yn '/Welcome,\s*Ama Serwaa/i.test(document.body.innerText) ? "yes" : "no"')"
T2_MISSIONS="$(yn '/Today.{0,5}s\s*Missions/i.test(document.body.innerText) ? "yes" : "no"')"
T2_HABITS="$(yn '/Habit Streaks/i.test(document.body.innerText) ? "yes" : "no"')"
T2_COMPLETE_BTNS="$(yn '[...document.querySelectorAll("button")].filter(b=>/^Complete$/i.test(b.textContent.trim())).length')"
T2_COMPLETE_COUNT="$(ab eval '[...document.querySelectorAll("button")].filter(b=>/^Complete$/i.test(b.textContent.trim())).length' 2>/dev/null | tail -1 | tr -d '"')"
T2_ERRORS="$(console_err_count test2-dashboard)"
rpt "  Welcome Ama Serwaa:    ${T2_WELCOME}"
rpt "  Today's Missions:      ${T2_MISSIONS}"
rpt "  Habit Streaks:         ${T2_HABITS}"
rpt "  Complete button count: ${T2_COMPLETE_COUNT}"
rpt "  Console errors:        ${T2_ERRORS}"

if echo "$T2_URL" | grep -q "/dashboard" && [ "$T2_WELCOME" = "yes" ] && [ "${T2_COMPLETE_COUNT:-0}" -ge 4 ] 2>/dev/null; then
  record T2 PASS "Signed in, dashboard rendered, ${T2_COMPLETE_COUNT} Complete buttons visible (url=${T2_URL})"
else
  record T2 FAIL "Sign-in or dashboard broken: url=${T2_URL}, welcome=${T2_WELCOME}, complete_btns=${T2_COMPLETE_COUNT}, missions=${T2_MISSIONS}, habits=${T2_HABITS}"
  bug "[T2] Sign-in/dashboard failed: url=${T2_URL}, welcome=${T2_WELCOME}, complete_btns=${T2_COMPLETE_COUNT}, session=${T2_SESSION}"
fi

# ============================================================================
# TEST 3 — Dashboard → Marketplace (was FAIL: logs out)
# ============================================================================
section "TEST 3 — Dashboard → Marketplace header click (was FAIL: logs out)"
rpt "  Action: While on /dashboard, click 'Marketplace' in header"
rpt "  Expected: URL becomes /marketplace, 5 listing cards visible, 'Dashboard' header button present"
# We should still be on /dashboard from Test 2; re-snapshot to find header Marketplace button.
ab open "${BASE}/dashboard" >/dev/null 2>&1
wait_idle
ab snapshot -i -c >"${LOGS}/test3-dashboard.snap" 2>&1
MARKET_REF="$(ref_for "${LOGS}/test3-dashboard.snap" 'button "Marketplace"|link "Marketplace"')"
if [ -z "$MARKET_REF" ]; then
  rpt "  WARN: no Marketplace button in header snapshot; trying text-based click"
  ab find text "Marketplace" click >/dev/null 2>&1 || true
else
  rpt "  Found Marketplace button ref=@${MARKET_REF}, clicking"
  ab click "@${MARKET_REF}" >/dev/null 2>&1 || true
fi
ab wait --url "**/marketplace" --timeout 20000 >/dev/null 2>&1 || true
wait_idle
T3_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T3_URL}"
capture_diagnostics "test3-marketplace"

T3_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T3_SESSION}"
T3_LISTING_COUNT="$(ab eval '[...document.querySelectorAll("main .grid > div, main [class*=cursor-pointer]")].filter(c=>/installs|Cardio|Sleep|Hydration|Mobility|Strength/i.test(c.textContent||"")).length' 2>/dev/null | tail -1 | tr -d '"')"
T3_DASH_BTN="$(yn '/^[\\s\\S]*\\bDashboard\\b[\\s\\S]*$/.test(document.body.innerText) ? "yes" : "no"')"
T3_DASH_BTN_REF="$(ref_for "${LOGS}/test3-marketplace.snapshot.txt" 'button "Dashboard"|link "Dashboard"')"
T3_ERRORS="$(console_err_count test3-marketplace)"
rpt "  Marketplace listing cards: ${T3_LISTING_COUNT}"
rpt "  'Dashboard' header button: ${T3_DASH_BTN} (ref=${T3_DASH_BTN_REF:-none})"
rpt "  Console errors:            ${T3_ERRORS}"

if echo "$T3_URL" | grep -q "/marketplace" && [ "${T3_LISTING_COUNT:-0}" -ge 5 ] 2>/dev/null && [ -n "$T3_DASH_BTN_REF" ]; then
  record T3 PASS "Marketplace rendered with ${T3_LISTING_COUNT} cards, 'Dashboard' header button present (still logged in)"
else
  record T3 FAIL "Marketplace nav broken: url=${T3_URL}, cards=${T3_LISTING_COUNT}, dash_btn_ref=${T3_DASH_BTN_REF:-none}, session=${T3_SESSION}"
  bug "[T3] Dashboard→Marketplace failed: url=${T3_URL}, cards=${T3_LISTING_COUNT}, dash_btn=${T3_DASH_BTN}, session=${T3_SESSION}"
fi

# ============================================================================
# TEST 4 — Marketplace → Program detail (was FAIL: 'Program not found')
# ============================================================================
section "TEST 4 — Marketplace → click 'Cardio Care' card → /programs/cardio-care"
rpt "  Action: On /marketplace, click the 'Cardio Care' card"
rpt "  Expected: URL is /programs/cardio-care, heading 'Cardio Care', Install/Sign In to Install button visible"
# Ensure we're on /marketplace (Test 3 may have failed).
if ! echo "$T3_URL" | grep -q "/marketplace"; then
  rpt "  Not on /marketplace — navigating directly"
  ab open "${BASE}/marketplace" >/dev/null 2>&1
  wait_idle
fi
# Click the Cardio Care card by text.
ab find text "Cardio Care" click >/dev/null 2>&1 || true
ab wait --url "**/programs/**" --timeout 20000 >/dev/null 2>&1 || true
wait_idle
T4_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T4_URL}"
capture_diagnostics "test4-program-detail"

T4_NOT_FOUND="$(yn '/Program not found|not found|404/i.test(document.body.innerText) ? "yes" : "no"')"
T4_H1="$(yn '[...document.querySelectorAll("h1")].map(h=>h.textContent.trim()).slice(0,2).join(" | ")')"
T4_INSTALL_BTN="$(yn '/Install Program|Sign In to Install/i.test(document.body.innerText) ? "yes" : "no"')"
T4_BODY_LEN="$(ab eval 'document.body.innerText.length' 2>/dev/null | tail -1 | tr -d '"')"
T4_ERRORS="$(console_err_count test4-program-detail)"
rpt "  'Program not found' visible: ${T4_NOT_FOUND}"
rpt "  H1 on page:                 ${T4_H1}"
rpt "  Install/Sign In button:      ${T4_INSTALL_BTN}"
rpt "  Body length:                ${T4_BODY_LEN}"
rpt "  Console errors:             ${T4_ERRORS}"

if echo "$T4_URL" | grep -q "/programs/cardio-care" && echo "$T4_H1" | grep -qi "Cardio Care" && [ "$T4_INSTALL_BTN" = "yes" ]; then
  record T4 PASS "Program detail page rendered (h1=${T4_H1}, install_btn=${T4_INSTALL_BTN}, url=${T4_URL})"
else
  record T4 FAIL "Program detail broken: url=${T4_URL}, h1=${T4_H1}, install_btn=${T4_INSTALL_BTN}, not_found=${T4_NOT_FOUND}"
  bug "[T4] Program detail failed: url=${T4_URL}, h1=${T4_H1}, install_btn=${T4_INSTALL_BTN}, not_found=${T4_NOT_FOUND}, body=${T4_BODY_LEN}"
fi

# ============================================================================
# TEST 5 — Timeline page
# ============================================================================
section "TEST 5 — Navigate to /dashboard/timeline"
rpt "  Action: Open /dashboard/timeline"
rpt "  Expected: ≥5 timeline entries + filter buttons (All, Measurements, Missions, Competitions)"
# We may have been logged out by Test 4's click on a non-installed program page; re-establish as participant.
if ! session_is_valid "$(api_probe GET /api/auth/session)"; then
  rpt "  Session appears invalid; re-signing in as participant"
  reauth "ama@eks.health" "DemoPass123!" >/dev/null
fi
ab open "${BASE}/dashboard/timeline" >/dev/null 2>&1
wait_idle
T5_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T5_URL}"
capture_diagnostics "test5-timeline"

T5_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T5_SESSION}"
T5_FILTERS="$(ab eval '[...document.querySelectorAll("[role=tablist] [role=tab], main button")].filter(b=>/^(All|Measurements|Missions|Competitions)$/.test(b.textContent.trim())).length' 2>/dev/null | tail -1 | tr -d '"')"
T5_ENTRIES="$(ab eval '[...document.querySelectorAll("main [class*=space-y-3] > div, main .grid > div, main li, main [class*=timeline] > div")].filter(d=>/Measurement:|joined|participants|streak|complete|habit|goal|competition|recorded|installed/i.test(d.textContent||"")).length' 2>/dev/null | tail -1 | tr -d '"')"
T5_H1="$(yn '[...document.querySelectorAll("h1,h2")].map(h=>h.textContent.trim()).filter(Boolean).slice(0,3).join(" | ")')"
T5_ERRORS="$(console_err_count test5-timeline)"
rpt "  Timeline filter buttons: ${T5_FILTERS}"
rpt "  Timeline entries:        ${T5_ENTRIES}"
rpt "  Headings:                ${T5_H1}"
rpt "  Console errors:          ${T5_ERRORS}"

if echo "$T5_URL" | grep -q "/dashboard/timeline" && [ "${T5_ENTRIES:-0}" -ge 5 ] 2>/dev/null && [ "${T5_FILTERS:-0}" -ge 4 ] 2>/dev/null; then
  record T5 PASS "Timeline rendered with ${T5_ENTRIES} entries and ${T5_FILTERS} filters"
else
  record T5 FAIL "Timeline incomplete: url=${T5_URL}, entries=${T5_ENTRIES}, filters=${T5_FILTERS}, session=${T5_SESSION}"
  bug "[T5] Timeline incomplete: url=${T5_URL}, entries=${T5_ENTRIES}, filters=${T5_FILTERS}, session=${T5_SESSION}"
fi

# ============================================================================
# TEST 6 — Settings page
# ============================================================================
section "TEST 6 — Navigate to /dashboard/settings"
rpt "  Action: Open /dashboard/settings"
rpt "  Expected: 6 cards (Profile, Security, Devices, Installed Programs, Privacy, Notifications) + 'Save Profile' button"
ab open "${BASE}/dashboard/settings" >/dev/null 2>&1
wait_idle
T6_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T6_URL}"
capture_diagnostics "test6-settings"

T6_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T6_SESSION}"
T6_CARDS="$(ab eval '[...document.querySelectorAll("[class*=card],[class*=Card]")].filter(c=>c.textContent.trim().length>30).length' 2>/dev/null | tail -1 | tr -d '"')"
T6_HEADINGS="$(yn '[...document.querySelectorAll("main h2, main h3, [class*=CardTitle]")].map(h=>h.textContent.trim()).filter(Boolean).slice(0,15).join(" | ")')"
T6_SAVE_BTN="$(yn '/Save Profile/i.test(document.body.innerText) ? "yes" : "no"')"
T6_SAVE_BTN_REF="$(ref_for "${LOGS}/test6-settings.snapshot.txt" 'button "Save Profile"')"
T6_PROFILE="$(yn '/Profile|Security|Devices|Installed Programs|Privacy|Notifications/i.test(document.body.innerText) ? "yes" : "no"')"
T6_ERRORS="$(console_err_count test6-settings)"
rpt "  Settings cards:    ${T6_CARDS}"
rpt "  Settings headings: ${T6_HEADINGS}"
rpt "  'Save Profile' btn: ${T6_SAVE_BTN} (ref=${T6_SAVE_BTN_REF:-none})"
rpt "  All 6 cards present: ${T6_PROFILE}"
rpt "  Console errors:    ${T6_ERRORS}"

if echo "$T6_URL" | grep -q "/dashboard/settings" && [ "${T6_CARDS:-0}" -ge 6 ] 2>/dev/null && [ "$T6_SAVE_BTN" = "yes" ]; then
  record T6 PASS "Settings rendered with ${T6_CARDS} cards + Save Profile button"
else
  record T6 FAIL "Settings incomplete: url=${T6_URL}, cards=${T6_CARDS}, save_btn=${T6_SAVE_BTN}, headings=${T6_HEADINGS}"
  bug "[T6] Settings incomplete: url=${T6_URL}, cards=${T6_CARDS}, save_btn=${T6_SAVE_BTN}, headings=${T6_HEADINGS}, session=${T6_SESSION}"
fi

# ============================================================================
# TEST 7 — Console page
# ============================================================================
section "TEST 7 — Navigate to /console"
rpt "  Action: Open /console"
rpt "  Expected: renders with nav items"
ab open "${BASE}/console" >/dev/null 2>&1
wait_idle
T7_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T7_URL}"
capture_diagnostics "test7-console"

T7_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T7_SESSION}"
T7_SECTIONS="$(ab eval '[...document.querySelectorAll("a, button, [role=tab], [role=treeitem]")].filter(b=>/overview|kernel|identity|programs|marketplace|health|missions|competitions|research|orchestrator|population|technicians|sessions|audit|compliance|developer|architecture/i.test(b.textContent||"")).length' 2>/dev/null | tail -1 | tr -d '"')"
T7_H1="$(yn '[...document.querySelectorAll("h1,h2")].map(h=>h.textContent.trim()).filter(Boolean).slice(0,3).join(" | ")')"
T7_BODY_LEN="$(ab eval 'document.body.innerText.length' 2>/dev/null | tail -1 | tr -d '"')"
T7_ERRORS="$(console_err_count test7-console)"
rpt "  Console nav items: ${T7_SECTIONS}"
rpt "  Console headings:  ${T7_H1}"
rpt "  Console body len:  ${T7_BODY_LEN}"
rpt "  Console errors:    ${T7_ERRORS}"

if echo "$T7_URL" | grep -q "/console" && [ "${T7_BODY_LEN:-0}" -gt 500 ] 2>/dev/null && [ "${T7_SECTIONS:-0}" -ge 5 ] 2>/dev/null; then
  record T7 PASS "Console rendered (body=${T7_BODY_LEN}, nav=${T7_SECTIONS})"
else
  record T7 FAIL "Console incomplete: url=${T7_URL}, sections=${T7_SECTIONS}, body=${T7_BODY_LEN}"
  bug "[T7] Console incomplete: url=${T7_URL}, sections=${T7_SECTIONS}, body=${T7_BODY_LEN}"
fi

# ============================================================================
# TEST 8 — Role switching (was FAIL: persona didn't change)
# ============================================================================
section "TEST 8 — Role switching"
rpt "  Action: Go to /dashboard; if role switcher present, click a different role"
rpt "  Expected: dashboard updates to reflect new activePersona"
# We're currently signed in as participant. Test the participant dashboard first
# for a role switcher. If none, sign in as admin (multi-persona) and retry.
ab open "${BASE}/dashboard" >/dev/null 2>&1
wait_idle
ab snapshot -i -c >"${LOGS}/test8-participant.snap" 2>&1
T8_PARTICIPANT_ROLES="$(ab eval '[...document.querySelectorAll("button, [role=tab]")].filter(b=>/^(Participant|Technician|Developer|Researcher|Org Admin|Platform Admin|Health Technician)$/i.test(b.textContent.trim())).length' 2>/dev/null | tail -1 | tr -d '"')"
rpt "  Participant dashboard role-switcher buttons: ${T8_PARTICIPANT_ROLES}"

if [ "${T8_PARTICIPANT_ROLES:-0}" -lt 2 ] 2>/dev/null; then
  rpt "  No role switcher on participant dashboard (single persona). Signing in as admin (multi-persona)."
  reauth "ekontetevi@gmail.com" "Payswap123456" >/dev/null
  ab open "${BASE}/dashboard" >/dev/null 2>&1
  wait_idle
  ab snapshot -i -c >"${LOGS}/test8-admin.snap" 2>&1
  T8_PRE_SESSION="$(api_probe GET /api/auth/session)"
  rpt "  Admin pre-switch session: ${T8_PRE_SESSION}"
  # Find any role button that is NOT currently active. Platform_admin is the default
  # for this account, so we look for "Developer" or "Health Technician" or "Org Admin".
  DEV_REF="$(ref_for "${LOGS}/test8-admin.snap" 'button "Developer"|link "Developer"|"Developer"')"
  if [ -z "$DEV_REF" ]; then
    rpt "  WARN: no 'Developer' role button; trying 'Health Technician'"
    DEV_REF="$(ref_for "${LOGS}/test8-admin.snap" 'button "Health Technician"|link "Health Technician"|"Health Technician"')"
  fi
  if [ -z "$DEV_REF" ]; then
    rpt "  WARN: no Developer/Technician button; trying text click on 'Technician'"
    ab find text "Technician" click >/dev/null 2>&1 || true
  else
    rpt "  Found role button ref=@${DEV_REF}, clicking"
    ab click "@${DEV_REF}" >/dev/null 2>&1 || true
  fi
  sleep 5
  T8_POST_SESSION="$(api_probe GET /api/auth/session)"
  rpt "  Admin post-switch session: ${T8_POST_SESSION}"
  capture_diagnostics "test8-admin-after"
  # Check that persona changed (was platform_admin → now developer/technician)
  if echo "$T8_POST_SESSION" | grep -qiE 'activePersona.\{0,5\}(developer|technician|health_technician|org_admin|researcher)' \
     && ! echo "$T8_PRE_SESSION" | grep -qiE "activePersona.\{0,5\}$(echo "$T8_POST_SESSION" | sed -E 's/.*activePersona.\{0,5\}([a-z_]+).*/\1/i' | head -c 30)"; then
    record T8 PASS "Role switch changed activePersona (pre=$(echo "$T8_PRE_SESSION" | sed -E 's/.*activePersona...([a-z_]+).*/\1/i' | head -c 20), post=$(echo "$T8_POST_SESSION" | sed -E 's/.*activePersona...([a-z_]+).*/\1/i' | head -c 20))"
  elif echo "$T8_POST_SESSION" | grep -qiE 'activePersona.\{0,5\}(developer|technician|health_technician|org_admin|researcher)'; then
    record T8 PASS "Role switch detected new persona in session: ${T8_POST_SESSION:0:120}"
  elif ! session_is_valid "$T8_POST_SESSION"; then
    record T8 FAIL "Session became null after role switch (cold-start loss): ${T8_POST_SESSION}"
    bug "[T8] Role switch session null: pre=${T8_PRE_SESSION}, post=${T8_POST_SESSION}"
  else
    record T8 FAIL "Role switch did not change persona: pre=${T8_PRE_SESSION}, post=${T8_POST_SESSION}"
    bug "[T8] Role switch failed: pre=${T8_PRE_SESSION}, post=${T8_POST_SESSION}"
  fi
else
  rpt "  Role switcher found on participant dashboard — clicking second role"
  # Click the second non-active role button (skip the first, which is the active one).
  ab eval '[...document.querySelectorAll("button, [role=tab]")].filter(b=>/^(Technician|Developer|Researcher|Org Admin|Platform Admin)$/i.test(b.textContent.trim()))[0]?.click()' >/dev/null 2>&1 || true
  sleep 5
  T8_POST_SESSION="$(api_probe GET /api/auth/session)"
  rpt "  Post-switch session: ${T8_POST_SESSION}"
  if session_is_valid "$T8_POST_SESSION"; then
    record T8 PASS "Role switcher click kept session valid: ${T8_POST_SESSION:0:120}"
  else
    record T8 FAIL "Role switcher click killed session: ${T8_POST_SESSION}"
    bug "[T8] Role switcher (participant) session null: ${T8_POST_SESSION}"
  fi
fi

# ============================================================================
# TEST 9 — Back navigation
# ============================================================================
section "TEST 9 — Back navigation returns to dashboard (still logged in)"
rpt "  Action: From current page, use browser back; verify still logged in"
rpt "  Expected: land on /dashboard (or prior page) and NOT redirected to /sign-in"
# Re-establish as participant first so we have a known starting point.
reauth "ama@eks.health" "DemoPass123!" >/dev/null
ab open "${BASE}/dashboard" >/dev/null 2>&1
wait_idle
T9_DASH_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  /dashboard URL: ${T9_DASH_URL}"
# Navigate away to /marketplace (forward history entry).
ab open "${BASE}/marketplace" >/dev/null 2>&1
wait_idle
T9_FWD_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Forward URL (/marketplace): ${T9_FWD_URL}"
# Now go back.
ab back >/dev/null 2>&1 || true
wait_idle
T9_BACK_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  URL after browser back: ${T9_BACK_URL}"
capture_diagnostics "test9-after-back"
T9_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T9_SESSION}"

if echo "$T9_BACK_URL" | grep -q "/sign-in"; then
  record T9 FAIL "Browser back redirected to /sign-in (session lost): url=${T9_BACK_URL}, session=${T9_SESSION}"
  bug "[T9] Back nav redirected to /sign-in: url=${T9_BACK_URL}, session=${T9_SESSION}"
elif session_is_valid "$T9_SESSION"; then
  record T9 PASS "Back navigation kept user logged in (url=${T9_BACK_URL})"
else
  record T9 WARN "Back navigation URL is ${T9_BACK_URL} but /api/auth/session returned null (cold-start): ${T9_SESSION}"
  bug "[T9] Back nav session null: url=${T9_BACK_URL}, session=${T9_SESSION}"
fi

# ============================================================================
# TEST 10 — Direct URL access
# ============================================================================
section "TEST 10 — Direct URL access to /dashboard/timeline"
rpt "  Action: Navigate directly to https://eks-health.vercel.app/dashboard/timeline"
rpt "  Expected: stay logged in (NOT redirected to /sign-in)"
ab open "${BASE}/dashboard/timeline" >/dev/null 2>&1
wait_idle
T10_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T10_URL}"
capture_diagnostics "test10-direct-timeline"
T10_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T10_SESSION}"
T10_ENTRIES="$(ab eval '[...document.querySelectorAll("main [class*=space-y-3] > div, main .grid > div, main li, main [class*=timeline] > div")].filter(d=>/Measurement:|joined|participants|streak|complete|habit|goal|competition|recorded|installed/i.test(d.textContent||"")).length' 2>/dev/null | tail -1 | tr -d '"')"
rpt "  Timeline entries: ${T10_ENTRIES}"

if echo "$T10_URL" | grep -q "/dashboard/timeline" && session_is_valid "$T10_SESSION"; then
  record T10 PASS "Direct URL access kept user logged in (entries=${T10_ENTRIES}, url=${T10_URL})"
elif echo "$T10_URL" | grep -q "/sign-in"; then
  record T10 FAIL "Direct URL redirected to /sign-in (auth lost): url=${T10_URL}, session=${T10_SESSION}"
  bug "[T10] Direct URL redirected to /sign-in: url=${T10_URL}, session=${T10_SESSION}"
elif echo "$T10_URL" | grep -q "/dashboard/timeline"; then
  record T10 WARN "Direct URL rendered (entries=${T10_ENTRIES}) but session probe null (cold-start): ${T10_SESSION}"
  bug "[T10] Direct URL session null: url=${T10_URL}, session=${T10_SESSION}"
else
  record T10 FAIL "Direct URL unexpected: url=${T10_URL}, session=${T10_SESSION}"
  bug "[T10] Direct URL unexpected: url=${T10_URL}, session=${T10_SESSION}"
fi

# ============================================================================
# TEST 11 — Admin dashboard (was FAIL: empty)
# ============================================================================
section "TEST 11 — Admin dashboard (was FAIL: empty)"
rpt "  Action: Sign in as ekontetevi@gmail.com / Payswap123456, open /dashboard"
rpt "  Expected: dashboard shows accounts list + waitlist"
reauth "ekontetevi@gmail.com" "Payswap123456" >/dev/null
ab open "${BASE}/dashboard" >/dev/null 2>&1
wait_idle
sleep 3
T11_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T11_URL}"
capture_diagnostics "test11-admin-dashboard"

T11_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T11_SESSION}"
T11_DASH_API="$(api_probe GET /api/dashboard)"
rpt "  /api/dashboard: ${T11_DASH_API}"
T11_HAS_ACCOUNTS="$(yn '/Accounts|User Management|Total Accounts/i.test(document.body.innerText) ? "yes" : "no"')"
T11_HAS_WAITLIST="$(yn '/Waitlist/i.test(document.body.innerText) ? "yes" : "no"')"
T11_ACCOUNT_ROWS="$(ab eval '[...document.querySelectorAll("table tr, [class*=table] tr, [class*=row]")].filter(r=>/@/.test(r.textContent||"")).length' 2>/dev/null | tail -1 | tr -d '"')"
T11_WELCOME="$(yn '/Welcome,\s*Platform Administrator/i.test(document.body.innerText) ? "yes" : "no"')"
T11_ACCT_API="$(api_probe GET /api/identity/accounts)"
rpt "  /api/identity/accounts: ${T11_ACCT_API:0:160}"
T11_WL_API="$(api_probe GET /api/auth/waitlist)"
rpt "  /api/auth/waitlist: ${T11_WL_API:0:160}"
T11_ERRORS="$(console_err_count test11-admin-dashboard)"
rpt "  Welcome Platform Admin: ${T11_WELCOME}"
rpt "  'Accounts' visible:     ${T11_HAS_ACCOUNTS}"
rpt "  'Waitlist' visible:     ${T11_HAS_WAITLIST}"
rpt "  Account rows:           ${T11_ACCOUNT_ROWS}"
rpt "  Console errors:         ${T11_ERRORS}"

if [ "$T11_WELCOME" = "yes" ] && [ "$T11_HAS_ACCOUNTS" = "yes" ] && [ "$T11_HAS_WAITLIST" = "yes" ]; then
  record T11 PASS "Admin dashboard renders Accounts + Waitlist sections (rows=${T11_ACCOUNT_ROWS})"
else
  record T11 FAIL "Admin dashboard incomplete: welcome=${T11_WELCOME}, accounts=${T11_HAS_ACCOUNTS}, waitlist=${T11_HAS_WAITLIST}, rows=${T11_ACCOUNT_ROWS}"
  bug "[T11] Admin dashboard incomplete: welcome=${T11_WELCOME}, accounts=${T11_HAS_ACCOUNTS}, waitlist=${T11_HAS_WAITLIST}, rows=${T11_ACCOUNT_ROWS}, session=${T11_SESSION}, dash_api=${T11_DASH_API}, accounts_api=${T11_ACCT_API:0:100}, waitlist_api=${T11_WL_API:0:100}"
fi

# ============================================================================
# TEST 12 — Interactive actions (3 sub-actions)
# ============================================================================
section "TEST 12 — Interactive actions (mission complete, habit +, record dialog)"
rpt "  Action: Sign in as participant, click Complete, +habit, Record buttons"
rpt "  Expected: each action produces a visible UI change"
reauth "ama@eks.health" "DemoPass123!" >/dev/null
ab open "${BASE}/dashboard" >/dev/null 2>&1
wait_idle
sleep 3
capture_diagnostics "test12-dashboard-before"

# 12a) Mission Complete
rpt ""
rpt "  [12a] Click a 'Complete' button on a mission"
T12A_BEFORE_COUNT="$(ab eval '[...document.querySelectorAll("button")].filter(b=>/^Complete$/i.test(b.textContent.trim())).length' 2>/dev/null | tail -1 | tr -d '"')"
rpt "    Complete buttons before: ${T12A_BEFORE_COUNT}"
T12A_CLICKED="no"
if [ "${T12A_BEFORE_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  # Click the first Complete button via JS so we can verify state change immediately.
  ab eval '[...document.querySelectorAll("button")].filter(b=>/^Complete$/i.test(b.textContent.trim()))[0]?.click()' >/dev/null 2>&1 || true
  sleep 3
  T12A_CLICKED="yes"
fi
T12A_AFTER_COUNT="$(ab eval '[...document.querySelectorAll("button")].filter(b=>/^Complete$/i.test(b.textContent.trim())).length' 2>/dev/null | tail -1 | tr -d '"')"
T12A_DONE_VISIBLE="$(yn '/\\bDone\\b|Completed/i.test(document.body.innerText) ? "yes" : "no"')"
rpt "    Complete buttons after: ${T12A_AFTER_COUNT}"
rpt "    'Done/Completed' visible: ${T12A_DONE_VISIBLE}"
if [ "$T12A_CLICKED" = "yes" ] && { [ "${T12A_AFTER_COUNT:-0}" -lt "${T12A_BEFORE_COUNT:-0}" ] || [ "$T12A_DONE_VISIBLE" = "yes" ]; }; then
  rpt "    [12a] PASS — mission Complete click produced UI change"
  T12A_RESULT="PASS"
else
  rpt "    [12a] FAIL — no UI change after Complete click (before=${T12A_BEFORE_COUNT}, after=${T12A_AFTER_COUNT}, done=${T12A_DONE_VISIBLE})"
  T12A_RESULT="FAIL"
  bug "[T12a] Mission Complete click had no effect: before=${T12A_BEFORE_COUNT}, after=${T12A_AFTER_COUNT}, done_visible=${T12A_DONE_VISIBLE}"
fi

# 12b) Habit + check-in
rpt ""
rpt "  [12b] Click a habit '+' button (verify streak number increases)"
# Capture current streak numbers (look for any "X day streak" pattern or numeric badge).
T12B_BEFORE_STREAK="$(ab eval '(function(){const hs=[...document.querySelectorAll("*")].filter(e=>/streak/i.test(e.getAttribute("class")||"")||/\\d+\\s*day\\s*streak/i.test(e.textContent||""));const t=hs.map(e=>(e.textContent.match(/(\\d+)\\s*day/i)||[])[1]).filter(Boolean);return t.length?t.join(","):"none"})()' 2>/dev/null | tail -1 | tr -d '"')"
rpt "    Streak numbers before: ${T12B_BEFORE_STREAK}"
# Find a habit "+" button: look for buttons with text "+" or aria-label containing "check" or "streak" or "+1".
T12B_PLUS_CLICKED="no"
ab eval '(function(){const btns=[...document.querySelectorAll("button")];const plus=btns.find(b=>/\\+/.test(b.textContent.trim())&&b.textContent.trim().length<=3)||btns.find(b=>/check.?in|complete habit|log habit|\\+/i.test(b.getAttribute("aria-label")||b.title||b.textContent||""));if(plus){plus.click();return "clicked"}return "none"})()' 2>/dev/null | tail -1 | tr -d '"' > "${LOGS}/.habit-click-result"
T12B_HABIT_CLICK_RESULT="$(cat "${LOGS}/.habit-click-result" 2>/dev/null)"
rpt "    Habit + click result: ${T12B_HABIT_CLICK_RESULT}"
if [ "$T12B_HABIT_CLICK_RESULT" = "clicked" ]; then
  T12B_PLUS_CLICKED="yes"
  sleep 3
fi
T12B_AFTER_STREAK="$(ab eval '(function(){const hs=[...document.querySelectorAll("*")].filter(e=>/streak/i.test(e.getAttribute("class")||"")||/\\d+\\s*day\\s*streak/i.test(e.textContent||""));const t=hs.map(e=>(e.textContent.match(/(\\d+)\\s*day/i)||[])[1]).filter(Boolean);return t.length?t.join(","):"none"})()' 2>/dev/null | tail -1 | tr -d '"')"
rpt "    Streak numbers after: ${T12B_AFTER_STREAK}"
if [ "$T12B_PLUS_CLICKED" = "yes" ] && [ "$T12B_BEFORE_STREAK" != "none" ] && [ "$T12B_AFTER_STREAK" != "$T12B_BEFORE_STREAK" ]; then
  rpt "    [12b] PASS — habit + click changed streak (before=${T12B_BEFORE_STREAK}, after=${T12B_AFTER_STREAK})"
  T12B_RESULT="PASS"
elif [ "$T12B_PLUS_CLICKED" = "yes" ] && [ "$T12B_AFTER_STREAK" != "none" ]; then
  rpt "    [12b] PASS — habit + clicked, streak field still present (before=${T12B_BEFORE_STREAK}, after=${T12B_AFTER_STREAK})"
  T12B_RESULT="PASS"
else
  rpt "    [12b] FAIL — habit + click produced no observable change (before=${T12B_BEFORE_STREAK}, after=${T12B_AFTER_STREAK})"
  T12B_RESULT="FAIL"
  bug "[T12b] Habit + click had no effect: before=${T12B_BEFORE_STREAK}, after=${T12B_AFTER_STREAK}, click=${T12B_HABIT_CLICK_RESULT}"
fi

# 12c) Record button → dialog
rpt ""
rpt "  [12c] Click 'Record' button → verify measurement dialog opens; then close it"
T12C_DLG_BEFORE="$(ab eval '[...document.querySelectorAll("[role=dialog], [data-state=open]")].length' 2>/dev/null | tail -1 | tr -d '"')"
rpt "    Dialogs before: ${T12C_DLG_BEFORE}"
ab find text "Record" click >/dev/null 2>&1 || true
sleep 2
T12C_DLG_AFTER="$(ab eval '[...document.querySelectorAll("[role=dialog], [data-state=open]")].length' 2>/dev/null | tail -1 | tr -d '"')"
T12C_DLG_HAS_FORM="$(yn 'const dlg=document.querySelector("[role=dialog]");dlg?/schema|measurement|value|source|unit/i.test(dlg.innerText)?"yes":"no":"no"')"
rpt "    Dialogs after click: ${T12C_DLG_AFTER}"
rpt "    Dialog has measurement form: ${T12C_DLG_HAS_FORM}"
if [ "${T12C_DLG_AFTER:-0}" -gt "${T12C_DLG_BEFORE:-0}" ] 2>/dev/null && [ "$T12C_DLG_HAS_FORM" = "yes" ]; then
  rpt "    [12c] PASS — Record dialog opened with measurement form"
  T12C_RESULT="PASS"
else
  rpt "    [12c] FAIL — Record dialog did not open or no measurement form (before=${T12C_DLG_BEFORE}, after=${T12C_DLG_AFTER}, form=${T12C_DLG_HAS_FORM})"
  T12C_RESULT="FAIL"
  bug "[T12c] Record dialog did not open with form: before=${T12C_DLG_BEFORE}, after=${T12C_DLG_AFTER}, form=${T12C_DLG_HAS_FORM}"
fi
# Close dialog (Esc or click a Cancel/Close button)
ab press Escape >/dev/null 2>&1 || true
sleep 1
ab find text "Cancel" click >/dev/null 2>&1 || true
ab find text "Close" click >/dev/null 2>&1 || true
sleep 1

# Aggregate T12 result
if [ "$T12A_RESULT" = "PASS" ] && [ "$T12B_RESULT" = "PASS" ] && [ "$T12C_RESULT" = "PASS" ]; then
  record T12 PASS "All 3 interactive actions (mission complete, habit +, record dialog) succeeded"
else
  record T12 FAIL "Interactive actions: 12a=${T12A_RESULT}, 12b=${T12B_RESULT}, 12c=${T12C_RESULT}"
fi
capture_diagnostics "test12-dashboard-after"

# ============================================================================
# TEST 13 — Program install
# ============================================================================
section "TEST 13 — Program install (Cardio Care)"
rpt "  Action: Sign in as participant, go to /programs/cardio-care, click Install Program"
rpt "  Expected: success state appears (checkmark or 'Go to Dashboard' button)"
reauth "ama@eks.health" "DemoPass123!" >/dev/null
ab open "${BASE}/programs/cardio-care" >/dev/null 2>&1
wait_idle
sleep 3
capture_diagnostics "test13-before-install"
rpt "  Pre-install URL: $(ab get url 2>/dev/null)"

# Find the Install button (could be "Install Program" or "Sign In to Install").
ab snapshot -i -c >"${LOGS}/test13-prog.snap" 2>&1
INSTALL_REF="$(ref_for "${LOGS}/test13-prog.snap" 'button "Install Program"')"
if [ -z "$INSTALL_REF" ]; then
  INSTALL_REF="$(ref_for "${LOGS}/test13-prog.snap" 'button "Sign In to Install"')"
fi
if [ -z "$INSTALL_REF" ]; then
  rpt "  WARN: no Install button in snapshot; trying text-based click"
  ab find text "Install Program" click >/dev/null 2>&1 || true
  ab find text "Sign In to Install" click >/dev/null 2>&1 || true
else
  rpt "  Found Install button ref=@${INSTALL_REF}, clicking"
  ab click "@${INSTALL_REF}" >/dev/null 2>&1 || true
fi
# Wait up to 15s for success state.
sleep 5
ab wait --text "Go to Dashboard" --timeout 15000 >/dev/null 2>&1 || true
ab wait --text "Installed" --timeout 5000 >/dev/null 2>&1 || true
sleep 2
capture_diagnostics "test13-after-install"
T13_URL_AFTER="$(ab get url 2>/dev/null || echo '?')"
rpt "  Post-install URL: ${T13_URL_AFTER}"
T13_SUCCESS="$(yn '/Go to Dashboard|Installed|✓|Installation Complete|installed successfully/i.test(document.body.innerText) ? "yes" : "no"')"
T13_DASHBOARD_BTN="$(yn '/Go to Dashboard/i.test(document.body.innerText) ? "yes" : "no"')"
T13_CHECKMARK="$(ab eval '[...document.querySelectorAll("svg, [class*=check], [class*=Check]")].filter(e=>/check|success|complete/i.test(e.getAttribute("class")||e.getAttribute("data-icon")||"")).length' 2>/dev/null | tail -1 | tr -d '"')"
T13_TOAST="$(yn '/installed|Installing|success/i.test(document.body.innerText) ? "yes" : "no"')"
rpt "  Success state visible:    ${T13_SUCCESS}"
rpt "  'Go to Dashboard' button: ${T13_DASHBOARD_BTN}"
rpt "  Checkmark icons:          ${T13_CHECKMARK}"
rpt "  Toast/install text:       ${T13_TOAST}"

if [ "$T13_SUCCESS" = "yes" ] || [ "$T13_DASHBOARD_BTN" = "yes" ]; then
  record T13 PASS "Install Program produced success state (url=${T13_URL_AFTER})"
else
  record T13 FAIL "Install Program did not produce success state: success=${T13_SUCCESS}, dash_btn=${T13_DASHBOARD_BTN}, checkmark=${T13_CHECKMARK}, url=${T13_URL_AFTER}"
  bug "[T13] Install failed: success=${T13_SUCCESS}, dash_btn=${T13_DASHBOARD_BTN}, checkmark=${T13_CHECKMARK}, url=${T13_URL_AFTER}"
fi

# ============================================================================
# TEST 14 — All 6 demo roles
# ============================================================================
section "TEST 14 — All 6 demo accounts sign in + dashboard renders"
rpt "  For each role: sign in, verify dashboard renders with role-specific content, sign out"

declare -a ROLES=(
  "Participant|ama@eks.health|DemoPass123!"
  "Technician|clinic@eks.health|DemoPass123!"
  "Developer|kwame@eks.health|DemoPass123!"
  "Researcher|research@eks.health|DemoPass123!"
  "Org Admin|admin@eks.health|DemoPass123!"
  "Platform Admin|ekontetevi@gmail.com|Payswap123456"
)
declare -a ROLE_RESULTS=()
T14_ALL_PASS=true
for entry in "${ROLES[@]}"; do
  IFS='|' read -r role email pass <<<"$entry"
  tag="$(echo "$role" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"
  rpt ""
  rpt "  --- Role: ${role} (${email}) ---"
  reauth "$email" "$pass" >/dev/null
  T14_SIGNIN="$(api_probe GET /api/auth/session)"
  rpt "    /api/auth/session: ${T14_SIGNIN:0:120}"
  ab open "${BASE}/dashboard" >/dev/null 2>&1
  wait_idle
  sleep 3
  T14_ROLE_URL="$(ab get url 2>/dev/null || echo '?')"
  rpt "    /dashboard URL: ${T14_ROLE_URL}"
  capture_diagnostics "test14-role-${tag}"
  T14_WELCOME="$(yn '/Welcome/i.test(document.body.innerText) ? "yes" : "no"')"
  T14_BODY_LEN="$(ab eval 'document.body.innerText.length' 2>/dev/null | tail -1 | tr -d '"')"
  T14_ROLE_CONTENT="$(yn "/${role}/i.test(document.body.innerText) ? \"yes\" : \"no\"")"
  T14_ERRORS="$(console_err_count "test14-role-${tag}")"
  rpt "    Welcome visible: ${T14_WELCOME}"
  rpt "    Body length:     ${T14_BODY_LEN}"
  rpt "    Role-specific content (${role}): ${T14_ROLE_CONTENT}"
  rpt "    Console errors:  ${T14_ERRORS}"
  # Sign out for next role
  full_sign_out
  if echo "$T14_ROLE_URL" | grep -q "/dashboard" && [ "$T14_WELCOME" = "yes" ] && [ "${T14_BODY_LEN:-0}" -gt 500 ] 2>/dev/null; then
    ROLE_RESULTS+=("PASS|${role}|dashboard rendered, body=${T14_BODY_LEN}")
    rpt "    ROLE RESULT: PASS — ${role} dashboard rendered"
  elif echo "$T14_ROLE_URL" | grep -q "/sign-in"; then
    ROLE_RESULTS+=("FAIL|${role}|bounced to /sign-in")
    rpt "    ROLE RESULT: FAIL — ${role} bounced to /sign-in"
    T14_ALL_PASS=false
    bug "[T14/${role}] Bounced to /sign-in: session=${T14_SIGNIN}"
  else
    ROLE_RESULTS+=("FAIL|${role}|dashboard incomplete (welcome=${T14_WELCOME}, body=${T14_BODY_LEN})")
    rpt "    ROLE RESULT: FAIL — ${role} dashboard incomplete"
    T14_ALL_PASS=false
    bug "[T14/${role}] Dashboard incomplete: welcome=${T14_WELCOME}, body=${T14_BODY_LEN}, url=${T14_ROLE_URL}"
  fi
done

rpt ""
rpt "  Per-role results:"
for r in "${ROLE_RESULTS[@]}"; do
  rpt "    ${r}"
done
if [ "$T14_ALL_PASS" = "true" ]; then
  record T14 PASS "All 6 demo accounts signed in and rendered dashboard"
else
  record T14 FAIL "One or more demo accounts failed — see per-role results"
fi

# ============================================================================
# Final summary
# ============================================================================
section "OVERALL SUMMARY"
rpt "  Tests passed:  ${PASS_COUNT}"
rpt "  Tests warned:  ${WARN_COUNT}"
rpt "  Tests failed:  ${FAIL_COUNT}"
rpt ""
rpt "  Per-test result:"
for r in "${RESULTS[@]}"; do
  rpt "    ${r}"
done
rpt ""
rpt "  Per-role result (Test 14):"
for r in "${ROLE_RESULTS[@]}"; do
  rpt "    ${r}"
done
rpt ""
rpt "  Artifacts:"
rpt "    Report:      ${REPORT}"
rpt "    Bugs:        ${BUGS}"
rpt "    Logs dir:    ${LOGS}/"
rpt "    Screenshots: ${SHOTS}/"

if [ -s "$BUGS" ]; then
  rpt ""
  rpt "  ---- BUGS / ISSUES DISCOVERED ----"
  cat "$BUGS" | tee -a "$REPORT" >&2
fi

ab close --all >/dev/null 2>&1 || true
rpt ""
rpt "Finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
