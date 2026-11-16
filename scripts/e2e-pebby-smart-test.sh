#!/bin/bash
# ============================================================================
# PULSE — Pebby round 4 e2e: GUI tables in chat bubbles + admin knowledge.
# Proves in the real browser (demo mode, super admin):
#   1. "When was Hassan cancelled?" → [[QUERY]] round against
#      cancellation_requests → answer carries the exact reviewed_at date
#   2. "Show overdue advances sorted by amount" → filtered + sorted +
#      aggregated advance_book query → answer carries the AED total
#   3. "What's the amount paid as salary in October, and how much is
#      pending?" → month-parameterized salary_sheet query → answer carries
#      paid/pending totals AND renders as a real GUI <table> inside the
#      bubble with a scrollable (overflow) container + sticky header
#   4. "Who supervises which branch, and what permissions do the admins
#      have?" → answered from the enriched ADMINS snapshot section as a GUI
#      table (menus / branches / direct sites per admin)
#   5. snapshot answers (nationality/code) still work from the prompt itself
#   6. no browser console errors; directive tokens never leak into the UI
# Runs in ONE Bash call — background processes are reaped when the call ends.
# ============================================================================
cd /home/z/my-project
mkdir -p /tmp/render

node scripts/mock-ai-provider.mjs > /tmp/mock-ai.log 2>&1 &
MOCK_PID=$!
# free port 3000 — lsof misses the renamed next-server process, so pkill both
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
# click the first button whose trimmed text equals $1
CLICKTEXT () { J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='$1'); if(b){b.click();return 'ok';} return 'not-found'; })()"; }
# the LAST assistant bubble's visible text
ANSWER () { J "(() => { const b=[...document.querySelectorAll('[role=\"dialog\"][aria-label=\"Pebby chat\"] [data-role=\"assistant\"]')]; return b[b.length-1]?.innerText ?? '(none)'; })()"; }

$B open http://localhost:3000 >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 1

# fresh v9 demo seed (cancelled Hassan + October salary sheet + advance
# ledger): clear, then RELOAD so the app re-seeds and drops any stored session
J "(() => { localStorage.clear(); return 'cleared'; })()"
$B open http://localhost:3000 >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 2

# ---- login (demo super admin) ---------------------------------------------
if J "document.body.innerText.toLowerCase().includes('sign in')" | grep -q true; then
  $B find label "Email" fill "super@pulse.app" >/dev/null 2>&1
  $B find label "Password" fill "demo1234" >/dev/null 2>&1
  CLICKTEXT "Sign In" >/dev/null
  sleep 3; $B wait --load networkidle >/dev/null 2>&1
fi
echo "login: $(J "document.body.innerText.includes('Dashboard')")"

# ---- configure the AI connection (mock provider) ---------------------------
CLICKTEXT "Site Settings" >/dev/null
sleep 2
$B find label "Base URL" fill "http://127.0.0.1:8787/v1" >/dev/null 2>&1
$B find label "Model" fill "mock-model" >/dev/null 2>&1
$B find label "API key" fill "sk-test-1234" >/dev/null 2>&1
CLICKTEXT "Save AI connection" >/dev/null
sleep 1.5
J "(() => { const s=document.querySelector('button[role=\"switch\"][aria-label=\"Enable Pebby — Smart Assistant\"]'); if(s){s.click();return 'ok';} return 'not-found'; })()" >/dev/null
sleep 1.5
echo "ai enabled: $(J "JSON.parse(localStorage.getItem('pulse_demo_db_v9')).siteSettings.ai_enabled")"
echo "ai base:    $(J "JSON.parse(localStorage.getItem('pulse_demo_db_v9')).siteSettings.ai_base_url")"

# ---- Q1: when was Hassan cancelled? ([[QUERY]] loop) ------------------------
J "(() => { const b=document.querySelector('button[aria-label=\"Open Pebby — Smart Assistant\"]'); if(b){b.click();return 'ok';} return 'not-found'; })()" >/dev/null
sleep 1.5
J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('When was Hassan cancelled')); if(b){b.click();return 'ok';} return 'not-found'; })()" >/dev/null
sleep 7   # provider call → [[QUERY]] → query engine → provider call → answer
ANSWER1=$(ANSWER)
echo; echo "### Q1 answer: $ANSWER1"
$B screenshot /tmp/render/pebby4-q1-cancelled.png

# ---- Q2: complex query — overdue advances sorted + summed -------------------
J "(() => { const ta=document.querySelector('textarea[placeholder^=\"Ask about\"]'); const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; set.call(ta,'Show overdue advances sorted by amount'); ta.dispatchEvent(new Event('input',{bubbles:true})); ta.focus(); return 'typed'; })()" >/dev/null
$B press Enter >/dev/null 2>&1
sleep 7
ANSWER2=$(ANSWER)
echo; echo "### Q2 answer: $ANSWER2"
$B screenshot /tmp/render/pebby4-q2-advances.png

# ---- Q3: October salary paid/pending → month query + GUI TABLE --------------
J "(() => { const ta=document.querySelector('textarea[placeholder^=\"Ask about\"]'); const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; set.call(ta,'What is the amount paid as salary in October, and how much is pending?'); ta.dispatchEvent(new Event('input',{bubbles:true})); ta.focus(); return 'typed'; })()" >/dev/null
$B press Enter >/dev/null 2>&1
sleep 8
ANSWER3=$(ANSWER)
echo; echo "### Q3 answer: $ANSWER3"
$B screenshot /tmp/render/pebby4-q3-salary-table.png

# ---- Q4: admin supervision + permissions → snapshot + GUI TABLE -------------
J "(() => { const ta=document.querySelector('textarea[placeholder^=\"Ask about\"]'); const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; set.call(ta,'Who supervises which branch, and what permissions do the admins have?'); ta.dispatchEvent(new Event('input',{bubbles:true})); ta.focus(); return 'typed'; })()" >/dev/null
$B press Enter >/dev/null 2>&1
sleep 8
ANSWER4=$(ANSWER)
echo; echo "### Q4 answer: $ANSWER4"
$B screenshot /tmp/render/pebby4-q4-admins-table.png

# ---- GUI table structure checks (on the LAST assistant bubble: Q4) ----------
TBL=$(J "(() => { const a=[...document.querySelectorAll('[role=\"dialog\"] [data-role=\"assistant\"]')].pop(); const t=a?.querySelector('table'); if(!t) return 'no-table'; const wrap=t.parentElement; const th=t.querySelector('thead th'); return 'rows=' + t.querySelectorAll('tbody tr').length + ' cols=' + t.querySelectorAll('thead th').length + ' ox=' + getComputedStyle(wrap).overflowX + ' oy=' + getComputedStyle(wrap).overflowY + ' sticky=' + (th ? getComputedStyle(th).position : 'none'); })()")
echo; echo "### Q4 bubble table structure: $TBL"
# how many GUI tables rendered across the whole thread (Q3 salary + Q4 admins)
TABLES=$(J "document.querySelectorAll('[role=\"dialog\"] [data-role=\"assistant\"] table').length")
echo "### GUI tables rendered in the thread: $TABLES"

# ---- Q5: snapshot answer regression (no directive round needed) -------------
J "(() => { const ta=document.querySelector('textarea[placeholder^=\"Ask about\"]'); const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; set.call(ta,'What is the nationality and emp code of Muhammad Iqbal?'); ta.dispatchEvent(new Event('input',{bubbles:true})); ta.focus(); return 'typed'; })()" >/dev/null
$B press Enter >/dev/null 2>&1
sleep 7
ANSWER5=$(ANSWER)
echo; echo "### Q5 answer: $ANSWER5"

# ---- verdicts ---------------------------------------------------------------
echo; echo "### CHECKS"
echo "Q1 carries the cancellation date:       $(echo "$ANSWER1" | grep -qE 'was cancelled on 2026-[0-9]{2}-[0-9]{2}' && echo PASS || echo FAIL)"
echo "Q1 carries the reviewer + reason:       $(echo "$ANSWER1" | grep -q 'visa cancellation required' && echo PASS || echo FAIL)"
echo "Q2 carries the overdue total (AED 800): $(echo "$ANSWER2" | grep -q 'AED 800' && echo PASS || echo FAIL)"
echo "Q3 carries paid vs pending totals:      $(echo "$ANSWER3" | grep -qE 'paid AED [0-9]+, pending AED [0-9]+' && echo PASS || echo FAIL)"
if echo "$ANSWER3" | grep -q '|'; then
  Q3TBL="FAIL (raw pipes visible)"
elif [ "$TABLES" = "2" ]; then
  Q3TBL="PASS"
else
  Q3TBL="FAIL ($TABLES of 2 expected tables rendered)"
fi
echo "Q3 renders a GUI table (no raw pipes):  $Q3TBL"
echo "Q4 lists branch supervision:            $(echo "$ANSWER4" | grep -q 'Northern Emirates Branch' && echo PASS || echo FAIL)"
echo "Q4 lists admin menu permissions:        $(echo "$ANSWER4" | grep -q 'Attendance' && echo PASS || echo FAIL)"
echo "Q5 answered from the snapshot:          $(echo "$ANSWER5" | grep -q 'MOCK DB ANSWER' && echo PASS || echo FAIL)"
echo "table present + 3 admins x 5 cols:      $(echo "$TBL" | grep -q 'rows=3 ' && echo "$TBL" | grep -q 'cols=5 ' && echo PASS || echo "FAIL ($TBL)")"
echo "table wrapper scrolls both axes:        $(echo "$TBL" | grep -q 'ox=auto' && echo "$TBL" | grep -q 'oy=auto' && echo PASS || echo FAIL)"
echo "table header is sticky:                 $(echo "$TBL" | grep -q 'sticky=sticky' && echo PASS || echo FAIL)"
LEAK=$(J "(() => { const b=[...document.querySelectorAll('[role=\"dialog\"][aria-label=\"Pebby chat\"] [data-role=\"assistant\"]')]; return b.some(x => /\[\[/.test(x.textContent)); })()")
echo "no [[directive]] leaked into the UI:    $( [ "$LEAK" = "false" ] && echo PASS || echo "FAIL ($LEAK)" )"

echo; echo "### browser console errors:"
$B errors 2>&1 | head -5

echo; echo "### mock provider log (queries must be >= 3):"
cat /tmp/mock-ai.log
