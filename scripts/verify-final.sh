#!/bin/bash
# PULSE — final verification pass + screenshots (one process group)
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
check () {
  RES=$(J "$2")
  if [ "$RES" = "true" ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1 → $RES"; FAIL=$((FAIL+1)); fi
}
clickbtn () { RES=$(J "$1"); echo "  click: $RES"; }

$B set viewport 1440 900 >/dev/null 2>&1
$B open http://localhost:3000 >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 1
if J "document.body.innerText.toLowerCase().includes('sign in')" | grep -q true; then
  $B find label "Email" fill "super@pulse.app" >/dev/null 2>&1
  $B find label "Password" fill "demo1234" >/dev/null 2>&1
  $B find text "Sign In" click >/dev/null 2>&1
  sleep 2; $B wait --load networkidle >/dev/null 2>&1
fi

# 1) deep link still works: employee details → notices → fines tab
clickbtn "(() => { const g=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Employees'); if(g){g.click(); return 'ok';} return 'none'; })()"
sleep 2
clickbtn "(() => { const row=[...document.querySelectorAll('tr')].find(r=>r.textContent.includes('Sandeep Singh')); if(!row) return 'no-row'; const btn=row.querySelector('button[title=\"View details\"]'); if(btn){btn.click(); return 'ok';} return 'no-btn'; })()"
sleep 2
clickbtn "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('View in Notifications')); if(b){b.click(); return 'ok';} return 'none'; })()"
sleep 2
check "deep link → Fines tab active" "(() => { const t=[...document.querySelectorAll('[role=tab]')].find(x=>x.getAttribute('data-state')==='active'); return !!t && t.textContent.includes('Fines'); })()"

# 2) sidebar navigation resets to Requests tab
clickbtn "(() => { const m=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Notifications') && b.closest('aside,nav')); if(m){m.click(); return 'ok';} return 'none'; })()"
sleep 2
check "sidebar click → Requests tab active" "(() => { const t=[...document.querySelectorAll('[role=tab]')].find(x=>x.getAttribute('data-state')==='active'); return !!t && t.textContent.includes('Requests'); })()"

# 3) screenshots for visual check ------------------------------------------------
mkdir -p /tmp/pulse-shots
# payroll with search + filters + expanded audit
clickbtn "(() => { const g=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Salary Details'); if(g){g.click(); return 'ok';} return 'none'; })()"
sleep 0.5
clickbtn "(() => { const m=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Payroll'); if(m){m.click(); return 'ok';} return 'none'; })()"
sleep 2.5
clickbtn "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Audit trail')); if(b){b.click(); return 'expanded';} return 'none'; })()"
sleep 1
$B screenshot /tmp/pulse-shots/payroll.png >/dev/null 2>&1
clickbtn "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Audit trail')); if(b){b.click(); return 'collapsed';} return 'none'; })()"
sleep 0.5

# salary sheet with a search active
clickbtn "(() => { const m=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Salary Sheet'); if(m){m.click(); return 'ok';} return 'none'; })()"
sleep 2.5
$B find first "input[aria-label='Search employees by name, ID or trade']" fill "Kumar" >/dev/null 2>&1
sleep 1
$B screenshot /tmp/pulse-shots/salary-sheet-search.png >/dev/null 2>&1
$B find first "input[aria-label='Search employees by name, ID or trade']" fill "" >/dev/null 2>&1
sleep 0.5

# employee details — personal info + notices card
clickbtn "(() => { const m=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Employees'); if(m){m.click(); return 'ok';} return 'none'; })()"
sleep 2
clickbtn "(() => { const row=[...document.querySelectorAll('tr')].find(r=>r.textContent.includes('Sandeep Singh')); if(!row) return 'no-row'; const btn=row.querySelector('button[title=\"View details\"]'); if(btn){btn.click(); return 'ok';} return 'no-btn'; })()"
sleep 2.5
$B screenshot /tmp/pulse-shots/employee-details.png >/dev/null 2>&1

# employee form — phone code + visa position + company
clickbtn "(() => { const m=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Employees'); if(m){m.click(); return 'ok';} return 'none'; })()"
sleep 2
clickbtn "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Add Employee')); if(b){b.click(); return 'ok';} return 'none'; })()"
sleep 2.5
$B screenshot /tmp/pulse-shots/employee-form.png >/dev/null 2>&1

echo ""
echo "======== RESULT: $PASS passed / $FAIL failed ========"
ls -la /tmp/pulse-shots/
kill $SERVER_PID 2>/dev/null
