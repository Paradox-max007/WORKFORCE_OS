// Smart mock OpenAI-compatible provider for verifying Pebby's protocol:
//  - reads the SYSTEM PROMPT (the database snapshot) from the request
//  - nationality/code questions → answers FROM the snapshot (proves the
//    employee directory is embedded and complete)
//  - passport questions → replies with a [[LOOKUP]] employees=… directive;
//    when the lookup result arrives, answers from it (proves the widget loop)
//  - news questions → replies with a [[WEB: query]] directive; when the web
//    research arrives, answers from it (proves the proxy loop)
import http from 'node:http';

const seen = { prompts: 0, lookups: 0, webs: 0 };

function findEmployeeLine(system, name) {
  for (const line of system.split('\n')) {
    if (line.includes(name)) return line;
  }
  return null;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let reply = 'MOCK: I could not find that.';
    try {
      const parsed = JSON.parse(body);
      const msgs = parsed.messages ?? [];
      const system = msgs.find((m) => m.role === 'system')?.content ?? '';
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      seen.prompts = msgs.length;

      if (lastUser.includes('DATABASE LOOKUP RESULT')) {
        seen.lookups += 1;
        const pass = /passport: ([^\n(]+?)(?: \()/.exec(lastUser);
        const code = /(?:^|\n)- (PUL-\d{4}-\d+)/.exec(lastUser);
        reply = `MOCK LOOKUP ANSWER: passport is ${pass ? pass[1].trim() : 'unknown'} for ${code ? code[1] : 'unknown code'}.`;
      } else if (lastUser.includes('WEB RESEARCH')) {
        seen.webs += 1;
        const first = /- ([^—\n]+)\s*\(.*?\)\s*—/.exec(lastUser);
        reply = `MOCK WEB ANSWER: based on live web research — top story: ${first ? first[1].trim() : '(several sources)'} — here is the current-affairs summary.`;
      } else if (/passport/i.test(lastUser)) {
        const line = findEmployeeLine(system, 'Muhammad Iqbal');
        const code = line ? /- (PUL-\d{4}-\d+)/.exec(line)[1] : 'PUL-2026-002';
        reply = `[[LOOKUP]] employees=${code}`;
      } else if (/news|weather|current affair/i.test(lastUser)) {
        reply = '[[WEB: latest UAE business news]]';
      } else if (/how many employees are in the directory/i.test(lastUser)) {
        const sec = /EMPLOYEE DIRECTORY \((\d+) on the roster\)\n([\s\S]*?)(?:\n\n|$)/.exec(system);
        const lines = sec ? sec[2].split('\n').filter((l) => l.startsWith('- ')).length : 0;
        reply = `MOCK COUNT: directory header says ${sec ? sec[1] : '?'}; found ${lines} directory lines.`;
      } else if (/nationality|emp(loyee)? code/i.test(lastUser)) {
        const nm = /employee ([A-Za-z][A-Za-z ]+?)(?:,|\?|$)/.exec(lastUser);
        const name = nm ? nm[1].trim() : 'Muhammad Iqbal';
        const line = findEmployeeLine(system, name);
        if (line) {
          const code = /- (PUL-\d{4}-\d+)/.exec(line)[1];
          const nat = /PUL-\d{4}-\d+ · [^·]+ · ([^·]+)/.exec(line)[1].trim();
          reply = `MOCK DB ANSWER: ${name} — nationality ${nat}, employee code ${code}.`;
        } else {
          reply = `MOCK DB ANSWER: ${name} NOT found in the snapshot.`;
        }
      }
    } catch { /* keep default reply */ }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      choices: [{ message: { content: reply } }],
      usage: { total_tokens: 10 },
    }));
  });
});

server.listen(8787, '127.0.0.1', () => console.log('smart mock provider on :8787'));
setInterval(() => console.log(`stats msgs=${seen.prompts} lookups=${seen.lookups} webs=${seen.webs}`), 3000);
