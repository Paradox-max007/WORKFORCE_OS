#!/bin/bash
# ============================================================================
# PULSE — E2E: Letters & Notices in the Notifications Hub
#   • Letters tab lists every formal document (warnings/fines/terminations)
#   • "New Letter / Notice" creates a WARNING LETTER → record created,
#     doc card shows ref + "Created by: <user>"
#   • card buttons open the WhatsApp send dialog with prefilled number+text
#   • creating a TERMINATION LETTER (custom body) lands in the list
#   • existing Warnings tab cards now carry the Letter PDF / WhatsApp buttons
# NOTE: Radix Tabs activates on MOUSEDOWN (not click) — synthetic tab clicks
# must dispatch mousedown.
# Real app (demo mode) through the standalone production server.
# ============================================================================
cd /home/z/my-project

# unique port per run → fresh browser origin → no stale HTTP cache
E2E_PORT=$((3100 + RANDOM % 80))
(lsof -ti:$E2E_PORT | xargs -r kill -9) 2>/dev/null
pkill -9 -f "standalone/server.js" 2>/dev/null
sleep 1
PORT=$E2E_PORT node .next/standalone/server.js > /tmp/pulse-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null' EXIT
code=000
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$E2E_PORT)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "== server up ($code) =="

B=agent-browser
J () { $B eval "$1" 2>/dev/null; }
CLICKTEXT () { J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='$1'); if(b){b.click();return 'ok';} return 'not-found'; })()"; }
TABCLICK () { J "(() => { const t=[...document.querySelectorAll('[role=\"tab\"]')].find(x=>x.textContent.includes('$1')); if(!t) return 'not-found'; t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})); return 'ok'; })()"; }
SETTEXT () { J "(() => { const el=document.getElementById('$1'); if(!el) return 'missing'; const proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype; const set=Object.getOwnPropertyDescriptor(proto,'value').set; set.call(el,'$2'); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 'set'; })()"; }

$B open "http://localhost:$E2E_PORT/?e2ebust=$RANDOM" >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 1
J "(() => { localStorage.clear(); return 'cleared'; })()" >/dev/null
$B open "http://localhost:$E2E_PORT/?e2ebust=$RANDOM$RANDOM" >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 2

# ---- login (demo super admin) ----------------------------------------------
if J "document.body.innerText.toLowerCase().includes('sign in')" | grep -q true; then
  $B find label "Email" fill "super@pulse.app" >/dev/null 2>&1
  $B find label "Password" fill "demo1234" >/dev/null 2>&1
  CLICKTEXT "Sign In" >/dev/null
  sleep 3; $B wait --load networkidle >/dev/null 2>&1
fi
echo "login: $(J "document.body.innerText.includes('Dashboard')")"

# ---- Notifications hub → Letters tab ----------------------------------------
# (the sidebar button carries the unread badge inside → match by includes)
echo "open hub: $(J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Notifications')); if(b){b.click();return 'ok';} return 'not-found'; })()")"
sleep 2.5
echo "hub: $(J "document.body.innerText.includes('Notifications Hub')")"
echo "letters tab: $(TABCLICK "Letters")"
sleep 1.5
echo "letters section: $(J "document.body.innerText.includes('Letters & Notices')")"

# ---- create a WARNING LETTER through the unified dialog ----------------------
echo "open creator: $(CLICKTEXT "New Letter / Notice")"
sleep 1.2
echo "pick type: $(CLICKTEXT "Warning Letter")"
# open the employee combobox and pick Rajesh Kumar
J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Search employees')); if(b){b.click();return 'combo-open';} return 'no-trigger'; })()"
sleep 0.8
echo "type query: $(J "(() => { const i=document.querySelector('input[placeholder=\"Type to search…\"]'); if(!i) return 'no-input'; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,'Rajesh'); i.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'; })()")"
sleep 0.8
echo "pick employee: $(J "(() => { const it=[...document.querySelectorAll('[role=\"option\"]')]; if(it.length){ it[0].click(); return 'picked'; } return 'no-options'; })()")"
sleep 0.8
echo "employee preview: $(J "(() => { const dlg=[...document.querySelectorAll('[role=\"dialog\"]')].pop(); const txt=dlg?dlg.innerText:document.body.innerText; return txt.includes('Electrician') && (txt.includes('Marina Tower')||txt.includes('No site')) ? 'shown' : 'hidden:'+txt.slice(0,140); })()")"
echo "reason: $(SETTEXT notice-reason 'Repeated late arrivals to the morning shift.')"
sleep 0.3
echo "create warning letter: $(CLICKTEXT "Create Warning Letter")"
sleep 2.5

# the doc card must appear in the Letters list with ref + created-by user
DOCS=$(J "(() => { const txt=document.body.innerText; return JSON.stringify({ warnRef: /WARN-[A-Z0-9]{8}/.test(txt), createdBy: txt.includes('Created by: Amira Sultan'), hasReason: txt.includes('Repeated late arrivals') }); })()" | sed 's/^"//; s/"$//; s/\\"/"/g')
echo "warning letter doc card: $DOCS"

# ---- WhatsApp dialog from the doc card ---------------------------------------
echo "open whatsapp: $(J "(() => { const cards=[...document.querySelectorAll('.card-glow')].filter(c=>/WARN-[A-Z0-9]{8}/.test(c.textContent)); if(!cards.length) return 'no-card'; const b=[...cards[0].querySelectorAll('button')].find(x=>x.textContent.includes('WhatsApp')); if(b){b.click();return 'ok';} return 'no-btn'; })()")"
sleep 1.2
WA=$(J "(() => { const ph=document.getElementById('wa-phone'); const tx=document.getElementById('wa-text'); if(!ph||!tx) return 'missing-dialog'; return JSON.stringify({ phone: ph.value, ref: /WARN-[A-Z0-9]{8}/.test(tx.value), name: tx.value.includes('Rajesh Kumar'), creator: tx.value.includes('Created by:'), len: tx.value.length }); })()" | sed 's/^"//; s/"$//; s/\\"/"/g')
echo "whatsapp dialog: $WA"
# close it again
J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Cancel'); if(b){b.click();return 'closed';} return 'stuck'; })()" >/dev/null
sleep 0.8

# ---- create a TERMINATION LETTER (custom body) --------------------------------
echo "open creator 2: $(CLICKTEXT "New Letter / Notice")"
sleep 1.2
echo "pick type: $(CLICKTEXT "Termination Letter")"
J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Search employees')); if(b){b.click();return 'combo-open';} return 'no-trigger'; })()"
sleep 0.8
J "(() => { const i=document.querySelector('input[placeholder=\"Type to search…\"]'); if(!i) return 'no-input'; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,'Arun'); i.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'; })()" >/dev/null
sleep 0.8
echo "pick employee 2: $(J "(() => { const it=[...document.querySelectorAll('[role=\"option\"]')]; if(it.length){ it[0].click(); return 'picked'; } return 'no-options'; })()")"
sleep 0.8
echo "effective date: $(SETTEXT notice-effective '2026-12-01')"
echo "reason 2: $(SETTEXT notice-reason 'Breach of safety protocols on site.')"
echo "custom body: $(SETTEXT notice-custom 'Custom termination text paragraph one.')"
sleep 0.3
echo "create termination: $(CLICKTEXT "Create Termination Letter")"
sleep 2.5

TERM=$(J "(() => { const txt=document.body.innerText; return JSON.stringify({ termRef: /TERM-[A-Z0-9]{8}/.test(txt), effective: txt.includes('Effective 1 Dec 2026'), name: txt.includes('Arun Nair') }); })()" | sed 's/^"//; s/"$//; s/\\"/"/g')
echo "termination letter doc card: $TERM"

# ---- Warnings tab still works + has letter buttons ----------------------------
echo "warnings tab: $(TABCLICK "Warnings")"
sleep 1.5
WARN_TAB=$(J "(() => { const cards=[...document.querySelectorAll('div.card-glow')].filter(c=>c.textContent.includes('Repeated late arrivals')); if(!cards.length) return 'no-warning-card'; const btns=cards[0].textContent; return JSON.stringify({ letter: btns.includes('Letter PDF'), wa: btns.includes('WhatsApp'), createdBy: btns.includes('Created by: Amira Sultan') }); })()" | sed 's/^"//; s/"$//; s/\\"/"/g')
echo "warnings tab card actions: $WARN_TAB"

# ---- verdict ------------------------------------------------------------------
fail=0
echo "$DOCS" | grep -q '"warnRef":true' && echo "$DOCS" | grep -q '"createdBy":true' && echo "$DOCS" | grep -q '"hasReason":true' || fail=1
echo "$WA" | grep -q '"ref":true' && echo "$WA" | grep -q '"name":true' && echo "$WA" | grep -q '"creator":true' && echo "$WA" | grep -qE '"phone":"[0-9]{8,}"' || fail=1
echo "$TERM" | grep -q '"termRef":true' && echo "$TERM" | grep -q '"effective":true' && echo "$TERM" | grep -q '"name":true' || fail=1
echo "$WARN_TAB" | grep -q '"letter":true' && echo "$WARN_TAB" | grep -q '"wa":true' || fail=1

mkdir -p /tmp/render
$B screenshot /tmp/render/e2e-notice-letters.png >/dev/null 2>&1

if [ "$fail" = "0" ]; then
  echo "E2E NOTICE LETTERS ALL PASS"
  exit 0
else
  echo "E2E NOTICE LETTERS FAILED — screenshot: /tmp/render/e2e-notice-letters.png"
  exit 1
fi
