#!/usr/bin/env bash
# reaudit-continue.sh — Continuation of reaudit.sh after timeout
# Completes Tests 13 (program install) + 14 (all 6 roles), and re-probes
# the failed Tests 2/3/8/11 with deeper /api/dashboard diagnostics.
#
# Site:    https://eks-health.vercel.app
# Task ID: reaudit-1 (continuation)

set -uo pipefail

BASE="https://eks-health.vercel.app"
SESSION="eks-reaudit-1"
ROOT="/home/z/my-project/.zscripts"
LOGS="${ROOT}/logs/reaudit-1"
SHOTS="${ROOT}/screenshots/reaudit-1"
REPORT="${LOGS}/REPORT.txt"
BUGS="${LOGS}/BUGS.txt"
mkdir -p "$LOGS" "$SHOTS"

ab() { agent-browser --session "$SESSION" "$@"; }
rpt() { printf '%s\n' "$*" | tee -a "$REPORT" >&2; }
section() {
  local bar="================================================================"
  { printf '\n%s\n%s\n%s\n' "$bar" "$*" "$bar"; } | tee -a "$REPORT" >&2
}
bug() { printf '%s\n' "$*" | tee -a "$BUGS" >&2; }

# Shorter networkidle wait (10s) — the page usually settles faster than that.
wait_idle() {
  ab wait --load networkidle --timeout 10000 >/dev/null 2>&1 || true
  sleep 2
}

capture_diagnostics() {
  local tag="$1"
  ab console >"${LOGS}/${tag}.console.txt" 2>&1 || true
  ab errors  >"${LOGS}/${tag}.errors.txt" 2>&1 || true
  ab snapshot -i -c >"${LOGS}/${tag}.snapshot.txt" 2>&1 || true
  ab screenshot "${SHOTS}/${tag}.png" >/dev/null 2>&1 || true
}

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

api_sign_in() {
  local email="$1" pass="$2"
  ab eval "fetch('/api/auth/sign-in',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'${email}',password:'${pass}'})}).then(async r=>{const d=await r.json();return [r.status,d.ok?1:0,d.data?.email||'',d.data?.activePersona||'',d.error?.message||''].join('|')})" 2>/dev/null | tail -1 | tr -d '"'
}

full_sign_out() {
  ab eval 'fetch("/api/auth/sign-out",{method:"POST"}).catch(()=>{})' >/dev/null 2>&1
  ab cookies clear >/dev/null 2>&1 || true
  sleep 1
}

reauth() {
  local email="$1" pass="$2"
  full_sign_out
  ab open "${BASE}/sign-in" >/dev/null 2>&1
  wait_idle
  api_sign_in "$email" "$pass" >/dev/null 2>&1
  sleep 2
}

ref_for() {
  grep -E "$2" "$1" 2>/dev/null | head -1 | sed -E 's/.*\[ref=([a-z0-9]+)\].*/\1/'
}

yn() {
  ab eval "$1" 2>/dev/null | tail -1 | tr -d '"'
}

session_is_valid() {
  local probe="$1"
  local status ok
  status="$(echo "$probe" | cut -d'|' -f1)"
  ok="$(echo "$probe" | cut -d'|' -f2)"
  [ "$status" = "200" ] && [ "$ok" = "1" ] || return 1
  echo "$probe" | grep -qiE 'accountId|email|displayName' || return 1
  if echo "$probe" | grep -qiE 'data\\*":null' && ! echo "$probe" | grep -qi 'accountId'; then
    return 1
  fi
  return 0
}

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

rpt ""
rpt "================================================================"
rpt "REAUDIT CONTINUATION — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
rpt "================================================================"
rpt ""

# Make sure browser session exists (may have been killed by timeout)
ab close --all >/dev/null 2>&1 || true

# ============================================================================
# RE-PROBE TEST 2 — Sign in as participant + check /api/dashboard directly
# (Confirms whether the dashboard body is empty due to /api/dashboard 401)
# ============================================================================
section "RE-PROBE TEST 2 — Participant dashboard + /api/dashboard probe"
rpt "  Action: Sign in fresh, open /dashboard, then probe /api/dashboard directly"
reauth "ama@eks.health" "DemoPass123!" >/dev/null
T2R_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T2R_SESSION}"
T2R_DASHBOARD_API="$(api_probe GET /api/dashboard)"
rpt "  /api/dashboard:    ${T2R_DASHBOARD_API}"
ab open "${BASE}/dashboard" >/dev/null 2>&1
wait_idle
sleep 3
capture_diagnostics "retest2-dashboard"
T2R_WELCOME="$(yn '/Welcome,\s*Ama Serwaa/i.test(document.body.innerText) ? "yes" : "no"')"
T2R_MISSIONS="$(yn '/Today.{0,5}s\s*Missions/i.test(document.body.innerText) ? "yes" : "no"')"
T2R_HABITS="$(yn '/Habit Streaks/i.test(document.body.innerText) ? "yes" : "no"')"
T2R_COMPLETE_COUNT="$(ab eval '[...document.querySelectorAll("button")].filter(b=>/^Complete$/i.test(b.textContent.trim())).length' 2>/dev/null | tail -1 | tr -d '"')"
T2R_DASH_OK="$(echo "$T2R_DASHBOARD_API" | cut -d'|' -f2)"
rpt "  Welcome: ${T2R_WELCOME} | Missions: ${T2R_MISSIONS} | Habits: ${T2R_HABITS} | Complete buttons: ${T2R_COMPLETE_COUNT}"
rpt "  /api/dashboard ok flag: ${T2R_DASH_OK} (1=fixed, 0=still 401)"
if [ "$T2R_DASH_OK" = "1" ] && [ "$T2R_MISSIONS" = "yes" ]; then
  record T2-RETEST PASS "Participant dashboard renders missions/habits after fresh sign-in (api/dashboard ok)"
elif [ "$T2R_DASH_OK" = "0" ]; then
  record T2-RETEST FAIL "/api/dashboard returns 401 even after fresh sign-in — root cause NOT fixed"
  bug "[T2-retest] /api/dashboard 401 after fresh sign-in: session=${T2R_SESSION}, dashboard=${T2R_DASHBOARD_API}"
else
  record T2-RETEST WARN "/api/dashboard ok=${T2R_DASH_OK} but missions visible=${T2R_MISSIONS} — partial"
  bug "[T2-retest] Dashboard partial: api_ok=${T2R_DASH_OK}, missions=${T2R_MISSIONS}, habits=${T2R_HABITS}, session=${T2R_SESSION}"
fi

# ============================================================================
# RE-PROBE TEST 3 — Dashboard → Marketplace, check if header shows Dashboard
# (re-test whether session persists across the navigation)
# ============================================================================
section "RE-PROBE TEST 3 — Dashboard → Marketplace, header state"
rpt "  Action: On /dashboard (still signed in), click Marketplace; check header state"
ab open "${BASE}/dashboard" >/dev/null 2>&1
wait_idle
ab snapshot -i -c >"${LOGS}/retest3-dashboard.snap" 2>&1
MARKET_REF="$(ref_for "${LOGS}/retest3-dashboard.snap" 'button "Marketplace"|link "Marketplace"')"
if [ -n "$MARKET_REF" ]; then
  ab click "@${MARKET_REF}" >/dev/null 2>&1 || true
fi
ab wait --url "**/marketplace" --timeout 15000 >/dev/null 2>&1 || true
wait_idle
T3R_URL="$(ab get url 2>/dev/null || echo '?')"
rpt "  Final URL: ${T3R_URL}"
capture_diagnostics "retest3-marketplace"
T3R_SESSION="$(api_probe GET /api/auth/session)"
rpt "  /api/auth/session: ${T3R_SESSION}"
T3R_HEADER_SIGNIN="$(yn '/^[\\s\\S]*\\bSign In\\b[\\s\\S]*$/.test(document.querySelector("header")?.innerText||"") ? "yes" : "no"')"
T3R_HEADER_DASHBOARD="$(yn '/^[\\s\\S]*\\bDashboard\\b[\\s\\S]*$/.test(document.querySelector("header")?.innerText||"") ? "yes" : "no"')"
T3R_LISTING_COUNT="$(ab eval '[...document.querySelectorAll("main .grid > div, main [class*=cursor-pointer]")].filter(c=>/installs|Cardio|Sleep|Hydration|Mobility|Strength|FitStreak|Mindful|Nutrition/i.test(c.textContent||"")).length' 2>/dev/null | tail -1 | tr -d '"')"
rpt "  Header has 'Sign In':  ${T3R_HEADER_SIGNIN}"
rpt "  Header has 'Dashboard': ${T3R_HEADER_DASHBOARD}"
rpt "  Listing cards: ${T3R_LISTING_COUNT}"
if [ "$T3R_HEADER_DASHBOARD" = "yes" ] && [ "${T3R_LISTING_COUNT:-0}" -ge 5 ] 2>/dev/null; then
  record T3-RETEST PASS "Marketplace header shows 'Dashboard' (logged-in state preserved)"
elif [ "$T3R_HEADER_SIGNIN" = "yes" ]; then
  record T3-RETEST FAIL "Marketplace header shows 'Sign In' (session lost on navigation): session=${T3R_SESSION}"
  bug "[T3-retest] Marketplace header shows Sign In (session lost): url=${T3R_URL}, session=${T3R_SESSION}, header_signin=${T3R_HEADER_SIGNIN}, header_dashboard=${T3R_HEADER_DASHBOARD}"
else
  record T3-RETEST WARN "Marketplace URL ok but header ambiguous: signin=${T3R_HEADER_SIGNIN}, dashboard=${T3R_HEADER_DASHBOARD}, session=${T3R_SESSION}"
  bug "[T3-retest] Marketplace header ambiguous: signin=${T3R_HEADER_SIGNIN}, dashboard=${T3R_HEADER_DASHBOARD}, session=${T3R_SESSION}"
fi

# ============================================================================
# RE-PROBE TEST 8 — Role switcher (admin) with proper snapshot inspection
# ============================================================================
section "RE-PROBE TEST 8 — Admin role switcher (find actual role buttons)"
rpt "  Action: Sign in as admin, snapshot /dashboard, list all role-switcher buttons"
reauth "ekontetevi@gmail.com" "Payswap123456" >/dev/null
T8R_PRE_SESSION="$(api_probe GET /api/auth/session)"
rpt "  Pre-switch session: ${T8R_PRE_SESSION:0:140}"
ab open "${BASE}/dashboard" >/dev/null 2>&1
wait_idle
sleep 3
capture_diagnostics "retest8-admin-before"
# List ALL buttons in the role-switcher area (between Welcome and main content).
T8R_ROLE_BTNS="$(ab eval '[...document.querySelectorAll("button")].filter(b=>/^(Participant|Health Technician|Developer|Researcher|Organization Admin|Platform Admin|Marketplace Reviewer|Support Agent)$/i.test(b.textContent.trim())).map(b=>b.textContent.trim()).join(", ")' 2>/dev/null | tail -1 | tr -d '"')"
rpt "  Role-switcher buttons found: ${T8R_ROLE_BTNS}"
T8R_PERSONAS_IN_SESSION="$(echo "$T8R_PRE_SESSION" | sed -E 's/.*personas.:\[([^]]+)\].*/\1/i' | head -c 200)"
rpt "  Personas in session: ${T8R_PERSONAS_IN_SESSION}"

if [ -n "$T8R_ROLE_BTNS" ]; then
  # Click the second role button (the first is usually the active one).
  ab eval '(function(){const btns=[...document.querySelectorAll("button")].filter(b=>/^(Participant|Health Technician|Developer|Researcher|Organization Admin|Platform Admin|Marketplace Reviewer|Support Agent)$/i.test(b.textContent.trim()));const inactive=btns.find(b=>!b.className.includes("bg-["));if(inactive){inactive.click();return inactive.textContent.trim()}return "none"})()' 2>/dev/null | tail -1 | tr -d '"' > "${LOGS}/.role-click-result"
  T8R_CLICKED_ROLE="$(cat "${LOGS}/.role-click-result" 2>/dev/null)"
  rpt "  Clicked role button: ${T8R_CLICKED_ROLE}"
  sleep 5
  T8R_POST_SESSION="$(api_probe GET /api/auth/session)"
  rpt "  Post-switch session: ${T8R_POST_SESSION:0:200}"
  # Extract activePersona before and after.
  T8R_PRE_PERSONA="$(echo "$T8R_PRE_SESSION" | sed -E 's/.*activePersona.:\s*.([a-z_]+).,.*/\1/i' | head -c 30)"
  T8R_POST_PERSONA="$(echo "$T8R_POST_SESSION" | sed -E 's/.*activePersona.:\s*.([a-z_]+).,.*/\1/i' | head -c 30)"
  rpt "  activePersona before: ${T8R_PRE_PERSONA}"
  rpt "  activePersona after:  ${T8R_POST_PERSONA}"
  if [ -n "$T8R_POST_PERSONA" ] && [ "$T8R_POST_PERSONA" != "$T8R_PRE_PERSONA" ] && [ "$T8R_POST_PERSONA" != "null" ]; then
    record T8-RETEST PASS "Role switch changed persona: ${T8R_PRE_PERSONA} → ${T8R_POST_PERSONA}"
  elif ! session_is_valid "$T8R_POST_SESSION"; then
    record T8-RETEST FAIL "Session became null after role switch click (cold-start loss): ${T8R_POST_SESSION}"
    bug "[T8-retest] Role switch session null: pre=${T8R_PRE_SESSION:0:80}, post=${T8R_POST_SESSION:0:80}, clicked=${T8R_CLICKED_ROLE}"
  else
    record T8-RETEST FAIL "Role switch did not change persona: pre=${T8R_PRE_PERSONA}, post=${T8R_POST_PERSONA}"
    bug "[T8-retest] Role switch did not change persona: pre=${T8R_PRE_PERSONA}, post=${T8R_POST_PERSONA}, clicked=${T8R_CLICKED_ROLE}"
  fi
else
  rpt "  FAIL: no role-switcher buttons visible on admin dashboard"
  record T8-RETEST FAIL "Admin dashboard has no role-switcher buttons visible (personas in session: ${T8R_PERSONAS_IN_SESSION})"
  bug "[T8-retest] No role-switcher buttons on admin dashboard: personas=${T8R_PERSONAS_IN_SESSION}, session=${T8R_PRE_SESSION:0:100}"
fi

# ============================================================================
# TEST 13 (REDO) — Program install
# ============================================================================
section "TEST 13 (redo) — Program install (Cardio Care)"
rpt "  Action: Sign in as participant, go to /programs/cardio-care, click Install Program"
rpt "  Expected: success state appears (checkmark or 'Go to Dashboard' button)"
reauth "ama@eks.health" "DemoPass123!" >/dev/null
ab open "${BASE}/programs/cardio-care" >/dev/null 2>&1
wait_idle
sleep 3
capture_diagnostics "test13-before-install"
rpt "  Pre-install URL: $(ab get url 2>/dev/null)"

ab snapshot -i -c >"${LOGS}/test13-prog.snap" 2>&1
INSTALL_REF="$(ref_for "${LOGS}/test13-prog.snap" 'button "Install Program"')"
if [ -z "$INSTALL_REF" ]; then
  INSTALL_REF="$(ref_for "${LOGS}/test13-prog.snap" 'button "Sign In to Install"')"
fi
rpt "  Install button ref: ${INSTALL_REF:-none}"
if [ -n "$INSTALL_REF" ]; then
  ab click "@${INSTALL_REF}" >/dev/null 2>&1 || true
else
  ab find text "Install Program" click >/dev/null 2>&1 || true
  ab find text "Sign In to Install" click >/dev/null 2>&1 || true
fi
# Wait up to 20s for success state.
sleep 5
ab wait --text "Go to Dashboard" --timeout 20000 >/dev/null 2>&1 || true
ab wait --text "Installed" --timeout 5000 >/dev/null 2>&1 || true
sleep 2
capture_diagnostics "test13-after-install"
T13_URL_AFTER="$(ab get url 2>/dev/null || echo '?')"
rpt "  Post-install URL: ${T13_URL_AFTER}"
T13_SUCCESS="$(yn '/Go to Dashboard|Installed|✓|Installation Complete|installed successfully|Uninstall/i.test(document.body.innerText) ? "yes" : "no"')"
T13_DASHBOARD_BTN="$(yn '/Go to Dashboard/i.test(document.body.innerText) ? "yes" : "no"')"
T13_CHECKMARK="$(ab eval '[...document.querySelectorAll("svg, [class*=check], [class*=Check], [class*=success], [class*=Success]")].filter(e=>/check|success|complete/i.test(e.getAttribute("class")||e.getAttribute("data-icon")||"")).length' 2>/dev/null | tail -1 | tr -d '"')"
T13_INSTALL_API="$(api_probe GET /api/marketplace/listings)"
rpt "  Success state visible:    ${T13_SUCCESS}"
rpt "  'Go to Dashboard' button: ${T13_DASHBOARD_BTN}"
rpt "  Checkmark icons:          ${T13_CHECKMARK}"
rpt "  /api/marketplace/listings: ${T13_INSTALL_API:0:80}"
# Also check if the install button changed state (e.g. now says "Installed" or "Uninstall")
T13_BTN_STATE="$(ab eval '[...document.querySelectorAll("button")].filter(b=>/install|uninstall|go to dashboard/i.test(b.textContent.trim())).map(b=>b.textContent.trim()).slice(0,3).join(" | ")' 2>/dev/null | tail -1 | tr -d '"')"
rpt "  Install-related buttons after click: ${T13_BTN_STATE}"

if [ "$T13_SUCCESS" = "yes" ] || [ "$T13_DASHBOARD_BTN" = "yes" ] || echo "$T13_BTN_STATE" | grep -qi "Uninstall\|Go to Dashboard"; then
  record T13 PASS "Install Program produced success state (url=${T13_URL_AFTER}, btn=${T13_BTN_STATE})"
else
  record T13 FAIL "Install Program did not produce success state: success=${T13_SUCCESS}, dash_btn=${T13_DASHBOARD_BTN}, btn_state=${T13_BTN_STATE}, url=${T13_URL_AFTER}"
  bug "[T13] Install failed: success=${T13_SUCCESS}, dash_btn=${T13_DASHBOARD_BTN}, btn_state=${T13_BTN_STATE}, url=${T13_URL_AFTER}"
fi

# ============================================================================
# TEST 14 — All 6 demo roles
# ============================================================================
section "TEST 14 — All 6 demo accounts sign in + dashboard renders"
rpt "  For each role: sign in, verify dashboard renders, sign out"

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
  T14_SIGNIN_RESULT="$(api_sign_in "$email" "$pass")"
  rpt "    api_sign_in result: ${T14_SIGNIN_RESULT}"
  T14_SESSION="$(api_probe GET /api/auth/session)"
  rpt "    /api/auth/session: ${T14_SESSION:0:120}"
  T14_DASH_API="$(api_probe GET /api/dashboard)"
  rpt "    /api/dashboard: ${T14_DASH_API:0:120}"
  ab open "${BASE}/dashboard" >/dev/null 2>&1
  wait_idle
  sleep 3
  T14_ROLE_URL="$(ab get url 2>/dev/null || echo '?')"
  rpt "    /dashboard URL: ${T14_ROLE_URL}"
  capture_diagnostics "test14-role-${tag}"
  T14_WELCOME="$(yn '/Welcome/i.test(document.body.innerText) ? "yes" : "no"')"
  T14_BODY_LEN="$(ab eval 'document.body.innerText.length' 2>/dev/null | tail -1 | tr -d '"')"
  T14_ROLE_CONTENT="$(yn "/${role}/i.test(document.body.innerText) ? \"yes\" : \"no\"")"
  # For each role, check role-specific content keywords.
  case "$role" in
    "Participant") T14_ROLE_KW="$(yn '/Today.{0,5}s\s*Missions|Habit Streaks|Active Goals|Active Competitions/i.test(document.body.innerText) ? "yes" : "no"')";;
    "Technician") T14_ROLE_KW="$(yn '/Technician|Verified Sessions|Sessions|Patient/i.test(document.body.innerText) ? "yes" : "no"')";;
    "Developer") T14_ROLE_KW="$(yn '/Developer|Programs Published|SDK|API/i.test(document.body.innerText) ? "yes" : "no"')";;
    "Researcher") T14_ROLE_KW="$(yn '/Research|Consent|Studies|Datasets/i.test(document.body.innerText) ? "yes" : "no"')";;
    "Org Admin") T14_ROLE_KW="$(yn '/Organization|Population|Members|Campaigns/i.test(document.body.innerText) ? "yes" : "no"')";;
    "Platform Admin") T14_ROLE_KW="$(yn '/Accounts|Waitlist|Platform/i.test(document.body.innerText) ? "yes" : "no"')";;
    *) T14_ROLE_KW="unknown";;
  esac
  rpt "    Welcome visible: ${T14_WELCOME}"
  rpt "    Body length:     ${T14_BODY_LEN}"
  rpt "    Role-specific content: ${T14_ROLE_KW}"
  rpt "    /api/dashboard ok: $(echo "$T14_DASH_API" | cut -d'|' -f2)"
  full_sign_out
  if echo "$T14_ROLE_URL" | grep -q "/dashboard" && [ "$T14_WELCOME" = "yes" ] && [ "${T14_BODY_LEN:-0}" -gt 500 ] 2>/dev/null && [ "$T14_ROLE_KW" = "yes" ]; then
    ROLE_RESULTS+=("PASS|${role}|dashboard rendered (body=${T14_BODY_LEN}, role_kw=yes)")
    rpt "    ROLE RESULT: PASS — ${role} dashboard rendered with role-specific content"
  elif echo "$T14_ROLE_URL" | grep -q "/sign-in"; then
    ROLE_RESULTS+=("FAIL|${role}|bounced to /sign-in (session lost)")
    rpt "    ROLE RESULT: FAIL — ${role} bounced to /sign-in"
    T14_ALL_PASS=false
    bug "[T14/${role}] Bounced to /sign-in: session=${T14_SESSION}, dash=${T14_DASH_API}"
  elif [ "$T14_ROLE_KW" != "yes" ]; then
    ROLE_RESULTS+=("FAIL|${role}|dashboard rendered but no role-specific content (welcome=${T14_WELCOME}, body=${T14_BODY_LEN})")
    rpt "    ROLE RESULT: FAIL — ${role} dashboard missing role-specific content"
    T14_ALL_PASS=false
    bug "[T14/${role}] Dashboard missing role content: welcome=${T14_WELCOME}, body=${T14_BODY_LEN}, dash_api=${T14_DASH_API}"
  else
    ROLE_RESULTS+=("WARN|${role}|dashboard rendered but body short (body=${T14_BODY_LEN})")
    rpt "    ROLE RESULT: WARN — ${role} dashboard short body"
    bug "[T14/${role}] Dashboard short body: body=${T14_BODY_LEN}, dash_api=${T14_DASH_API}"
  fi
done

rpt ""
rpt "  Per-role results (Test 14):"
for r in "${ROLE_RESULTS[@]}"; do
  rpt "    ${r}"
done
if [ "$T14_ALL_PASS" = "true" ]; then
  record T14 PASS "All 6 demo accounts signed in and rendered dashboard with role-specific content"
else
  record T14 FAIL "One or more demo accounts failed — see per-role results"
fi

# ============================================================================
# Continuation summary
# ============================================================================
section "CONTINUATION SUMMARY"
rpt "  Tests passed:  ${PASS_COUNT}"
rpt "  Tests warned:  ${WARN_COUNT}"
rpt "  Tests failed:  ${FAIL_COUNT}"
rpt ""
rpt "  Per-test result (continuation):"
for r in "${RESULTS[@]}"; do
  rpt "    ${r}"
done
rpt ""
rpt "  Per-role result (Test 14):"
for r in "${ROLE_RESULTS[@]}"; do
  rpt "    ${r}"
done
rpt ""
rpt "Finished continuation: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

ab close --all >/dev/null 2>&1 || true
exit 0
