// Logic test for the Trade & Salary engine — exercises demo-salary
// (the TypeScript mirror of the calculate_employee_payroll /
// get_employee_salary_eligibility Postgres RPCs) against the confirmed business
// rules and the example table from the specification.
//
// Run: bunx tsx tests/salary-engine.test.ts
import { db, type DemoTradeRate } from '../src/lib/data/demo-store';
import {
  addMonthsClamped, calcEligibility, calcEmployeePayroll,
} from '../src/lib/data/demo-salary';
import type {
  Attendance, Employee, ExperienceTier, SalaryRole, Site, Trade, TradeRate,
} from '../src/lib/types';

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.error(`  \u2717 ${name} ${detail}`); }
};
const eq = (a: number, b: number, eps = 0.005): boolean => Math.abs(a - b) < eps;

const T0 = '2026-01-01T00:00:00.000Z';
const site = (id: string, name: string): Site =>
  ({ id, name, client_name: null, project_name: null, supervisor: null, is_active: true, created_at: T0 });

const emp = (id: string, name: string, siteId: string | null, opening = 0, join = '2026-01-01', tradeId: string | null = null): Employee => ({
  id, full_name: name, employee_code: `PUL-2026-${id}`, nationality: null, date_of_birth: null,
  phone: null, email: null, address: null, emergency_contact: null, position: null, join_date: join,
  company_name: null, passport_number: null, passport_status: null, id_number: null, id_status: null,
  current_site_id: siteId, camp_id: null, camp_block: null, camp_room: null, rating: 5,
  status: 'active', photo: null, is_team_leader: false, team_leader_site_id: null,
  opening_hours: opening, trade_id: tradeId, salary_role: 'standard', payment_type: null, card_type_id: null,
  created_at: `${join}T00:00:00.000Z`, updated_at: T0,
});

let attSeq = 0;
const att = (employeeId: string, date: string, hours: number | null, hidden = false, at = T0): Attendance => ({
  id: `a${++attSeq}`, employee_id: employeeId, date,
  status: hours == null ? 'absent' : 'present', hours, is_hidden: hidden, created_at: at,
});

const trade = (id: string, name: string): Trade =>
  ({ id, name, description: null, is_active: true, created_at: T0, updated_at: T0 });

const rate = (
  tradeId: string, role: SalaryRole, tier: ExperienceTier, hourly: number,
  from = '2026-01-01', to: string | null = null,
): DemoTradeRate => ({
  id: `r-${tradeId}-${role}-${tier}-${from}`, trade_id: tradeId, salary_role: role,
  experience_tier: tier, hourly_rate: hourly, effective_from: from, effective_to: to,
  created_by: null, created_at: T0,
});

/** Electrician trade with the spec example rates: standard 8/10 (+1 leader, +2 supervisor). */
const ELECTRICIAN_RATES = (tradeId: string): DemoTradeRate[] =>
  (['standard', 'team_leader', 'supervisor'] as SalaryRole[]).flatMap((role, i) =>
    (['below_threshold', 'qualified'] as ExperienceTier[]).map((tier) =>
      rate(tradeId, role, tier, (tier === 'below_threshold' ? 8 : 10) + i)));

function reset(): void {
  db.profiles = []; db.sites = []; db.camps = []; db.employees = []; db.attendance = [];
  db.notifications = []; db.warnings = []; db.fines = []; db.leaveRequests = [];
  db.cancellationRequests = []; db.uniforms = []; db.menuPermissions = [];
  db.siteAssignments = []; db.siteTransfers = []; db.counters = { uniform_id: 0, token_number: 0 };
  db.trades = []; db.tradeRates = []; db.salaryAssignments = [];
  db.payrollPeriods = []; db.payrollEmployees = []; db.payrollSites = [];
  db.payrollLines = []; db.payrollAudit = []; db.tradeRateAudit = [];
}

const rangeDates = (start: [number, number, number], count: number): string[] => {
  const out: string[] = [];
  let [y, m, d] = start;
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    d += 1;
    const dim = new Date(y, m, 0).getDate();
    if (d > dim) { d = 1; m += 1; if (m > 12) { m = 1; y += 1; } }
  }
  return out;
};

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  console.log('\u2014 Calendar-month arithmetic (six-month milestone)');
  check('Aug 31 + 6 months = Feb 28 (clamped)', addMonthsClamped('2025-08-31', 6) === '2026-02-28');
  check('Aug 31 + 6 months in leap year = Feb 29', addMonthsClamped('2023-08-31', 6) === '2024-02-29');
  check('Jan 31 + 6 months = Jul 31', addMonthsClamped('2026-01-31', 6) === '2026-07-31');
  check('Feb 29 + 6 months = Aug 29', addMonthsClamped('2024-02-29', 6) === '2024-08-29');

  // -------------------------------------------------------------------------
  console.log('\u2014 Spec \u00a71.2 example table: eligibility routes');
  reset();
  const TR = trade('tr1', 'Electrician');
  db.trades = [TR];
  db.tradeRates = ELECTRICIAN_RATES(TR.id);
  db.sites = [site('s1', 'Site A')];

  // 300 hours, 2 months employed → below-threshold rate
  db.employees = [emp('e1', 'Worker', 's1', 292, '2026-01-01', TR.id)];
  db.attendance = [att('e1', '2026-03-01', 8)];
  let e = calcEligibility(db, 'e1', '2026-03-02');
  check('300 h / 2 months → not qualified', !e.qualified);
  check('1,000 h progress shown independently (300/1000 = 30%)',
    eq(e.hours_to_threshold, 700) && eq(e.progress_percent, 30));

  // 996 hours before a 10-hour shift → 4 hours at old rate, 6 at qualified
  reset();
  db.trades = [TR];
  db.tradeRates = ELECTRICIAN_RATES(TR.id);
  db.sites = [site('s1', 'Site A')];
  db.employees = [emp('e1', 'SplitShift', 's1', 996, '2026-01-01', TR.id)];
  db.attendance = [att('e1', '2026-06-01', 10)];
  e = calcEligibility(db, 'e1', '2026-06-02');
  check('1,000 h / 3 months → qualified via thousand_hours', e.qualified && e.qualification_reason === 'thousand_hours');
  check('qualification date = crossing date', e.qualification_date === '2026-06-01');
  const calc1 = calcEmployeePayroll(db, 'e1', 2026, 6);
  const below = calc1.lines.find((l) => l.experience_tier === 'below_threshold');
  const qual = calc1.lines.find((l) => l.experience_tier === 'qualified');
  check('996 h before a 10 h shift → split 4 + 6', eq(below?.hours ?? -1, 4) && eq(qual?.hours ?? -1, 6));
  check('split gross = 4\u00d78 + 6\u00d710 = 92', eq(calc1.gross_salary, 92));

  // 700 hours, 6 months employed → qualified from six-month anniversary (whole day)
  reset();
  db.trades = [TR];
  db.tradeRates = ELECTRICIAN_RATES(TR.id);
  db.sites = [site('s1', 'Site A')];
  db.employees = [emp('e2', 'SixMonther', 's1', 700, '2026-01-15', TR.id)];
  // anniversary = 2026-07-15; work on Jul 14 (below) and Jul 15 (qualified)
  db.attendance = [att('e2', '2026-07-14', 8), att('e2', '2026-07-15', 8)];
  e = calcEligibility(db, 'e2', '2026-07-15');
  check('700 h + 6 months → qualified via six_months', e.qualified && e.qualification_reason === 'six_months');
  check('six-month date = Jan 15 + 6 = Jul 15', e.six_month_date === '2026-07-15');
  const calc2 = calcEmployeePayroll(db, 'e2', 2026, 7);
  const jul14 = calc2.lines.find((l) => l.date === '2026-07-14');
  const jul15 = calc2.lines.find((l) => l.date === '2026-07-15');
  check('Jul 14 at below-threshold rate', jul14?.experience_tier === 'below_threshold' && eq(jul14.hourly_rate, 8));
  check('Jul 15 WHOLE day at qualified rate', jul15?.experience_tier === 'qualified' && eq(jul15.hourly_rate, 10));

  // 1,200 opening hours → qualified from employment start
  reset();
  db.trades = [TR];
  db.tradeRates = ELECTRICIAN_RATES(TR.id);
  db.sites = [site('s1', 'Site A')];
  db.employees = [emp('e3', 'Veteran', 's1', 1200, '2026-05-01', TR.id)];
  db.attendance = [att('e3', '2026-05-02', 8)];
  e = calcEligibility(db, 'e3', '2026-05-02');
  check('1,200 opening hours → qualified via opening_balance', e.qualified && e.qualification_reason === 'opening_balance');
  check('qualified from employment start', e.qualification_date === '2026-05-01');
  const calc3 = calcEmployeePayroll(db, 'e3', 2026, 5);
  check('all hours at qualified rate (lines exist)',
    calc3.lines.length > 0 && calc3.lines.every((l) => l.experience_tier === 'qualified'));

  // -------------------------------------------------------------------------
  console.log('\u2014 Global threshold across sites (spec \u00a74.2)');
  reset();
  const SA = site('sa', 'Site A');
  const SB = site('sb', 'Site B');
  db.sites = [SA, SB];
  db.trades = [TR];
  db.tradeRates = ELECTRICIAN_RATES(TR.id);
  // recent join so ONLY the hours route can qualify (six months not reached)
  db.employees = [emp('e5', 'GlobalHours', 'sb', 0, '2026-09-01', TR.id)];
  // Site A: 75 days \u00d7 8 h = 600 lifetime hours (Oct 1 – Dec 14)
  rangeDates([2026, 10, 1], 75).forEach((d) => db.attendance.push(att('e5', d, 8)));
  // move to Site B effective Dec 15
  db.siteTransfers.push({
    id: 't2', employee_id: 'e5', from_site_id: 'sa', to_site_id: 'sb',
    effective_date: '2026-12-15', created_at: '2026-12-15T20:00:00.000Z',
  });
  // Site B: Dec 15–31 (17d) + Jan (31d) at 8h = 384, Feb 1 (8h), Feb 2 (4h) → 396
  // Site B records must be MARKED AFTER the transfer was recorded (the
  // "marked before the move" rule keeps pre-marked days at the old site)
  const afterMove = '2026-12-16T09:00:00.000Z';
  rangeDates([2026, 12, 15], 48).forEach((d) => db.attendance.push(att('e5', d, 8, false, afterMove)));
  db.attendance.push(att('e5', '2027-02-01', 8, false, afterMove));
  db.attendance.push(att('e5', '2027-02-02', 4, false, afterMove));
  // final 10 h shift at Site B with 996 GLOBAL lifetime hours before it
  db.attendance.push(att('e5', '2027-02-03', 10, false, afterMove));

  const calc4 = calcEmployeePayroll(db, 'e5', 2027, 2);
  const febSiteB = calc4.lines.filter((l) => l.site_name === 'Site B');
  const febBelow = febSiteB.filter((l) => l.experience_tier === 'below_threshold').reduce((n, l) => n + l.hours, 0);
  const febQual = febSiteB.filter((l) => l.experience_tier === 'qualified').reduce((n, l) => n + l.hours, 0);
  check('Site A hours count toward the GLOBAL threshold (Feb: 16 h below + 6 h qualified)',
    eq(febBelow, 16) && eq(febQual, 6));
  check('Site B final shift split 4 below + 6 qualified',
    eq(febSiteB.find((l) => l.date === '2027-02-03' && l.experience_tier === 'below_threshold')?.hours ?? -1, 4)
    && eq(febSiteB.find((l) => l.date === '2027-02-03' && l.experience_tier === 'qualified')?.hours ?? -1, 6));
  check('gross = 16\u00d78 + 6\u00d710 = 188', eq(calc4.gross_salary, 188));
  const siteA = calc4.lines.filter((l) => l.site_name === 'Site A');
  check('no Site A lines inside the February payroll', siteA.length === 0);

  // -------------------------------------------------------------------------
  console.log('\u2014 Effective-dated rates & role changes mid-month');
  reset();
  db.sites = [site('s1', 'Site A')];
  db.trades = [TR];
  // rate changed on Nov 15: below 8 → 9, qualified 10 → 12
  (['standard', 'team_leader', 'supervisor'] as SalaryRole[]).forEach((role, i) => {
    (['below_threshold', 'qualified'] as ExperienceTier[]).forEach((tier) => {
      const base = tier === 'below_threshold' ? 8 : 10;
      db.tradeRates.push(rate(TR.id, role, tier, base + i, '2026-01-01', '2026-11-14'));
      db.tradeRates.push(rate(TR.id, role, tier, base + 1 + i, '2026-11-15', null));
    });
  });
  db.employees = [emp('e6', 'RateChange', 's1', 5000, '2020-01-01', TR.id)];
  db.attendance = [att('e6', '2026-11-14', 8), att('e6', '2026-11-15', 8)];
  const calc5 = calcEmployeePayroll(db, 'e6', 2026, 11);
  const nov14 = calc5.lines.find((l) => l.date === '2026-11-14');
  const nov15 = calc5.lines.find((l) => l.date === '2026-11-15');
  check('Nov 14 priced at the OLD qualified rate (10)', nov14 != null && eq(nov14.hourly_rate, 10));
  check('Nov 15 priced at the NEW qualified rate (11)', nov15 != null && eq(nov15.hourly_rate, 11));

  // role change mid-month: standard → supervisor, effective Nov 15
  reset();
  db.sites = [site('s1', 'Site A')];
  db.trades = [TR];
  db.tradeRates = ELECTRICIAN_RATES(TR.id);
  db.employees = [emp('e7', 'RoleChange', 's1', 5000, '2020-01-01', TR.id)];
  db.salaryAssignments.push({
    id: 'as1', employee_id: 'e7', trade_id: TR.id, salary_role: 'standard',
    effective_from: '2020-01-01', effective_to: '2026-11-14', created_by: null, created_at: T0,
  });
  db.salaryAssignments.push({
    id: 'as2', employee_id: 'e7', trade_id: TR.id, salary_role: 'supervisor',
    effective_from: '2026-11-15', effective_to: null, created_by: null, created_at: T0,
  });
  db.attendance = [att('e7', '2026-11-14', 8), att('e7', '2026-11-15', 8)];
  const calc6 = calcEmployeePayroll(db, 'e7', 2026, 11);
  const r1 = calc6.lines.find((l) => l.date === '2026-11-14');
  const r2 = calc6.lines.find((l) => l.date === '2026-11-15');
  check('Nov 14 at STANDARD qualified rate (10)', r1?.salary_role === 'standard' && eq(r1.hourly_rate, 10));
  check('Nov 15 at SUPERVISOR qualified rate (12)', r2?.salary_role === 'supervisor' && eq(r2.hourly_rate, 12));

  // -------------------------------------------------------------------------
  console.log('\u2014 Hidden records, unassigned trades & core invariants');
  reset();
  db.sites = [site('s1', 'Site A')];
  db.trades = [TR];
  db.tradeRates = ELECTRICIAN_RATES(TR.id);
  db.employees = [
    emp('e8', 'EdgeWorker', 's1', 0, '2026-10-01', TR.id),
    emp('e9', 'NoTrade', 's1', 0, '2026-10-01', null),
  ];
  db.attendance = [
    att('e8', '2026-10-05', 8),
    att('e8', '2026-10-06', 8, true),   // hidden — excluded
    att('e9', '2026-10-05', 6),          // no trade → unassigned
  ];
  const calc7 = calcEmployeePayroll(db, 'e8', 2026, 10);
  check('hidden attendance excluded', eq(calc7.total_hours, 8));
  const calc8 = calcEmployeePayroll(db, 'e9', 2026, 10);
  check('hours without trade → unassigned (no lines, no gross)',
    eq(calc8.total_hours, 6) && eq(calc8.unassigned_hours, 6) && calc8.lines.length === 0 && eq(calc8.gross_salary, 0));

  // -------------------------------------------------------------------------
  console.log('\u2014 Absent deduction: configurable rule (Deduction Management)');
  reset();
  db.sites = [site('s1', 'Site A')];
  db.trades = [TR];
  db.tradeRates = ELECTRICIAN_RATES(TR.id);
  db.employees = [emp('e10', 'Absentee', 's1', 0, '2026-01-01', TR.id)];
  // 5 absences + 1 worked day in October 2026
  db.attendance = [
    att('e10', '2026-10-01', null), att('e10', '2026-10-02', null),
    att('e10', '2026-10-05', null), att('e10', '2026-10-06', null),
    att('e10', '2026-10-07', null), att('e10', '2026-10-08', 8),
  ];

  // default rule (no settings row yet) — first 2 free, AED 25 each after
  delete (db as { deductionSettings?: unknown }).deductionSettings;
  let a = calcEmployeePayroll(db, 'e10', 2026, 10);
  check('default rule: 5 absences \u2192 (5\u22122)\u00d725 = 75', eq(a.absent_deduction, 75) && a.absent_count === 5);

  // configured rule: 3 free days, AED 10 each
  db.deductionSettings = { absent_free_days: 3, absent_deduction_amount: 10, updated_at: null, updated_by_name: null };
  a = calcEmployeePayroll(db, 'e10', 2026, 10);
  check('configured 3 free / AED 10: 5 absences \u2192 (5\u22123)\u00d710 = 20', eq(a.absent_deduction, 20));

  // configured rule: 0 free days, AED 5 each — every absence chargeable
  db.deductionSettings = { absent_free_days: 0, absent_deduction_amount: 5, updated_at: null, updated_by_name: null };
  a = calcEmployeePayroll(db, 'e10', 2026, 10);
  check('configured 0 free / AED 5: 5 absences \u2192 5\u00d75 = 25', eq(a.absent_deduction, 25));

  // generous rule: more free days than absences \u2192 no deduction
  db.deductionSettings = { absent_free_days: 6, absent_deduction_amount: 50, updated_at: null, updated_by_name: null };
  a = calcEmployeePayroll(db, 'e10', 2026, 10);
  check('6 free days vs 5 absences \u2192 0', eq(a.absent_deduction, 0));

  // restore the default rule for any later sections
  db.deductionSettings = {
    absent_free_days: 2, absent_deduction_amount: 25, updated_at: null, updated_by_name: null,
  };

  // Employee Gross = Σ Salary Lines (spec \u00a711 core invariant) across scenarios
  const inv1 = calc1.lines.reduce((n, l) => n + l.gross_amount, 0);
  const inv2 = calc4.lines.reduce((n, l) => n + l.gross_amount, 0);
  const inv3 = calc5.lines.reduce((n, l) => n + l.gross_amount, 0);
  check('Employee Gross = \u03a3 Salary Lines (all scenarios)',
    eq(inv1, calc1.gross_salary) && eq(inv2, calc4.gross_salary) && eq(inv3, calc5.gross_salary));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
