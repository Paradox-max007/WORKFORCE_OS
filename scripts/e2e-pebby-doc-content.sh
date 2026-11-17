#!/bin/bash
# ============================================================================
# PULSE — E2E: Pebby reads INSIDE uploaded site documents
#   1. upload a real .xlsx timesheet + a PDF time card for Marina Heights Tower
#   2. ask Pebby to read the timesheet  -> mock replies [[LOOKUP]] doc-content
#      -> the widget extracts the XLSX text (SheetJS) and re-asks
#      -> the answer quotes the workers FROM THE FILE
#   3. ask Pebby to read the time card  -> same loop with the PDF (pdf.js)
#   4. Pebby now shows the cute pebble avatar (launcher + header)
# Real app, demo mode, one Bash call.
# ============================================================================
cd /home/z/my-project

# ---- fixtures ---------------------------------------------------------------
B64=$(bun scripts/make-dark-fixture.mjs)
[ -n "$B64" ] || { echo "FAIL: xlsx fixture not built"; exit 1; }
python3 -c "
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
c = canvas.Canvas('/tmp/time-card.pdf', pagesize=A4)
c.drawString(72, 790, 'MARINA TOWER - TIME CARD NOVEMBER 2026')
c.drawString(72, 770, 'EMPLOYEE: ARUN KUMAR (PUL-2026-001)')
c.drawString(72, 750, 'TOTAL HOURS: 208.5')
c.drawString(72, 730, 'REMARKS: overtime approved by site supervisor')
c.save()
print('pdf fixture ok')
" || { echo "FAIL: pdf fixture not built"; exit 1; }
PDF_B64=$(base64 -w0 /tmp/time-card.pdf)

# ---- servers (same call!) ---------------------------------------------------
(lsof -ti:3000 | xargs -r kill -9) 2>/dev/null
pkill -9 -f "standalone/server.js" 2>/dev/null
pkill -9 -f "mock-ai-doc-content" 2>/dev/null
sleep 1
node scripts/mock-ai-doc-content.mjs > /tmp/mock-doc.log 2>&1 &
MOCK_PID=$!
node .next/standalone/server.js > /tmp/pulse-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $MOCK_PID $SERVER_PID 2>/dev/null; pkill -9 -f "standalone/server.js"; pkill -9 -f "mock-ai-doc-content" 2>/dev/null' EXIT
code=000
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "== server up ($code) =="

B=agent-browser
J () { $B eval "$1" 2>/dev/null; }
CLICKTEXT () { J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='$1'); if(b){b.click();return 'ok';} return 'not-found'; })()"; }

$B open http://localhost:3000 >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 1
J "(() => { localStorage.clear(); return 'cleared'; })()" >/dev/null
$B open http://localhost:3000 >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 2

# ---- login + AI connection --------------------------------------------------
if J "document.body.innerText.toLowerCase().includes('sign in')" | grep -q true; then
  $B find label "Email" fill "super@pulse.app" >/dev/null 2>&1
  $B find label "Password" fill "demo1234" >/dev/null 2>&1
  CLICKTEXT "Sign In" >/dev/null
  sleep 3; $B wait --load networkidle >/dev/null 2>&1
fi
echo "login: $(J "document.body.innerText.includes('Dashboard')")"

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

# ---- upload both documents --------------------------------------------------
CLICKTEXT "Sites" >/dev/null; sleep 2.5
J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Dubai Central Branch')); if(b){b.click();return 'ok';} return 'not-found'; })()" >/dev/null
sleep 1.5
J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Timesheet / Time Cards') && (x.getAttribute('aria-label')||'').includes('Marina')); if(b){b.click();return 'ok';} return 'not-found'; })()" >/dev/null
sleep 3
echo "timesheets page: $(J "document.body.innerText.includes('Site Timesheets / Time Cards')")"

echo "upload xlsx: $(J "(() => {
  const b64 = '$B64';
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const f = new File([u8], 'marina-nov-2026.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const dt = new DataTransfer(); dt.items.add(f);
  const input = document.querySelector('input[accept=\".pdf,.xlsx,.xls,.csv\"]');
  if (!input) return 'input-not-found';
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'uploaded';
})()")"
sleep 3
echo "upload pdf: $(J "(() => {
  const b64 = '$PDF_B64';
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const f = new File([u8], 'time-card-nov-2026.pdf', { type: 'application/pdf' });
  const dt = new DataTransfer(); dt.items.add(f);
  const input = document.querySelector('input[accept=\".pdf\"]');
  if (!input) return 'input-not-found';
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'uploaded';
})()")"
sleep 3
echo "slots filled: $(J "(() => { const t = document.body.innerText; return JSON.stringify({ xlsx: t.includes('Open & Edit'), pdf: t.includes('Preview') }); })()")"

# ---- Q1: read the uploaded timesheet ----------------------------------------
J "(() => { document.querySelector('button[aria-label=\"Open Pebby — Smart Assistant\"]')?.click(); return 'open'; })()" >/dev/null
sleep 2
J "(() => { const ta=document.querySelector('textarea[placeholder^=\"Ask about\"]'); if(!ta) return 'no-ta'; const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; set.call(ta,'Please read the uploaded timesheet'); ta.dispatchEvent(new Event('input',{bubbles:true})); ta.focus(); return 'typed'; })()" >/dev/null
$B press Enter >/dev/null 2>&1
sleep 9
A1=$(J "(() => { const b=[...document.querySelectorAll('[role=\"dialog\"][aria-label=\"Pebby chat\"] [data-role=\"assistant\"]')]; return b[b.length-1]?.innerText ?? '(none)'; })()")
echo "### Q1: $A1"
q1_ok=$(echo "$A1" | grep -c "Ravi Kumar")
$B screenshot /tmp/render/pebby-doc-content-xlsx.png >/dev/null 2>&1

# ---- Q2: read the time card PDF ---------------------------------------------
J "(() => { const ta=document.querySelector('textarea[placeholder^=\"Ask about\"]'); const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; set.call(ta,'Please read the time card'); ta.dispatchEvent(new Event('input',{bubbles:true})); ta.focus(); return 'typed'; })()" >/dev/null
$B press Enter >/dev/null 2>&1
sleep 9
A2=$(J "(() => { const b=[...document.querySelectorAll('[role=\"dialog\"][aria-label=\"Pebby chat\"] [data-role=\"assistant\"]')]; return b[b.length-1]?.innerText ?? '(none)'; })()")
echo "### Q2: $A2"
q2_ok=$(echo "$A2" | grep -c "208.5")
$B screenshot /tmp/render/pebby-doc-content-pdf.png >/dev/null 2>&1

# ---- Pebby avatar (header while the panel is open, launcher after closing) --
AV=$(J "(() => { const header = document.querySelector('[aria-label=\"Pebby chat\"] svg[role=\"img\"]'); return JSON.stringify({ headerOk: !!header, label: header?.getAttribute('aria-label') }); })()")
J "(() => { document.querySelector('button[aria-label=\"Collapse the chat panel\"]')?.click(); return 'closed'; })()" >/dev/null
sleep 1
AV2=$(J "(() => { const launcher = document.querySelector('button[aria-label=\"Open Pebby — Smart Assistant\"] svg[role=\"img\"]'); return launcher ? 'launcher:true' : 'launcher:false'; })()")
echo "avatar: $AV $AV2"
av_ok=0
echo "$AV" | grep -q 'headerOk.*true' && echo "$AV" | grep -q 'cute pebble' && echo "$AV2" | grep -q 'launcher:true' && av_ok=1

# ---- mock provider saw the protocol in the system prompt? --------------------
proto=$(grep -c "protocol=true" /tmp/mock-doc.log)
echo "mock log protocol lines: $proto (of $(grep -c '\[mock\]' /tmp/mock-doc.log) calls)"

echo
if [ "$q1_ok" -ge 1 ] && [ "$q2_ok" -ge 1 ] && [ "$av_ok" -ge 1 ] && [ "$proto" -ge 1 ]; then
  echo "PEBBY DOC-CONTENT + AVATAR E2E ALL PASS"
  exit 0
else
  echo "E2E FAILED (xlsx=$q1_ok pdf=$q2_ok avatar=$av_ok protocol=$proto)"
  exit 1
fi
