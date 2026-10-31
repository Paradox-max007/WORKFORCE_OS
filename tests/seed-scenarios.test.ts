// Validates supabase/seed.sql END-TO-END: parses the generated SQL, rebuilds
// the dataset in memory, then runs the REAL app engine (src/lib/site-timeline)
// against it and asserts every demo scenario renders as documented.
// Run: bun tests/seed-scenarios.test.ts
import { buildMonthTimeline, getEmployeeSiteForDate, indexRecords } from '../src/lib/site-timeline';
import type { Attendance, SiteTransfer } from '../src/lib/types';
import { readFileSync } from 'node:fs';

const sql = readFileSync('supabase/seed.sql', 'utf8');
let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

// ---- parse sites -----------------------------------------------------------
const siteName = new Map(
  [...sql.matchAll(/insert into public\.site \(id, name, client_name, project_name\) values \('([^']+)', '([^']+)', '([^']+)', '([^']+)'\)/g)]
    .map((m) => [m[1], m[2]] as [string, string]),
);
const sites = new Set(siteName.keys());
const SITE1 = [...siteName.entries()].find(([, n]) => n === 'Marina Bay Tower')![0];
const SITE3 = [...siteName.entries()].find(([, n]) => n === 'Sheikh Zayed Metro Extension')![0];

// ---- parse employees -------------------------------------------------------
// Each employee insert is isolated by splitting on the insert header; its
// block ends at the first `now());`. current_site_id is derived from which
// SITE uuid the block contains (leaders repeat it as team_leader_site_id).
const employees: { id: string; code: string; name: string; site: string | null }[] = [];
for (const chunk of sql.split('insert into public.employee (')) {
  const head = chunk.match(/^id, full_name, employee_code[\s\S]*?values \('([^']+)', '([^']+)', '(ASM-[^']+)',/);
  if (!head) continue;
  const block = chunk.slice(0, chunk.indexOf('now());') + 7);
  const blockSites = [...sites].filter((s) => block.includes(`'${s}'`));
  employees.push({ id: head[1], name: head[2], code: head[3], site: blockSites[0] ?? null });
}
const byCode = (c: string) => employees.find((e) => e.code === c)!;

// ---- parse transfers -------------------------------------------------------
const transfers: SiteTransfer[] = [];
for (const m of sql.matchAll(/insert into public\.site_transfer \(employee_id, from_site_id, to_site_id, effective_date, created_at\) values \('([^']+)', (null|'[^']+'), (null|'[^']+'), '([^']+)', '([^']+)'\)/g)) {
  transfers.push({
    id: `t${transfers.length}`, employee_id: m[1],
    from_site_id: m[2] === 'null' ? null : m[2].slice(1, -1),
    to_site_id: m[3] === 'null' ? null : m[3].slice(1, -1),
    effective_date: m[4], created_at: m[5],
  });
}

// ---- parse attendance ------------------------------------------------------
const records: Attendance[] = [];
for (const m of sql.matchAll(/insert into public\.attendance \(employee_id, date, status, hours, created_at\) values \('([^']+)', '([^']+)', '(present|absent)', (null|\d+(?:\.\d+)?), '([^']+)'\)/g)) {
  records.push({
    id: `a${records.length}`, employee_id: m[1], date: m[2],
    status: m[3] as 'present' | 'absent',
    hours: m[4] === 'null' ? null : Number(m[4]),
    is_hidden: false, created_at: m[5],
  });
}

const recIdx = indexRecords(records);
const input = (empId: string, currentSiteId: string | null) => ({
  transfers, records: recIdx, currentSiteId,
});

console.log(`parsed: ${employees.length} employees, ${siteName.size} sites, ${transfers.length} transfers, ${records.length} attendance rows`);

console.log('\n— Data integrity');
check('22 employees parsed', employees.length === 22, `got ${employees.length}`);
check('4 sites parsed', siteName.size === 4);
check('5 transfers parsed (1 + 2 + 1 + 1)', transfers.length === 5, `got ${transfers.length}`);
check('every transfer employee exists', transfers.every((t) => employees.some((e) => e.id === t.employee_id)));
check('every transfer site id exists', transfers.every((t) => (t.from_site_id === null || sites.has(t.from_site_id)) && (t.to_site_id === null || sites.has(t.to_site_id))));
check('every attendance employee exists', records.every((r) => employees.some((e) => e.id === r.employee_id)));
const dupKey = records.length !== new Set(records.map((r) => `${r.employee_id}|${r.date}`)).size;
check('attendance (employee, date) unique — no conflict with the unique constraint', !dupKey);
check('every attendance date is a Sun–Thu workday', records.every((r) => [0, 1, 2, 3, 4].includes(new Date(`${r.date}T00:00:00`).getDay())));
check('employee codes are ASM-2026-001…022 in order', employees.every((e, i) => e.code === `ASM-2026-${String(i + 1).padStart(3, '0')}`));

console.log('\n— Scenario 1: Rahul Sharma (ASM-2026-019) — 25th at 5 PM marked, moved 25th at 8 PM');
{
  const e = byCode('ASM-2026-019');
  const inp = input(e.id, e.site);
  check('Oct 24 → Marina Bay Tower', getEmployeeSiteForDate(e.id, '2026-10-24', inp) === SITE1);
  check('Oct 25 → Marina Bay Tower (pre-marked before the move)', getEmployeeSiteForDate(e.id, '2026-10-25', inp) === SITE1);
  check('Oct 26 → Metro Extension', getEmployeeSiteForDate(e.id, '2026-10-26', inp) === SITE3);
  const tl = buildMonthTimeline(e.id, 2026, 10, inp);
  check('timeline: 2 segments split at day 26',
    tl.segments.length === 2 && tl.segments[0].siteId === SITE1 && tl.segments[0].toDay === 25
    && tl.segments[1].siteId === SITE3 && tl.segments[1].fromDay === 26,
    JSON.stringify(tl.segments));
  check('current_site_id = destination (Site 3)', e.site === SITE3);
}

console.log('\n— Scenario 2: Mohammed Yousuf (ASM-2026-020) — A → B → C chain');
{
  const e = byCode('ASM-2026-020');
  const tl = buildMonthTimeline(e.id, 2026, 10, input(e.id, e.site));
  const s2 = tl.segments[0].siteId, s4 = tl.segments[1].siteId, s1 = tl.segments[2].siteId;
  check('3 segments (1–9, 10–19, 20–31)',
    tl.segments.length === 3 && tl.segments[0].toDay === 9 && tl.segments[1].fromDay === 10 && tl.segments[1].toDay === 19 && tl.segments[2].fromDay === 20,
    JSON.stringify(tl.segments));
  check('chain is Desert Rose → Palm Villas → Marina Bay',
    siteName.get(s2!) === 'Desert Rose Mall' && siteName.get(s4!) === 'Palm Jumeirah Villas' && siteName.get(s1!) === 'Marina Bay Tower');
  check('current_site_id = final destination (Marina Bay)', e.site === SITE1);
}

console.log('\n— Scenario 3: Aung San (ASM-2026-021) — Site 3 → idle on Oct 18');
{
  const e = byCode('ASM-2026-021');
  const inp = input(e.id, e.site);
  check('Oct 17 → Metro', getEmployeeSiteForDate(e.id, '2026-10-17', inp) === SITE3);
  check('Oct 18 → null (idle)', getEmployeeSiteForDate(e.id, '2026-10-18', inp) === null);
  const tl = buildMonthTimeline(e.id, 2026, 10, inp);
  check('2 segments, second is idle 18–31',
    tl.segments.length === 2 && tl.segments[1].siteId === null && tl.segments[1].fromDay === 18);
  check('no attendance after going idle', !records.some((r) => r.employee_id === e.id && r.date >= '2026-10-18'));
  check('current_site_id = null', e.site === null);
}

console.log('\n— Scenario 4: Bilal Akhtar (ASM-2026-022) — idle → Palm Villas on Oct 15');
{
  const e = byCode('ASM-2026-022');
  const inp = input(e.id, e.site);
  const palm = getEmployeeSiteForDate(e.id, '2026-10-15', inp);
  check('Oct 14 → null (idle)', getEmployeeSiteForDate(e.id, '2026-10-14', inp) === null);
  check('Oct 15 → Palm Villas', palm !== null && siteName.get(palm!) === 'Palm Jumeirah Villas');
  const tl = buildMonthTimeline(e.id, 2026, 10, inp);
  check('2 segments, first idle 1–14', tl.segments.length === 2 && tl.segments[0].siteId === null && tl.segments[0].toDay === 14);
}

console.log('\n— Scenario 5: regular employees stay single-segment at their site');
{
  for (const c of ['ASM-2026-002', 'ASM-2026-008', 'ASM-2026-016', 'ASM-2026-018']) {
    const e = byCode(c);
    const tl = buildMonthTimeline(e.id, 2026, 10, input(e.id, e.site));
    check(`${c}: single segment at own site, not transferred`,
      tl.segments.length === 1 && tl.segments[0].siteId === e.site && !tl.transferred);
  }
  check('ASM-2026-018 (Faisal) is idle with no records', byCode('ASM-2026-018').site === null
    && !records.some((r) => r.employee_id === byCode('ASM-2026-018').id));
}

console.log('\n— Scenario 6: absence streak employee has matching auto-warning');
{
  const e = byCode('ASM-2026-011');
  const abs = records.filter((r) => r.employee_id === e.id && r.status === 'absent').map((r) => r.date).sort();
  check('absent exactly Oct 5–7', abs.join(',') === '2026-10-05,2026-10-06,2026-10-07', abs.join(','));
  check('seed contains the matching auto-warning row',
    sql.includes('Auto-generated: 3 consecutive absences detected (2026-10-05, 2026-10-06, 2026-10-07)'));
}

console.log('\n— Scenario 7: sick-leave employee (ASM-2026-003) has Oct 12–13 blank');
{
  const e = byCode('ASM-2026-003');
  check('no records on Oct 12/13', !records.some((r) => r.employee_id === e.id && (r.date === '2026-10-12' || r.date === '2026-10-13')));
  check('approved sick leave row exists for those dates',
    /'sick', null, '2026-10-12', '2026-10-13'/.test(sql));
}

console.log('\n— Scenario 8: seed integrity extras');
{
  check('3 auth users seeded', (sql.match(/insert into auth\.users /g) ?? []).length === 3);
  check('3 identities seeded', (sql.match(/insert into auth\.identities /g) ?? []).length === 3);
  check('roles fixed (super_admin + 2 admins)',
    sql.includes("set role = 'super_admin'") && sql.includes("set role = 'admin'"));
  check('admin A gets both sites, admin B only Metro',
    /\(v_admin_a, '[^']+'\), \(v_admin_a, '[^']+'\),\s*\n?\s*\(v_admin_b, '[^']+'\);/.test(sql));
  check('idempotency guard present (marker site check)', sql.includes("where name = 'Marina Bay Tower'"));
  check('schema guard present', sql.includes('Run supabase/schema.sql first'));
  check('5 uniform entries', (sql.match(/insert into public\.uniform_registry/g) ?? []).length === 5);
  check('one overdue renewal (April entry)', /'2026-04-\d+[^']*', '\{[^}]*\}'|'2026-04-/.test(sql) || sql.includes("2026-04-10"));
  check('pending cancellation request for ASM-2026-016', /'pending_deletion' where id =/.test(sql));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
