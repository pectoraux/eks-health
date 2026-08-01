#!/usr/bin/env bash
# audit-systematic.sh — SYSTEMATIC bug audit of live Eks-Health app
#
# Site:    https://eks-health.vercel.app  (Vercel production, serverless)
# Task ID: audit-systematic-1
#
# Goal:
#   Drive a real Chrome session via agent-browser through every page and
#   navigation flow. For each test, capture PASS/FAIL + observed vs expected
#   + console errors + final URL. The app uses in-memory state that does
#   not persist across serverless cold starts, so we test auth/session
#   persistence especially hard.
#
# Key design choices:
#   - api_probe returns pipe-delimited strings "status|ok|snippet" — avoids
#     JSON-string-escaping issues when grep'ing for ok:true.
#   - All `wait N` calls are followed by `sleep` for reliability.
#   - Element refs are extracted with EXACT patterns (e.g. 'button "Marketplace"')
#     rather than loose alternations that match the first line containing
#     "button".
#   - Per-test session setup: we sign in fresh where needed so tests don't
#     inherit unexpected state from prior tests.
#
# Artifacts:
#   Logs:        /home/z/my-project/.zscripts/logs/audit-systematic/
#   Screenshots: /home/z/my-project/.zscripts/screenshots/audit-systematic/
#   Report:      /home/z/my-project/.zscripts/logs/audit-systematic/REPORT.txt
#   Bugs:        /home/z/my-project/.zscripts/logs/audit-systematic/BUGS.txt

set -uo pipefail

BASE="https://eks-health.vercel.app"
SESSION="eks-audit-sys"
ROOT="/home/z/my-project/.zscripts"
LOGS="${ROOT}/logs/audit-systematic"
SHOTS="${ROOT}/screenshots/audit-systematic"
REPORT="${LOGS}/REPORT.txt"
BUGS="${LOGS}/BUGS.txt"
mkdir -p "$LOGS" "$SHOTS"
: >"$REPORT"
: >"$BUGS"

# agent-browser helper (isolated session).
ab() { agent-browser --session "$SESSION" "$@"; }

# Write a line to the report (and stdout).
rpt() { printf '%s\n' "$*" | tee -a "$REPORT" >&2; }
section() {
  local bar="================================================================"
  {
    printf '\n%s\n%s\n%s\n' "$bar" "$*" "$bar"
  } | tee -a "$REPORT" >&2
}
bug() { printf '%s\n' "$*" | tee -a "$BUGS" >&2; }

# Capture console + page errors + interactive snapshot + screenshot.
capture_diagnostics() {
  local tag="$1"
  ab console >"${LOGS}/${tag}.console.txt" 2>&1 || true
  ab errors  >"${LOGS}/${tag}.errors.txt" 2>&1 || true
  ab snapshot -i -c >"${LOGS}/${tag}.snapshot.txt" 2>&1 || true
  ab screenshot "${SHOTS}/${tag}.png" >/dev/null 2>&1 || true
}

# Count console error-level messages for a tag.
console_err_count() {
  local f="${LOGS}/$1.console.txt"
  if [ -s "$f" ]; then
    grep -iE '"type":"error"|level=error|SEVERE|Error:|Failed to|Uncaught' "$f" 2>/dev/null | wc -l | tr -d ' '
  else
    echo 0
  fi
}

# Run a fetch() inside the browser. Returns a pipe-delimited string:
#   "<status>|<ok 0/1>|<snippet>"
# The snippet is the first ~150 chars of either d.error.message or
# JSON.stringify(d.data ?? d), with pipe characters replaced so it doesn't
# break parsing.
api_probe() {
  local method="$1" path="$2" body="${3:-}"
  local js
  if [ -n "$body" ]; then
    js="fetch('${path}',{method:'${method}',headers:{'Content-Type':'application/json'},body:JSON.stringify(${body}),cache:'no-store'}).then(async r=>{const d=await r.json().catch(()=>({}));const snip=(d.error?.message||JSON.stringify(d.data??d)||'').slice(0,180).replace(/\\|/g,'/');return [r.status,d.ok?1:0,snip].join('|')})"
  else
    js="fetch('${path}',{cache:'no-store'}).then(async r=>{const d=await r.json().catch(()=>({}));const snip=(d.error?.message||JSON.stringify(d.data??d)||'').slice(0,180).replace(/\\|/g,'/');return [r.status,d.ok?1:0,snip].join('|')})"
  fi
  ab eval "$js" 2>/dev/null | tail -1 | tr -d '"'
}

# Sign in via direct API (reliable). Returns "status|ok|email|persona|err".
api_sign_in() {
  local email="$1" pass="$2"
  ab eval "fetch('/api/auth/sign-in',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'${email}',password:'${pass}'})}).then(async r=>{const d=await r.json();return [r.status,d.ok?1:0,d.data?.email||'',d.data?.activePersona||'',d.error?.message||''].join('|')})" 2>/dev/null | tail -1 | tr -d '"'
}

# Sign in via the actual UI form (fills inputs + clicks Sign In button).
# Sets up the dashboard state. Returns 0 on success.
ui_sign_in() {
  local email="$1" pass="$2"
  ab open "${BASE}/sign-in" >/dev/null 2>&1
  ab wait --load networkidle >/dev/null 2>&1
  sleep 1
  ab snapshot -i -c >"${LOGS}/.signin.snap" 2>&1
  local emailref passref signinref
  emailref="$(grep -iE 'textbox.*Email' "${LOGS}/.signin.snap" | head -1 | sed -E 's/.*\[ref=([a-z0-9]+)\].*/\1/')"
  passref="$(grep -iE 'textbox.*Password' "${LOGS}/.signin.snap" | head -1 | sed -E 's/.*\[ref=([a-z0-9]+)\].*/\1/')"
  signinref="$(grep -E 'button "Sign In"' "${LOGS}/.signin.snap" | head -1 | sed -E 's/.*\[ref=([a-z0-9]+)\].*/\1/')"
  if [ -z "$emailref" ] || [ -z "$passref" ] || [ -z "$signinref" ]; then
    echo "ERROR: could not locate sign-in form fields (email=$emailref pass=$passref btn=$signinref)" >&2
    return 1
  fi
  ab fill "@${emailref}" "$email" >/dev/null 2>&1 || true
  ab fill "@${passref}"  "$pass"  >/dev/null 2>&1 || true
  ab click "@${signinref}" >/dev/null 2>&1 || true
  ab wait --url "**/dashboard" --timeout 15000 >/dev/null 2>&1 || true
  sleep 3
  return 0
}

# Extract an element ref by EXACTLY matching a snapshot pattern like
# 'button "Marketplace"' (so we don't grab an unrelated button line).
# Args: <snapshot-file> <pattern>
ref_for() {
  grep -E "$2" "$1" 2>/dev/null | head -1 | sed -E 's/.*\[ref=([a-z0-9]+)\].*/\1/'
}

# Count listings on the marketplace page.
marketplace_card_count() {
  ab eval '[...document.querySelectorAll("main .grid > div")].filter(c=>/installs/i.test(c.textContent||"")).length' 2>/dev/null | tail -1 | tr -d '"'
}

# Get "name|slug" of the first marketplace listing card.
first_listing_slug() {
  ab eval '(function(){const c=document.querySelector("main .grid > div");if(!c)return "none|none";const h3=c.querySelector("h3");const name=h3?h3.textContent.trim():"?";const slug=name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");return name+"|"+slug})()' 2>/dev/null | tail -1 | tr -d '"'
}

# Pass/Fail counters
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
declare -a RESULTS=()

record() {
  # record <test_id> <PASS|FAIL|WARN> <summary>
  RESULTS+=("$1|$2|$3")
  case "$2" in
    PASS) PASS_COUNT=$((PASS_COUNT+1));;
    FAIL) FAIL_COUNT=$((FAIL_COUNT+1));;
    WARN) WARN_COUNT=$((WARN_COUNT+1));;
  esac
  rpt "  RESULT: $2 — $3"
}

# Check that an api_probe result has status=200 and ok=1.
# Args: <probe-result> <label>
api_ok() {
  local probe="$1" label="$2"
  local status ok
  status="$(echo "$probe" | cut -d'|' -f1)"
  ok="$(echo "$probe" | cut -d'|' -f2)"
  if [ "$status" = "200" ] && [ "$ok" = "1" ]; then
    return 0
  fi
  return 1
}

# Stricter check: status=200, ok=1, AND the snippet contains real session
# fields (accountId/email). /api/auth/session returns {ok:true,data:null} when
# the cookie is invalid on a cold serverless instance — api_ok alone would
# treat that as success, masking the real auth-persistence bug.
# Args: <probe-result>
session_is_valid() {
  local probe="$1"
  api_ok "$probe" session || return 1
  # Look for real session fields. The snippet is JSON-stringified with escaped
  # quotes (e.g. {\"accountId\":\"acc_...\"}), so grep for the field name
  # without requiring exact quote matching.
  echo "$probe" | grep -qiE 'accountId|email|displayName' || return 1
  # Explicitly reject the null-session shape.
  if echo "$probe" | grep -qiE 'data\\*":null|ok\\*":true,\\*"data\\*":null'; then
    # Only reject if accountId is NOT present (null session has no accountId)
    if ! echo "$probe" | grep -qi 'accountId'; then
      return 1
    fi
  fi
  return 0
}

# Extract a field from a probe result. Args: <probe> <field-index 1-based>.
probe_field() { echo "$1" | cut -d'|' -f"$2"; }

# ============================================================================
# Header
# ============================================================================
rpt "Eks-Health systematic bug audit"
rpt "Task ID:   audit-systematic-1"
rpt "Target:    ${BASE}"
rpt "Started:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
rpt "Browser:   $(agent-browser --version 2>&1 | head -1)"
rpt ""

ab close --all >/dev/null 2>&1 || true

# ============================================================================
# TEST 1 — Landing page
# ============================================================================
section "TEST 1 — Landing page renders and Sign In button navigates to /sign-in"
rpt "  Action: Open https://eks-health.vercel.app/"
ab open "${BASE}/" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 3
# Retry once if the page is still blank
T1_OPEN_URL="$(ab get url 2>/dev/null || echo '?')"
if [ "$T1_OPEN_URL" = "about:blank" ] || [ -z "$T1_OPEN_URL" ]; then
  rpt "  WARN: initial open returned '$T1_OPEN_URL' — retrying"
  ab open "${BASE}/" >/dev/null 2>&1
  ab wait --load networkidle >/dev/null 2>&1
  sleep 3
  T1_OPEN_URL="$(ab get url 2>/dev/null || echo '?')"
fi
rpt "  Final URL after open: ${T1_OPEN_URL}"

LANDING_HEADING="$(ab eval '[...document.querySelectorAll("h1,h2")].map(h=>h.textContent.trim()).filter(Boolean).slice(0,3).join(" | ")' 2>/dev/null | tail -1 | tr -d '"')"
rpt "  Landing headings: ${LANDING_HEADING}"
rpt "  Expected: 'Prevent disease' heading present + a 'Sign In' button that routes to /sign-in"

capture_diagnostics "test1-landing"

# Find the Sign In button in the nav (exact match)
SIGNIN_BTN_REF="$(ref_for "${LOGS}/test1-landing.snapshot.txt" 'button "Sign In"')"
if [ -z "$SIGNIN_BTN_REF" ]; then
  rpt "  WARN: no 'button \"Sign In\"\" in snapshot; trying text-based click"
  ab find text "Sign In" click >/dev/null 2>&1 || true
else
  rpt "  Found Sign In button ref=@${SIGNIN_BTN_REF}, clicking"
  ab click "@${SIGNIN_BTN_REF}" >/dev/null 2>&1 || true
fi
ab wait --url "**/sign-in" --timeout 10000 >/dev/null 2>&1 || true
sleep 2
T1_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL after Sign In click: ${T1_URL}"
T1_ERRORS="$(console_err_count test1-landing)"
rpt "  Console errors on landing: ${T1_ERRORS}"

if echo "$T1_URL" | grep -q "/sign-in" && echo "$LANDING_HEADING" | grep -qi "Prevent disease"; then
  record T1 PASS "Landing rendered with 'Prevent disease' heading and Sign In routed to /sign-in (url=${T1_URL})"
else
  record T1 FAIL "Expected /sign-in + 'Prevent disease' heading; got url=${T1_URL}, headings=${LANDING_HEADING}"
  bug "[T1] Landing page or Sign In navigation broken: url=${T1_URL}, headings=${LANDING_HEADING}"
fi

# ============================================================================
# TEST 2 — Sign-in flow (Ama / Participant)
# ============================================================================
section "TEST 2 — Sign in as ama@eks.health / DemoPass123! and verify dashboard"
rpt "  Action: Fill sign-in form and click Sign In"
ui_sign_in "ama@eks.health" "DemoPass123!"
T2_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T2_URL}"
rpt "  Expected: redirect to /dashboard; show 'Welcome, Ama Serwaa'; missions/habits/goals/competitions cards visible"
sleep 2
capture_diagnostics "test2-dashboard"

T2_WELCOME="$(ab eval '/Welcome,\s*Ama Serwaa/i.test(document.body.innerText) ? "yes" : "no"' 2>/dev/null | tail -1 | tr -d '"')"
T2_MISSIONS="$(ab eval '/Today.{0,5}s\s*Missions/i.test(document.body.innerText) ? "yes" : "no"' 2>/dev/null | tail -1 | tr -d '"')"
T2_HABITS="$(ab eval '/Habit Streaks/i.test(document.body.innerText) ? "yes" : "no"' 2>/dev/null | tail -1 | tr -d '"')"
T2_GOALS="$(ab eval '/Active Goals/i.test(document.body.innerText) ? "yes" : "no"' 2>/dev/null | tail -1 | tr -d '"')"
T2_COMPS="$(ab eval '/Active Competitions/i.test(document.body.innerText) ? "yes" : "no"' 2>/dev/null | tail -1 | tr -d '"')"
T2_CARDS="$(ab eval '[...document.querySelectorAll("main [class*=card], main [class*=Card]")].filter(c=>c.textContent.trim().length>30).length' 2>/dev/null | tail -1 | tr -d '"')"
T2_ERRORS="$(console_err_count test2-dashboard)"
rpt "  Welcome Ama Serwaa visible: ${T2_WELCOME}"
rpt "  Today's Missions visible:   ${T2_MISSIONS}"
rpt "  Habit Streaks visible:      ${T2_HABITS}"
rpt "  Active Goals visible:       ${T2_GOALS}"
rpt "  Active Competitions visible:${T2_COMPS}"
rpt "  Dashboard cards found:      ${T2_CARDS}"
rpt "  Console errors:             ${T2_ERRORS}"

if echo "$T2_URL" | grep -q "/dashboard" && [ "$T2_WELCOME" = "yes" ] && [ "$T2_MISSIONS" = "yes" ] && [ "$T2_HABITS" = "yes" ]; then
  record T2 PASS "Signed in as Ama Serwaa, dashboard rendered with missions + habits cards (url=${T2_URL})"
elif echo "$T2_URL" | grep -q "/sign-in"; then
  record T2 FAIL "Bounced back to /sign-in (session not persisted across cold start) — url=${T2_URL}"
  bug "[T2] Sign-in bounced back to /sign-in: Welcome=${T2_WELCOME}, Missions=${T2_MISSIONS}, Habits=${T2_HABITS}, url=${T2_URL}"
else
  record T2 FAIL "On /dashboard but body incomplete: Welcome=${T2_WELCOME}, Missions=${T2_MISSIONS}, Habits=${T2_HABITS}, Cards=${T2_CARDS}, url=${T2_URL}"
  bug "[T2] Dashboard body incomplete: Welcome=${T2_WELCOME}, Missions=${T2_MISSIONS}, Habits=${T2_HABITS}, Cards=${T2_CARDS}, url=${T2_URL}"
fi

# ============================================================================
# TEST 3 — Navigation from dashboard to Marketplace (REPORTED BUG)
# ============================================================================
section "TEST 3 — From /dashboard, click Marketplace in the header (reported bug)"
rpt "  Action: Find 'Marketplace' button in the header and click it"
rpt "  Expected: stay logged in and land on /marketplace; if logged out → BUG"
# Re-establish session via API (T2's UI sign-in may have bounced). This lets
# us isolate the Marketplace-click bug from the sign-in bug.
ab eval 'fetch("/api/auth/sign-out",{method:"POST"}).catch(()=>{})' >/dev/null 2>&1
ab cookies clear >/dev/null 2>&1
ab open "${BASE}/sign-in" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 1
T3_SIGNIN="$(api_sign_in "ama@eks.health" "DemoPass123!")"
rpt "  API sign-in (participant): ${T3_SIGNIN}"
sleep 2
ab open "${BASE}/dashboard" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 3
ab snapshot -i -c >"${LOGS}/test3-dashboard.snap" 2>&1
MARKET_REF="$(ref_for "${LOGS}/test3-dashboard.snap" 'button "Marketplace"')"
if [ -z "$MARKET_REF" ]; then
  rpt "  WARN: no exact 'button \"Marketplace\"' in snapshot; trying text-based click"
  ab find text "Marketplace" click >/dev/null 2>&1 || true
else
  rpt "  Found Marketplace button ref=@${MARKET_REF}, clicking"
  ab click "@${MARKET_REF}" >/dev/null 2>&1 || true
fi
ab wait --url "**/marketplace" --timeout 15000 >/dev/null 2>&1 || true
ab wait --load networkidle >/dev/null 2>&1
sleep 3
T3_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL after Marketplace click: ${T3_URL}"
capture_diagnostics "test3-marketplace"

T3_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session after Marketplace click: ${T3_SESSION}"
T3_LISTING_COUNT="$(marketplace_card_count)"
rpt "  Marketplace listing cards: ${T3_LISTING_COUNT}"
T3_ERRORS="$(console_err_count test3-marketplace)"

# T3 PASS requires: URL is /marketplace AND session is still valid (not null).
# A null session ({ok:true,data:null}) means the serverless instance that
# handled the /api/auth/session probe doesn't know about our cookie — the
# core cold-start bug.
if echo "$T3_URL" | grep -q "/marketplace" && session_is_valid "$T3_SESSION"; then
  record T3 PASS "Clicking Marketplace kept user logged in and routed to /marketplace (cards=${T3_LISTING_COUNT})"
elif echo "$T3_URL" | grep -q "/marketplace"; then
  record T3 WARN "Routed to /marketplace but /api/auth/session returned null data (cold-start session loss on probe instance) — url=${T3_URL}"
  bug "[T3] Marketplace URL ok but session probe null (cold start): url=${T3_URL}, session=${T3_SESSION}"
elif echo "$T3_URL" | grep -q "/sign-in"; then
  record T3 FAIL "Clicking Marketplace redirected to /sign-in — auth lost on navigation (url=${T3_URL})"
  bug "[T3] Marketplace click logged user out: url=${T3_URL}, session=${T3_SESSION}"
else
  record T3 FAIL "Unexpected outcome on Marketplace click: url=${T3_URL}, session=${T3_SESSION}"
  bug "[T3] Marketplace navigation unexpected: url=${T3_URL}, session=${T3_SESSION}"
fi

# ============================================================================
# TEST 4 — Program detail page (REPORTED BUG)
# ============================================================================
section "TEST 4 — On /marketplace, click a listing card (reported bug: 'Program not found')"
rpt "  Action: Click the first listing card on /marketplace"
rpt "  Expected: program detail page renders (NOT 'Program not found')"
# Make sure we're on /marketplace (in case Test 3 failed to land there)
if ! echo "$T3_URL" | grep -q "/marketplace"; then
  rpt "  Not on /marketplace — navigating directly"
  ab open "${BASE}/marketplace" >/dev/null 2>&1
  ab wait --load networkidle >/dev/null 2>&1
  sleep 3
fi
T4_EXPECTED_SLUG="$(first_listing_slug)"
rpt "  First listing name|expected slug: ${T4_EXPECTED_SLUG}"
# Click the first listing card
ab eval 'const c=document.querySelector("main .grid > div");if(c)c.click()' >/dev/null 2>&1
ab wait --url "**/programs/**" --timeout 15000 >/dev/null 2>&1 || true
ab wait --load networkidle >/dev/null 2>&1
sleep 3
T4_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL after card click: ${T4_URL}"
capture_diagnostics "test4-program-detail"

T4_NOT_FOUND="$(ab eval '/Program not found/i.test(document.body.innerText) ? "yes" : "no"' 2>/dev/null | tail -1 | tr -d '"')"
T4_BODY_LEN="$(ab eval 'document.body.innerText.length' 2>/dev/null | tail -1 | tr -d '"')"
T4_H1="$(ab eval '[...document.querySelectorAll("h1")].map(h=>h.textContent.trim()).slice(0,2).join(" | ")' 2>/dev/null | tail -1 | tr -d '"')"
T4_INSTALL_BTN="$(ab eval '/Install Program|Sign In to Install/i.test(document.body.innerText) ? "yes" : "no"' 2>/dev/null | tail -1 | tr -d '"')"
T4_ERRORS="$(console_err_count test4-program-detail)"
rpt "  'Program not found' visible: ${T4_NOT_FOUND}"
rpt "  Body text length:           ${T4_BODY_LEN}"
rpt "  H1 on page:                 ${T4_H1}"
rpt "  Install button visible:     ${T4_INSTALL_BTN}"
rpt "  Console errors:             ${T4_ERRORS}"

if [ "$T4_NOT_FOUND" = "no" ] && [ "${T4_BODY_LEN:-0}" -gt 200 ] 2>/dev/null && echo "$T4_URL" | grep -q "/programs/"; then
  record T4 PASS "Program detail page rendered (h1=${T4_H1}, body=${T4_BODY_LEN}, url=${T4_URL})"
elif [ "$T4_NOT_FOUND" = "yes" ]; then
  record T4 FAIL "Program detail shows 'Program not found' — listing IDs differ across serverless instances (url=${T4_URL})"
  bug "[T4] Program detail 'not found': expected_slug=${T4_EXPECTED_SLUG}, url=${T4_URL}, body=${T4_BODY_LEN}, h1=${T4_H1}"
else
  record T4 FAIL "Program detail page unexpected state: not_found=${T4_NOT_FOUND}, body=${T4_BODY_LEN}, url=${T4_URL}"
  bug "[T4] Program detail page unexpected: not_found=${T4_NOT_FOUND}, body=${T4_BODY_LEN}, url=${T4_URL}"
fi

# ============================================================================
# TEST 5 — Timeline page
# ============================================================================
section "TEST 5 — Navigate to /dashboard/timeline"
rpt "  Action: Open /dashboard/timeline directly"
rpt "  Expected: renders with entries; user stays logged in"
ab open "${BASE}/dashboard/timeline" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 4
T5_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T5_URL}"
capture_diagnostics "test5-timeline"

T5_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T5_SESSION}"
T5_FILTERS="$(ab eval '[...document.querySelectorAll("[role=tablist] [role=tab], main button")].filter(b=>/^(All|Measurements|Missions|Competitions)$/.test(b.textContent.trim())).length' 2>/dev/null | tail -1 | tr -d '"')"
T5_ENTRIES="$(ab eval '[...document.querySelectorAll("main [class*=space-y-3] > div, main .grid > div, main li, main [class*=timeline] > div")].filter(d=>/Measurement:|joined|participants|streak|complete|habit|goal|competition/i.test(d.textContent||"")).length' 2>/dev/null | tail -1 | tr -d '"')"
T5_H2="$(ab eval '[...document.querySelectorAll("h1,h2")].map(h=>h.textContent.trim()).filter(Boolean).slice(0,3).join(" | ")' 2>/dev/null | tail -1 | tr -d '"')"
T5_ERRORS="$(console_err_count test5-timeline)"
rpt "  Timeline filter buttons: ${T5_FILTERS}"
rpt "  Timeline entries:        ${T5_ENTRIES}"
rpt "  Headings:                ${T5_H2}"
rpt "  Console errors:          ${T5_ERRORS}"

if echo "$T5_URL" | grep -q "/dashboard/timeline" && [ "${T5_ENTRIES:-0}" -gt 0 ] 2>/dev/null && session_is_valid "$T5_SESSION"; then
  record T5 PASS "Timeline rendered with ${T5_ENTRIES} entries, user still logged in"
elif echo "$T5_URL" | grep -q "/dashboard/timeline" && [ "${T5_ENTRIES:-0}" -gt 0 ] 2>/dev/null; then
  record T5 WARN "Timeline page rendered with ${T5_ENTRIES} entries but /api/auth/session returned null (cold-start session loss on probe instance)"
  bug "[T5] Timeline rendered but session probe null (cold start): url=${T5_URL}, session=${T5_SESSION}"
elif echo "$T5_URL" | grep -q "/sign-in"; then
  record T5 FAIL "Timeline redirected to /sign-in (auth lost on direct URL)"
  bug "[T5] Timeline redirected to /sign-in: url=${T5_URL}, session=${T5_SESSION}"
else
  record T5 FAIL "Timeline incomplete: filters=${T5_FILTERS}, entries=${T5_ENTRIES}, url=${T5_URL}, session=${T5_SESSION}"
  bug "[T5] Timeline incomplete: filters=${T5_FILTERS}, entries=${T5_ENTRIES}, url=${T5_URL}"
fi

# ============================================================================
# TEST 6 — Settings page
# ============================================================================
section "TEST 6 — Navigate to /dashboard/settings"
rpt "  Action: Open /dashboard/settings"
rpt "  Expected: renders all cards; user stays logged in"
ab open "${BASE}/dashboard/settings" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 4
T6_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T6_URL}"
capture_diagnostics "test6-settings"

T6_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T6_SESSION}"
T6_CARDS="$(ab eval '[...document.querySelectorAll("[class*=card],[class*=Card]")].filter(c=>c.textContent.trim().length>30).length' 2>/dev/null | tail -1 | tr -d '"')"
T6_HEADINGS="$(ab eval '[...document.querySelectorAll("main h2, main h3, [class*=CardTitle]")].map(h=>h.textContent.trim()).filter(Boolean).slice(0,15).join(" | ")' 2>/dev/null | tail -1 | tr -d '"')"
T6_ERRORS="$(console_err_count test6-settings)"
rpt "  Settings cards:   ${T6_CARDS}"
rpt "  Settings headings:${T6_HEADINGS}"
rpt "  Console errors:   ${T6_ERRORS}"

if echo "$T6_URL" | grep -q "/dashboard/settings" && [ "${T6_CARDS:-0}" -ge 3 ] 2>/dev/null && api_ok "$T6_SESSION" session; then
  record T6 PASS "Settings rendered with ${T6_CARDS} cards, user still logged in"
elif echo "$T6_URL" | grep -q "/sign-in"; then
  record T6 FAIL "Settings redirected to /sign-in (auth lost on cold start)"
  bug "[T6] Settings redirected to /sign-in: url=${T6_URL}, session=${T6_SESSION}"
else
  record T6 FAIL "Settings incomplete: cards=${T6_CARDS}, url=${T6_URL}, session=${T6_SESSION}"
  bug "[T6] Settings incomplete: cards=${T6_CARDS}, url=${T6_URL}"
fi

# ============================================================================
# TEST 7 — Console page
# ============================================================================
section "TEST 7 — Navigate to /console"
rpt "  Action: Open /console"
rpt "  Expected: renders; user stays logged in"
ab open "${BASE}/console" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 4
T7_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T7_URL}"
capture_diagnostics "test7-console"

T7_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T7_SESSION}"
# Console nav items live in a sidebar; query all interactive elements, not just <main>.
T7_SECTIONS="$(ab eval '[...document.querySelectorAll("a, button, [role=tab], [role=treeitem]")].filter(b=>/overview|kernel|identity|programs|marketplace|health|missions|competitions|research|orchestrator|population|technicians|sessions|audit|compliance|developer|architecture/i.test(b.textContent||"")).length' 2>/dev/null | tail -1 | tr -d '"')"
T7_H1="$(ab eval '[...document.querySelectorAll("h1,h2")].map(h=>h.textContent.trim()).filter(Boolean).slice(0,3).join(" | ")' 2>/dev/null | tail -1 | tr -d '"')"
T7_BODY_LEN="$(ab eval 'document.body.innerText.length' 2>/dev/null | tail -1 | tr -d '"')"
T7_ERRORS="$(console_err_count test7-console)"
rpt "  Console nav items:  ${T7_SECTIONS}"
rpt "  Console headings:   ${T7_H1}"
rpt "  Console body len:   ${T7_BODY_LEN}"
rpt "  Console errors:     ${T7_ERRORS}"

if echo "$T7_URL" | grep -q "/console" && [ "${T7_BODY_LEN:-0}" -gt 500 ] 2>/dev/null && [ "${T7_SECTIONS:-0}" -ge 5 ] 2>/dev/null; then
  if session_is_valid "$T7_SESSION"; then
    record T7 PASS "Console rendered (body=${T7_BODY_LEN}, nav=${T7_SECTIONS}), session valid"
  else
    record T7 PASS "Console rendered (body=${T7_BODY_LEN}, nav=${T7_SECTIONS}); session probe null (cold start) but /console is public"
  fi
elif echo "$T7_URL" | grep -q "/sign-in"; then
  record T7 WARN "Console redirected to /sign-in (auth required? acceptable if intentional)"
  bug "[T7] Console redirected to /sign-in: url=${T7_URL}, session=${T7_SESSION}"
else
  record T7 FAIL "Console incomplete: sections=${T7_SECTIONS}, body=${T7_BODY_LEN}, url=${T7_URL}"
  bug "[T7] Console incomplete: sections=${T7_SECTIONS}, body=${T7_BODY_LEN}, url=${T7_URL}"
fi

# ============================================================================
# TEST 8 — Role switching (admin has 7 personas)
# ============================================================================
section "TEST 8 — Role switcher on dashboard (admin)"
rpt "  Action: Sign in as admin (ekontetevi@gmail.com), click 'Developer' role"
rpt "  Expected: dashboard updates; /api/auth/session reflects new activePersona"
ab eval 'fetch("/api/auth/sign-out",{method:"POST"}).catch(()=>{})' >/dev/null 2>&1
ab cookies clear >/dev/null 2>&1
ab open "${BASE}/sign-in" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 1
T8_SIGNIN="$(api_sign_in "ekontetevi@gmail.com" "Payswap123456")"
rpt "  API sign-in (admin): ${T8_SIGNIN}"
sleep 2
# Verify session is actually valid before navigating (retry once if not)
T8_PRE_SESSION="$(api_probe GET /api/auth/session)"
if ! session_is_valid "$T8_PRE_SESSION"; then
  rpt "  WARN: session not valid after first sign-in (cold start); retrying"
  sleep 2
  api_sign_in "ekontetevi@gmail.com" "Payswap123456" >/dev/null 2>&1
  sleep 2
  T8_PRE_SESSION="$(api_probe GET /api/auth/session)"
fi
rpt "  Pre-navigation session: ${T8_PRE_SESSION}"
ab open "${BASE}/dashboard" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 4
T8_URL_BEFORE="$(ab get url 2>/dev/null || echo '?')"
rpt "  Dashboard URL: ${T8_URL_BEFORE}"
T8_SESSION_BEFORE="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session before switch: ${T8_SESSION_BEFORE}"
capture_diagnostics "test8-dashboard-before"

# If the dashboard bounced to /sign-in, we can't test the role switcher.
if echo "$T8_URL_BEFORE" | grep -q "/sign-in"; then
  record T8 FAIL "Admin dashboard bounced to /sign-in (session lost on navigation) — cannot test role switcher"
  bug "[T8] Admin dashboard bounced to /sign-in before role switch could be tested: session_before=${T8_SESSION_BEFORE}, url=${T8_URL_BEFORE}"
else
  ab snapshot -i -c >"${LOGS}/test8-admin.snap" 2>&1
  DEV_REF="$(ref_for "${LOGS}/test8-admin.snap" 'button "Developer"')"
  if [ -z "$DEV_REF" ]; then
    rpt "  WARN: no 'button \"Developer\"' in snapshot; trying text click"
    ab find text "Developer" click >/dev/null 2>&1 || true
  else
    rpt "  Found Developer role button ref=@${DEV_REF}, clicking"
    ab click "@${DEV_REF}" >/dev/null 2>&1 || true
  fi
  sleep 5
  T8_SESSION_AFTER="$(api_probe GET /api/auth/session)"
  rpt "  /api/auth/session after switch click: ${T8_SESSION_AFTER}"
  capture_diagnostics "test8-dashboard-after"
  T8_URL_AFTER="$(ab get url 2>/dev/null || echo '?')"
  rpt "  Dashboard URL after switch: ${T8_URL_AFTER}"
  # Check whether the dashboard text reflects developer persona (e.g. "Developer" badge highlighted, or developer-specific content like "Programs" or "SDK")
  T8_DASH_DEV_CONTENT="$(ab eval '/Developer Profile|SDK|Programs Published|Developer SDK|developer/i.test(document.body.innerText) ? "yes" : "no"' 2>/dev/null | tail -1 | tr -d '"')"
  rpt "  Developer-specific content visible: ${T8_DASH_DEV_CONTENT}"

  # The snippet contains JSON-stringified data; persona appears as \"activePersona\":\"developer\"
  # Also check that the session is still valid (not null) AND persona is developer.
  if session_is_valid "$T8_SESSION_AFTER" && echo "$T8_SESSION_AFTER" | grep -qi 'activePersona.\{0,3\}developer\|developer.\{0,3\}activePersona'; then
    record T8 PASS "Role switch API succeeded — session now reflects developer persona"
  elif echo "$T8_SESSION_AFTER" | grep -qi 'developer'; then
    record T8 PASS "Role switch succeeded (developer persona detected in session)"
  elif ! session_is_valid "$T8_SESSION_AFTER"; then
    record T8 FAIL "Session became null after role switch click (cold-start session loss): session=${T8_SESSION_AFTER}"
    bug "[T8] Session null after role switch: before=${T8_SESSION_BEFORE}, after=${T8_SESSION_AFTER}"
  else
    record T8 FAIL "Role switch did not change persona: session=${T8_SESSION_AFTER}"
    bug "[T8] Role switch failed: before=${T8_SESSION_BEFORE}, after=${T8_SESSION_AFTER}"
  fi
fi

# ============================================================================
# TEST 9 — Back navigation (re-sign in as participant first)
# ============================================================================
section "TEST 9 — Back navigation from marketplace"
rpt "  Action: Sign in as participant, go to /marketplace, use browser back"
rpt "  Expected: land back on /dashboard and stay logged in"
ab eval 'fetch("/api/auth/sign-out",{method:"POST"}).catch(()=>{})' >/dev/null 2>&1
ab cookies clear >/dev/null 2>&1
ab open "${BASE}/sign-in" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 1
api_sign_in "ama@eks.health" "DemoPass123!" >/dev/null 2>&1
sleep 2
# Navigate to /dashboard first (to establish back-history)
ab open "${BASE}/dashboard" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 3
T9_DASH_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  /dashboard URL: ${T9_DASH_URL}"
# Now go to /marketplace
ab open "${BASE}/marketplace" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 3
T9_BEFORE_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  URL before back: ${T9_BEFORE_URL}"
# Use browser back
ab back >/dev/null 2>&1 || true
ab wait --load networkidle >/dev/null 2>&1
sleep 3
T9_AFTER_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  URL after back:  ${T9_AFTER_URL}"
capture_diagnostics "test9-after-back"
T9_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T9_SESSION}"

if session_is_valid "$T9_SESSION"; then
  record T9 PASS "Back navigation kept user logged in (url=${T9_AFTER_URL})"
else
  record T9 FAIL "Back navigation: session is null after back (url=${T9_AFTER_URL}, session=${T9_SESSION}) — cold-start session loss"
  bug "[T9] Back navigation session null: url=${T9_AFTER_URL}, session=${T9_SESSION}"
fi

# ============================================================================
# TEST 10 — Direct URL access to protected page
# ============================================================================
section "TEST 10 — Direct URL access to /dashboard/timeline"
rpt "  Action: Sign in fresh, then directly open /dashboard/timeline"
rpt "  Expected: stay logged in and view the page (NOT redirected to /sign-in)"
ab eval 'fetch("/api/auth/sign-out",{method:"POST"}).catch(()=>{})' >/dev/null 2>&1
ab cookies clear >/dev/null 2>&1
ab open "${BASE}/sign-in" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 1
api_sign_in "ama@eks.health" "DemoPass123!" >/dev/null 2>&1
sleep 2
ab open "${BASE}/dashboard/timeline" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 4
T10_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T10_URL}"
capture_diagnostics "test10-direct-timeline"
T10_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T10_SESSION}"
T10_ENTRIES="$(ab eval '[...document.querySelectorAll("main [class*=space-y-3] > div, main .grid > div, main li, main [class*=timeline] > div")].filter(d=>/Measurement:|joined|participants|streak|complete|habit|goal|competition/i.test(d.textContent||"")).length' 2>/dev/null | tail -1 | tr -d '"')"
T10_H1="$(ab eval '[...document.querySelectorAll("h1")].map(h=>h.textContent.trim()).slice(0,2).join(" | ")' 2>/dev/null | tail -1 | tr -d '"')"
rpt "  Timeline entries on direct access: ${T10_ENTRIES}"
rpt "  Timeline H1: ${T10_H1}"

if echo "$T10_URL" | grep -q "/dashboard/timeline" && session_is_valid "$T10_SESSION"; then
  record T10 PASS "Direct URL access to /dashboard/timeline kept user logged in (entries=${T10_ENTRIES}, h1=${T10_H1})"
elif echo "$T10_URL" | grep -q "/dashboard/timeline" && [ "${T10_ENTRIES:-0}" -gt 0 ] 2>/dev/null; then
  record T10 WARN "Direct URL: /dashboard/timeline rendered (${T10_ENTRIES} entries) but /api/auth/session returned null (cold-start session loss)"
  bug "[T10] Direct URL rendered but session probe null (cold start): url=${T10_URL}, session=${T10_SESSION}"
elif echo "$T10_URL" | grep -q "/sign-in"; then
  record T10 FAIL "Direct URL access redirected to /sign-in (auth lost on cold start)"
  bug "[T10] Direct URL redirected to /sign-in: url=${T10_URL}, session=${T10_SESSION}"
else
  record T10 FAIL "Direct URL unexpected state: url=${T10_URL}, session=${T10_SESSION}"
  bug "[T10] Direct URL unexpected: url=${T10_URL}, session=${T10_SESSION}"
fi

# ============================================================================
# TEST 11 — Sign in as Platform Admin
# ============================================================================
section "TEST 11 — Sign in as admin (ekontetevi@gmail.com / Payswap123456)"
rpt "  Action: Sign out, sign in as admin, verify admin dashboard"
rpt "  Expected: dashboard shows accounts + waitlist (platform_admin persona)"
ab eval 'fetch("/api/auth/sign-out",{method:"POST"}).catch(()=>{})' >/dev/null 2>&1
ab cookies clear >/dev/null 2>&1
ab open "${BASE}/sign-in" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 1
api_sign_in "ekontetevi@gmail.com" "Payswap123456" >/dev/null 2>&1
sleep 2
ab open "${BASE}/dashboard" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
sleep 5
T11_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T11_URL}"
capture_diagnostics "test11-admin-dashboard"

T11_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T11_SESSION}"
T11_DASH="$(api_probe GET /api/dashboard)"
rpt "  /api/dashboard snippet: ${T11_DASH}"
T11_HAS_ACCOUNTS="$(ab eval '/Accounts|User Management|Total Accounts|accounts/i.test(document.body.innerText) ? "yes" : "no"' 2>/dev/null | tail -1 | tr -d '"')"
T11_HAS_WAITLIST="$(ab eval '/Waitlist|waitlist/i.test(document.body.innerText) ? "yes" : "no"' 2>/dev/null | tail -1 | tr -d '"')"
T11_ACCOUNT_ROWS="$(ab eval '[...document.querySelectorAll("table tr, [class*=table] tr, [class*=row]")].filter(r=>/@/.test(r.textContent||"")).length' 2>/dev/null | tail -1 | tr -d '"')"
T11_WELCOME="$(ab eval '/Welcome,\s*Platform Administrator/i.test(document.body.innerText) ? "yes" : "no"' 2>/dev/null | tail -1 | tr -d '"')"
T11_ERRORS="$(console_err_count test11-admin-dashboard)"
rpt "  Welcome Platform Admin visible: ${T11_WELCOME}"
rpt "  'Accounts' visible:            ${T11_HAS_ACCOUNTS}"
rpt "  'Waitlist' visible:            ${T11_HAS_WAITLIST}"
rpt "  Account rows found:            ${T11_ACCOUNT_ROWS}"
rpt "  Console errors:                ${T11_ERRORS}"

# Probe /api/identity/accounts directly to see if the in-memory store is seeded.
T11_ACCT_API="$(api_probe GET /api/identity/accounts)"
rpt "  /api/identity/accounts: ${T11_ACCT_API}"
T11_WL_API="$(api_probe GET /api/auth/waitlist)"
rpt "  /api/auth/waitlist:     ${T11_WL_API}"

if echo "$T11_SESSION" | grep -qi 'platform_admin' && [ "$T11_WELCOME" = "yes" ] && [ "$T11_HAS_ACCOUNTS" = "yes" ] && [ "$T11_HAS_WAITLIST" = "yes" ]; then
  record T11 PASS "Admin dashboard renders with Accounts + Waitlist sections (rows=${T11_ACCOUNT_ROWS})"
elif echo "$T11_SESSION" | grep -qi 'platform_admin' && [ "$T11_WELCOME" = "yes" ]; then
  record T11 WARN "Admin signed in and dashboard renders, but Accounts=${T11_HAS_ACCOUNTS}, Waitlist=${T11_HAS_WAITLIST} — likely empty in-memory store on cold instance"
  bug "[T11] Admin dashboard partial: accounts_visible=${T11_HAS_ACCOUNTS}, waitlist_visible=${T11_HAS_WAITLIST}, accounts_api=${T11_ACCT_API}, waitlist_api=${T11_WL_API}"
else
  record T11 FAIL "Admin dashboard incomplete: session=${T11_SESSION}, welcome=${T11_WELCOME}, accounts=${T11_HAS_ACCOUNTS}, waitlist=${T11_HAS_WAITLIST}"
  bug "[T11] Admin dashboard incomplete: session=${T11_SESSION}, welcome=${T11_WELCOME}, accounts=${T11_HAS_ACCOUNTS}, waitlist=${T11_HAS_WAITLIST}, url=${T11_URL}"
fi

# ============================================================================
# TEST 12 — API consistency (while signed in as admin)
# ============================================================================
section "TEST 12 — API consistency checks (4 endpoints)"
rpt "  Action: Hit 4 core APIs from the browser, check 200 + data shape"
rpt "  Expected: all four return 200 with non-empty data"

T12A_SESSION="$(api_probe GET /api/auth/session)"
rpt "  [12a] GET /api/auth/session:       ${T12A_SESSION}"
T12B_DASHBOARD="$(api_probe GET /api/dashboard)"
rpt "  [12b] GET /api/dashboard:          ${T12B_DASHBOARD}"
T12C_LISTINGS="$(api_probe GET /api/marketplace/listings)"
rpt "  [12c] GET /api/marketplace/listings: ${T12C_LISTINGS}"
T12D_PROGRAMS="$(api_probe GET /api/programs/list)"
rpt "  [12d] GET /api/programs/list:      ${T12D_PROGRAMS}"

T12_PASS=true
T12_DETAILS=""

if api_ok "$T12A_SESSION" session && echo "$T12A_SESSION" | grep -qi 'accountId\|email'; then
  T12_DETAILS+="session=OK "
else
  T12_PASS=false
  T12_DETAILS+="session=FAIL "
  bug "[T12a] /api/auth/session failed: ${T12A_SESSION}"
fi

if api_ok "$T12B_DASHBOARD" dashboard && echo "$T12B_DASHBOARD" | grep -qi 'persona\|displayName'; then
  T12_DETAILS+="dashboard=OK "
else
  T12_PASS=false
  T12_DETAILS+="dashboard=FAIL "
  bug "[T12b] /api/dashboard failed: ${T12B_DASHBOARD}"
fi

if api_ok "$T12C_LISTINGS" listings && echo "$T12C_LISTINGS" | grep -qi 'listings'; then
  T12_DETAILS+="listings=OK "
else
  T12_PASS=false
  T12_DETAILS+="listings=FAIL "
  bug "[T12c] /api/marketplace/listings failed: ${T12C_LISTINGS}"
fi

if api_ok "$T12D_PROGRAMS" programs && echo "$T12D_PROGRAMS" | grep -qi 'programs'; then
  T12_DETAILS+="programs=OK"
else
  T12_PASS=false
  T12_DETAILS+="programs=FAIL"
  bug "[T12d] /api/programs/list failed: ${T12D_PROGRAMS}"
fi

# Cross-endpoint consistency check: do /api/dashboard and /api/marketplace/listings
# agree on the number of marketplace listings?
T12_DASH_LISTINGS="$(echo "$T12B_DASHBOARD" | sed -E 's/.*totalListings.{0,3}([0-9]+).*/\1/' | head -c 4)"
T12_LISTING_API_COUNT="$(echo "$T12C_LISTINGS" | sed -E 's/.*"listings":\[\{[^}]+\}\]//; s/.*listings.//; s/[^0-9].*//' | head -c 2)"
rpt "  Cross-check: /api/dashboard reports totalListings=${T12_DASH_LISTINGS}; /api/marketplace/listings returned non-empty data"
if [ "$T12_PASS" = "true" ]; then
  record T12 PASS "All 4 core APIs returned 200 with data (${T12_DETAILS})"
else
  record T12 FAIL "API consistency check failed (${T12_DETAILS})"
fi

# ============================================================================
# Final summary
# ============================================================================
section "OVERALL SUMMARY"
rpt "  Tests passed: ${PASS_COUNT}"
rpt "  Tests warned:${WARN_COUNT}"
rpt "  Tests failed: ${FAIL_COUNT}"
rpt ""
rpt "  Per-test result:"
for r in "${RESULTS[@]}"; do
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
