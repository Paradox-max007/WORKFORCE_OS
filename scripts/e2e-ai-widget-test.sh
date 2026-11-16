#!/bin/bash
# End-to-end test of the AI chat widget, round 2 (corrected assertions).
# Runs in ONE Bash call — background processes are reaped when the call ends.
cd /home/z/my-project
mkdir -p /tmp/render

node scripts/mock-ai-provider.mjs > /tmp/mock-ai.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
sleep 1

echo "### STEP 0: reload — FAB must sit at the true bottom-right (fixed)"
agent-browser reload
agent-browser wait --load networkidle 2>/dev/null
agent-browser wait 1500
agent-browser eval "(() => { const fab = document.querySelector('button[aria-label=\"Open the AI assistant\"]'); if (!fab) return { fab: false }; const cs = getComputedStyle(fab); const r = fab.getBoundingClientRect(); return { fab: true, position: cs.position, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, viewport: { w: innerWidth, h: innerHeight } }; })()"
agent-browser screenshot /tmp/render/ai2-00-fab.png

echo; echo "### STEP 1: open the panel via the FAB"
agent-browser find role button click --name "Open the AI assistant"
agent-browser wait --text "Ask me anything" || echo "!! panel did not open"
agent-browser eval "(() => { const p = document.querySelector('[role=\"dialog\"][aria-label=\"AI assistant chat\"]'); const r = p.getBoundingClientRect(); const fab = document.querySelector('button[aria-label=\"Collapse the AI assistant\"]'); const fr = fab.getBoundingClientRect(); return { panel: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, fab: { x: Math.round(fr.left), y: Math.round(fr.top) }, gap: Math.round(r.bottom - fr.top) * -1 }; })()"

echo; echo "### STEP 2: send a suggested question -> mock reply"
agent-browser find text "How many employees are on the roster right now?" click
agent-browser wait --text "the connection works end to end" || echo "!! no reply arrived"
agent-browser screenshot /tmp/render/ai2-01-reply.png

echo; echo "### STEP 3: collapse the panel by clicking the bot again"
agent-browser find role button click --name "Collapse the AI assistant"
agent-browser wait 800
agent-browser eval "(() => ({ panelOpen: !!document.querySelector('[role=\"dialog\"][aria-label=\"AI assistant chat\"]'), fabLabelBack: !!document.querySelector('button[aria-label=\"Open the AI assistant\"]') }))()"

echo; echo "### STEP 4: reopen — the thread must survive the collapse"
agent-browser find role button click --name "Open the AI assistant"
agent-browser wait --text "the connection works end to end" && echo "thread persisted" || echo "!! thread lost"

echo; echo "### STEP 5: typed message, FOCUSED textarea, sent with Enter"
agent-browser eval "(() => { const ta = document.querySelector('textarea[placeholder^=\"Ask about\"]'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'Who has the most absences this month?'); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); return 'typed+focused'; })()"
agent-browser press Enter
agent-browser wait 2500
agent-browser eval "(() => { const bubbles = [...document.querySelectorAll('[role=\"dialog\"] .whitespace-pre-wrap')]; return { bubbleCount: bubbles.length, last: bubbles[bubbles.length - 1]?.textContent?.slice(0, 110) ?? '(none)' }; })()"
agent-browser screenshot /tmp/render/ai2-02-second.png

echo; echo "### STEP 6: Escape collapses the panel"
agent-browser press Escape
agent-browser wait 700
agent-browser eval "!!document.querySelector('[role=\"dialog\"][aria-label=\"AI assistant chat\"]')"

echo; echo "### STEP 7: disable the assistant -> FAB disappears (exact selector)"
agent-browser find role button click --name "Site Settings"
agent-browser wait 1000
agent-browser find role switch click --name "Enable the AI assistant"
agent-browser wait 1200
agent-browser eval "(() => ({ fabGone: !document.querySelector('button[aria-label=\"Open the AI assistant\"]') && !document.querySelector('button[aria-label=\"Collapse the AI assistant\"]'), enabled: JSON.parse(localStorage.getItem('pulse_demo_db_v8')).siteSettings.ai_enabled }))()"

echo; echo "### STEP 8: re-enable for the final look + browser console errors"
agent-browser find role switch click --name "Enable the AI assistant"
agent-browser wait 1000
agent-browser screenshot /tmp/render/ai2-03-final.png
agent-browser errors 2>&1 | head -5

echo; echo "### mock provider log (sysChars must be < 24000):"
cat /tmp/mock-ai.log
