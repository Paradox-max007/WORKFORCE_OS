// Throwaway local OpenAI-compatible mock provider for testing the AI chat
// widget end-to-end: the demo Site Settings point at http://127.0.0.1:8787/v1
// and this answers /chat/completions with canned replies. Logs request info
// (model, auth header, message count, system-prompt size) for verification.
import http from 'node:http';

let hits = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits += 1;
    const url = req.url ?? '';
    console.log(`[mock] ${req.method} ${url} (hit ${hits})`);
    if (req.method === 'POST' && /\/chat\/completions$/.test(url)) {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      const msgs = parsed.messages ?? [];
      const sys = msgs.find((m) => m.role === 'system');
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      console.log(`[mock] model=${parsed.model} auth=${req.headers.authorization ?? '(none)'} messages=${msgs.length} sysChars=${sys ? sys.content.length : 0}`);
      if (lastUser) console.log(`[mock] last user message: ${lastUser.content.slice(0, 90)}`);
      if (sys) console.log(`[mock] system head: ${sys.content.slice(0, 130).replace(/\n/g, ' | ')}`);
      const reply = `**Mock reply ${hits}** — you asked: "${lastUser ? lastUser.content.slice(0, 60) : ''}".\n\n- the connection works end to end\n- the system prompt arrived (${sys ? sys.content.length : 0} chars)\n- inline \`code\` also renders`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: reply } }],
        usage: { total_tokens: 42 },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route ${url}` } }));
  });
});
server.listen(8787, '127.0.0.1', () => console.log('[mock] OpenAI-compatible mock listening on http://127.0.0.1:8787/v1'));
