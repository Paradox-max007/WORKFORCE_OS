// Smoke test for the Pebby [[QUERY]] engine + knowledge base against the
// seeded demo store — now covering the BRANCH-SCOPED access model:
//   • unrestricted (super admin / All-Branches) behaves exactly as before
//   • a branch-scoped admin's queries/lookups/snapshot only ever contain
//     their granted branches' + directly assigned sites' records
// Run: bun scripts/test-ai-query-engine.ts
import {
  parseAiQueryDirective, runAiQuery, queryableTablesDoc,
} from '../src/lib/ai/query-engine';
import { buildAiKnowledgeBase, buildAiSystemPrompt } from '../src/lib/ai/knowledge';
import { buildAiScope } from '../src/lib/ai/scope';
import { dataApi } from '../src/lib/data';
import { db as demoDb } from '../src/lib/data/demo-store';
import { DEFAULT_SITE_SETTINGS, type BranchWithCount } from '../src/lib/types';

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
  // admin access — permissions + branch supervision (new fields)
  '[[QUERY]] {"table":"admins"}',
  '[[QUERY]] {"table":"admins","fields":["name","branches"],"where":[{"field":"branches","op":"contains","value":"Northern"}]}',
  '[[QUERY]] {"table":"admins","fields":["name","menus"],"where":[{"field":"menus","op":"contains","value":"Attendance"}]}',
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

// ---------------------------------------------------------------------------
// fixtures: the demo seed, once — super scope + a single-branch admin scope
// ---------------------------------------------------------------------------
const [allSites, employees, cancelled] = await Promise.all([
  dataApi.listSites(),
  dataApi.listEmployees(),
  dataApi.listCancelledEmployees(),
]);
const allBranches: BranchWithCount[] = demoDb.branches.map((b) => ({
  ...b, site_count: 0, employee_count: 0,
}));
const hostBranchId = allSites.find((s) => s.branch_id)?.branch_id ?? null;
const grantedBranches = hostBranchId
  ? allBranches.filter((b) => b.id === hostBranchId)
  : [];

const superScope = buildAiScope({
  viewerName: 'Super Admin', viewerRole: 'super_admin', unrestricted: true,
  branches: allBranches, allSites, assignedSiteIds: new Set(),
  employees, cancelledEmployees: cancelled,
});
const branchScope = buildAiScope({
  viewerName: 'Branch Admin', viewerRole: 'admin', unrestricted: false,
  branches: grantedBranches, allSites, assignedSiteIds: new Set(),
  employees, cancelledEmployees: cancelled,
});

console.log(`\n=== SCOPE FIXTURES ===`);
console.log(`super scope: ${employees.length} employees, ${allSites.length} sites, ${allBranches.length} branches`);
console.log(`branch scope: granted ${grantedBranches.map((b) => b.name).join(', ') || '(none!)'} → `
  + `${branchScope.employees.length} employees, ${branchScope.sites.length} sites`);
if (grantedBranches.length === 0) {
  console.log('FAIL: demo seed has no branch-owned site — cannot test branch scoping');
  failures += 1;
}

// ---------------------------------------------------------------------------
// system prompt sanity (super scope): snapshot must now carry the cancellation
// date + the query dictionary + the full admin directory
// ---------------------------------------------------------------------------
const kb = await buildAiKnowledgeBase(superScope);
const prompt = buildAiSystemPrompt(kb, {
  ...DEFAULT_SITE_SETTINGS, id: 1, logo_url: null, ai_api_key_masked: '',
} as never, superScope);
const checks: [string, boolean][] = [
  ['snapshot carries CANCELLED EMPLOYEES section', prompt.includes('CANCELLED EMPLOYEES')],
  ['cancelled directory line carries the cancellation date', /cancelled \d{4}-\d{2}-\d{2}/.test(prompt)],
  ['cancellation requests carry reviewed_at date', /reviewed \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(prompt)],
  ['query dictionary embedded (DATABASE QUERY ENGINE)', prompt.includes('DATABASE QUERY ENGINE')],
  ['dictionary lists cancellation_requests', prompt.includes('- cancellation_requests —')],
  ['dictionary lists every table (25 total)', (prompt.match(/^- [a-z_]+ —/gm) ?? []).length >= 25],
  ['worked example mentions the cancellation-date semantics', prompt.includes('IS the cancellation date')],
  ['ADMINS section carries menu permissions', /ADMINS \(\d+\)[\s\S]*?menus:/.test(prompt)],
  ['ADMINS section carries branch supervision', /supervises branches: [^\n]+Branch/.test(prompt)],
  ['ADMINS section carries direct site access', /direct site access:/.test(prompt)],
  ['super-admin line says access EVERYTHING', /SUPER ADMIN[\s\S]*?access: EVERYTHING/.test(prompt)],
  ['answer protocol asks for markdown tables', prompt.includes('markdown pipe table')],
  ['answer protocol covers admin questions', prompt.includes('Admin questions')],
  ['super prompt carries the VIEWER ACCESS SCOPE section', prompt.includes('=== VIEWER ACCESS SCOPE ===')],
];
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures += 1;
}
console.log(`\nsuper prompt chars: ${prompt.length} (proxy cap 150k)`);

// ---------------------------------------------------------------------------
// BRANCH-SCOPED Pebby — the whole point of this test
// ---------------------------------------------------------------------------
const outOfScopeSite = allSites.find((s) => !branchScope.siteIds?.has(s.id));
const outOfScopeEmployee = employees.find((e) => !branchScope.employeeIds?.has(e.id));

const scopedChecks: [string, boolean][] = [];

// 1. scoped employees query never returns another branch's employees
const scopedEmp = await runAiQuery({ table: 'employees', limit: 200 }, branchScope);
const scopedEmpCodes = [...scopedEmp.matchAll(/employee_code: ([A-Z0-9-]+)/g)].map((m) => m[1]);
scopedChecks.push([
  `scoped employees query stays inside the scope (${scopedEmpCodes.length} rows)`,
  scopedEmpCodes.length > 0 && scopedEmpCodes.every((c) => branchScope.employeeByCodeInScope(c)),
]);
if (outOfScopeEmployee) {
  scopedChecks.push([
    `scoped query drops out-of-scope employee ${outOfScopeEmployee.employee_code}`,
    !scopedEmp.includes(`employee_code: ${outOfScopeEmployee.employee_code}`),
  ]);
  // 2. the working_hours guard rejects out-of-scope employee ids
  const whGuard = await runAiQuery({ table: 'working_hours', employee_id: outOfScopeEmployee.id }, branchScope);
  scopedChecks.push([
    'working_hours of an out-of-scope employee is blocked',
    whGuard.includes('outside your branch'),
  ]);
}

// 3. org-wide tables are super-only
for (const t of ['admins', 'monthly_attendance_summary']) {
  const res = await runAiQuery({ table: t, ...(t === 'monthly_attendance_summary' ? {} : {}) }, branchScope);
  scopedChecks.push([
    `org-wide table "${t}" is blocked for the branch admin`,
    res.includes("outside this viewer's branch access"),
  ]);
}

// 4. the scoped snapshot + prompt carry only in-scope data
const scopedKb = await buildAiKnowledgeBase(branchScope);
const scopedPrompt = buildAiSystemPrompt(scopedKb, {
  ...DEFAULT_SITE_SETTINGS, id: 1, logo_url: null, ai_api_key_masked: '',
} as never, branchScope);
scopedChecks.push([
  'scoped prompt carries the VIEWER ACCESS SCOPE section naming the granted branch',
  scopedPrompt.includes('=== VIEWER ACCESS SCOPE ===')
    && grantedBranches.every((b) => scopedPrompt.includes(b.name)),
]);
scopedChecks.push([
  'scoped prompt replaces the admin directory with the viewer\'s own access',
  scopedPrompt.includes('ADMIN DIRECTORY — not available') && !/ADMINS \(\d+\)/.test(scopedPrompt),
]);
if (outOfScopeSite) {
  scopedChecks.push([
    `scoped prompt never mentions the out-of-scope site "${outOfScopeSite.name}"`,
    !scopedPrompt.includes(outOfScopeSite.name),
  ]);
}
if (outOfScopeEmployee) {
  scopedChecks.push([
    `scoped prompt never mentions the out-of-scope employee ${outOfScopeEmployee.employee_code}`,
    !scopedPrompt.includes(outOfScopeEmployee.employee_code),
  ]);
  scopedChecks.push([
    'scoped prompt never mentions the out-of-scope employee by name',
    !scopedPrompt.includes(outOfScopeEmployee.full_name),
  ]);
}

// 5. the scoped salary sheet totals are recomputed from in-scope rows only
const scopedSalary = await runAiQuery({
  table: 'salary_sheet',
  month: new Date().toISOString().slice(0, 7),
}, branchScope);
scopedChecks.push([
  'scoped salary query runs (or reports no sheet) without leaking other branches',
  scopedSalary.startsWith('DATABASE QUERY')
    && scopedSalary.includes("scoped to the viewer's branch access"),
]);

// 6. the scoped dictionary drops the org-wide tables
const scopedDoc = queryableTablesDoc(branchScope);
scopedChecks.push([
  'scoped dictionary drops the admins / monthly_attendance_summary tables',
  !scopedDoc.includes('- admins —') && !scopedDoc.includes('- monthly_attendance_summary —')
    && scopedDoc.includes("LIMITED TO THE VIEWER'S BRANCH ACCESS"),
]);
const superDoc = queryableTablesDoc(superScope);
scopedChecks.push([
  'super dictionary still lists the org-wide tables',
  superDoc.includes('- admins —') && superDoc.includes('- monthly_attendance_summary —'),
]);

// 7. attendance aggregate cannot count another branch's rows
const scopedAtt = await runAiQuery({
  table: 'attendance', month: new Date().toISOString().slice(0, 7), aggregate: 'count',
}, branchScope);
const superAtt = await runAiQuery({
  table: 'attendance', month: new Date().toISOString().slice(0, 7), aggregate: 'count',
}, superScope);
const attScopedCount = Number(/count = (\d+)/.exec(scopedAtt)?.[1] ?? -1);
const attSuperCount = Number(/count = (\d+)/.exec(superAtt)?.[1] ?? -1);
scopedChecks.push([
  `scoped attendance count (${attScopedCount}) ≤ super count (${attSuperCount})`,
  attScopedCount >= 0 && attSuperCount >= 0 && attScopedCount <= attSuperCount,
]);

for (const [label, ok] of scopedChecks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) failures += 1;
}
console.log(`\nscoped prompt chars: ${scopedPrompt.length} (proxy cap 150k)`);

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
if (failures > 0 || scopedPrompt.includes('queryableTablesDoc()')) process.exit(1);
