// Mock OpenAI-compatible provider for the doc-content E2E:
//   "read the uploaded timesheet"  -> [[LOOKUP]] doc-content=<site>:2026-11:timesheet
//   "read the time card"           -> [[LOOKUP]] doc-content=<site>:2026-11:time-card
//   when the DOCUMENT CONTENT result arrives -> answer FROM it (proving the
//   widget really extracted the file's text and fed it back)
// Also asserts the system prompt documents the doc-content protocol.
import http from 'node:http';

const SITE = 'Marina Heights Tower';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let reply = 'MOCK: nothing to say.';
    let promptHasProtocol = false;
    let parsed = null;
    let lastUser = '';
    try {
      parsed = JSON.parse(body);
      const msgs = parsed.messages ?? [];
      const system = msgs.find((m) => m.role === 'system')?.content ?? '';
      promptHasProtocol = system.includes('doc-content=');
      lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';

      if (lastUser.includes('DOCUMENT CONTENT')) {
        if (lastUser.includes('.xlsx') || lastUser.includes('sheet "')) {
          const workers = ['Ravi Kumar', 'Anita Shah', 'John Doe', 'Sam Raj']
            .filter((w) => lastUser.includes(w));
          const hasTotal = lastUser.includes('MARINA TOWER');
          reply = `MOCK TIMESHEET ANSWER: the November timesheet contains ${workers.length} workers (${workers.join(', ')})${hasTotal ? ' on the MARINA TOWER sheet' : ''}. Sheet rows include "${lastUser.split('\n').find((l) => l.includes('Ravi')) ?? 'n/a'}".`;
        } else if (lastUser.includes('PDF') || lastUser.includes('TIME CARD')) {
          const okHours = lastUser.includes('208.5');
          const okName = lastUser.includes('ARUN KUMAR');
          reply = `MOCK TIME CARD ANSWER: the PDF lists ARUN KUMAR with total hours 208.5 — name:${okName} hours:${okHours}.`;
        }
      } else if (lastUser.toLowerCase().includes('read the uploaded timesheet')) {
        reply = `[[LOOKUP]] doc-content=${SITE}:2026-11:timesheet`;
      } else if (lastUser.toLowerCase().includes('read the time card')) {
        reply = `[[LOOKUP]] doc-content=${SITE}:2026-11:time-card`;
      }
    } catch { /* keep default reply */ }

    console.log(`[mock] protocol=${promptHasProtocol} lastUser="${lastUser.slice(0, 260)}" -> ${reply.slice(0, 60)}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-1', object: 'chat.completion', created: Date.now(),
      model: parsed?.model ?? 'mock-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply } }],
    }));
  });
});
server.listen(8787, '127.0.0.1', () => console.log('mock doc-content provider on :8787'));
