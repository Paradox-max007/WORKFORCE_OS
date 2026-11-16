// Smoke test for the Pebby [[QUERY]] engine against the seeded demo store.
// Run: bun scripts/test-ai-query-engine.ts
import {
  parseAiQueryDirective, runAiQuery, queryableTablesDoc,
} from '../src/lib/ai/query-engine';
import { buildAiKnowledgeBase, buildAiSystemPrompt } from '../src/lib/ai/knowledge';
import { DEFAULT_SITE_SETTINGS } from '../src/lib/types';

const EXAMPLES = [
  // the user's exact scenario
  '[[QUERY]] {"table":"cancellation_requests","where":[{"field":"status","op":"eq","value":"approved"}]}',
  // name → code resolution on the cancelled roster
  '[[QUERY]] {"table":"cancelled_employees","fields":["employee_code","full_name"],"where":[{"field":"full_name","op":"contains","value":"Hassan"}]}',
  // group + count
  '[[QUERY]] {"table":"employees","group_by":"nationality","aggregate":"count"}',
  // filter + sort + limit on the advance ledger
  '[[QUERY]] {"table":"advance_book","where":[{"field":"overdue","op":"eq","value":true}],"order_by":"amount","desc":true,"limit":5}',
  // attendance of one employee, past month
  `[[QUERY]] {"table":"attendance","month":"${new Date().toISOString().slice(0, 7)}","where":[{"field":"employee_name","op":"contains","value":"Hassan"}],"limit":5}`,
  // invalid field → self-correcting error
  '[[QUERY]] {"table":"employees","where":[{"field":"favourite_colour","op":"eq","value":"blue"}]}',
  // malformed JSON → parse error round
  '[[QUERY]] {"table": employees}',
  // not a directive at all
  'This is a normal answer.',
];

let failures = 0;
for (const ex of EXAMPLES) {
  const parsed = parseAiQueryDirective(ex);
  if (parsed === null) {
    console.log(`\n### ${ex.slice(0, 70)}\n→ not a directive (treated as normal answer)`);
    continue;
  }
  if ('error' in parsed) {
    console.log(`\n### ${ex.slice(0, 70)}\n→ PARSE ERROR round: ${parsed.error.slice(0, 140)}`);
    continue;
  }
  const out = await runAiQuery(parsed.spec);
  const ok = out.startsWith('DATABASE QUERY');
  if (!ok) failures += 1;
  console.log(`\n### ${ex.slice(0, 70)}\n${out.split('\n').slice(0, 6).join('\n').slice(0, 700)}`);
}

// system prompt sanity: snapshot must now carry the cancellation date + the
// query dictionary
const kb = await buildAiKnowledgeBase();
const prompt = buildAiSystemPrompt(kb, {
  ...DEFAULT_SITE_SETTINGS, id: 1, logo_url: null, ai_api_key_masked: '',
} as never);
const checks: [string, boolean][] = [
  ['snapshot carries CANCELLED EMPLOYEES section', prompt.includes('CANCELLED EMPLOYEES')],
  ['cancelled directory line carries the cancellation date', /cancelled \d{4}-\d{2}-\d{2}/.test(prompt)],
  ['cancellation requests carry reviewed_at date', /reviewed \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(prompt)],
  ['query dictionary embedded (DATABASE QUERY ENGINE)', prompt.includes('DATABASE QUERY ENGINE')],
  ['dictionary lists cancellation_requests', prompt.includes('- cancellation_requests —')],
  ['dictionary lists every table (25 total)', (prompt.match(/^- [a-z_]+ —/gm) ?? []).length >= 25],
  ['worked example mentions the cancellation-date semantics', prompt.includes('IS the cancellation date')],
];
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures += 1;
}
console.log(`\nprompt chars: ${prompt.length} (proxy cap 150k)`);
console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
if (failures > 0 || prompt.includes('queryableTablesDoc()')) process.exit(1);
