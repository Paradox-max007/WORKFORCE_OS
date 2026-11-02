#!/usr/bin/env bash
# Focused verification: duplicate-row fix + full payment workflow.
set -u
cd /home/z/my-project
PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production bun .next/standalone/server.js > server-demo.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 0.5
done
echo "== server: HTTP $code =="

agent-browser open http://localhost:3000/ --timeout 30000
sleep 5
agent-browser find first "#email" fill "super@pulse.app"
agent-browser find first "#password" fill "demo1234"
sleep 0.5
agent-browser eval "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sign In')?.click()" >/dev/null
sleep 5

# salary sheet → month already generated + finalized in the previous session
# (demo DB persists in localStorage)
agent-browser eval "[...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === 'Salary Sheet')?.click()" >/dev/null
sleep 4
echo "== period status: $(agent-browser eval "document.body.innerText.includes('Finalized') ? 'FINALIZED' : (document.body.innerText.includes('Draft') ? 'DRAFT' : 'none')")"

# open the payment dialog on the first unpaid employee (pencil icon disabled when paid)
echo "== pay click: $(agent-browser eval "(function(){
  const tables=[...document.querySelectorAll('table')];
  const settle=tables[tables.length-1];
  for (const r of settle.querySelectorAll('tbody tr')) {
    const btns=[...r.querySelectorAll('button')];
    const payBtn=btns.find(b => (b.title||'').startsWith('Mark salary paid'));
    if (payBtn && !payBtn.disabled) { payBtn.click(); return 'clicked for ' + r.textContent.trim().slice(0,30); }
  }
  return 'no enabled pay button found';
})()")"
sleep 1.5
echo "== payment dialog: $(agent-browser eval "[...document.querySelectorAll('[role=dialog]')].map(d=>d.innerText.slice(0,200).replace(/\\n/g,' | ')).join(' ;; ') || 'NO DIALOG'")"
# enter an advance of 100 and confirm
agent-browser eval "(function(){ const dlg=[...document.querySelectorAll('[role=dialog]')][0]; if(!dlg) return 'no dialog'; const inputs=dlg.querySelectorAll('input[type=number]'); if(inputs[0]) { inputs[0].value=''; inputs[0].dispatchEvent(new Event('input',{bubbles:true})); } return 'inputs: '+inputs.length; })()"
agent-browser find first "[role=dialog] input[type=number]" fill "100"
sleep 0.5
agent-browser eval "[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.includes('Confirm'))?.click()" >/dev/null
sleep 3
echo "== paid badges after payment: $(agent-browser eval "(document.body.innerText.match(/\\bPaid\\b/g)||[]).length")"
echo "== net card: $(agent-browser eval "[...document.querySelectorAll('.card-glow')].slice(0,4).map(c=>c.innerText.replace(/\\n+/g,' ')).join(' ;; ')")"
echo "== audit: $(agent-browser eval "document.body.innerText.slice(document.body.innerText.indexOf('Audit trail')).replace(/\\n/g,' | ').slice(0,300)")"

# reopen flow (super admin)
agent-browser eval "[...document.querySelectorAll('button')].find(b => b.textContent.trim().includes('Reopen'))?.click()" >/dev/null
sleep 1.5
agent-browser find first "[role=dialog] input" fill "Verification: attendance correction needed"
sleep 0.5
agent-browser eval "[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.includes('Reopen with Reason'))?.click()" >/dev/null
sleep 3
echo "== status after reopen: $(agent-browser eval "document.body.innerText.includes('Finalized') ? 'still finalized' : 'back to DRAFT'")"

# employee details — confirm the duplicate Trade/Role rows are gone
agent-browser eval "[...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === 'Employees')?.click()" >/dev/null
sleep 3
agent-browser eval "[...document.querySelectorAll(\"[title='View details']\")][0]?.click()" >/dev/null
sleep 5
echo "== professional card rows: $(agent-browser eval "([...document.querySelectorAll('section')].find(s => s.textContent.includes('Professional Information'))?.innerText.match(/TRADE|SALARY ROLE/g)||[]).length + ' occurrences of TRADE/SALARY ROLE (expect 2)'")"
echo "== role label: $(agent-browser eval "([...document.querySelectorAll('section')].find(s => s.textContent.includes('Professional Information'))?.innerText.match(/SALARY ROLE\\n[^\\n]+/)||[''])[0]")"
echo "== page errors =="
agent-browser errors
kill $SERVER_PID 2>/dev/null
echo "== done =="
