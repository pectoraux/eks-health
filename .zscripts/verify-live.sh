#!/usr/bin/env bash
# verify-live.sh — Browser-test the live Eks-Health deployment
# Site: https://eks-health.vercel.app  (Vercel production, serverless)
# Task ID: verify-live-1
#
# Strategy:
#   Use agent-browser to drive a real Chrome session against the live site.
#   For each role, exercise the actual UI flow (form-fill + Sign In click),
#   then verify via direct fetch() calls which APIs succeed/fail. This lets
#   us distinguish UI bugs from API bugs.
#
# Critical bug discovered (documented in BUGS.txt):
#   /api/dashboard returns 401 even when authenticated, because the route
#   calls ensureHydrated() (which does NOT hydrate the sessions store from
#   DB) instead of ensureAdminAccount()/ensureDemoAccounts() (which DO).
#   On Vercel serverless, fresh instances handling /api/dashboard have an
#   empty sessions store and reject the access token. The dashboard UI
#   therefore never receives data and renders an empty body.
#
# Artifacts:
#   Logs:        /home/z/my-project/.zscripts/logs/verify-live/
#   Screenshots: /home/z/my-project/.zscripts/screenshots/verify-live/
#   Summary:     /home/z/my-project/.zscripts/logs/verify-live/SUMMARY.txt
#   Bugs:        /home/z/my-project/.zscripts/logs/verify-live/BUGS.txt

set -uo pipefail

BASE="https://eks-health.vercel.app"
SESSION="eks-live-verify"
ROOT="/home/z/my-project/.zscripts"
LOGS="${ROOT}/logs/verify-live"
SHOTS="${ROOT}/screenshots/verify-live"
SUMMARY="${LOGS}/SUMMARY.txt"
BUGS="${LOGS}/BUGS.txt"
mkdir -p "$LOGS" "$SHOTS"
export AGENT_BROWSER_SESSION="$SESSION"

ab() { agent-browser --session "$SESSION" "$@"; }
log() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }
bug() { printf '%s\n' "$*" | tee -a "$BUGS"; }
section() {
  local bar="----------------------------------------------------------------"
  printf '\n%s\n%s\n%s\n' "$bar" "$*" "$bar" | tee -a "$SUMMARY"
}

# Run a fetch() in the browser and return a compact "status|ok|snippet" string.
# Args: <method> <path> [body-json]
api_probe() {
  local method="$1" path="$2" body="${3:-}"
  local js
  if [ -n "$body" ]; then
    js="fetch('${path}',{method:'${method}',headers:{'Content-Type':'application/json'},body:JSON.stringify(${body}),cache:'no-store'}).then(async r=>{const d=await r.json().catch(()=>({}));return JSON.stringify({status:r.status,ok:d.ok,err:d.error?.message?.slice(0,80),snippet:JSON.stringify(d.data??d).slice(0,150)})})"
  else
    js="fetch('${path}',{cache:'no-store'}).then(async r=>{const d=await r.json().catch(()=>({}));return JSON.stringify({status:r.status,ok:d.ok,err:d.error?.message?.slice(0,80),snippet:JSON.stringify(d.data??d).slice(0,150)})})"
  fi
  ab eval "$js" 2>/dev/null | tail -1
}

# Sign in via direct API call (most reliable). Sets cookies in the browser.
api_sign_in() {
  local email="$1" pass="$2"
  ab eval "fetch('/api/auth/sign-in',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'${email}',password:'${pass}'})}).then(async r=>{const d=await r.json();return JSON.stringify({status:r.status,ok:d.ok,email:d.data?.email,persona:d.data?.activePersona,err:d.error?.message})})" 2>/dev/null | tail -1
}

# Sign in via the actual UI form (form-fill + Sign In button click).
# Returns 0 if URL ends up at /dashboard, 1 otherwise.
ui_sign_in() {
  local email="$1" pass="$2"
  ab open "${BASE}/sign-in" >/dev/null 2>&1
  ab wait --load networkidle >/dev/null 2>&1
  # Snapshot to get refs
  ab snapshot -i -c >"${LOGS}/.signin.snap" 2>&1
  local emailref passref signinref
  emailref="$(grep -iE 'textbox.*Email' "${LOGS}/.signin.snap" | head -1 | sed -E 's/.*\[ref=([a-z0-9]+)\].*/\1/')"
  passref="$(grep -iE 'textbox.*Password' "${LOGS}/.signin.snap" | head -1 | sed -E 's/.*\[ref=([a-z0-9]+)\].*/\1/')"
  signinref="$(grep -E 'button "Sign In"' "${LOGS}/.signin.snap" | head -1 | sed -E 's/.*\[ref=([a-z0-9]+)\].*/\1/')"
  ab fill "@${emailref}" "$email" >/dev/null 2>&1 || true
  ab fill "@${passref}"  "$pass"  >/dev/null 2>&1 || true
  ab click "@${signinref}" >/dev/null 2>&1 || true
  ab wait --url "**/dashboard" --timeout 15000 >/dev/null 2>&1 || true
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
: >"$SUMMARY"
: >"$BUGS"
log "Eks-Health live verification — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Target: ${BASE}"
log ""
ab close --all >/dev/null 2>&1 || true

# Open the site once to establish browser session
ab open "${BASE}/sign-in" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1

# ============================================================================
# PHASE 1 — Sign-in + dashboard render for all 6 demo accounts
# ============================================================================
log "================================================================"
log "PHASE 1 — Sign-in + dashboard render for 6 demo accounts"
log "================================================================"

declare -a ROLES=(
  "Participant|ama@eks.health|DemoPass123!"
  "Technician|clinic@eks.health|DemoPass123!"
  "Developer|kwame@eks.health|DemoPass123!"
  "Researcher|research@eks.health|DemoPass123!"
  "Org Admin|admin@eks.health|DemoPass123!"
  "Platform Admin|ekontetevi@gmail.com|Payswap123456"
)

declare -a ROLE_RESULTS=()
for entry in "${ROLES[@]}"; do
  IFS='|' read -r role email pass <<<"$entry"
  tag="$(echo "$role" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"
  section "ROLE: $role ($email)"

  # Sign out + clear cookies first
  ab eval 'fetch("/api/auth/sign-out",{method:"POST"}).catch(()=>{})' >/dev/null 2>&1
  ab cookies clear >/dev/null 2>&1
  ab wait 500 >/dev/null 2>&1

  # 1a) UI sign-in (form fill + button click)
  ui_sign_in "$email" "$pass"
  local_url="$(ab get url 2>/dev/null || echo '?')"
  log "  UI sign-in: URL after click = $local_url"

  # 1b) Direct API sign-in (sets cookies reliably)
  ab open "${BASE}/sign-in" >/dev/null 2>&1
  ab wait --load networkidle >/dev/null 2>&1
  signin_result="$(api_sign_in "$email" "$pass")"
  log "  API /api/auth/sign-in: $signin_result"

  # Wait briefly for cookie/session propagation
  ab wait 1500 >/dev/null 2>&1

  # 1c) Probe /api/auth/session
  sess_result="$(api_probe GET /api/auth/session)"
  log "  API /api/auth/session: $sess_result"

  # 1d) Probe /api/dashboard (expected to fail due to hydration bug)
  dash_result="$(api_probe GET /api/dashboard)"
  log "  API /api/dashboard:    $dash_result"
  if echo "$dash_result" | grep -q '"status":401'; then
    bug "[$role] /api/dashboard returns 401 despite valid session (route uses ensureHydrated() instead of ensureAdminAccount()/ensureDemoAccounts() — sessions store not hydrated from DB on fresh serverless instances)"
  fi

  # 1e) Navigate to /dashboard and check UI render
  ab open "${BASE}/dashboard" >/dev/null 2>&1
  ab wait --load networkidle >/dev/null 2>&1
  ab wait 2500 >/dev/null 2>&1
  ui_url="$(ab get url 2>/dev/null || echo '?')"
  ui_render="$(ab eval 'const h=document.body.innerHTML;JSON.stringify({len:h.length,missions:/Today.{0,5}s Missions/.test(h),habits:/Habit Streaks/.test(h),welcome:/Welcome/.test(h)})' 2>/dev/null | tail -1)"
  log "  UI /dashboard URL: $ui_url"
  log "  UI /dashboard body: $ui_render"

  ab screenshot "${SHOTS}/role-${tag}.png" >/dev/null 2>&1 || true
  ab snapshot -i -c >"${LOGS}/role-${tag}.snapshot.txt" 2>&1 || true
  ab console >"${LOGS}/role-${tag}.console.txt" 2>&1 || true
  ab errors  >"${LOGS}/role-${tag}.errors.txt" 2>&1 || true

  # Classify result
  if echo "$ui_render" | grep -q '"missions":true' || echo "$ui_render" | grep -q '"habits":true'; then
    ROLE_RESULTS+=("PASS|$role|dashboard body rendered")
  elif echo "$dash_result" | grep -q '"status":401'; then
    ROLE_RESULTS+=("FAIL|$role|/api/dashboard 401 (hydration bug) → empty body")
  elif echo "$sess_result" | grep -q '"ok":true,"err"'; then
    ROLE_RESULTS+=("FAIL|$role|session API failed")
  else
    ROLE_RESULTS+=("PARTIAL|$role|session OK but dashboard body empty")
  fi
done

section "PHASE 1 SUMMARY"
for r in "${ROLE_RESULTS[@]}"; do
  log "  $r"
done

# ============================================================================
# PHASE 2 — Participant action APIs (direct fetch, since UI is broken)
# ============================================================================
section "PHASE 2 — Participant action APIs (direct fetch)"

# Sign in as participant
ab eval 'fetch("/api/auth/sign-out",{method:"POST"}).catch(()=>{})' >/dev/null 2>&1
ab cookies clear >/dev/null 2>&1
ab open "${BASE}/sign-in" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
api_sign_in "ama@eks.health" "DemoPass123!" >/dev/null
ab wait 1500 >/dev/null 2>&1
log "  Signed in as Participant"

# 2a) Fetch today's missions + complete the first active one
log ""
log "  [2a] Complete a mission"
missions_list="$(ab eval 'fetch("/api/missions/list",{cache:"no-store"}).then(async r=>{const d=await r.json();const m=d.data?.missions?.find(x=>x.state==="active");return m?JSON.stringify({id:m.id,title:m.title}):"none"})' 2>/dev/null | tail -1)"
log "    active mission: $missions_list"
mid="$(echo "$missions_list" | sed -E 's/.*"id":"([^"]+)".*/\1/')"
if [ -n "$mid" ] && [ "$mid" != "none" ]; then
  comp_result="$(api_probe POST /api/missions/complete "{\"missionId\":\"${mid}\",\"outcome\":\"success\"}")"
  log "    POST /api/missions/complete: $comp_result"
  if echo "$comp_result" | grep -q '"ok":true'; then
    log "    OK: mission marked completed"
  else
    bug "[Participant] /api/missions/complete failed: $comp_result"
  fi
else
  log "    SKIP: no active mission found"
fi

# 2b) Habit check-in
log ""
log "  [2b] Habit +check-in"
habits_list="$(ab eval 'fetch("/api/missions/habits",{cache:"no-store"}).then(async r=>{const d=await r.json();const h=d.data?.habits?.[0];return h?JSON.stringify({id:h.id,name:h.name}):"none"})' 2>/dev/null | tail -1)"
log "    first habit: $habits_list"
hid="$(echo "$habits_list" | sed -E 's/.*"id":"([^"]+)".*/\1/')"
if [ -n "$hid" ] && [ "$hid" != "none" ]; then
  habit_result="$(api_probe POST /api/missions/habits "{\"habitId\":\"${hid}\",\"action\":\"complete\"}")"
  log "    POST /api/missions/habits: $habit_result"
  if echo "$habit_result" | grep -q '"ok":true'; then
    log "    OK: habit checked in"
  else
    bug "[Participant] /api/missions/habits failed: $habit_result"
  fi
else
  log "    SKIP: no habit found"
fi

# 2c) Record measurement
log ""
log "  [2c] Record measurement (dialog flow)"
schemas_result="$(ab eval 'fetch("/api/health/schemas").then(async r=>{const d=await r.json();const arr=Array.isArray(d.data)?d.data:d.data?.schemas;const s=arr?.[0];return s?JSON.stringify({id:s.id,name:s.name,unit:s.unit}):"none"})' 2>/dev/null | tail -1)"
sources_result="$(ab eval 'fetch("/api/health/sources").then(async r=>{const d=await r.json();const s=d.data?.sources?.[0];return s?JSON.stringify({id:s.id,label:s.label}):"none"})' 2>/dev/null | tail -1)"
log "    schemas[0]: $schemas_result"
log "    sources[0]: $sources_result"
sid="$(echo "$schemas_result" | sed -E 's/.*"id":"([^"]+)".*/\1/')"
srcid="$(echo "$sources_result" | sed -E 's/.*"id":"([^"]+)".*/\1/')"
unit="$(echo "$schemas_result" | sed -E 's/.*"unit":"([^"]+)".*/\1/')"
if [ -n "$sid" ] && [ "$sid" != "none" ] && [ -n "$srcid" ] && [ "$srcid" != "none" ]; then
  meas_result="$(api_probe POST /api/health/measurements "{\"schemaId\":\"${sid}\",\"profileId\":\"prof_demo_1\",\"value\":42,\"unitId\":\"${unit}\",\"sourceId\":\"${srcid}\",\"collectedBy\":\"self\",\"tags\":[\"self-reported\"]}")"
  log "    POST /api/health/measurements: $meas_result"
  if echo "$meas_result" | grep -q '"ok":true'; then
    log "    OK: measurement recorded"
  else
    bug "[Participant] /api/health/measurements failed: $meas_result"
  fi
else
  log "    SKIP: no schema/source available"
fi

# ============================================================================
# PHASE 3 — Marketplace (public)
# ============================================================================
section "PHASE 3 — Marketplace (public)"

ab eval 'fetch("/api/auth/sign-out",{method:"POST"}).catch(()=>{})' >/dev/null 2>&1
ab cookies clear >/dev/null 2>&1
ab open "${BASE}/marketplace" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
ab wait 2500 >/dev/null 2>&1

LISTING_COUNT="$(ab eval '[...document.querySelectorAll("main .grid > div, main [class*=cursor-pointer]")].filter(c=>/installs/i.test(c.textContent)).length' 2>/dev/null | tail -1 | tr -d '\"')"
log "  marketplace listing cards: ${LISTING_COUNT}"
ab screenshot "${SHOTS}/marketplace.png" >/dev/null 2>&1 || true
ab snapshot -i -c >"${LOGS}/marketplace.snapshot.txt" 2>&1 || true
ab console >"${LOGS}/marketplace.console.txt" 2>&1 || true
ab errors  >"${LOGS}/marketplace.errors.txt" 2>&1 || true

if [ "${LISTING_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  log "  PASS: marketplace listings rendered"
else
  log "  FAIL: no listing cards"
  bug "[Marketplace] no listing cards rendered"
fi

# Click first listing → /programs/[id]
log ""
log "  Click first listing → /programs/[id]"
ab eval 'const c=document.querySelector("main .grid > div, main [class*=cursor-pointer]");if(c){c.click()}' >/dev/null 2>&1
ab wait --url "**/programs/**" --timeout 15000 >/dev/null 2>&1 || true
ab wait --load networkidle >/dev/null 2>&1
ab wait 2000 >/dev/null 2>&1

PROG_URL="$(ab get url 2>/dev/null || echo '?')"
log "  program detail URL: ${PROG_URL}"
PROG_BODY_LEN="$(ab eval 'document.body.innerText.length' 2>/dev/null | tail -1 | tr -d '\"')"
PROG_HEADINGS="$(ab eval '[...document.querySelectorAll("h1,h2,h3")].map(h=>h.textContent.trim()).filter(Boolean).slice(0,8).join(" | ")' 2>/dev/null | tail -1 | tr -d '\"')"
log "  program page body length: ${PROG_BODY_LEN}"
log "  program page headings: ${PROG_HEADINGS}"
ab screenshot "${SHOTS}/program-detail.png" >/dev/null 2>&1 || true
ab snapshot -i -c >"${LOGS}/program-detail.snapshot.txt" 2>&1 || true
ab console >"${LOGS}/program-detail.console.txt" 2>&1 || true

if echo "$PROG_URL" | grep -q "/programs/" && [ "${PROG_BODY_LEN:-0}" -gt 200 ] 2>/dev/null; then
  log "  PASS: program detail page rendered"
else
  log "  WARN: program detail page may be sparse (body=${PROG_BODY_LEN})"
  bug "[Marketplace] program detail page sparse (url=$PROG_URL, body=${PROG_BODY_LEN})"
fi

# ============================================================================
# PHASE 4 — /dashboard/settings (Participant auth)
# ============================================================================
section "PHASE 4 — /dashboard/settings (Participant auth)"

ab open "${BASE}/sign-in" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
api_sign_in "ama@eks.health" "DemoPass123!" >/dev/null
ab wait 1500 >/dev/null 2>&1
log "  Signed in as Participant"

log "  Navigating to /dashboard/settings..."
ab open "${BASE}/dashboard/settings" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
ab wait 3000 >/dev/null 2>&1

SETTINGS_URL="$(ab get url 2>/dev/null || echo '?')"
SETTINGS_CARD_COUNT="$(ab eval '[...document.querySelectorAll("[class*=card],[class*=Card]")].filter(c=>c.textContent.trim().length>30).length' 2>/dev/null | tail -1 | tr -d '\"')"
SETTINGS_HEADINGS="$(ab eval '[...document.querySelectorAll("main h2, main h3, [class*=CardTitle]")].map(h=>h.textContent.trim()).filter(Boolean).slice(0,15).join(" | ")' 2>/dev/null | tail -1 | tr -d '\"')"
log "  settings URL: ${SETTINGS_URL}"
log "  settings cards: ${SETTINGS_CARD_COUNT}"
log "  settings headings: ${SETTINGS_HEADINGS}"
ab screenshot "${SHOTS}/settings.png" >/dev/null 2>&1 || true
ab snapshot -i -c >"${LOGS}/settings.snapshot.txt" 2>&1 || true
ab console >"${LOGS}/settings.console.txt" 2>&1 || true
ab errors  >"${LOGS}/settings.errors.txt" 2>&1 || true

if [ "${SETTINGS_CARD_COUNT:-0}" -ge 3 ] 2>/dev/null; then
  log "  PASS: settings page rendered with multiple cards"
elif echo "$SETTINGS_URL" | grep -q "/sign-in"; then
  log "  FAIL: settings redirected to /sign-in (auth not persisted)"
  bug "[Settings] redirected to /sign-in despite valid session cookie"
else
  log "  WARN: settings page has few/no cards (got ${SETTINGS_CARD_COUNT})"
fi

# ============================================================================
# PHASE 5 — /dashboard/timeline (Participant auth)
# ============================================================================
section "PHASE 5 — /dashboard/timeline (Participant auth)"

log "  Navigating to /dashboard/timeline..."
ab open "${BASE}/dashboard/timeline" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
ab wait 3000 >/dev/null 2>&1

TIMELINE_URL="$(ab get url 2>/dev/null || echo '?')"
TIMELINE_FILTER_COUNT="$(ab eval '[...document.querySelectorAll("main [role=tablist] [role=tab], main button")].filter(b=>/^(All|Measurements|Missions|Competitions)$/.test(b.textContent.trim())).length' 2>/dev/null | tail -1 | tr -d '\"')"
TIMELINE_ENTRY_COUNT="$(ab eval '[...document.querySelectorAll("main [class*=space-y-3] > div, main .grid > div")].filter(d=>/Measurement:|joined|participants|streak|complete/i.test(d.textContent)).length' 2>/dev/null | tail -1 | tr -d '\"')"
log "  timeline URL: ${TIMELINE_URL}"
log "  timeline filter buttons: ${TIMELINE_FILTER_COUNT}"
log "  timeline entries: ${TIMELINE_ENTRY_COUNT}"
ab screenshot "${SHOTS}/timeline.png" >/dev/null 2>&1 || true
ab snapshot -i -c >"${LOGS}/timeline.snapshot.txt" 2>&1 || true
ab console >"${LOGS}/timeline.console.txt" 2>&1 || true
ab errors  >"${LOGS}/timeline.errors.txt" 2>&1 || true

if [ "${TIMELINE_FILTER_COUNT:-0}" -ge 4 ] 2>/dev/null && [ "${TIMELINE_ENTRY_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  log "  PASS: timeline rendered with filters and entries"
elif echo "$TIMELINE_URL" | grep -q "/sign-in"; then
  log "  FAIL: timeline redirected to /sign-in"
  bug "[Timeline] redirected to /sign-in despite valid session cookie"
else
  log "  WARN: timeline partial (filters=${TIMELINE_FILTER_COUNT}, entries=${TIMELINE_ENTRY_COUNT})"
fi

# ============================================================================
# Final summary
# ============================================================================
section "OVERALL SUMMARY"
log "  Phase 1 (role dashboards):"
for r in "${ROLE_RESULTS[@]}"; do
  log "    $r"
done
log ""
log "  Phase 2 (participant action APIs): direct fetch probes (see above)"
log "  Phase 3 (marketplace):  ${LISTING_COUNT:-?} listings, program page body=${PROG_BODY_LEN:-?}"
log "  Phase 4 (settings):     ${SETTINGS_CARD_COUNT:-?} cards (url=${SETTINGS_URL})"
log "  Phase 5 (timeline):     ${TIMELINE_ENTRY_COUNT:-?} entries, ${TIMELINE_FILTER_COUNT:-?} filters"
log ""
log "Artifacts:"
log "  Logs:        ${LOGS}/"
log "  Screenshots: ${SHOTS}/"
log "  Summary:     ${SUMMARY}"
log "  Bugs:        ${BUGS}"

if [ -s "$BUGS" ]; then
  log ""
  log "---- BUGS / ISSUES DISCOVERED ----"
  cat "$BUGS" | tee -a "$SUMMARY"
fi

ab close --all >/dev/null 2>&1 || true
log ""
log "Done."
