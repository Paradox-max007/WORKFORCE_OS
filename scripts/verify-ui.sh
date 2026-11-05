#!/bin/bash
# ============================================================================
# PULSE — one-shot UI verification (server + browser in the same process group)
# ============================================================================
cd /home/z/my-project

(lsof -ti:3000 | xargs -r kill -9) 2>/dev/null
sleep 1
node .next/standalone/server.js > /tmp/pulse-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "== server up (code $code) =="

B="agent-browser"
J () { $B eval "$1" 2>/dev/null; }
PASS=0; FAIL=0
check () { # $1 description, $2 JS boolean expr
  RES=$(J "$2")
  if [ "$RES" = "true" ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 → $RES"; FAIL=$((FAIL+1)); fi
}
clickbtn () { # $1 = JS to find & click a button, returns status text
  RES=$(J "$1")
  echo "  click: $RES"
}

$B open http://localhost:3000 >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 1

# ---- login ------------------------------------------------------------------
if J "document.body.innerText.toLowerCase().includes('sign in')" | grep -q true; then
  $B find label "Email" fill "super@pulse.app" >/dev/null 2>&1
  $B find label "Password" fill "demo1234" >/dev/null 2>&1
  $B find text "Sign In" click >/dev/null 2>&1
  sleep 2; $B wait --load networkidle >/dev/null 2>&1
fi
check "logged in (dashboard visible)" "document.body.innerText.includes('Dashboard')"

# ============================================================================
echo "-------- 1. SALARY SHEET --------"
clickbtn "(() => { const g=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Salary Details'); if(g){g.click(); return 'group-open';} return 'no-group'; })()"
sleep 0.5
clickbtn "(() => { const m=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Salary Sheet'); if(m){m.click(); return 'ok';} return 'none'; })()"
sleep 2.5
BODY_HAS=$(J "document.body.innerText.includes('No payroll for')")
if [ "$BODY_HAS" = "true" ]; then
  clickbtn "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Generate Payroll')); if(b){b.click(); return 'generated';} return 'none'; })()"
  sleep 3
fi
check "salary sheet loaded" "document.body.innerText.includes('Salary Sheet')"
check "search input present" "!!document.querySelector('input[aria-label=\"Search employees by name, ID or trade\"]')"
check "'always last' chip removed" "!document.body.innerText.includes('always last')"
check "idle employees section exists (after group headers)" "document.body.innerText.includes('Idle Employees')"

# search → row counter + fewer rows
clickbtn "(() => { const i=document.querySelector('input[aria-label=\"Search employees by name, ID or trade\"]'); i.focus(); return 'ok'; })()"
$B find first "input[aria-label='Search employees by name, ID or trade']" fill "Rajesh" >/dev/null 2>&1
sleep 1
check "search narrows rows (counter n/total)" "/\\s\\d+\\/\\d+\\s/.test(document.body.innerText) || /\\d+\\/\\d+/.test(document.body.innerText)"
check "Rajesh still visible" "document.body.innerText.includes('Rajesh Kumar')"
check "other site rows hidden (Muhammad Iqbal gone)" "!document.body.innerText.includes('Muhammad Iqbal')"
$B find first "input[aria-label='Search employees by name, ID or trade']" fill "" >/dev/null 2>&1
sleep 0.5

# ============================================================================
echo "-------- 2. PAYROLL --------"
clickbtn "(() => { const m=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Payroll'); if(m){m.click(); return 'ok';} return 'none'; })()"
sleep 2.5
if J "document.body.innerText.includes('No payroll for')" | grep -q true; then
  clickbtn "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Generate Payroll')); if(b){b.click(); return 'generated';} return 'none'; })()"
  sleep 3
fi
check "payroll loaded (Mark paid column)" "document.body.innerText.includes('Mark paid')"
check "search input present" "!!document.querySelector('input[aria-label=\"Search employees by name, ID or trade\"]')"
check "trade filter select present" "!!document.querySelector('button[aria-label=\"Filter by trade\"]')"
check "nationality filter select present" "!!document.querySelector('button[aria-label=\"Filter by nationality\"]')"
check "Paid salary card present" "document.body.innerText.toUpperCase().includes('PAID SALARY')"
check "Balance to pay card present" "document.body.innerText.toUpperCase().includes('BALANCE TO PAY')"
check "audit collapsed (no audit lines visible)" "!document.body.innerText.includes('marked paid') && !document.body.innerText.includes('finalized — calculation locked')"

# mark one employee paid (creates an audit entry with name + code)
clickbtn "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Mark paid') && !x.disabled); if(b){b.click(); return 'ok';} return 'none'; })()"
sleep 1
clickbtn "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Confirm & Mark Paid')); if(b){b.click(); return 'confirmed';} return 'none'; })()"
sleep 2.5
check "audit toggle button with count (after first audit entry)" "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Audit trail')); return !!b && /\\d+/.test(b.textContent); })()"

# expand audit trail and verify employee name+code, no UUIDs
clickbtn "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Audit trail')); if(b){b.click(); return 'expanded';} return 'none'; })()"
sleep 1.5
check "audit expanded shows 'marked paid' entry" "document.body.innerText.includes('marked paid')"
check "audit uses employee code (PUL-)" "document.body.innerText.includes('(PUL-')"
check "audit has no raw database UUIDs" "!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/.test(document.body.innerText)"

# hours tooltip — click an hours value opens the calculation dialog
clickbtn "(() => { const b=[...document.querySelectorAll('button')].find(x=>/^\\d+(\\.\\d+)? h$/.test(x.textContent.trim())); if(b){b.click(); return 'ok';} return 'none'; })()"
sleep 1.2
check "calculation dialog wording '1000 h / 6 months'" "document.body.innerText.toLowerCase().includes('below 1000 h / 6 months')"
check "dialog has site distribution 'Below 1000h/6mo'" "document.body.innerText.includes('Below 1000h/6mo')"
$B press Escape >/dev/null 2>&1; sleep 0.5

# trade filter — pick a trade, expect fewer rows + counter
clickbtn "document.querySelector('button[aria-label=\"Filter by trade\"]').click()"
sleep 0.8
clickbtn "(() => { const o=[...document.querySelectorAll('[role=option]')].find(x=>x.textContent.trim().startsWith('Electrician')); if(o){o.click(); return o.textContent.trim();} return 'none'; })()"
sleep 1
check "trade filter applied (counter visible)" "/\\d+\\/\\d+/.test(document.body.innerText)"
clickbtn "(() => { const c=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('Clear')); if(c){c.click(); return 'cleared';} return 'none'; })()"
sleep 0.5

# ============================================================================
echo "-------- 3. EMPLOYEE DETAILS (notices & fines) --------"
clickbtn "(() => { const m=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Employees'); if(m){m.click(); return 'ok';} return 'none'; })()"
sleep 2.5
clickbtn "(() => { const row=[...document.querySelectorAll('tr')].find(r=>r.textContent.includes('Sandeep Singh')); if(!row) return 'no-row'; const btn=row.querySelector('button[title=\"View details\"]'); if(btn){btn.click(); return 'ok';} return 'no-btn'; })()"
sleep 2.5
check "employee details page open" "document.body.innerText.includes('Professional Information')"
check "Personal Information card present" "document.body.innerText.includes('Personal Information')"
check "Notices & Fines card present" "document.body.innerText.includes('Notices & Fines')"
check "Sandeep's fine shown (SAR amount)" "/SAR|AED/.test(document.body.innerText) && document.body.innerText.includes('Damage to company equipment')"

# hyperlink → notifications fines tab
clickbtn "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('View in Notifications')); if(b){b.click(); return 'ok';} return 'none'; })()"
sleep 2.5
check "notifications hub opened" "document.body.innerText.includes('Notifications Hub')"
check "deep-linked to Fines tab active" "(() => { const t=[...document.querySelectorAll('[role=tab]')].find(x=>x.getAttribute('data-state')==='active'); return !!t && t.textContent.includes('Fines'); })()"

# ============================================================================
echo "-------- 4. EMPLOYEE FORM (phone code / visa position / company) --------"
clickbtn "(() => { const m=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Employees'); if(m){m.click(); return 'ok';} return 'none'; })()"
sleep 2
clickbtn "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Add Employee')); if(b){b.click(); return 'ok';} return 'none'; })()"
sleep 2.5
check "form page open" "document.body.innerText.includes('Add New Employee')"
check "phone country code select present" "!!document.querySelector('button[aria-label=\"Phone country code\"]')"
check "'Position as per Visa' label" "document.body.innerText.includes('Position as per Visa')"
check "company dropdown present" "!!document.querySelector('button[aria-label=\"Company name\"]')"
clickbtn "document.querySelector('button[aria-label=\"Company name\"]').click()"
sleep 1
check "company options + Add New Company" "document.body.innerText.includes('Add New Company') && document.body.innerText.includes('Arabian Shield Manpower')"
$B press Escape >/dev/null 2>&1
# phone country select shows dial codes
clickbtn "document.querySelector('button[aria-label=\"Phone country code\"]').click()"
sleep 1
check "phone country list has +971 / +966 / +91" "document.body.innerText.includes('+971') && document.body.innerText.includes('+966') && document.body.innerText.includes('+91')"
$B press Escape >/dev/null 2>&1

# ============================================================================
echo "-------- 5. NOTIFICATIONS default tab reset --------"
clickbtn "(() => { const m=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Notifications') && b.closest('aside,nav')); if(m){m.click(); return 'ok';} return 'none'; })()"
sleep 2
check "notifications hub opens (default requests tab)" "(() => { const t=[...document.querySelectorAll('[role=tab]')].find(x=>x.getAttribute('data-state')==='active'); return document.body.innerText.includes('Notifications Hub') && !!t && t.textContent.includes('Requests'); })()"

echo ""
echo "======== RESULT: $PASS passed / $FAIL failed ========"
kill $SERVER_PID 2>/dev/null
