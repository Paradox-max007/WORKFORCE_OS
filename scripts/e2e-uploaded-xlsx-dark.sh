#!/bin/bash
# ============================================================================
# PULSE — E2E: an UPLOADED Excel timesheet renders dark in DARK MODE
#   (white fills -> dark paper, light ink text, chosen colours survive)
#   and still renders exactly as before in LIGHT MODE.
# Real app (demo mode), real upload through the Site Timesheets page, real
# FortuneSheet canvas — verified by reading the canvas pixels in-page.
# Everything runs in ONE Bash call (background processes are reaped when a
# call ends, so the server must live inside this same call).
# ============================================================================
cd /home/z/my-project

# ---- fixture ---------------------------------------------------------------
B64=$(bun scripts/make-dark-fixture.mjs)
[ -n "$B64" ] || { echo "FAIL: fixture not built"; exit 1; }

# ---- server (must stay inside this call) -----------------------------------
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
CLICKTEXT () { J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='$1'); if(b){b.click();return 'ok';} return 'not-found'; })()"; }

$B open http://localhost:3000 >/dev/null 2>&1
$B wait --load networkidle >/dev/null 2>&1
sleep 1
J "(() => { localStorage.clear(); return 'cleared'; })()" >/dev/null
$B open http://localhost:3000 >/dev/null 2>&1
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
echo "dark class: $(J "document.documentElement.classList.contains('dark')")"

# ---- Sites -> expand the Dubai branch -> first site's Timesheets -----------
CLICKTEXT "Sites" >/dev/null
sleep 2.5
echo "expand branch: $(J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Dubai Central Branch')); if(b){b.click();return 'ok';} return 'not-found'; })()")"
sleep 1.5
echo "open timesheets: $(J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Timesheet / Time Cards')); if(b){b.click();return 'ok';} return 'not-found'; })()")"
sleep 3
echo "timesheets page: $(J "document.body.innerText.includes('Site Timesheets / Time Cards')")"

# ---- upload the fixture into the newest month's TIMESHEET slot -------------
echo "upload: $(J "(() => {
  const b64 = '$B64';
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const f = new File([u8], 'marina-nov-2026.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const dt = new DataTransfer();
  dt.items.add(f);
  const input = document.querySelector('input[accept=\".pdf,.xlsx,.xls,.csv\"]');
  if (!input) return 'input-not-found';
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'uploaded';
})()")"
sleep 3
echo "edit btn: $(J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Open & Edit')); return b ? 'present' : 'missing'; })()")"

# ---- open the editor (poll until the FortuneSheet canvas exists) -----------
J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Open & Edit')); if(b){b.click();return 'ok';} return 'not-found'; })()" >/dev/null
CV=0
for i in $(seq 1 20); do
  CV=$(J "(() => { const c = document.querySelector('.pulse-fortune .fortune-sheet-container canvas'); return c && c.width > 50 ? 'ready' : 'wait'; })()")
  [ "$CV" = "ready" ] && break
  sleep 1
done
echo "editor canvas: $CV"

# ---- pixel verification (reads the real canvas) ----------------------------
# returns plain "k:v" pairs (agent-browser eval output is JSON-quoted, so we
# avoid nested JSON)
CHECK='(() => {
  const host = document.querySelector(".pulse-fortune .fortune-sheet-container");
  const cv = host ? host.querySelector("canvas") : null;
  if (!cv) return "error:no-canvas";
  const s = document.createElement("canvas");
  s.width = cv.width; s.height = cv.height;
  const ctx = s.getContext("2d");
  ctx.drawImage(cv, 0, 0);
  const W = cv.width, H = cv.height;
  const x0 = Math.round(W * 0.08), y0 = Math.round(H * 0.13);
  const x1 = Math.round(W * 0.75), y1 = Math.round(H * 0.6);
  const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let paper = 0, white = 0, yellow = 0, ink = 0, red = 0, grey = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    n++;
    if (Math.abs(r - 19) <= 8 && Math.abs(g - 19) <= 8 && Math.abs(b - 28) <= 8) paper++;
    if (r > 250 && g > 250 && b > 250) white++;
    if (r > 230 && g > 230 && b < 60) yellow++;
    if (r > 225 && g > 225 && b > 225) ink++;
    if (r > 140 && g < 80 && b < 80) red++;
    if (Math.abs(r - 242) <= 12 && Math.abs(g - 242) <= 12 && Math.abs(b - 242) <= 12) grey++;
  }
  const f = (v) => (100 * v / n).toFixed(2);
  return "paper:" + f(paper) + " white:" + f(white) + " yellow:" + f(yellow) + " ink:" + f(ink) + " red:" + f(red) + " grey:" + f(grey);
})()'

getval () { echo "$1" | grep -oE "$2:[-0-9.]+" | cut -d: -f2; }

DARK=$(J "$CHECK")
echo "DARK canvas: $DARK"
$B screenshot /tmp/render/e2e-uploaded-dark.png >/dev/null 2>&1

paper=$(getval "$DARK" paper); white=$(getval "$DARK" white); yellow=$(getval "$DARK" yellow); ink=$(getval "$DARK" ink); grey=$(getval "$DARK" grey)
dark_ok=1
awk -v p="$paper" -v w="$white" -v y="$yellow" -v i="$ink" -v g="$grey" 'BEGIN { exit !(p > 25 && w < 2 && y > 0.02 && i > 0.1 && g < 8) }' && dark_ok=0
echo "dark mode: $([ $dark_ok = 0 ] && echo PASS || echo FAIL)"

# ---- light mode regression: remove .dark, reopen the editor ----------------
J "(() => { document.documentElement.classList.remove('dark'); const b = document.querySelector('button[aria-label=\"Close editor\"]'); if (b) b.click(); return 'light+closed'; })()" >/dev/null
sleep 2
J "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Open & Edit')); if(b){b.click();return 'ok';} return 'not-found'; })()" >/dev/null
CV=0
for i in $(seq 1 20); do
  CV=$(J "(() => { const c = document.querySelector('.pulse-fortune .fortune-sheet-container canvas'); return c && c.width > 50 ? 'ready' : 'wait'; })()")
  [ "$CV" = "ready" ] && break
  sleep 1
done
echo "light editor canvas: $CV"

LIGHT=$(J "$CHECK")
echo "LIGHT canvas: $LIGHT"
$B screenshot /tmp/render/e2e-uploaded-light.png >/dev/null 2>&1

lwhite=$(getval "$LIGHT" white); lpaper=$(getval "$LIGHT" paper); lyellow=$(getval "$LIGHT" yellow)
light_ok=1
awk -v w="$lwhite" -v p="$lpaper" -v y="$lyellow" 'BEGIN { exit !(w > 30 && p < 2 && y > 0.02) }' && light_ok=0
echo "light mode: $([ $light_ok = 0 ] && echo PASS || echo FAIL)"

# restore dark for the record
J "(() => { document.documentElement.classList.add('dark'); return 'dark-restored'; })()" >/dev/null

if [ "$dark_ok" = "0" ] && [ "$light_ok" = "0" ]; then
  echo "E2E UPLOADED-XLSX DARK+LIGHT ALL PASS"
  exit 0
else
  echo "E2E FAILED (dark=$dark_ok light=$light_ok) — screenshots: /tmp/render/e2e-uploaded-*.png"
  exit 1
fi
