#!/bin/bash
# ============================================================================
# PULSE — E2E smoke: BRANCH SELECTORS + letterhead/trade letter tweaks
#   1. Advance Book: Branch dropdown scopes ledger + cards (demo vectors:
#      Dubai Central → 2 due records SAR 2140; Northern Emirates → 1 overdue
#      SAR 800; All branches → 3 records)
#   2. Trade/Ded Management: Branch dropdown scopes the trade grid to the
#      branch's trades, cards show "<N> employees · <branch>" chips
#   3. Notifications → Letters: New Letter/Notice dialog previews the TRADE
#      (not the position)
# Real app (demo mode) served from the standalone production build.
# ============================================================================
cd /home/z/my-project

FAILS=0
ok () { echo "PASS  $1"; }
bad () { echo "FAIL  $1"; FAILS=$((FAILS+1)); }

(lsof -ti:3000 | xargs -r kill -9) 2>/dev/null
pkill -9 -f "standalone/server.js" 2>/dev/null
sleep 1
node .next/standalone/server.js > /tmp/pulse-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; pkill -9 -f "standalone/server.js" 2>/dev/null' EXIT
code=000
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "== server up ($code) =="

B=agent-browser
J () { $B eval "$1" 2>/dev/null; }
JS () { $B eval "$1" 2>/dev/null | tr -d '"'; }   # string result without JSON quotes
CLICKTEXT () { J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='$1'); if(b){b.click();return 'ok';} return 'not-found'; })()"; }
CLICKHAS () { J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('$1')); if(b){b.click();return 'ok';} return 'not-found'; })()"; }
PICK () { # open the radix select labelled by its trigger text, then click an option
  J "(() => { const t=[...document.querySelectorAll('[role=combobox]')].find(x=>x.textContent.trim()==='$1'); if(!t) return 'trigger-not-found'; t.click(); return 'ok'; })()"
  sleep 0.6
  J "(() => { const o=[...document.querySelectorAll('[role=option]')].find(x=>x.textContent.trim()==='$2'); if(!o) return 'option-not-found'; o.click(); return 'ok'; })()"
}

$B open http://localhost:3000 >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 1
J "(() => { localStorage.clear(); return 'cleared'; })()" >/dev/null
$B open http://localhost:3000 >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 2

if J "document.body.innerText.toLowerCase().includes('sign in')" | grep -q true; then
  $B find label "Email" fill "super@pulse.app" >/dev/null 2>&1
  $B find label "Password" fill "demo1234" >/dev/null 2>&1
  CLICKTEXT "Sign In" >/dev/null
  sleep 3; $B wait --load networkidle >/dev/null 2>&1
fi
J "document.body.innerText.includes('Dashboard')" | grep -q true && ok "demo login" || bad "demo login"

# ---- 1. Advance Book --------------------------------------------------------
CLICKTEXT "Salary Details" >/dev/null; sleep 0.8
CLICKTEXT "Advance Book" >/dev/null; sleep 3
J "document.body.innerText.includes('The advance ledger') || document.body.innerText.includes('Advance Book')" | grep -q true && ok "advance book page" || bad "advance book page"

ALLROWS=$(J "document.querySelectorAll('[id^=adv-rec-]').length")
echo "rows(all branches)=$ALLROWS"
[ "$ALLROWS" = "3" ] && ok "all branches shows the 3 seeded records" || bad "all branches shows the 3 seeded records (got $ALLROWS)"

R=$(PICK "All branches" "Dubai Central Branch"); sleep 1
DROWS=$(J "document.querySelectorAll('[id^=adv-rec-]').length")
DHINT=$(J "document.body.innerText.includes('— Dubai Central Branch')")
# card labels render UPPERCASE (CSS text-transform) → innerText shows DUE / OVERDUE
DCARD=$(JS "(() => { const m=document.body.innerText.match(/DUE\\s*([\\d,]+\\.\\d{2})/); return m ? m[1] : 'none'; })()")
echo "rows(Dubai)=$DROWS dueCard=$DCARD hintScoped=$DHINT"
[ "$DROWS" = "2" ] && ok "Dubai Central scope → 2 records" || bad "Dubai Central scope → 2 records (got $DROWS)"
[ "$DCARD" = "2,140.00" ] && ok "Dubai Central Due card = SAR 2,140.00" || bad "Dubai Central Due card (got $DCARD)"
echo "$DHINT" | grep -q true && ok "card hints carry the branch scope" || bad "card hints carry the branch scope"
J "document.body.innerText.includes('Suresh Patel')" | grep -q true && ok "Suresh Patel (Dubai) listed" || bad "Suresh Patel (Dubai) listed"
J "document.body.innerText.includes('Rajesh Kumar')" | grep -q true && bad "Rajesh Kumar (Northern) leaked into Dubai scope" || ok "Rajesh Kumar (Northern) correctly hidden"

R=$(PICK "Dubai Central Branch" "Northern Emirates Branch"); sleep 1
NROWS=$(J "document.querySelectorAll('[id^=adv-rec-]').length")
NCARD=$(JS "(() => { const m=document.body.innerText.match(/OVERDUE\\s*([\\d,]+\\.\\d{2})/); return m ? m[1] : 'none'; })()")
echo "rows(Northern)=$NROWS overdueCard=$NCARD"
[ "$NROWS" = "1" ] && ok "Northern Emirates scope → 1 record" || bad "Northern Emirates scope → 1 record (got $NROWS)"
[ "$NCARD" = "800.00" ] && ok "Northern Emirates Overdue card = SAR 800.00" || bad "Northern Emirates Overdue card (got $NCARD)"

# ---- add dialog pre-sets to the branch picked in the toolbar -----------------
# (toolbar is at Northern Emirates Branch right now)
CLICKTEXT "Add Advance" >/dev/null; sleep 1.2
DEFBR=$(JS "(() => { const t=[...document.querySelectorAll('[role=combobox]')].map(x=>x.textContent.trim()); return t.length ? t[t.length-3] : 'none'; })()")
echo "add-dialog branch pre-set: $DEFBR"
[ "$DEFBR" = "Northern Emirates Branch" ] && ok "Add Advance opens pre-set to the picked branch" || bad "Add Advance branch pre-set (got $DEFBR)"
CLICKTEXT "Cancel" >/dev/null; sleep 0.8

# reset the toolbar to All branches — the full ledger returns
R=$(PICK "Northern Emirates Branch" "All branches"); sleep 1
echo "reset pick: $R"
ALLROWS2=$(J "document.querySelectorAll('[id^=adv-rec-]').length")
[ "$ALLROWS2" = "3" ] && ok "back to All branches → all 3 records" || bad "back to All branches (got $ALLROWS2)"

# ---- 2. Trade / Ded Management ----------------------------------------------
CLICKTEXT "Trade/Ded Management" >/dev/null; sleep 3
J "document.body.innerText.includes('Trade / Deduction Management')" | grep -q true && ok "trade page" || bad "trade page"
ALLTRADES=$(J "document.querySelectorAll('section.card-glow').length")
echo "trade cards(all)=$ALLTRADES"
[ "$ALLTRADES" -ge "10" ] && ok "all branches shows the full trade grid" || bad "all branches trade grid (got $ALLTRADES)"

R=$(PICK "All branches" "Dubai Central Branch"); sleep 1
DTRADES=$(J "document.querySelectorAll('section.card-glow').length")
DSUMMARY=$(J "document.body.innerText.includes('Dubai Central Branch branch —')")
DCHIP=$(J "document.body.innerText.includes('employee') && [...document.querySelectorAll('section.card-glow p')].some(p=>p.textContent.includes('· Dubai Central Branch'))")
echo "trade cards(Dubai)=$DTRADES summary=$DSUMMARY chips=$DCHIP"
[ "$DTRADES" -ge "1" ] && [ "$DTRADES" -lt "$ALLTRADES" ] && ok "Dubai scope narrows the trade grid ($DTRADES < $ALLTRADES)" || bad "Dubai scope trade grid (got $DTRADES)"
echo "$DSUMMARY" | grep -q true && ok "branch summary line shown" || bad "branch summary line shown"
echo "$DCHIP" | grep -q true && ok "trade cards show '<N> employees · branch' chips" || bad "trade cards employee chips"

# ---- 3. Notifications → Letters (trade, not position) ------------------------
# (the sidebar Notifications button carries an unread badge BEFORE the label →
#  its text is like "4Notifications", so match with includes)
NT=$(J "(() => { const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.includes('Notifications')); if(b.length){b[b.length-1].click();return 'ok:'+b.length;} return 'not-found'; })()")
sleep 3
echo "notifications click: $NT"
echo "on hub: $(J "document.body.innerText.includes('Notifications Hub')")"
# Radix tab triggers need REAL pointer events (synthetic el.click() is ignored)
$B click '[role=tab]:nth-of-type(2)' >/dev/null 2>&1
sleep 1.5
echo "letters tab active: $(J "(() => { const t=[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim().startsWith('Letters')); return t ? t.getAttribute('data-state') : 'nf'; })()")"
J "document.body.innerText.includes('Letters & Notices')" | grep -q true && ok "letters tab" || bad "letters tab"
CLICKTEXT "New Letter / Notice" >/dev/null; sleep 1.2
J "document.body.innerText.includes('New Letter / Notice')" | grep -q true && ok "create dialog opens" || bad "create dialog opens"
# pick an employee through the combobox (Command palette)
J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Search employees')); if(b){b.click();return 'ok';} return 'not-found'; })()" >/dev/null
sleep 0.8
$B eval "(() => { const i=document.querySelector('[cmdk-input]') || document.querySelector('input[placeholder*=Type]'); if(i){ const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i,'Rajesh'); i.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'; } return 'input-not-found'; })()" >/dev/null
sleep 0.8
J "(() => { const it=[...document.querySelectorAll('[cmdk-item],[role=option]')][0]; if(it){it.click();return 'ok';} return 'no-item'; })()" >/dev/null
sleep 0.8
PREVIEW=$(JS "(() => { const p=[...document.querySelectorAll('p')].find(x=>x.className.includes('bg-muted/60')); return p ? p.textContent.trim() : 'none'; })()")
echo "employee preview: $PREVIEW"
echo "$PREVIEW" | grep -q "Electrician" && ok "create-dialog preview shows the TRADE (Electrician)" || bad "create-dialog preview shows the trade (got: $PREVIEW)"
echo "$PREVIEW" | grep -q "Foreman" && bad "preview still shows the position" || ok "position removed from the preview"

echo ""
if [ "$FAILS" = "0" ]; then echo "ALL SMOKE CHECKS PASSED"; else echo "$FAILS SMOKE CHECK(S) FAILED"; fi
exit $FAILS
