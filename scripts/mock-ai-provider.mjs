// Smart mock OpenAI-compatible provider for verifying Pebby's protocol:
//  - reads the SYSTEM PROMPT (the database snapshot) from the request
//  - nationality/code questions → answers FROM the snapshot (proves the
//    employee directory is embedded and complete)
//  - "when was X cancelled" → replies with a [[QUERY]] directive against the
//    cancellation_requests table; when the query result arrives, answers
//    from it with the exact reviewed_at timestamp (proves the query loop)
//  - passport questions → replies with a [[LOOKUP]] employees=… directive;
//    when the lookup result arrives, answers from it (proves the lookup loop)
//  - "overdue advances" → replies with a [[QUERY]] directive against the
//    advance_book table with filters + sorting (proves complex querying)
//  - news questions → replies with a [[WEB: query]] directive; when the web
//    research arrives, answers from it (proves the proxy loop)
import http from 'node:http';

const seen = { prompts: 0, lookups: 0, queries: 0, webs: 0 };

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

      if (lastUser.includes('DATABASE QUERY RESULT') || lastUser.includes('DATABASE QUERY ERROR')) {
        seen.queries += 1;
        if (lastUser.includes('cancellation_requests')) {
          const name = /employee_name: ([^·]+) ·/.exec(lastUser)?.[1]?.trim() ?? 'unknown';
          const code = /employee_code: ([^·]+) ·/.exec(lastUser)?.[1]?.trim() ?? 'unknown';
          const requested = /requested_at: ([^·]+) ·/.exec(lastUser)?.[1]?.trim() ?? 'unknown';
          const requestedBy = /requested_by_name: ([^·]+) ·/.exec(lastUser)?.[1]?.trim() ?? 'unknown';
          const reviewed = /reviewed_at: ([^·]+) ·/.exec(lastUser)?.[1]?.trim() ?? 'unknown';
          const reviewedBy = /reviewed_by_name: ([^·]+) ·/.exec(lastUser)?.[1]?.trim() ?? 'unknown';
          const reason = /reason: "?([^"\n·]+)"?/.exec(lastUser)?.[1]?.trim() ?? 'unknown';
          reply = `MOCK QUERY ANSWER: ${name} (${code}) was cancelled on ${reviewed} — the cancellation request was approved by ${reviewedBy}. It was raised ${requested} by ${requestedBy} ("${reason}").`;
        } else if (lastUser.includes('advance_book')) {
          const rows = (lastUser.match(/^- /gm) ?? []).length;
          const total = /sum\(amount\) = ([\d.]+)/.exec(lastUser)?.[1] ?? 'unknown';
          reply = `MOCK QUERY ANSWER: ${rows} advance record(s) matched the filters; total overdue amount AED ${total}.`;
        } else {
          reply = 'MOCK QUERY ANSWER: the query engine returned rows (unparsed test path).';
        }
      } else if (lastUser.includes('DATABASE LOOKUP RESULT')) {
        seen.lookups += 1;
        const pass = /passport: ([^\n(]+?)(?: \()/.exec(lastUser);
        const code = /(?:^|\n)- (PUL-\d{4}-\d+)/.exec(lastUser);
        reply = `MOCK LOOKUP ANSWER: passport is ${pass ? pass[1].trim() : 'unknown'} for ${code ? code[1] : 'unknown code'}.`;
      } else if (lastUser.includes('WEB RESEARCH')) {
        seen.webs += 1;
        const first = /- ([^—\n]+)\s*\(.*?\)\s*—/.exec(lastUser);
        reply = `MOCK WEB ANSWER: based on live web research — top story: ${first ? first[1].trim() : '(several sources)'} — here is the current-affairs summary.`;
      } else if (/when .*(cancel|terminate)/i.test(lastUser) || /cancel.*when/i.test(lastUser)) {
        // exercise the [[QUERY]] loop: pull the approved cancellation requests
        reply = '[[QUERY]] {"table":"cancellation_requests","where":[{"field":"status","op":"eq","value":"approved"}]}';
      } else if (/overdue advance/i.test(lastUser)) {
        // exercise complex querying: filter + sort + aggregate
        reply = '[[QUERY]] {"table":"advance_book","where":[{"field":"overdue","op":"eq","value":true}],"order_by":"amount","desc":true,"aggregate":"sum","on":"amount"}';
      } else if (/passport/i.test(lastUser)) {
        const line = findEmployeeLine(system, 'Muhammad Iqbal');
        const code = line ? /- (PUL-\d{4}-\d+)/.exec(line)[1] : 'PUL-2026-002';
        reply = `[[LOOKUP]] employees=${code}`;
      } else if (/news|weather|current affair/i.test(lastUser)) {
        reply = '[[WEB: latest UAE business news]]';
      } else if (/how many employees are (in the directory|on the roster)/i.test(lastUser)) {
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
setInterval(() => console.log(`stats msgs=${seen.prompts} lookups=${seen.lookups} queries=${seen.queries} webs=${seen.webs}`), 3000);
