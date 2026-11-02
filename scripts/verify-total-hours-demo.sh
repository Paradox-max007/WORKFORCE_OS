#!/usr/bin/env bash
# One-shot demo-mode verification of the "Total Hours" row in the
# Professional Information card of the Employee Details page.
set -u
cd /home/z/my-project
mkdir -p /tmp/render

# ---- 1. start the demo-mode production server -------------------------------
PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production bun .next/standalone/server.js > server-demo.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 0.5
done
echo "== server: HTTP $code =="

# ---- 2. login via the demo super admin --------------------------------------
agent-browser set viewport 1440 900 >/dev/null 2>&1
agent-browser open http://localhost:3000/ --timeout 30000
sleep 5
agent-browser find first "#email" fill "super@pulse.app"
agent-browser find first "#password" fill "demo1234"
sleep 0.5
agent-browser eval "[...document.querySelectorAll('button[type=submit], button')].find(b => b.textContent.trim() === 'Sign In')?.click()" >/dev/null
sleep 5
echo "== shell loaded? =="
agent-browser eval "Boolean(document.querySelector('nav'))"
echo "== current heading =="
agent-browser eval "(document.querySelector('h1') || document.querySelector('h2'))?.textContent"

# ---- 3. go to Employees via the sidebar button ------------------------------
agent-browser eval "[...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === 'Employees')?.click()" >/dev/null
sleep 3
echo "== employees view heading =="
agent-browser eval "(document.querySelector('h1') || document.querySelector('h2'))?.textContent"

# ---- 4. open the first employee's details ------------------------------------
agent-browser eval "[...document.querySelectorAll(\"[title='View details']\")][0]?.click()" >/dev/null
sleep 5

# ---- 5. prove the Total Hours row ------------------------------------------------
echo "== employee on screen =="
agent-browser eval "document.querySelector('h1')?.textContent"
echo "== Professional Information card text =="
agent-browser eval "([...document.querySelectorAll('section')].find(s => s.textContent.includes('Professional Information'))?.innerText || 'SECTION NOT FOUND')"
echo "== page errors (if any) =="
agent-browser errors

# ---- 6. screenshot for visual check ----------------------------------------------
agent-browser screenshot /tmp/render/employee-details-total-hours.png --full
echo "== screenshot saved =="

kill $SERVER_PID 2>/dev/null
echo "== done =="
