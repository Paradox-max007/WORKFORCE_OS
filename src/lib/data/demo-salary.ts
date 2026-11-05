// ============================================================================
// PULSE Workforce OS — Demo salary engine
// ----------------------------------------------------------------------------
// TypeScript mirror of the Postgres calculation engine defined in
// supabase/migrations/20261103_trade_salary_system.sql. Demo mode and
// production mode must return the same report structure and the same results:
//
//   • Eligibility is OR: join_date + 6 calendar months OR 1,000 lifetime
//     working hours (opening balance INCLUDED) — whichever happens first.
//   • The 1,000-hour threshold is GLOBAL (never per site) and splits a shift
//     mid-record; the six-month anniversary qualifies the whole day.
//   • Site attribution uses the same historical transfer logic as attendance
//     (getEmployeeSiteForDate) — never the employee's current site.
//   • Rates and trade/role assignments are effective-dated; payroll drafts
//     recalculate live, finalization locks the snapshot.
//
// The DATABASE remains the authoritative implementation in production; this
// module exists so the demo produces identical, explainable numbers.
// ============================================================================

import type {
  EmployeeSalaryAssignment,
  ExperienceTier,
  PayrollEmployeeSiteVM,
  PayrollEmployeeVM,
  PayrollPeriodVM,
  PayrollSalaryLineVM,
  SalaryEligibility,
  SalaryRole,
  SalarySheetReport,
  SalarySheetRowUpdate,
  SalarySheetSiteGroup,
  SalarySheetTotals,
  Trade,
  TradeRate,
} from '@/lib/types';
import { SALARY_THRESHOLD_HOURS, SALARY_THRESHOLD_MONTHS } from '@/lib/types';
import type { DemoDB } from './demo-store';
import { getEmployeeSiteForDate, indexRecords } from '@/lib/site-timeline';

// ---------------------------------------------------------------------------
// Date helpers (YYYY-MM-DD strings, local time)
// ---------------------------------------------------------------------------
export const localTodayYMD = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const ymdOf = (iso: string): string => (iso.length === 10 ? iso : iso.slice(0, 10));

/** Calendar-month arithmetic with month-end clamping (Aug 31 + 6 → Feb 28/29). */
export const addMonthsClamped = (ymd: string, months: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const lastDay = new Date(ty, tm, 0).getDate();
  return `${ty}-${String(tm).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
};

const monthStart = (year: number, month: number): string =>
  `${year}-${String(month).padStart(2, '0')}-01`;

const monthEnd = (year: number, month: number): string => {
  const last = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
};

export const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Effective-dated lookups
// ---------------------------------------------------------------------------

/** Trade + salary role applicable to the employee on a date (assignment first,
 *  falling back to the employee row — mirrors emp_trade_on_date). */
export const tradeOnDate = (
  database: DemoDB, employeeId: string, date: string,
): { trade_id: string | null; salary_role: SalaryRole } | null => {
  const emp = database.employees.find((e) => e.id === employeeId);
  if (!emp) return null;
  const a = [...database.salaryAssignments]
    .filter((x) => x.employee_id === employeeId
      && x.effective_from <= date
      && (x.effective_to == null || x.effective_to >= date))
    .sort((x, y) => (x.effective_from < y.effective_from ? 1 : -1))[0];
  if (a) return { trade_id: a.trade_id, salary_role: a.salary_role };
  return { trade_id: emp.trade_id ?? null, salary_role: emp.salary_role ?? 'standard' };
};

/** Effective hourly rate for a trade × role × tier on a date (null = unrated). */
export const rateOnDate = (
  database: DemoDB, tradeId: string, role: string, tier: string, date: string,
): number | null => {
  const r = [...database.tradeRates]
    .filter((x) => x.trade_id === tradeId
      && x.salary_role === role
      && x.experience_tier === tier
      && x.effective_from <= date
      && (x.effective_to == null || x.effective_to >= date))
    .sort((x, y) => (x.effective_from < y.effective_from ? 1 : -1))[0];
  return r ? r.hourly_rate : null;
};

/** Current (today) rates for every trade — for the Trade Management list. */
export const currentRatesOf = (database: DemoDB, tradeId: string): TradeRate[] => {
  const today = localTodayYMD();
  return database.tradeRates
    .filter((r) => r.trade_id === tradeId
      && r.effective_from <= today
      && (r.effective_to == null || r.effective_to >= today))
    .sort((a, b) => (a.salary_role === b.salary_role
      ? (a.experience_tier < b.experience_tier ? -1 : 1)
      : (a.salary_role < b.salary_role ? -1 : 1)))
    .map((r) => ({ ...r }));
};

/** All rates of one trade, newest-first per cell (rate editor history). */
export const rateHistoryOf = (database: DemoDB, tradeId: string): TradeRate[] =>
  [...database.tradeRates]
    .filter((r) => r.trade_id === tradeId)
    .sort((a, b) => (a.salary_role === b.salary_role
      ? (a.experience_tier === b.experience_tier
        ? (a.effective_from < b.effective_from ? 1 : -1)
        : (a.experience_tier < b.experience_tier ? -1 : 1))
      : (a.salary_role < b.salary_role ? -1 : 1)))
    .map((r) => ({ ...r }));

// ---------------------------------------------------------------------------
// Eligibility — Q = min(join + 6 months, date lifetime hours reach 1,000)
// ---------------------------------------------------------------------------
export const calcEligibility = (
  database: DemoDB, employeeId: string, asOf?: string,
): SalaryEligibility => {
  const emp = database.employees.find((e) => e.id === employeeId && e.status !== 'deleted');
  if (!emp) throw new Error('Employee not found');
  const asOfDate = asOf ?? localTodayYMD();
  const join = emp.join_date ?? ymdOf(emp.created_at);
  const sixMonthDate = addMonthsClamped(join, SALARY_THRESHOLD_MONTHS);
  const opening = emp.opening_hours ?? 0;

  const records = database.attendance
    .filter((a) => a.employee_id === employeeId && !a.is_hidden && a.hours != null && (a.hours as number) > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  let cum = opening;
  let thresholdDate: string | null = null;
  let tracked = 0;
  records.forEach((a) => {
    tracked += a.hours as number;
    if (thresholdDate == null && cum + (a.hours as number) >= SALARY_THRESHOLD_HOURS) {
      thresholdDate = a.date;
    }
    cum += a.hours as number;
  });
  const lifetime = round2(opening + tracked);

  let qualificationDate: string | null;
  let qualificationReason: SalaryEligibility['qualification_reason'] = null;
  if (opening >= SALARY_THRESHOLD_HOURS) {
    qualificationDate = join;
    qualificationReason = 'opening_balance';
  } else {
    const candidates: [string, SalaryEligibility['qualification_reason']][] = [
      [sixMonthDate, 'six_months'],
      ...(thresholdDate != null ? [[thresholdDate, 'thousand_hours'] as [string, SalaryEligibility['qualification_reason']]] : []),
    ];
    candidates.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    qualificationDate = candidates[0][0];
    qualificationReason = candidates[0][1];
  }

  const current = tradeOnDate(database, employeeId, asOfDate);
  const tradeId = current?.trade_id ?? null;
  const role = current?.salary_role ?? emp.salary_role ?? 'standard';
  const tradeName = tradeId ? database.trades.find((t) => t.id === tradeId)?.name ?? null : null;
  const qualifiedNow = qualificationDate != null && asOfDate >= qualificationDate;
  const currentRate = tradeId
    ? rateOnDate(database, tradeId, role, qualifiedNow ? 'qualified' : 'below_threshold', asOfDate)
    : null;

  return {
    employee_id: emp.id,
    full_name: emp.full_name,
    employee_code: emp.employee_code,
    join_date: emp.join_date ?? null,
    opening_hours: round2(opening),
    tracked_hours: round2(tracked),
    lifetime_hours: lifetime,
    six_month_date: sixMonthDate,
    threshold_hours: SALARY_THRESHOLD_HOURS,
    threshold_date: thresholdDate,
    hours_to_threshold: Math.max(0, round2(SALARY_THRESHOLD_HOURS - lifetime)),
    progress_percent: Math.min(100, round2((100 * lifetime) / SALARY_THRESHOLD_HOURS)),
    qualified: qualifiedNow,
    qualification_date: qualificationDate,
    qualification_reason: qualificationReason,
    as_of: asOfDate,
    trade_id: tradeId,
    trade_name: tradeName,
    salary_role: role,
    current_rate: currentRate,
  };
};

// ---------------------------------------------------------------------------
// THE CALCULATION ENGINE (mirrors calculate_employee_payroll)
// ---------------------------------------------------------------------------
export interface PayrollCalc {
  total_hours: number;
  opening_lifetime_hours: number;
  closing_lifetime_hours: number;
  unrated_hours: number;
  unassigned_hours: number;
  /** site key (site id or '__none__') → unassigned hours worked at that site */
  unassigned_sites: Map<string, number>;
  /** site key → unrated hours (trade but no effective rate) at that site */
  unrated_sites: Map<string, number>;
  gross_salary: number;
  lines: PayrollSalaryLineVM[];
}

const siteKeyOf = (siteId: string | null): string => siteId ?? '__none__';

const addToSiteMap = (map: Map<string, number>, siteId: string | null, hours: number): void => {
  const key = siteKeyOf(siteId);
  map.set(key, round2((map.get(key) ?? 0) + hours));
};

export const calcEmployeePayroll = (
  database: DemoDB, employeeId: string, year: number, month: number,
): PayrollCalc => {
  const emp = database.employees.find((e) => e.id === employeeId && e.status !== 'deleted');
  if (!emp) throw new Error('Employee not found');

  const start = monthStart(year, month);
  const end = monthEnd(year, month);
  const join = emp.join_date ?? ymdOf(emp.created_at);
  const sixMonthDate = addMonthsClamped(join, SALARY_THRESHOLD_MONTHS);
  const opening = emp.opening_hours ?? 0;

  const siteIndex = indexRecords(database.attendance);
  const records = database.attendance
    .filter((a) => a.employee_id === employeeId && !a.is_hidden
      && a.hours != null && (a.hours as number) > 0 && a.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  let cum = opening;               // lifetime hours BEFORE the current record
  let totalHours = 0;
  let openingLifetime = 0;
  let closingLifetime = 0;
  let unrated = 0;
  let unassigned = 0;
  const unassignedSites = new Map<string, number>();
  const unratedSites = new Map<string, number>();
  let gross = 0;
  const lines: PayrollSalaryLineVM[] = [];

  records.forEach((a) => {
    const hours = a.hours as number;
    const assignment = tradeOnDate(database, employeeId, a.date);
    const tradeId = assignment?.trade_id ?? null;
    const role = assignment?.salary_role ?? 'standard';

    // tier split at the qualification point
    const dayQualified = a.date >= sixMonthDate || cum >= SALARY_THRESHOLD_HOURS;
    let belowHours: number;
    let qualifiedHours: number;
    if (dayQualified) {
      belowHours = 0;
      qualifiedHours = hours;
    } else if (cum + hours >= SALARY_THRESHOLD_HOURS) {
      belowHours = round2(SALARY_THRESHOLD_HOURS - cum);
      qualifiedHours = round2(hours - belowHours);
    } else {
      belowHours = hours;
      qualifiedHours = 0;
    }
    cum = round2(cum + hours);

    if (a.date < start) {
      openingLifetime = cum;
      return;
    }
    totalHours = round2(totalHours + hours);
    closingLifetime = cum;

    const siteId = getEmployeeSiteForDate(employeeId, a.date, {
      transfers: database.siteTransfers,
      records: siteIndex,
      currentSiteId: emp.current_site_id ?? null,
    });

    if (tradeId == null) {
      unassigned = round2(unassigned + hours);
      // no trade: the hours still belong to the site where they were worked
      addToSiteMap(unassignedSites, siteId, hours);
      return;
    }
    const tradeName = database.trades.find((t) => t.id === tradeId)?.name ?? 'Unknown trade';
    const siteName = siteId
      ? database.sites.find((s) => s.id === siteId)?.name ?? 'No site'
      : 'No site';

    const segment = (tier: ExperienceTier, h: number): void => {
      if (h <= 0) return;
      const rate = rateOnDate(database, tradeId, role, tier, a.date);
      if (rate == null) {
        unrated = round2(unrated + h);
        addToSiteMap(unratedSites, siteId, h);
        return;
      }
      const amount = round2(h * rate);
      gross = round2(gross + amount);
      lines.push({
        site_id: siteId,
        site_name: siteName,
        date: a.date,
        trade_id: tradeId,
        trade_name: tradeName,
        salary_role: role,
        experience_tier: tier,
        hours: round2(h),
        hourly_rate: rate,
        gross_amount: amount,
      });
    };
    segment('below_threshold', belowHours);
    segment('qualified', qualifiedHours);
  });

  if (openingLifetime === 0) openingLifetime = opening;
  if (closingLifetime === 0) closingLifetime = openingLifetime;

  return {
    total_hours: round2(totalHours),
    opening_lifetime_hours: round2(openingLifetime),
    closing_lifetime_hours: round2(closingLifetime),
    unrated_hours: round2(unrated),
    unassigned_hours: round2(unassigned),
    unassigned_sites: unassignedSites,
    unrated_sites: unratedSites,
    gross_salary: gross,
    lines,
  };
};

// ---------------------------------------------------------------------------
// Payroll storage refresh (mirrors payroll_upsert_employee + generate)
// ---------------------------------------------------------------------------
export interface DemoPayrollPeriodRow {
  id: string;
  year: number;
  month: number;
  status: 'draft' | 'finalized';
  created_by: string | null;
  finalized_by: string | null;
  finalized_at: string | null;
  created_at: string;
}

export interface DemoPayrollEmployeeRow {
  id: string;
  payroll_period_id: string;
  employee_id: string;
  opening_lifetime_hours: number;
  closing_lifetime_hours: number;
  total_hours: number;
  unrated_hours: number;
  unassigned_hours: number;
  gross_salary: number;
  advance: number;
  deduction: number;
  net_salary: number;
  payment_status: 'unpaid' | 'paid';
  paid_at: string | null;
  paid_by: string | null;
  notes: string | null;
  trade_id_snapshot: string | null;
  salary_role_snapshot: SalaryRole;
  manually_edited: boolean;
}

export interface DemoPayrollSiteRow {
  id: string;
  payroll_employee_id: string;
  site_id: string | null;
  site_name_snapshot: string;
  total_hours: number;
  below_threshold_hours: number;
  qualified_hours: number;
  standard_hours: number;
  team_leader_hours: number;
  supervisor_hours: number;
  gross_salary: number;
  has_missing_rate: boolean;
  manually_edited: boolean;
}

export interface DemoPayrollLineRow {
  id: string;
  payroll_employee_id: string;
  site_id: string | null;
  site_name_snapshot: string;
  attendance_date: string;
  trade_id: string | null;
  trade_name_snapshot: string;
  salary_role_snapshot: SalaryRole;
  experience_tier: ExperienceTier;
  hours: number;
  hourly_rate: number;
  gross_amount: number;
}

const uidOf = (database: DemoDB): string =>
  // stable, local uid — mirrors the crypto uid used elsewhere in demo-store
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${database.payrollEmployees.length}`;

export const refreshPayrollEmployee = (
  database: DemoDB, period: DemoPayrollPeriodRow, employeeId: string,
  uidFn: () => string,
): void => {
  const emp = database.employees.find((e) => e.id === employeeId && e.status !== 'deleted');
  if (!emp) return;

  // THE SHEET RECORD HAS PRIORITY: a settlement edited by hand in the
  // Salary Sheet is never recalculated until resetPayrollEmployeeAuto.
  const existing = database.payrollEmployees.find(
    (x) => x.payroll_period_id === period.id && x.employee_id === employeeId,
  );
  if (existing?.manually_edited) return;

  const calc = calcEmployeePayroll(database, employeeId, period.year, period.month);

  // aggregate lines into site buckets (site-key = id or '__none__')
  interface SiteAgg {
    site_id: string | null; site_name: string;
    total_hours: number; below_threshold_hours: number; qualified_hours: number;
    standard_hours: number; team_leader_hours: number; supervisor_hours: number;
    gross_salary: number; has_missing_rate: boolean;
  }
  const buckets = new Map<string, SiteAgg>();
  const keyOf = (siteId: string | null): string => siteId ?? '__none__';
  const bucketOf = (siteId: string | null): SiteAgg => {
    const key = keyOf(siteId);
    let agg = buckets.get(key);
    if (!agg) {
      agg = {
        site_id: siteId,
        site_name: siteId
          ? database.sites.find((s) => s.id === siteId)?.name ?? 'No site'
          : 'No site',
        total_hours: 0, below_threshold_hours: 0, qualified_hours: 0,
        standard_hours: 0, team_leader_hours: 0, supervisor_hours: 0,
        gross_salary: 0, has_missing_rate: false,
      };
      buckets.set(key, agg);
    }
    return agg;
  };
  calc.lines.forEach((l) => {
    const agg = bucketOf(l.site_id);
    agg.total_hours = round2(agg.total_hours + l.hours);
    if (l.experience_tier === 'below_threshold') agg.below_threshold_hours = round2(agg.below_threshold_hours + l.hours);
    else if (l.experience_tier === 'qualified') agg.qualified_hours = round2(agg.qualified_hours + l.hours);
    if (l.salary_role === 'standard') agg.standard_hours = round2(agg.standard_hours + l.hours);
    else if (l.salary_role === 'team_leader') agg.team_leader_hours = round2(agg.team_leader_hours + l.hours);
    else agg.supervisor_hours = round2(agg.supervisor_hours + l.hours);
    agg.gross_salary = round2(agg.gross_salary + l.gross_amount);
  });

  // unpriced hours (no trade / no effective rate) belong to the site where
  // they were WORKED — an employee who moved mid-month appears at every
  // site they worked at, with the hours of that site
  calc.unassigned_sites.forEach((hours, key) => {
    const agg = bucketOf(key === '__none__' ? null : key);
    agg.total_hours = round2(agg.total_hours + hours);
  });
  calc.unrated_sites.forEach((hours, key) => {
    const agg = bucketOf(key === '__none__' ? null : key);
    agg.total_hours = round2(agg.total_hours + hours);
    agg.has_missing_rate = true;
  });

  // upsert the settlement row (manually entered adjustments preserved)
  let pe = existing;
  if (!pe) {
    pe = {
      id: uidFn(),
      payroll_period_id: period.id,
      employee_id: employeeId,
      opening_lifetime_hours: calc.opening_lifetime_hours,
      closing_lifetime_hours: calc.closing_lifetime_hours,
      total_hours: calc.total_hours,
      unrated_hours: calc.unrated_hours,
      unassigned_hours: calc.unassigned_hours,
      gross_salary: calc.gross_salary,
      advance: 0,
      deduction: 0,
      net_salary: calc.gross_salary,
      payment_status: 'unpaid',
      paid_at: null,
      paid_by: null,
      notes: null,
      trade_id_snapshot: emp.trade_id ?? null,
      salary_role_snapshot: emp.salary_role ?? 'standard',
      manually_edited: false,
    };
    database.payrollEmployees.push(pe);
  } else {
    pe.opening_lifetime_hours = calc.opening_lifetime_hours;
    pe.closing_lifetime_hours = calc.closing_lifetime_hours;
    pe.total_hours = calc.total_hours;
    pe.unrated_hours = calc.unrated_hours;
    pe.unassigned_hours = calc.unassigned_hours;
    pe.gross_salary = calc.gross_salary;
    pe.net_salary = round2(calc.gross_salary - pe.advance - pe.deduction);
    pe.trade_id_snapshot = emp.trade_id ?? null;
    pe.salary_role_snapshot = emp.salary_role ?? 'standard';
  }

  // rebuild the pure-calculation children
  database.payrollSites = database.payrollSites.filter((s) => s.payroll_employee_id !== pe!.id);
  database.payrollLines = database.payrollLines.filter((l) => l.payroll_employee_id !== pe!.id);

  buckets.forEach((agg) => {
    database.payrollSites.push({
      id: uidFn(),
      payroll_employee_id: pe!.id,
      site_id: agg.site_id,
      site_name_snapshot: agg.site_name,
      total_hours: agg.total_hours,
      below_threshold_hours: agg.below_threshold_hours,
      qualified_hours: agg.qualified_hours,
      standard_hours: agg.standard_hours,
      team_leader_hours: agg.team_leader_hours,
      supervisor_hours: agg.supervisor_hours,
      gross_salary: agg.gross_salary,
      has_missing_rate: agg.has_missing_rate,
      manually_edited: false,
    });
  });

  calc.lines.forEach((l) => {
    database.payrollLines.push({
      id: uidFn(),
      payroll_employee_id: pe!.id,
      site_id: l.site_id,
      site_name_snapshot: l.site_name,
      attendance_date: l.date,
      trade_id: l.trade_id,
      trade_name_snapshot: l.trade_name,
      salary_role_snapshot: l.salary_role,
      experience_tier: l.experience_tier,
      hours: l.hours,
      hourly_rate: l.hourly_rate,
      gross_amount: l.gross_amount,
    });
  });
};

/** Generate / refresh a month's draft payroll (mirrors generate_payroll_period). */
export const refreshPayrollPeriod = (
  database: DemoDB, year: number, month: number, actorId: string | null, uidFn: () => string,
): DemoPayrollPeriodRow => {
  let period = database.payrollPeriods.find((p) => p.year === year && p.month === month);
  if (!period) {
    period = {
      id: uidFn(),
      year,
      month,
      status: 'draft',
      created_by: actorId,
      finalized_by: null,
      finalized_at: null,
      created_at: new Date().toISOString(),
    };
    database.payrollPeriods.push(period);
  }
  if (period.status === 'finalized') {
    throw new Error(`Payroll for ${year}/${month} is finalized — reopen it (with a reason) before regenerating`);
  }

  const end = monthEnd(year, month);
  const inScope = database.employees.filter((e) =>
    e.status !== 'deleted' && ymdOf(e.join_date ?? e.created_at) <= end);
  inScope.forEach((e) => refreshPayrollEmployee(database, period!, e.id, uidFn));

  // drop employees that left the scope (e.g. deleted since last generate)
  const scopeIds = new Set(inScope.map((e) => e.id));
  database.payrollEmployees = database.payrollEmployees.filter(
    (pe) => pe.payroll_period_id !== period!.id || scopeIds.has(pe.employee_id),
  );

  return period;
};

// ---------------------------------------------------------------------------
// Salary sheet read model (mirrors get_salary_sheet)
// ---------------------------------------------------------------------------
/** First date the lifetime cumulative (opening + all tracked attendance)
 *  reaches the 1,000-hour threshold — chronologically. Null = never (yet). */
const thresholdDateOf = (database: DemoDB, employeeId: string): string | null => {
  const emp = database.employees.find((e) => e.id === employeeId);
  if (!emp) return null;
  let cum = emp.opening_hours ?? 0;
  let hit: string | null = null;
  database.attendance
    .filter((a) => a.employee_id === employeeId && !a.is_hidden
      && a.hours != null && (a.hours as number) > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .forEach((a) => {
      if (hit == null && cum + (a.hours as number) >= SALARY_THRESHOLD_HOURS) hit = a.date;
      cum += a.hours as number;
    });
  return hit;
};

const toPeriodVM = (p: DemoPayrollPeriodRow): PayrollPeriodVM => ({
  id: p.id, year: p.year, month: p.month, status: p.status,
  created_by: p.created_by, finalized_by: p.finalized_by,
  finalized_at: p.finalized_at, created_at: p.created_at,
});

export const buildSalarySheet = (
  database: DemoDB, year: number, month: number,
  regenerateDraft: (y: number, m: number) => void,
): SalarySheetReport => {
  let period = database.payrollPeriods.find((p) => p.year === year && p.month === month);
  if (!period) {
    return {
      exists: false, period: null,
      totals: { employees: 0, total_hours: 0, gross_salary: 0, advances: 0, deductions: 0, net_payable: 0, paid_count: 0, unpaid_count: 0 },
      sites: [], employees: [], audit: [],
    };
  }

  // drafts stay live: attendance edits recalculate on every view
  if (period.status === 'draft') {
    regenerateDraft(year, month);
    period = database.payrollPeriods.find((p) => p.year === year && p.month === month)!;
  }

  const pes = database.payrollEmployees.filter((pe) => pe.payroll_period_id === period!.id);

  const totals: SalarySheetTotals = {
    employees: pes.length,
    total_hours: round2(pes.reduce((n, pe) => n + pe.total_hours, 0)),
    gross_salary: round2(pes.reduce((n, pe) => n + pe.gross_salary, 0)),
    advances: round2(pes.reduce((n, pe) => n + pe.advance, 0)),
    deductions: round2(pes.reduce((n, pe) => n + pe.deduction, 0)),
    net_payable: round2(pes.reduce((n, pe) => n + pe.net_salary, 0)),
    paid_count: pes.filter((pe) => pe.payment_status === 'paid').length,
    unpaid_count: pes.filter((pe) => pe.payment_status !== 'paid').length,
  };

  // site groups keyed by site id (never by name); the no-site bucket is NOT
  // a site group — it becomes part of the trailing Idle Employees group
  const siteKeys = new Map<string, { site_id: string | null; site_name: string }>();
  pes.forEach((pe) => {
    database.payrollSites
      .filter((s) => s.payroll_employee_id === pe.id && s.site_id != null)
      .forEach((s) => siteKeys.set(s.site_id!, {
        site_id: s.site_id,
        site_name: s.site_name_snapshot,
      }));
  });

  const sites: SalarySheetSiteGroup[] = [];
  siteKeys.forEach(({ site_id, site_name }) => {
    const rows: SalarySheetSiteGroup['rows'] = [];
    pes.forEach((pe) => {
      const siteRow = database.payrollSites.find(
        (s) => s.payroll_employee_id === pe.id
          && (s.site_id ?? '__none__') === (site_id ?? '__none__'),
      );
      if (!siteRow) return;
      const emp = database.employees.find((e) => e.id === pe.employee_id);
      const lines = database.payrollLines
        .filter((l) => l.payroll_employee_id === pe.id
          && (l.site_id ?? '__none__') === (site_id ?? '__none__'))
        .sort((a, b) => (a.attendance_date < b.attendance_date ? -1 : 1))
        .map((l): PayrollSalaryLineVM => ({
          site_id: l.site_id, site_name: l.site_name_snapshot, date: l.attendance_date,
          trade_id: l.trade_id, trade_name: l.trade_name_snapshot,
          salary_role: l.salary_role_snapshot, experience_tier: l.experience_tier,
          hours: l.hours, hourly_rate: l.hourly_rate, gross_amount: l.gross_amount,
        }));
      rows.push({
        site_id: siteRow.site_id,
        site_name: siteRow.site_name_snapshot,
        total_hours: siteRow.total_hours,
        below_threshold_hours: siteRow.below_threshold_hours,
        qualified_hours: siteRow.qualified_hours,
        standard_hours: siteRow.standard_hours,
        team_leader_hours: siteRow.team_leader_hours,
        supervisor_hours: siteRow.supervisor_hours,
        gross_salary: siteRow.gross_salary,
        has_missing_rate: siteRow.has_missing_rate,
        manually_edited: siteRow.manually_edited,
        lines,
        employee_id: pe.employee_id,
        full_name: emp?.full_name ?? 'Unknown',
        employee_code: emp?.employee_code ?? '—',
        nationality: emp?.nationality ?? null,
        photo: emp?.photo ?? null,
        trade_name: pe.trade_id_snapshot
          ? database.trades.find((t) => t.id === pe.trade_id_snapshot)?.name ?? null
          : null,
        salary_role: pe.salary_role_snapshot,
      });
    });
    rows.sort((a, b) => a.full_name.localeCompare(b.full_name));
    sites.push({
      site_id,
      site_name,
      employees: rows.length,
      total_hours: round2(rows.reduce((n, r) => n + r.total_hours, 0)),
      gross_salary: round2(rows.reduce((n, r) => n + r.gross_salary, 0)),
      rows,
    });
  });
  sites.sort((a, b) => b.gross_salary - a.gross_salary);

  // ---- IDLE EMPLOYEES (always the LAST group) -----------------------------
  // (a) employees with unassigned / unrated (no-site) hours — shown as idle
  //     hours, never attributed to an invented site;
  // (b) employees whose CURRENT site is empty without a no-site row →
  //     synthetic zero rows (covers site-less employees with no attendance).
  // Historical attendance of these employees keeps its original site
  // attribution and stays in the site groups above.
  const idleRows: SalarySheetSiteGroup['rows'] = [];
  pes.forEach((pe) => {
    const emp = database.employees.find((e) => e.id === pe.employee_id);
    if (!emp) return;
    const tradeName = pe.trade_id_snapshot
      ? database.trades.find((t) => t.id === pe.trade_id_snapshot)?.name ?? null
      : null;
    const noSiteRow = database.payrollSites.find(
      (s) => s.payroll_employee_id === pe.id && s.site_id == null,
    );
    if (noSiteRow) {
      const lines = database.payrollLines
        .filter((l) => l.payroll_employee_id === pe.id && l.site_id == null)
        .sort((a, b) => (a.attendance_date < b.attendance_date ? -1 : 1))
        .map((l): PayrollSalaryLineVM => ({
          site_id: l.site_id, site_name: l.site_name_snapshot, date: l.attendance_date,
          trade_id: l.trade_id, trade_name: l.trade_name_snapshot,
          salary_role: l.salary_role_snapshot, experience_tier: l.experience_tier,
          hours: l.hours, hourly_rate: l.hourly_rate, gross_amount: l.gross_amount,
        }));
      idleRows.push({
        site_id: null,
        site_name: 'Idle Employees',
        total_hours: noSiteRow.total_hours,
        below_threshold_hours: noSiteRow.below_threshold_hours,
        qualified_hours: noSiteRow.qualified_hours,
        standard_hours: noSiteRow.standard_hours,
        team_leader_hours: noSiteRow.team_leader_hours,
        supervisor_hours: noSiteRow.supervisor_hours,
        gross_salary: noSiteRow.gross_salary,
        has_missing_rate: noSiteRow.has_missing_rate,
        manually_edited: noSiteRow.manually_edited,
        synthetic: false,
        lines,
        employee_id: pe.employee_id,
        full_name: emp.full_name,
        employee_code: emp.employee_code,
        nationality: emp.nationality ?? null,
        photo: emp.photo ?? null,
        trade_name: tradeName,
        salary_role: pe.salary_role_snapshot,
      });
    } else if (emp.current_site_id == null) {
      idleRows.push({
        site_id: null,
        site_name: 'Idle Employees',
        total_hours: 0,
        below_threshold_hours: 0,
        qualified_hours: 0,
        standard_hours: 0,
        team_leader_hours: 0,
        supervisor_hours: 0,
        gross_salary: 0,
        has_missing_rate: false,
        manually_edited: false,
        synthetic: true,
        lines: [],
        employee_id: pe.employee_id,
        full_name: emp.full_name,
        employee_code: emp.employee_code,
        nationality: emp.nationality ?? null,
        photo: emp.photo ?? null,
        trade_name: tradeName,
        salary_role: pe.salary_role_snapshot,
      });
    }
  });
  idleRows.sort((a, b) => a.full_name.localeCompare(b.full_name));
  if (idleRows.length > 0) {
    sites.push({
      site_id: null,
      site_name: 'Idle Employees',
      employees: idleRows.length,
      total_hours: round2(idleRows.reduce((n, r) => n + r.total_hours, 0)),
      gross_salary: round2(idleRows.reduce((n, r) => n + r.gross_salary, 0)),
      idle: true,
      rows: idleRows,
    });
  }

  // consolidated per-employee rows — ONE row per employee for the Payroll
  // page; includes the qualification fields used by the hours tooltip
  const employees: PayrollEmployeeVM[] = pes.map((pe) => {
    const emp = database.employees.find((e) => e.id === pe.employee_id);
    const siteRows = database.payrollSites.filter((s) => s.payroll_employee_id === pe.id);
    const sitesVM: PayrollEmployeeSiteVM[] = siteRows
      .map((s): PayrollEmployeeSiteVM => ({
        site_id: s.site_id,
        site_name: s.site_name_snapshot,
        total_hours: s.total_hours,
        below_threshold_hours: s.below_threshold_hours,
        qualified_hours: s.qualified_hours,
        standard_hours: s.standard_hours,
        team_leader_hours: s.team_leader_hours,
        supervisor_hours: s.supervisor_hours,
        gross_salary: s.gross_salary,
        has_missing_rate: s.has_missing_rate,
        manually_edited: s.manually_edited,
        lines: database.payrollLines
          .filter((l) => l.payroll_employee_id === pe.id
            && (l.site_id ?? '__none__') === (s.site_id ?? '__none__'))
          .sort((a, b) => (a.attendance_date < b.attendance_date ? -1 : 1))
          .map((l): PayrollSalaryLineVM => ({
            site_id: l.site_id, site_name: l.site_name_snapshot, date: l.attendance_date,
            trade_id: l.trade_id, trade_name: l.trade_name_snapshot,
            salary_role: l.salary_role_snapshot, experience_tier: l.experience_tier,
            hours: l.hours, hourly_rate: l.hourly_rate, gross_amount: l.gross_amount,
          })),
      }))
      .sort((a, b) => b.gross_salary - a.gross_salary);

    return {
      id: pe.id,
      payroll_period_id: pe.payroll_period_id,
      employee_id: pe.employee_id,
      full_name: emp?.full_name ?? 'Unknown',
      employee_code: emp?.employee_code ?? '—',
      nationality: emp?.nationality ?? null,
      photo: emp?.photo ?? null,
      status: emp?.status ?? 'active',
      trade_id: pe.trade_id_snapshot,
      trade_name: pe.trade_id_snapshot
        ? database.trades.find((t) => t.id === pe.trade_id_snapshot)?.name ?? null
        : null,
      salary_role: pe.salary_role_snapshot,
      total_hours: pe.total_hours,
      opening_lifetime_hours: pe.opening_lifetime_hours,
      closing_lifetime_hours: pe.closing_lifetime_hours,
      below_threshold_hours: round2(siteRows.reduce((n, s) => n + s.below_threshold_hours, 0)),
      qualified_hours: round2(siteRows.reduce((n, s) => n + s.qualified_hours, 0)),
      unrated_hours: pe.unrated_hours,
      unassigned_hours: pe.unassigned_hours,
      gross_salary: pe.gross_salary,
      advance: pe.advance,
      deduction: pe.deduction,
      net_salary: pe.net_salary,
      payment_status: pe.payment_status,
      paid_at: pe.paid_at,
      paid_by: pe.paid_by,
      paid_by_name: pe.paid_by
        ? database.profiles.find((p) => p.id === pe.paid_by)?.name ?? null
        : null,
      notes: pe.notes,
      manually_edited: pe.manually_edited,
      join_date: emp?.join_date ?? null,
      six_month_date: emp
        ? addMonthsClamped(emp.join_date ?? ymdOf(emp.created_at), SALARY_THRESHOLD_MONTHS)
        : null,
      threshold_date: thresholdDateOf(database, pe.employee_id),
      sites: sitesVM,
    };
  });
  employees.sort((a, b) => a.full_name.localeCompare(b.full_name));

  const audit = database.payrollAudit
    .filter((a) => a.period_id === period!.id)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((a) => ({
      id: a.id, action: a.action, actor_name: a.actor_name,
      details: a.details, created_at: a.created_at,
    }));

  return { exists: true, period: toPeriodVM(period), totals, sites, employees, audit };
};

// ---------------------------------------------------------------------------
// Effective-dated assignment replacement (mirrors apply_employee_assignment)
// ---------------------------------------------------------------------------
export const applyAssignment = (
  database: DemoDB,
  employeeId: string,
  tradeId: string | null,
  role: SalaryRole,
  effectiveDate: string,
  createdBy: string | null,
): void => {
  // an assignment starting exactly on the date is replaced (same-day re-assignment)
  database.salaryAssignments = database.salaryAssignments.filter(
    (a) => !(a.employee_id === employeeId && a.effective_from === effectiveDate),
  );

  // a strictly future-scheduled assignment caps the new one (it wins from its date)
  const future = database.salaryAssignments
    .filter((a) => a.employee_id === employeeId && a.effective_from > effectiveDate)
    .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))[0];
  const cap = future
    ? (() => {
      const [y, m, d] = future.effective_from.split('-').map(Number);
      const dt = new Date(y, m - 1, d - 1);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    })()
    : null;

  // close the currently open assignment the day before
  database.salaryAssignments.forEach((a) => {
    if (a.employee_id === employeeId
      && a.effective_from < effectiveDate
      && (a.effective_to == null || a.effective_to >= effectiveDate)) {
      const [y, m, d] = effectiveDate.split('-').map(Number);
      const dt = new Date(y, m - 1, d - 1);
      a.effective_to = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    }
  });

  if (tradeId != null) {
    if (!database.trades.some((t) => t.id === tradeId)) throw new Error('Trade not found');
    database.salaryAssignments.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      employee_id: employeeId,
      trade_id: tradeId,
      salary_role: role,
      effective_from: effectiveDate,
      effective_to: cap,
      created_by: createdBy,
      created_at: new Date().toISOString(),
    });
  }
};

// ---------------------------------------------------------------------------
// Effective-dated rate replacement (mirrors update_trade_rates)
// ---------------------------------------------------------------------------
export const applyTradeRates = (
  database: DemoDB,
  tradeId: string,
  rates: { salary_role: SalaryRole; experience_tier: ExperienceTier; hourly_rate: number }[],
  effectiveDate: string,
  createdBy: string | null,
): void => {
  rates.forEach((r) => {
    // the FIRST rate of a cell covers all history (mirrors update_trade_rates
    // — "adding the missing rate" prices past months too)
    const hasEarlier = database.tradeRates.some((x) =>
      x.trade_id === tradeId
      && x.salary_role === r.salary_role
      && x.experience_tier === r.experience_tier
      && x.effective_from < effectiveDate);
    const eff = hasEarlier ? effectiveDate : '1970-01-01';

    // a rate scheduled for exactly this date is replaced by the new one
    database.tradeRates = database.tradeRates.filter((x) => !(
      x.trade_id === tradeId
      && x.salary_role === r.salary_role
      && x.experience_tier === r.experience_tier
      && x.effective_from === eff
    ));

    // a strictly future-scheduled rate caps the new period
    const future = database.tradeRates
      .filter((x) => x.trade_id === tradeId
        && x.salary_role === r.salary_role
        && x.experience_tier === r.experience_tier
        && x.effective_from > effectiveDate)
      .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))[0];
    const cap = future
      ? (() => {
        const [y, m, d] = future.effective_from.split('-').map(Number);
        const dt = new Date(y, m - 1, d - 1);
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      })()
      : null;

    // close the currently open period the day before
    database.tradeRates.forEach((x) => {
      if (x.trade_id === tradeId
        && x.salary_role === r.salary_role
        && x.experience_tier === r.experience_tier
        && x.effective_from < eff
        && (x.effective_to == null || x.effective_to >= eff)) {
        const [y, m, d] = eff.split('-').map(Number);
        const dt = new Date(y, m - 1, d - 1);
        x.effective_to = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      }
    });

    database.tradeRates.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      trade_id: tradeId,
      salary_role: r.salary_role,
      experience_tier: r.experience_tier,
      hourly_rate: round2(r.hourly_rate),
      effective_from: eff,
      effective_to: cap,
      created_by: createdBy,
      created_at: new Date().toISOString(),
    });
  });
};

/** Assignment history rows joined with names (mirrors get_employee_salary_history). */
export const assignmentHistoryOf = (
  database: DemoDB, employeeId: string,
): EmployeeSalaryAssignment[] =>
  [...database.salaryAssignments]
    .filter((a) => a.employee_id === employeeId)
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))
    .map((a) => ({
      id: a.id,
      employee_id: a.employee_id,
      employee_name: database.employees.find((e) => e.id === a.employee_id)?.full_name ?? 'Unknown',
      trade_id: a.trade_id,
      trade_name: database.trades.find((t) => t.id === a.trade_id)?.name ?? 'Unknown',
      salary_role: a.salary_role,
      effective_from: a.effective_from,
      effective_to: a.effective_to,
      created_at: a.created_at,
    }));

/** Trades list with today's rates (mirrors list_trades). */
export const tradesWithRates = (
  database: DemoDB,
): (Trade & { current_rates: TradeRate[] })[] =>
  [...database.trades]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ ...t, current_rates: currentRatesOf(database, t.id) }));

// ---------------------------------------------------------------------------
// SALARY SHEET EDITING (mirrors update_salary_sheet_row / reset_payroll_
// employee_auto). THE SHEET RECORD HAS PRIORITY: manual values overwrite the
// calculated data and survive every recalculation; a trade picked in the
// sheet overwrites the employee's stored trade + assignment history.
// ---------------------------------------------------------------------------
export const applySalarySheetRow = (
  database: DemoDB,
  payload: SalarySheetRowUpdate,
  actorId: string | null,
  actorName: string | null,
  uidFn: () => string,
): void => {
  const pe = database.payrollEmployees.find((x) => x.id === payload.payroll_employee_id);
  if (!pe) throw new Error('Payroll employee not found');
  if (pe.payment_status === 'paid') {
    throw new Error('This employee is already marked paid — reopen the payroll to correct it');
  }
  const period = database.payrollPeriods.find((p) => p.id === pe.payroll_period_id);
  if (!period) throw new Error('Payroll period not found');
  const monthStartDate = monthStart(period.year, period.month);
  const emp = database.employees.find((e) => e.id === pe.employee_id);
  if (!emp) throw new Error('Employee not found');
  const details: string[] = [];
  const wasManual = pe.manually_edited;

  // 1. trade picked in the sheet → OVERWRITE the stored trade + assignment
  //    (effective from the 1st of the payroll month — the whole month prices
  //    at the new trade)
  let tradeChanged = false;
  if ('trade_id' in payload) {
    const newTradeId = payload.trade_id ?? null;
    if (newTradeId && !database.trades.some((t) => t.id === newTradeId)) {
      throw new Error('Trade not found');
    }
    if ((newTradeId ?? null) !== (emp.trade_id ?? null)) {
      tradeChanged = true;
      applyAssignment(database, emp.id, newTradeId, emp.salary_role ?? 'standard', monthStartDate, actorId);
      emp.trade_id = newTradeId;
      pe.trade_id_snapshot = newTradeId;
      details.push(`trade → ${
        newTradeId ? database.trades.find((t) => t.id === newTradeId)?.name ?? 'unknown' : 'no trade'}`);
    }
  }

  // 2. manual site overrides — the sheet record wins
  if (payload.sites && payload.sites.length > 0) {
    payload.sites.forEach((s) => {
      const row = database.payrollSites.find((x) => x.payroll_employee_id === pe.id
        && (x.site_id ?? null) === (s.site_id ?? null));
      if (!row) throw new Error('Site row not found for this employee');
      const hours = round2(s.total_hours);
      const gross = round2(s.gross_salary);
      if (!Number.isFinite(hours) || hours < 0 || !Number.isFinite(gross) || gross < 0) {
        throw new Error('Hours and gross must be 0 or more');
      }
      row.total_hours = hours;
      row.gross_salary = gross;
      row.has_missing_rate = false;
      row.manually_edited = true;

      // the site's rate lines collapse into ONE manual line
      database.payrollLines = database.payrollLines.filter((l) => !(
        l.payroll_employee_id === pe.id && (l.site_id ?? null) === (s.site_id ?? null)));
      if (hours > 0) {
        const rate = s.hourly_rate != null && Number.isFinite(s.hourly_rate)
          ? round2(s.hourly_rate)
          : round2(gross / hours);
        database.payrollLines.push({
          id: uidFn(),
          payroll_employee_id: pe.id,
          site_id: s.site_id ?? null,
          site_name_snapshot: row.site_name_snapshot,
          attendance_date: monthStartDate,
          trade_id: emp.trade_id ?? null,
          trade_name_snapshot: emp.trade_id
            ? database.trades.find((t) => t.id === emp.trade_id)?.name ?? 'No trade'
            : 'No trade',
          salary_role_snapshot: emp.salary_role ?? 'standard',
          experience_tier: 'manual',
          hours,
          hourly_rate: rate,
          gross_amount: gross,
        });
      }
    });

    // settlement totals = sum over ALL site rows (manual + automatic)
    const rows = database.payrollSites.filter((x) => x.payroll_employee_id === pe.id);
    pe.total_hours = round2(rows.reduce((n, r) => n + r.total_hours, 0));
    pe.gross_salary = round2(rows.reduce((n, r) => n + r.gross_salary, 0));
    pe.unrated_hours = 0;
    pe.unassigned_hours = 0;
    pe.manually_edited = true;
    details.push('manual site values');
  }

  // 3. trade change without manual values → re-price the month automatically
  if (tradeChanged && !(payload.sites && payload.sites.length > 0)) {
    if (!wasManual) {
      refreshPayrollEmployee(database, period, emp.id, uidFn);
      details.push('recalculated');
    } else {
      // manual values exist: keep them, only refresh the trade snapshot
      pe.trade_id_snapshot = emp.trade_id ?? null;
      pe.salary_role_snapshot = emp.salary_role ?? 'standard';
    }
  }

  // 4. settlement adjustments (advance / deduction / notes)
  if (payload.advance != null || payload.deduction != null || payload.notes !== undefined) {
    if (payload.advance != null) {
      if (!Number.isFinite(payload.advance) || payload.advance < 0) throw new Error('Advance must be 0 or more');
      pe.advance = round2(payload.advance);
    }
    if (payload.deduction != null) {
      if (!Number.isFinite(payload.deduction) || payload.deduction < 0) throw new Error('Deduction must be 0 or more');
      pe.deduction = round2(payload.deduction);
    }
    if (payload.notes !== undefined) pe.notes = payload.notes?.trim() || null;
    details.push('settlement');
  }

  pe.net_salary = round2(pe.gross_salary - pe.advance - pe.deduction);

  database.payrollAudit.push({
    id: uidFn(),
    period_id: period.id,
    trade_id: null,
    action: 'manual_edit',
    actor_id: actorId,
    actor_name: actorName,
    details: `Salary sheet row of ${emp.full_name} (${emp.employee_code}) edited: ${details.join('; ') || 'no changes'}`,
    created_at: new Date().toISOString(),
  });
};

/** Return an employee's settlement to automatic calculation (draft periods). */
export const resetPayrollEmployeeAuto = (
  database: DemoDB,
  payrollEmployeeId: string,
  actorId: string | null,
  actorName: string | null,
  uidFn: () => string,
): void => {
  const pe = database.payrollEmployees.find((x) => x.id === payrollEmployeeId);
  if (!pe) throw new Error('Payroll employee not found');
  const period = database.payrollPeriods.find((p) => p.id === pe.payroll_period_id);
  if (!period) throw new Error('Payroll period not found');
  if (period.status === 'finalized') {
    throw new Error('Reopen the finalized payroll before resetting to automatic calculation');
  }
  pe.manually_edited = false;
  refreshPayrollEmployee(database, period, pe.employee_id, uidFn);
  const emp = database.employees.find((e) => e.id === pe.employee_id);
  database.payrollAudit.push({
    id: uidFn(),
    period_id: period.id,
    trade_id: null,
    action: 'reset_auto',
    actor_id: actorId,
    actor_name: actorName,
    details: `Salary sheet row of ${emp ? `${emp.full_name} (${emp.employee_code})` : 'unknown employee'} returned to automatic calculation`,
    created_at: new Date().toISOString(),
  });
};

export const uidOfPayroll = uidOf;
