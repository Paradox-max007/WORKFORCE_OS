#!/usr/bin/env bash
# End-to-end demo-mode verification of the Trade & Salary system:
# trades page → salary sheet (generate, totals, breakdown, finalize, pay) →
# employee details eligibility block → employee form trade dropdown.
set -u
cd /home/z/my-project
mkdir -p /tmp/render

PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production bun .next/standalone/server.js > server-demo.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 0.5
done
echo "== server: HTTP $code =="

agent-browser set viewport 1440 900 >/dev/null 2>&1
agent-browser open http://localhost:3000/ --timeout 30000
sleep 5
agent-browser find first "#email" fill "super@pulse.app"
agent-browser find first "#password" fill "demo1234"
sleep 0.5
agent-browser eval "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sign In')?.click()" >/dev/null
sleep 5
echo "== shell loaded: $(agent-browser eval "Boolean(document.querySelector('nav'))") =="

go_menu () {
  agent-browser eval "[...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === '$1')?.click()" >/dev/null
  sleep 3.5
}

# ---- 1. Trade Management ------------------------------------------------------
go_menu "Trade Management"
echo "== TRADE PAGE heading: $(agent-browser eval "(document.querySelector('h1,h2,h3')||{}).textContent")"
echo "== trade cards: $(agent-browser eval "document.querySelectorAll('section .text-base.font-semibold').length")"
echo "== first trade card text:"
agent-browser eval "document.querySelector('section')?.innerText.slice(0, 260)"

# ---- 2. Salary Sheet: generate --------------------------------------------------
go_menu "Salary Sheet"
echo "== SALARY SHEET empty state: $(agent-browser eval "document.body.innerText.includes('Generate Payroll')")"
agent-browser eval "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Generate Payroll'))?.click()" >/dev/null
sleep 6
echo "== summary cards text:"
agent-browser eval "[...document.querySelectorAll('.card-glow')].slice(0,4).map(c => c.innerText.replace(/\\n/g,' | ')).join(' ;; ')"
echo "== site groups:"
agent-browser eval "[...document.querySelectorAll('section button')].filter(b => b.textContent.includes('Employees:')).map(b => b.textContent.trim()).join(' ;; ')"
echo "== settlement rows: $(agent-browser eval "document.body.innerText.includes('Employee Settlement') ? [...document.querySelectorAll('table')].pop().querySelectorAll('tbody tr').length : 'NO SETTLEMENT TABLE'")"
echo "== invariants (sum of site gross = total gross?):"
agent-browser eval "(function(){ const t=[...document.querySelectorAll('.card-glow')].map(c=>c.innerText).join(' '); return t.slice(0,400); })()"

# ---- 3. Rate breakdown dialog ----------------------------------------------------
echo "== open first site row (rate breakdown):"
agent-browser eval "document.querySelector('section table tbody tr')?.click()" >/dev/null
sleep 1.5
echo "dialog text: $(agent-browser eval "[...document.querySelectorAll('[role=dialog]')].map(d => d.innerText.slice(0,300).replace(/\\n/g,' | ')).join(' ;; ') || 'NO DIALOG'")"
agent-browser eval "document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))" >/dev/null
sleep 1

# ---- 4. Finalize → Mark Paid ------------------------------------------------------
agent-browser eval "[...document.querySelectorAll('button')].find(b => b.textContent.trim().includes('Finalize'))?.click()" >/dev/null
sleep 1.5
agent-browser eval "[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.includes('Finalize Payroll'))?.click()" >/dev/null
sleep 3
echo "== status after finalize: $(agent-browser eval "document.body.innerText.includes('Finalized') ? 'FINALIZED' : 'still draft'")"
echo "== pay button enabled: $(agent-browser eval "[...document.querySelectorAll('button[title*=Finalize], button[title*=paid], button[title*=paid i]').length > 0 ? 'found' : 'none'")"
# click the first enabled "mark paid" action (BadgeCheck in settlement table)
agent-browser eval "(function(){ const rows=[...document.querySelectorAll('table')].pop().querySelectorAll('tbody tr'); for (const r of rows){ const btn=[...r.querySelectorAll('button')].find(b=>!b.disabled && b.querySelector('svg')); if (btn && btn.title.includes('paid')) { btn.click(); return 'clicked: '+btn.title; } } return 'no enabled pay button'; })()"
sleep 1.5
agent-browser eval "[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.includes('Confirm'))?.click()" >/dev/null
sleep 3
echo "== payment statuses: $(agent-browser eval "(document.body.innerText.match(/Paid/g)||[]).length + ' Paid badges'")"
echo "== audit trail: $(agent-browser eval "document.body.innerText.includes('Audit trail') ? document.body.innerText.slice(document.body.innerText.indexOf('Audit trail'), document.body.innerText.indexOf('Audit trail')+260).replace(/\\n/g,' | ') : 'none'")"

# ---- 5. Employee details: eligibility block ---------------------------------------
go_menu "Employees"
agent-browser eval "[...document.querySelectorAll(\"[title='View details']\")][0]?.click()" >/dev/null
sleep 5
echo "== employee: $(agent-browser eval "document.querySelector('h1')?.textContent")"
echo "== professional card:"
agent-browser eval "([...document.querySelectorAll('section')].find(s => s.textContent.includes('Professional Information'))?.innerText || 'NOT FOUND').replace(/\\n/g,' | ').slice(0, 700)"

# ---- 6. Employee form: trade dropdown ----------------------------------------------
agent-browser eval "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit')?.click()" >/dev/null
sleep 4
echo "== form trade dropdown present: $(agent-browser eval "Boolean([...document.querySelectorAll('[aria-label=Trade]')].length)")"
echo "== form salary role present: $(agent-browser eval "Boolean([...document.querySelectorAll('[aria-label=\"Salary role\"]')].length)")"
echo "== add-new-trade option: $(agent-browser eval "(function(){ const sel=[...document.querySelectorAll('[aria-label=Trade]')]; return sel.length; })()")"

echo "== page errors =="
agent-browser errors
agent-browser screenshot /tmp/render/salary-verification.png --full
echo "== screenshot saved =="

kill $SERVER_PID 2>/dev/null
echo "== done =="
