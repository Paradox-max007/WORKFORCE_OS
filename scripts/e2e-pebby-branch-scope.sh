#!/bin/bash
# ============================================================================
# PULSE — Pebby branch-scoping e2e: per-user access, no global DB results.
# Proves in the real browser (demo mode):
#   1. Super admin saves the AI connection ONCE (Site Settings) — every admin
#      then chats through the SAME stored credentials.
#   2. A branch-scoped admin (Ravi — Northern Emirates Branch + direct sites
#      NPC & Red Coast) gets a Pebby scoped to HIS access:
#        - welcome card shows "Your access: branches: Northern Emirates…"
#        - system prompt roster = ONLY his 6 in-scope employees
#          (PUL-001/002/003 NPC + PUL-005/006/007 Red Coast)
#        - NO Marina Heights Tower (Sara's Dubai branch), no Oasis Mall, no
#          idle employees, no cancelled Ahmed Hassan (idle → out of scope)
#        - admin directory replaced by his own access line
#   3. The SUPER admin still sees the whole organization (per-user scoping,
#      not a global filter): roster carries PUL-2026-004 + Marina Heights.
# Runs in ONE Bash call — background processes are reaped when the call ends.
# ============================================================================
cd /home/z/my-project
mkdir -p /tmp/render

node scripts/mock-ai-provider.mjs > /tmp/mock-ai.log 2>&1 &
MOCK_PID=$!
(lsof -ti:3000 | xargs -r kill -9) 2>/dev/null
pkill -9 -f "next-server" 2>/dev/null
pkill -9 -f "standalone/server.js" 2>/dev/null
sleep 1
node .next/standalone/server.js > /tmp/pulse-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $MOCK_PID $SERVER_PID 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null' EXIT

code=000
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "== server up (code $code) =="

B="agent-browser"
J () { $B eval "$1" 2>/dev/null; }
CLICKTEXT () { J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='$1'); if(b){b.click();return 'ok';} return 'not-found'; })()"; }
ANSWER () { J "(() => { const b=[...document.querySelectorAll('[role=\"dialog\"][aria-label=\"Pebby chat\"] [data-role=\"assistant\"]')]; return b[b.length-1]?.innerText ?? '(none)'; })()"; }
ASK () { J "(() => { const ta=document.querySelector('textarea[placeholder^=\"Ask about\"]'); if(!ta) return 'no-ta'; const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; set.call(ta,'$1'); ta.dispatchEvent(new Event('input',{bubbles:true})); ta.focus(); return 'typed'; })()" >/dev/null; $B press Enter >/dev/null 2>&1; }

LOGIN () {  # $1 email
  $B find label "Email" fill "$1" >/dev/null 2>&1
  $B find label "Password" fill "demo1234" >/dev/null 2>&1
  CLICKTEXT "Sign In" >/dev/null
  sleep 3; $B wait --load networkidle >/dev/null 2>&1
}
LOGOUT () { J "(() => { localStorage.removeItem('pulse_demo_session'); return 'signed-out'; })()"; $B open http://localhost:3000 >/dev/null 2>&1; $B wait --load networkidle >/dev/null 2>&1; sleep 2; }

$B open http://localhost:3000 >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 1

# fresh v9 demo seed: clear + reload (re-seeds, drops any stored session)
J "(() => { localStorage.clear(); return 'cleared'; })()"
$B open http://localhost:3000 >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 2

# ---- 1. super admin saves the AI connection (the ONLY credentials entry) ---
if J "document.body.innerText.toLowerCase().includes('sign in')" | grep -q true; then
  LOGIN "super@pulse.app"
fi
echo "super login: $(J "document.body.innerText.includes('Dashboard')")"
CLICKTEXT "Site Settings" >/dev/null
sleep 2
$B find label "Base URL" fill "http://127.0.0.1:8787/v1" >/dev/null 2>&1
$B find label "Model" fill "mock-model" >/dev/null 2>&1
$B find label "API key" fill "sk-test-1234" >/dev/null 2>&1
CLICKTEXT "Save AI connection" >/dev/null
sleep 1.5
J "(() => { const s=document.querySelector('button[role=\"switch\"][aria-label=\"Enable Pebby — Smart Assistant\"]'); if(s){s.click();return 'ok';} return 'not-found'; })()" >/dev/null
sleep 1.5
echo "ai enabled (stored once by super admin): $(J "JSON.parse(localStorage.getItem('pulse_demo_db_v9')).siteSettings.ai_enabled")"

# ---- 2. branch-scoped admin uses Pebby through the SAME connection --------
LOGOUT
if J "document.body.innerText.toLowerCase().includes('sign in')" | grep -q true; then
  LOGIN "admin@pulse.app"   # Ravi Kumar — Northern Emirates Branch + NPC & Red Coast
fi
echo "ravi login: $(J "document.body.innerText.includes('Dashboard')")"

J "(() => { const b=document.querySelector('button[aria-label=\"Open Pebby — Smart Assistant\"]'); if(b){b.click();return 'ok';} return 'not-found'; })()" >/dev/null
sleep 3
WELCOME=$(J "(() => { const d=document.querySelector('[role=\"dialog\"][aria-label=\"Pebby chat\"]'); return d ? d.innerText : '(none)'; })()")
if [ -z "$WELCOME" ]; then sleep 2; WELCOME=$(J "(() => { const d=document.querySelector('[role=\"dialog\"][aria-label=\"Pebby chat\"]'); return d ? d.innerText : '(none)'; })()"); fi
echo; echo "### welcome card (Ravi):"
echo "$WELCOME" | head -14
$B screenshot /tmp/render/pebby-scope-welcome-ravi.png

# Q1 — the viewer's own access line (from the system prompt)
ASK "What is my access?"
sleep 6
A1=$(ANSWER)
echo; echo "### Q1 (access line): $A1"

# Q2 — the roster/sites actually inside the scoped snapshot
ASK "Dump the snapshot roster"
sleep 6
A2=$(ANSWER)
echo; echo "### Q2 (scoped roster): $A2"
$B screenshot /tmp/render/pebby-scope-roster-ravi.png

# ---- 3. super admin still sees the WHOLE organization ----------------------
LOGOUT
if J "document.body.innerText.toLowerCase().includes('sign in')" | grep -q true; then
  LOGIN "super@pulse.app"
fi
J "(() => { const b=document.querySelector('button[aria-label=\"Open Pebby — Smart Assistant\"]'); if(b){b.click();return 'ok';} return 'not-found'; })()" >/dev/null
sleep 2
ASK "Dump the snapshot roster"
sleep 6
A3=$(ANSWER)
echo; echo "### Q3 (super roster): $A3"
$B screenshot /tmp/render/pebby-scope-roster-super.png

# ---- verdicts ---------------------------------------------------------------
echo; echo "### CHECKS"
pass=0; fail=0
CK () { if echo "$2" | grep -q "$3"; then echo "PASS: $1"; pass=$((pass+1)); else echo "FAIL: $1"; fail=$((fail+1)); fi; }
CKN () { if echo "$2" | grep -q "$3"; then echo "FAIL: $1"; fail=$((fail+1)); else echo "PASS: $1"; pass=$((pass+1)); fi; }

echo "-- shared credentials (super admin saved, branch admin chats) --"
CK  "AI connection enabled in the shared settings" "$(J "JSON.parse(localStorage.getItem('pulse_demo_db_v9')).siteSettings.ai_enabled")" "true"
CK  "Ravi got a real Pebby answer (connection reused)" "$A1" "ACCESS LINE"
echo "-- branch-scoped admin (Ravi) --"
CK  "welcome card names his branch access" "$WELCOME" "Northern Emirates Branch"
CK  "access line names Ravi" "$A1" "Ravi Kumar"
CK  "access line names the granted branch" "$A1" "Northern Emirates Branch"
CK  "access line names his direct sites" "$A1" "Red Coast Compound"
CK  "roster: 6 in-scope employees" "$A2" "ROSTER(6)"
CK  "roster: NPC crew present (PUL-2026-001)" "$A2" "PUL-2026-001"
CK  "roster: Red Coast crew present (PUL-2026-005)" "$A2" "PUL-2026-005"
CKN "roster: Marina employee PUL-2026-004 ABSENT" "$A2" "PUL-2026-004"
CKN "roster: Marina employee PUL-2026-009 ABSENT" "$A2" "PUL-2026-009"
CKN "roster: idle employees ABSENT (PUL-2026-013)" "$A2" "PUL-2026-013"
CKN "cancelled idle Ahmed Hassan ABSENT (PUL-2026-008)" "$A2" "PUL-2026-008"
CK  "cancelled list empty for the branch admin" "$A2" "CANCELLED(0)"
CKN "sites: Marina Heights Tower ABSENT" "$A2" "Marina Heights Tower"
CKN "sites: Oasis Mall Fitout ABSENT" "$A2" "Oasis Mall Fitout"
CK  "sites: 3 in-scope sites (NPC, Old Depot, Red Coast)" "$A2" "SITES(3)"
CK  "admin directory hidden for the branch admin" "$A1" "ADMIN DIRECTORY — not available"
CKN "no full ADMINS section leaks to Ravi" "$A1" "ADMINS ("
echo "-- super admin unchanged (per-user, not global) --"
CK  "super roster: 14 employees" "$A3" "ROSTER(14)"
CK  "super roster: PUL-2026-004 present" "$A3" "PUL-2026-004"
CK  "super roster: Marina Heights Tower present" "$A3" "Marina Heights Tower"
CK  "super roster: cancelled Ahmed Hassan present" "$A3" "CANCELLED(1)"

echo; echo "### RESULT: $pass pass, $fail fail"
[ "$fail" = "0" ] || exit 1
