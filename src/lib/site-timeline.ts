// ============================================================================
// PULSE Workforce OS — Date-effective employee site assignment
// ----------------------------------------------------------------------------
// ONE shared engine for "which site did an employee belong to on date X".
// It is used by the attendance marking sheet, Bulk Day Entry and the demo-mode
// permission checks; the Postgres function emp_site_on_date() in
// supabase/schema.sql mirrors it exactly for production (Supabase RPCs must
// never rely on employee.current_site_id for historical authorization).
//
// Core rule (the "25th at 8 PM" rule):
//   A site move is recorded with an effective_date AND a created_at timestamp.
//   Attendance already marked at the OLD site BEFORE the move was recorded
//   keeps its old-site assignment — the move is only displayed/enforced from
//   the first day that was NOT already marked. Attendance marked on the 25th
//   + moved on the 25th at 8 PM → the move takes effect from the 26th.
//   Existing attendance records are NEVER moved or rewritten.
//
// Multiple transfers chain chronologically (effective_date, then created_at),
// so A → B → C within one month yields three correct segments.
// ============================================================================

import type { Attendance, SiteTransfer } from '@/lib/types';

/** A run of days within one month spent at one site (null = idle/unassigned). */
export interface MonthSegment {
  fromDay: number;
  toDay: number;
  siteId: string | null;
}

/** An employee's site timeline across one viewed month. */
export interface MonthTimeline {
  /** Site the employee was at on day 1 of the month — where their row lives. */
  homeSiteId: string | null;
  segments: MonthSegment[];
  /** True when at least one move became effective inside this month. */
  transferred: boolean;
}

/** Everything the engine needs to answer site-on-date questions for one
 *  employee (transfers/records may be shared across employees). */
export interface SiteTimelineInput {
  /** All logged site moves (filtered internally per employee). */
  transfers: SiteTransfer[];
  /** Attendance records (all months — they drive the pre-marked-day rule). */
  records: Iterable<Attendance> | Map<string, Map<string, Attendance>>;
  /** The employee's current site — the fallback before any logged move. */
  currentSiteId: string | null;
}

// ---------------------------------------------------------------------------
// Date helpers (YYYY-MM-DD strings, timezone-free)
// ---------------------------------------------------------------------------
const pad = (n: number): string => String(n).padStart(2, '0');

export const ymdStr = (y: number, m: number, d: number): string =>
  `${y}-${pad(m)}-${pad(d)}`;

export const daysInMonth = (y: number, m: number): number => new Date(y, m, 0).getDate();

export const addDaysYMD = (date: string, delta: number): string => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return ymdStr(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/** transfers of ONE employee in deterministic order: effective_date, then
 *  created_at (test 14: two moves on the same date never overlap). */
export function transfersFor(transfers: SiteTransfer[], employeeId: string): SiteTransfer[] {
  return transfers
    .filter((t) => t.employee_id === employeeId)
    .sort((a, b) =>
      a.effective_date === b.effective_date
        ? a.created_at.localeCompare(b.created_at)
        : a.effective_date < b.effective_date ? -1 : 1);
}

/** records index: employee_id → date → record (created_at drives the rule). */
export function indexRecords(records: Iterable<Attendance>): Map<string, Map<string, Attendance>> {
  const map = new Map<string, Map<string, Attendance>>();
  for (const r of records) {
    let m = map.get(r.employee_id);
    if (!m) { m = new Map(); map.set(r.employee_id, m); }
    m.set(r.date, r);
  }
  return map;
}

function recordsAsMap(records: SiteTimelineInput['records']): Map<string, Map<string, Attendance>> {
  return records instanceof Map ? records : indexRecords(records);
}

// ---------------------------------------------------------------------------
// The core rule
// ---------------------------------------------------------------------------

/**
 * First day a move is DISPLAYED from: the effective date, unless that day (and
 * every following day up to `cap`) was already marked BEFORE the move was
 * recorded — then the first unmarked day instead.
 *   marked on the 25th (5 PM) + moved on the 25th (8 PM) → the 26th.
 * Returns null when every day up to `cap` was already pre-marked (the move
 * displays from beyond the cap — nothing to show in this range).
 */
export function transferDisplayDate(
  transfer: SiteTransfer,
  empRecords: Map<string, Attendance> | undefined,
  cap: string,
): string | null {
  let day = transfer.effective_date;
  // walk past consecutive days that were already marked at the old site
  // before the move was recorded (bounded by the cap + a hard safety limit)
  let guard = 0;
  while (day <= cap && guard < 400) {
    const rec = empRecords?.get(day);
    if (rec && rec.created_at <= transfer.created_at) day = addDaysYMD(day, 1);
    else break;
    guard += 1;
  }
  return day <= cap ? day : null;
}

/**
 * The site an employee belonged to on the given date — the ONE function the
 * marking sheet, Bulk Day Entry, demo permissions and the SQL RPC all agree
 * on. Folds every logged move whose display date is on/before `dateYMD`.
 * Returns null for idle/unassigned employees on that date.
 */
export function getEmployeeSiteForDate(
  employeeId: string,
  dateYMD: string,
  input: SiteTimelineInput,
): string | null {
  const ts = transfersFor(input.transfers, employeeId);
  if (ts.length === 0) return input.currentSiteId;

  const empRecords = recordsAsMap(input.records).get(employeeId);
  // site before any logged move = where the earliest move started from
  let site: string | null = ts[0].from_site_id ?? null;
  for (const t of ts) {
    const displayFrom = transferDisplayDate(t, empRecords, dateYMD);
    if (displayFrom !== null && displayFrom <= dateYMD) {
      site = t.to_site_id ?? null;
    }
  }
  return site;
}

/**
 * Month timeline for the Excel-style marking sheet. The month is split into
 * segments per site; moves whose display date falls inside the month create a
 * new segment (moved employees get a row in EVERY site they spent days at —
 * bottom of the crew, faded — and foreign segments merge into one labelled
 * cell). Months entirely before/after the move resolve to a single normal
 * segment via the fold, so history stays intact.
 */
export function buildMonthTimeline(
  employeeId: string,
  year: number,
  month: number,
  input: SiteTimelineInput,
): MonthTimeline {
  const currentSiteId = input.currentSiteId;
  const days = daysInMonth(year, month);
  const ts = transfersFor(input.transfers, employeeId);
  if (ts.length === 0) {
    return {
      homeSiteId: currentSiteId,
      segments: [{ fromDay: 1, toDay: days, siteId: currentSiteId }],
      transferred: false,
    };
  }

  const empRecords = recordsAsMap(input.records).get(employeeId);
  const first = ymdStr(year, month, 1);
  const last = ymdStr(year, month, days);

  // site on day 1 = fold of every move already effective by then
  let site: string | null = ts[0].from_site_id ?? null;
  const moves: { day: number; to: string | null }[] = [];
  for (const t of ts) {
    if (t.effective_date <= first) {
      site = t.to_site_id ?? null;
    } else if (t.effective_date <= last) {
      const displayFrom = transferDisplayDate(t, empRecords, last);
      if (displayFrom === null) continue; // whole month already marked at the old site
      moves.push({ day: Number(displayFrom.slice(8, 10)), to: t.to_site_id ?? null });
    }
  }

  const segments: MonthSegment[] = [{ fromDay: 1, toDay: days, siteId: site }];
  for (const mv of moves) {
    const cur = segments[segments.length - 1];
    if (mv.day <= cur.fromDay) { cur.siteId = mv.to; continue; } // same-day move → overwrite
    cur.toDay = mv.day - 1;
    segments.push({ fromDay: mv.day, toDay: days, siteId: mv.to });
  }
  return { homeSiteId: site, segments, transferred: moves.length > 0 };
}
