// Logic test for the Working Hours module — exercises demoApi.getEmployeeWorkingHours
// (the mirror of the get_employee_working_hours Postgres RPC) against controlled
// scenarios from the feature spec. Run: bunx tsx tests/working-hours.test.ts
import { demoApi } from '../src/lib/data/demo-api';
import { db } from '../src/lib/data/demo-store';
import type { Attendance, Employee, EmployeeInput, Site } from '../src/lib/types';

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};
const eq = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

const T0 = '2026-10-01T00:00:00.000Z';
const site = (id: string, name: string): Site =>
  ({ id, name, client_name: null, project_name: null, supervisor: null, is_active: true, created_at: T0 });

const emp = (id: string, name: string, siteId: string | null, opening = 0): Employee => ({
  id, full_name: name, employee_code: `PUL-2026-${id}`, nationality: null, date_of_birth: null,
  phone: null, email: null, address: null, emergency_contact: null, position: null, join_date: null,
  company_name: null, passport_number: null, passport_status: null, id_number: null, id_status: null,
  current_site_id: siteId, camp_id: null, camp_block: null, camp_room: null, rating: 5,
  status: 'active', photo: null, is_team_leader: false, team_leader_site_id: null,
  opening_hours: opening, created_at: T0, updated_at: T0,
});

let attSeq = 0;
const att = (employeeId: string, date: string, hours: number | null, at = T0, hidden = false): Attendance => ({
  id: `a${++attSeq}`, employee_id: employeeId, date,
  status: hours == null ? 'absent' : 'present', hours, is_hidden: hidden, created_at: at,
});

function reset(): void {
  db.profiles = []; db.sites = []; db.camps = []; db.employees = []; db.attendance = [];
  db.notifications = []; db.warnings = []; db.fines = []; db.leaveRequests = [];
  db.cancellationRequests = []; db.uniforms = []; db.menuPermissions = [];
  db.siteAssignments = []; db.siteTransfers = []; db.counters = { uniform_id: 0, token_number: 0 };
}

async function main(): Promise<void> {
// ---------------------------------------------------------------------------
console.log('— Scenario 1: mid-month transfer + the "marked before the move" rule');
reset();
const S1 = site('s1', 'Site A');
const S2 = site('s2', 'Site B');
db.sites = [S1, S2];
const E1 = emp('e1', 'Transfer Worker', 's1', 2000);
db.employees = [E1];
// Oct 1–15 at Site A (10h/day) — Oct 15 was marked at 17:00, BEFORE the 20:00 move
for (let d = 1; d <= 15; d++) {
  const dd = String(d).padStart(2, '0');
  db.attendance.push(att('e1', `2026-10-${dd}`, 10, `2026-10-${dd}T17:00:00.000Z`));
}
// move Site A → Site B effective Oct 15, recorded Oct 15 at 20:00 → displays from Oct 16
db.siteTransfers.push({
  id: 't1', employee_id: 'e1', from_site_id: 's1', to_site_id: 's2',
  effective_date: '2026-10-15', created_at: '2026-10-15T20:00:00.000Z',
});
// Oct 16–31 at Site B (10h/day, each marked after the move was recorded)
for (let d = 16; d <= 31; d++) {
  const dd = String(d).padStart(2, '0');
  db.attendance.push(att('e1', `2026-10-${dd}`, 10, `2026-10-${dd}T17:00:00.000Z`));
}
{
  const r = await demoApi.getEmployeeWorkingHours('e1');
  check('opening balance reported as-is', eq(r.openingHours, 2000), `got ${r.openingHours}`);
  check('Oct 15 stays at Site A (marked before the move)', eq(r.monthlyBreakdown[0].sites.find((s) => s.siteId === 's1')!.totalHours, 150), `got ${r.monthlyBreakdown[0].sites.find((s) => s.siteId === 's1')?.totalHours}`);
  check('Site B gets Oct 16–31 (160 hrs)', eq(r.monthlyBreakdown[0].sites.find((s) => s.siteId === 's2')!.totalHours, 160));
  check('month total = Σ site totals (310)', eq(r.monthlyBreakdown[0].totalHours, 310), `got ${r.monthlyBreakdown[0].totalHours}`);
  check('attendance days = 31', r.monthlyBreakdown[0].attendanceDays === 31, `got ${r.monthlyBreakdown[0].attendanceDays}`);
  check('tracked = 310', eq(r.trackedHours, 310));
  check('lifetime = 2000 + 310 = 2310', eq(r.lifetimeHours, 2310), `got ${r.lifetimeHours}`);
  check('lifetime = opening + Σ months (reconciliation)', eq(r.lifetimeHours, r.openingHours + r.monthlyBreakdown.reduce((n, m) => n + m.totalHours, 0)));
}

// ---------------------------------------------------------------------------
console.log('— Scenario 2: hidden records, absent days, decimals, corrections');
reset();
db.sites = [S1];
const E2 = emp('e2', 'Decimal Worker', 's1', 0);
db.employees = [E2];
db.attendance = [
  att('e2', '2026-10-01', 8.5),
  att('e2', '2026-10-02', 10.25),
  att('e2', '2026-10-03', null),          // absent → zero hours, not a worked day
  att('e2', '2026-10-04', 10, T0, true),  // hidden → excluded entirely
  att('e2', '2026-10-05', 0),             // zero-hour record → no hours, not a worked day
];
{
  const r = await demoApi.getEmployeeWorkingHours('e2');
  check('decimals preserved (8.5 + 10.25 = 18.75)', eq(r.trackedHours, 18.75), `got ${r.trackedHours}`);
  check('absent / hidden / zero days not counted (2 days)', r.monthlyBreakdown[0].attendanceDays === 2, `got ${r.monthlyBreakdown[0].attendanceDays}`);
  check('hidden record excluded from totals', !eq(r.trackedHours, 28.75));
  check('lifetime = tracked when opening is 0', eq(r.lifetimeHours, 18.75));

  // correction 10 → 8 on a fresh visible record
  db.attendance.push(att('e2', '2026-10-06', 10));
  const before = (await demoApi.getEmployeeWorkingHours('e2')).trackedHours; // 28.75
  db.attendance[db.attendance.length - 1].hours = 8;
  const after = (await demoApi.getEmployeeWorkingHours('e2')).trackedHours;  // 26.75
  check('correcting 10 → 8 lowers the total by exactly 2', eq(before - after, 2), `${before} → ${after}`);
}

// ---------------------------------------------------------------------------
console.log('— Scenario 3: opening balance only (no attendance history)');
reset();
db.sites = [S1];
db.employees = [emp('e3', 'Legacy Worker', 's1', 920)];
{
  const r = await demoApi.getEmployeeWorkingHours('e3');
  check('lifetime = opening (920)', eq(r.lifetimeHours, 920));
  check('tracked = 0', eq(r.trackedHours, 0));
  check('monthly breakdown empty (never invent history)', r.monthlyBreakdown.length === 0);
}

// ---------------------------------------------------------------------------
console.log('— Scenario 4: multiple months, newest first, cross-month invariants');
reset();
db.sites = [S1, S2];
const E4 = emp('e4', 'Long Haul', 's2', 100);
db.employees = [E4];
// September at Site A, October at Site B (move effective Oct 1)
db.siteTransfers.push({
  id: 't4', employee_id: 'e4', from_site_id: 's1', to_site_id: 's2',
  effective_date: '2026-10-01', created_at: '2026-10-01T08:00:00.000Z',
});
db.attendance = [
  att('e4', '2026-09-28', 10), att('e4', '2026-09-29', 10), att('e4', '2026-09-30', 10),
  // October days marked AFTER the move was recorded → they belong to Site B
  att('e4', '2026-10-01', 8, '2026-10-02T09:00:00.000Z'), att('e4', '2026-10-02', 8, '2026-10-02T09:00:00.000Z'),
];
{
  const r = await demoApi.getEmployeeWorkingHours('e4');
  check('newest month first', r.monthlyBreakdown[0].month === 10 && r.monthlyBreakdown[1].month === 9);
  check('September attributed to Site A (30)', eq(r.monthlyBreakdown[1].sites[0].siteId === 's1' ? r.monthlyBreakdown[1].sites[0].totalHours : 0, 30));
  check('October attributed to Site B (16)', eq(r.monthlyBreakdown[0].sites[0].siteId === 's2' ? r.monthlyBreakdown[0].sites[0].totalHours : 0, 16));
  check('lifetime = opening + Σ all months (146)', eq(r.lifetimeHours, 146), `got ${r.lifetimeHours}`);
  check('every month reconciles (Σ sites = month total)',
    r.monthlyBreakdown.every((m) => eq(m.totalHours, m.sites.reduce((n, s) => n + s.totalHours, 0))));
}

// ---------------------------------------------------------------------------
console.log('— Scenario 5: create / update flows and visibility rules');
reset();
db.sites = [S1];
db.profiles = []; // no session → not a super admin
{
  // create with an opening balance
  const created = await demoApi.createEmployee({
    full_name: 'New Joiner', nationality: null, date_of_birth: null, phone: null, email: null,
    address: null, emergency_contact: null, position: null, join_date: null, company_name: null,
    passport_number: null, passport_status: null, id_number: null, id_status: null,
    current_site_id: 's1', camp_id: null, camp_block: null, camp_room: null,
    photo: null, is_team_leader: false, team_leader_site_id: null, opening_hours: 1860.5,
  });
  check('create stores the opening balance (1860.5)', eq(created.opening_hours, 1860.5));
  const r = await demoApi.getEmployeeWorkingHours(created.id);
  check('new employee with opening, no attendance → lifetime = 1860.5', eq(r.lifetimeHours, 1860.5));

  // create without an opening balance starts at zero
  const fresh = await demoApi.createEmployee({
    full_name: 'Fresh Grad', nationality: null, date_of_birth: null, phone: null, email: null,
    address: null, emergency_contact: null, position: null, join_date: null, company_name: null,
    passport_number: null, passport_status: null, id_number: null, id_status: null,
    current_site_id: null, camp_id: null, camp_block: null, camp_room: null,
    photo: null, is_team_leader: false, team_leader_site_id: null, opening_hours: null,
  });
  check('blank opening on create → 0', eq((await demoApi.getEmployeeWorkingHours(fresh.id)).lifetimeHours, 0));

  // negative opening rejected
  let threw = false;
  try {
    await demoApi.createEmployee({
      full_name: 'Bad Input', nationality: null, date_of_birth: null, phone: null, email: null,
      address: null, emergency_contact: null, position: null, join_date: null, company_name: null,
      passport_number: null, passport_status: null, id_number: null, id_status: null,
      current_site_id: null, camp_id: null, camp_block: null, camp_room: null,
      photo: null, is_team_leader: false, team_leader_site_id: null, opening_hours: -5,
    });
  } catch { threw = true; }
  check('negative opening balance rejected on create', threw);

  // non-super (no session) cannot CHANGE an existing balance — but the same
  // value passes through untouched (form edit without changes)
  const base: EmployeeInput = {
    full_name: created.full_name, nationality: null, date_of_birth: null, phone: null, email: null,
    address: null, emergency_contact: null, position: null, join_date: null, company_name: null,
    passport_number: null, passport_status: null, id_number: null, id_status: null,
    current_site_id: 's1', camp_id: null, camp_block: null, camp_room: null,
    photo: null, is_team_leader: false, team_leader_site_id: null,
  };
  await demoApi.updateEmployee(created.id, { ...base, opening_hours: 1860.5 });
  check('unchanged opening balance passes through a normal edit',
    eq((await demoApi.getEmployeeWorkingHours(created.id)).openingHours, 1860.5));
  threw = false;
  try { await demoApi.updateEmployee(created.id, { ...base, opening_hours: 5000 }); }
  catch (err) {
    threw = err instanceof Error && err.message.includes('Only super admins');
  }
  check('changing the balance without super-admin rights is refused', threw);
  check('refused change did not alter the stored balance',
    eq((await demoApi.getEmployeeWorkingHours(created.id)).openingHours, 1860.5));

  // deleted employees are not reportable
  db.employees.push(emp('e6', 'Deleted Worker', 's1', 50));
  db.employees.find((e) => e.id === 'e6')!.status = 'deleted';
  threw = false;
  try { await demoApi.getEmployeeWorkingHours('e6'); } catch { threw = true; }
  check('deleted employee → report refused', threw);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
