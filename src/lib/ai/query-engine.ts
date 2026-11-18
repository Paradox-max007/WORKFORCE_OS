// ============================================================================
// PULSE Workforce OS — Pebby query engine (src/lib/ai/query-engine.ts)
// ----------------------------------------------------------------------------
// Complex, read-only database querying for the Smart Assistant over EVERY
// table of the app. When the compact snapshot in the system prompt omits the
// detail a question needs (exact timestamps, other months, filtered / sorted /
// aggregated / cross-table views) the model replies with one directive line:
//
//   [[QUERY]] {"table":"cancellation_requests","where":[{"field":"status","op":"eq","value":"approved"}]}
//
// The chat widget parses the directive, runs it here against the live dataApi
// (demo store OR Supabase — same interface, RLS applies per signed-in user)
// and re-asks the model with the rows. Up to 3 rounds per question, so Pebby
// can chain queries (resolve an employee code → pull the cancellation request).
//
//   • parseAiQueryDirective() — validates the [[QUERY]] JSON syntax (types
//     only; field names are validated at run time so the model can self-correct)
//   • runAiQuery()            — fetch → filter → group/aggregate → sort →
//                                project → compact text result (never throws;
//                                errors come back as QUERY ERROR + hints)
//   • queryableTablesDoc()    — the table dictionary embedded in the system
//                                prompt (every table + its fields + parameters)
//
// Query options (all optional except table):
//   where[]  — field / op / value   ops: eq ne gt gte lt lte contains in
//                                    is_null not_null (string compares are
//                                    case-insensitive; a YYYY-MM-DD value
//                                    matches the whole day of an ISO datetime)
//   fields[] — column projection     order_by + desc — sorting
//   limit    — rows returned (default 25, max 200)
//   group_by — group rows by a field
//   aggregate + on — count | sum | avg | min | max over a (numeric) field
//   month    — required for attendance / salary_sheet (YYYY-MM)
//   trade_id / employee_id / months — optional parameters of specific tables
// ============================================================================

import { dataApi } from '@/lib/data';
import type { AiScope } from '@/lib/ai/scope';
import type {
  AttendanceShareLink, Attendance, EmployeeVM, TradeRate,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

export type AiQueryOp =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'in' | 'is_null' | 'not_null';

export type AiQueryAggregate = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface AiQueryFilter {
  field: string;
  op: AiQueryOp;
  value?: unknown;
}

export interface AiQuerySpec {
  table: string;
  month?: string;
  trade_id?: string;
  employee_id?: string;
  months?: number;
  where?: AiQueryFilter[];
  fields?: string[];
  order_by?: string;
  desc?: boolean;
  limit?: number;
  group_by?: string;
  aggregate?: AiQueryAggregate;
  on?: string;
}

/** parse result: {spec} = runnable · {error} = directive-shaped but broken
 *  (the widget feeds the error back so the model retries) · null = not a
 *  query directive at all (a normal answer). */
export type ParsedQueryDirective =
  | { spec: AiQuerySpec }
  | { error: string }
  | null;

const OPS: readonly string[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'is_null', 'not_null'];
const AGGREGATES: readonly string[] = ['count', 'sum', 'avg', 'min', 'max'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ---------------------------------------------------------------------------
// Date / value formatting helpers
// ---------------------------------------------------------------------------

/** ISO datetime → "YYYY-MM-DD HH:MM" (date-only strings stay untouched). */
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = iso.slice(0, 10);
  if (iso.length >= 16) return `${d} ${iso.slice(11, 16)}`;
  return d;
}

/** ISO datetime / date → "YYYY-MM-DD". */
function fmtDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

/** A value that starts like a date → its YYYY-MM-DD part (else null). */
function datePart(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

/** Render one cell for the result text. */
function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join(',') : '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// Filtering primitives
// ---------------------------------------------------------------------------

function valueEqual(rowVal: unknown, filterVal: unknown): boolean {
  if (rowVal === null || rowVal === undefined) {
    return filterVal === null || filterVal === undefined || filterVal === '';
  }
  // a plain YYYY-MM-DD filter value matches the whole day of an ISO datetime
  const fd = datePart(filterVal);
  if (fd) {
    const rd = datePart(rowVal);
    return rd !== null && rd === fd;
  }
  if (typeof rowVal === 'number' || typeof filterVal === 'number') {
    const a = Number(rowVal);
    const b = Number(filterVal);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  if (typeof rowVal === 'boolean' || typeof filterVal === 'boolean') {
    return rowVal === filterVal;
  }
  return String(rowVal).toLowerCase() === String(filterVal).toLowerCase();
}

/** Numeric compare when both sides parse as numbers, else string compare. */
function compareVals(a: unknown, b: unknown): number {
  const na = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' && !Number.isNaN(Number(a)) ? Number(a) : null;
  const nb = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' && !Number.isNaN(Number(b)) ? Number(b) : null;
  if (na !== null && nb !== null) return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function applyFilter(row: Record<string, unknown>, f: AiQueryFilter): boolean {
  const v = row[f.field];
  switch (f.op) {
    case 'eq': return valueEqual(v, f.value);
    case 'ne': return !valueEqual(v, f.value);
    case 'contains': {
      if (v === null || v === undefined) return false;
      const fd = datePart(f.value);
      if (fd) {
        const rd = datePart(v);
        return rd !== null && rd === fd;
      }
      return String(v).toLowerCase().includes(String(f.value ?? '').toLowerCase());
    }
    case 'in':
      return Array.isArray(f.value) && f.value.some((x) => valueEqual(v, x));
    case 'is_null':
      return v === null || v === undefined || v === '';
    case 'not_null':
      return !(v === null || v === undefined || v === '');
    case 'gt': case 'gte': case 'lt': case 'lte': {
      if (v === null || v === undefined || f.value === undefined || f.value === null) return false;
      const fd = datePart(f.value);
      const lhs = fd && typeof v === 'string' && datePart(v) !== null ? datePart(v) : v;
      const c = compareVals(lhs, f.value);
      return f.op === 'gt' ? c > 0 : f.op === 'gte' ? c >= 0 : f.op === 'lt' ? c < 0 : c <= 0;
    }
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Table registry — every readable table of the app
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FetchResult {
  rows: Row[];
  /** extra context line (e.g. salary-sheet period status, working-hours totals) */
  header?: string;
}

interface TableDef {
  /** one-line doc for the system prompt dictionary */
  doc: string;
  /** every normalized field name (validation + error hints) */
  fields: string[];
  /** default column projection when the query omits "fields" */
  defaultFields: string[];
  defaultOrder?: { field: string; desc?: boolean };
  requiresMonth?: boolean;
  requiresEmployeeId?: boolean;
  /** org-wide tables a branch-scoped viewer cannot query (the admins
   *  directory, whole-org attendance summaries) — the run guard and the
   * prompt dictionary both honour this */
  superOnly?: boolean;
  fetch: (spec: AiQuerySpec, scope?: AiScope) => Promise<FetchResult>;
}

/** employee VM → normalized query row (never includes the photo blob) */
function employeeRow(e: EmployeeVM): Row {
  return {
    id: e.id,
    employee_code: e.employee_code,
    full_name: e.full_name,
    nationality: e.nationality,
    position: e.position,
    trade_name: e.trade_name,
    salary_role: e.salary_role,
    site_name: e.site_name,
    branch_name: e.branch_name,
    camp_name: e.camp_name,
    camp_block: e.camp_block,
    camp_room: e.camp_room,
    company_name: e.company_name,
    is_team_leader: e.is_team_leader,
    leader_site_name: e.leader_site_name,
    status: e.status,
    join_date: e.join_date,
    phone: e.phone,
    email: e.email,
    date_of_birth: e.date_of_birth,
    passport_number: e.passport_number,
    passport_status: e.passport_status,
    id_number: e.id_number,
    id_status: e.id_status,
    address: e.address,
    emergency_contact: e.emergency_contact,
    payment_type: e.payment_type,
    card_type_name: e.card_type_name,
    opening_hours: e.opening_hours,
    rating: e.rating,
    created: fmtDate(e.created_at),
    updated: fmtDateTime(e.updated_at),
  };
}

const EMPLOYEE_FIELDS = 'id, employee_code, full_name, nationality, position, trade_name, salary_role (standard|team_leader|supervisor), site_name, branch_name, camp_name, camp_block, camp_room, company_name, is_team_leader, leader_site_name, status, join_date, phone, email, date_of_birth, passport_number, passport_status, id_number, id_status, address, emergency_contact, payment_type, card_type_name, opening_hours, rating, created, updated';

async function fetchEmployeeTable(cancelled: boolean): Promise<FetchResult> {
  const list = cancelled ? await dataApi.listCancelledEmployees() : await dataApi.listEmployees();
  return { rows: list.map(employeeRow) };
}

const TABLES: Record<string, TableDef> = {
  employees: {
    doc: `the active workforce — ${EMPLOYEE_FIELDS}`,
    fields: Object.keys(employeeRow({} as unknown as EmployeeVM)),
    defaultFields: ['employee_code', 'full_name', 'nationality', 'position', 'trade_name', 'site_name', 'status', 'join_date'],
    defaultOrder: { field: 'employee_code' },
    fetch: () => fetchEmployeeTable(false),
  },
  cancelled_employees: {
    doc: `archived workforce (cancelled — all records kept) — same fields as employees`,
    fields: Object.keys(employeeRow({} as unknown as EmployeeVM)),
    defaultFields: ['employee_code', 'full_name', 'nationality', 'position', 'trade_name', 'status', 'join_date'],
    defaultOrder: { field: 'employee_code' },
    fetch: () => fetchEmployeeTable(true),
  },
  cancellation_requests: {
    doc: 'employee cancellation requests — employee_name, employee_code, employee_position, employee_status, status (pending|approved|rejected), reason, requested_by_name, requested_at (when raised), reviewed_by_name, reviewed_at (when approved/rejected — for an APPROVED request reviewed_at IS the employee\u2019s cancellation date)',
    fields: ['employee_name', 'employee_code', 'employee_position', 'employee_status', 'status', 'reason', 'requested_by_name', 'requested_at', 'reviewed_by_name', 'reviewed_at'],
    defaultFields: ['employee_name', 'employee_code', 'status', 'requested_by_name', 'requested_at', 'reviewed_by_name', 'reviewed_at', 'reason'],
    defaultOrder: { field: 'requested_at', desc: true },
    fetch: async () => {
      const list = await dataApi.listCancellationRequests();
      return {
        rows: list.map((c) => ({
          employee_name: c.employee_name,
          employee_code: c.employee_code,
          employee_position: c.employee_position,
          employee_status: c.employee_status,
          status: c.status,
          reason: c.reason,
          requested_by_name: c.requested_by_name,
          requested_at: fmtDateTime(c.created_at),
          reviewed_by_name: c.reviewed_by_name,
          reviewed_at: fmtDateTime(c.reviewed_at),
        })),
      };
    },
  },
  leave_requests: {
    doc: 'leave requests — employee_name, employee_code, leave_type, start_date, end_date, total_days, reason, status, requested_by_name, requested_at, reviewed_by_name, reviewed_at',
    fields: ['employee_name', 'employee_code', 'leave_type', 'start_date', 'end_date', 'total_days', 'reason', 'status', 'requested_by_name', 'requested_at', 'reviewed_by_name', 'reviewed_at'],
    defaultFields: ['employee_name', 'employee_code', 'leave_type', 'start_date', 'end_date', 'total_days', 'status', 'requested_at', 'reviewed_at'],
    defaultOrder: { field: 'requested_at', desc: true },
    fetch: async () => {
      const list = await dataApi.listLeaveRequests();
      return {
        rows: list.map((l) => ({
          employee_name: l.employee_name,
          employee_code: l.employee_code,
          leave_type: l.other_type_text || l.leave_type,
          start_date: l.start_date,
          end_date: l.end_date,
          total_days: l.total_days,
          reason: l.reason,
          status: l.status,
          requested_by_name: l.created_by_name,
          requested_at: fmtDateTime(l.created_at),
          reviewed_by_name: l.reviewed_by_name,
          reviewed_at: fmtDateTime(l.reviewed_at),
        })),
      };
    },
  },
  attendance: {
    doc: 'daily attendance records — employee_code, employee_name, date, status (present|absent|not_marked), hours, note (free-text marker). Param: {"month":"YYYY-MM"} (required)',
    fields: ['employee_code', 'employee_name', 'date', 'status', 'hours', 'note'],
    defaultFields: ['employee_code', 'employee_name', 'date', 'status', 'hours', 'note'],
    defaultOrder: { field: 'date', desc: true },
    requiresMonth: true,
    fetch: async (spec) => {
      const month = spec.month ?? '';
      const [records, active, cancelled] = await Promise.all([
        dataApi.getMonthAttendance(month),
        dataApi.listEmployees(),
        dataApi.listCancelledEmployees(),
      ]);
      const byId = new Map([...active, ...cancelled].map((e) => [e.id, e]));
      const rows = (records as Attendance[])
        .filter((r) => !r.is_hidden)
        .map((r) => {
          const e = byId.get(r.employee_id);
          return {
            employee_code: e?.employee_code ?? r.employee_id.slice(0, 8),
            employee_name: e?.full_name ?? 'unknown',
            date: r.date,
            status: r.status,
            hours: r.hours,
            note: r.note ?? null,
          } satisfies Row;
        });
      return { rows, header: `month ${month}` };
    },
  },
  salary_sheet: {
    doc: 'monthly salary settlements — employee_code, full_name, trade_name, camp_name, payment_type, salary_role, total_hours, opening_lifetime_hours, closing_lifetime_hours, gross_salary, absent_deduction, advance, deduction, net_salary, payment_status (AED). Param: {"month":"YYYY-MM"} (required)',
    fields: ['employee_code', 'full_name', 'trade_name', 'camp_name', 'payment_type', 'salary_role', 'total_hours', 'opening_lifetime_hours', 'closing_lifetime_hours', 'gross_salary', 'absent_deduction', 'advance', 'deduction', 'net_salary', 'payment_status'],
    defaultFields: ['employee_code', 'full_name', 'total_hours', 'gross_salary', 'absent_deduction', 'advance', 'deduction', 'net_salary', 'payment_status'],
    defaultOrder: { field: 'employee_code' },
    requiresMonth: true,
    fetch: async (spec, scope) => {
      const month = spec.month ?? '';
      const year = Number(month.slice(0, 4));
      const mon = Number(month.slice(5, 7));
      const report = await dataApi.getSalarySheet(year, mon);
      // branch-scoped viewers get the report narrowed inside the scope —
      // rows by site membership, totals recomputed (same rule as the
      // Salary Sheet page), so another branch's amounts never leak
      const scopedReport = scope ? scope.scopeSalaryReport(report) : report;
      if (!scopedReport || !scopedReport.exists) return { rows: [], header: `no salary sheet exists for ${month}` };
      const t = scopedReport.totals;
      const rows = scopedReport.employees.map((p) => ({
        employee_code: p.employee_code,
        full_name: p.full_name,
        trade_name: p.trade_name,
        camp_name: p.camp_name,
        payment_type: p.payment_type,
        salary_role: p.salary_role,
        total_hours: p.total_hours,
        opening_lifetime_hours: p.opening_lifetime_hours,
        closing_lifetime_hours: p.closing_lifetime_hours,
        gross_salary: p.gross_salary,
        absent_deduction: p.absent_deduction,
        advance: p.advance,
        deduction: p.deduction,
        net_salary: p.net_salary,
        payment_status: p.payment_status,
      }));
      return {
        rows,
        header: `month ${month} · period ${scopedReport.period?.status ?? 'draft'} · totals: ${t.employees} employees, ${t.total_hours} h, gross AED ${t.gross_salary}, net AED ${t.net_payable}, paid ${t.paid_count}/${t.employees}`,
      };
    },
  },
  advance_book: {
    doc: 'advance ledger — employee_code, full_name, amount, given_date, cut (YYYY-MM the advance is recovered from), note, cleared, overdue, applied, from_time_card, cleared_at, created_by_name, created. Amounts in AED',
    fields: ['employee_code', 'full_name', 'amount', 'given_date', 'cut', 'note', 'cleared', 'overdue', 'applied', 'from_time_card', 'cleared_at', 'created_by_name', 'created'],
    defaultFields: ['employee_code', 'full_name', 'amount', 'given_date', 'cut', 'cleared', 'overdue', 'note'],
    defaultOrder: { field: 'given_date', desc: true },
    fetch: async () => {
      const book = await dataApi.getAdvanceBook();
      if (!book) return { rows: [] };
      const t = book.totals;
      const rows = book.records.map((r) => ({
        employee_code: r.employee_code,
        full_name: r.full_name,
        amount: r.amount,
        given_date: r.given_date,
        cut: `${r.cut_year}-${String(r.cut_month).padStart(2, '0')}`,
        note: r.note,
        cleared: r.cleared,
        overdue: r.overdue,
        applied: r.applied,
        from_time_card: !!r.from_time_card,
        cleared_at: fmtDate(r.cleared_at),
        created_by_name: r.created_by_name,
        created: fmtDate(r.created_at),
      }));
      return {
        rows,
        header: `due ${t.due_count} (AED ${t.due_amount}) · overdue ${t.overdue_count} (AED ${t.overdue_amount}) · cleared ${t.cleared_count} (AED ${t.cleared_amount})`,
      };
    },
  },
  trades: {
    doc: 'trades with their current rates — name, description, is_active, rates (one cell per salary role × experience tier)',
    fields: ['name', 'description', 'is_active', 'rates', 'created'],
    defaultFields: ['name', 'is_active', 'rates'],
    defaultOrder: { field: 'name' },
    fetch: async () => {
      const list = await dataApi.listTrades();
      return {
        rows: list.map((t) => ({
          name: t.name,
          description: t.description,
          is_active: t.is_active,
          rates: t.current_rates
            .map((r) => `${r.salary_role}/${r.experience_tier} ${r.hourly_rate} AED/h`)
            .join(', '),
          created: fmtDate(t.created_at),
        })),
      };
    },
  },
  trade_rates: {
    doc: 'hourly rates per trade × salary_role × experience_tier — trade_name, salary_role, experience_tier, hourly_rate (AED), effective_from, effective_to (empty = current). Optional param: {"trade_id":"…"} for the full history of one trade (id comes from trades)',
    fields: ['trade_name', 'salary_role', 'experience_tier', 'hourly_rate', 'effective_from', 'effective_to'],
    defaultFields: ['trade_name', 'salary_role', 'experience_tier', 'hourly_rate', 'effective_from', 'effective_to'],
    defaultOrder: { field: 'effective_from', desc: true },
    fetch: async (spec) => {
      const trades = await dataApi.listTrades();
      if (spec.trade_id) {
        const trade = trades.find((t) => t.id === spec.trade_id);
        if (!trade) return { rows: [], header: `no trade with id ${spec.trade_id}` };
        const history = (await dataApi.getTradeRateHistory(spec.trade_id)) as TradeRate[];
        return {
          rows: history.map((r) => ({
            trade_name: trade.name,
            salary_role: r.salary_role,
            experience_tier: r.experience_tier,
            hourly_rate: r.hourly_rate,
            effective_from: r.effective_from,
            effective_to: r.effective_to ?? '',
          })),
          header: `history of ${trade.name}`,
        };
      }
      const rows = trades.flatMap((t) =>
        t.current_rates.map((r) => ({
          trade_name: t.name,
          salary_role: r.salary_role,
          experience_tier: r.experience_tier,
          hourly_rate: r.hourly_rate,
          effective_from: r.effective_from,
          effective_to: r.effective_to ?? '',
        })),
      );
      return { rows, header: 'current rates' };
    },
  },
  monthly_attendance_summary: {
    doc: 'attendance counts per month — month (YYYY-MM), status (present|absent|not_marked), count. Optional param: {"months":6} (how far back)',
    fields: ['month', 'status', 'count'],
    defaultFields: ['month', 'status', 'count'],
    defaultOrder: { field: 'month', desc: true },
    // whole-organization counts — outside a branch admin's access
    superOnly: true,
    fetch: async (spec) => {
      const rows = await dataApi.getMonthlyAttendanceSummary(spec.months ?? 6);
      return { rows: rows.map((r) => ({ month: r.month, status: r.status, count: r.count })) };
    },
  },
  warnings: {
    doc: 'employee warnings — employee_name, employee_code, type (auto|manual), reason, absent_dates, issued_by_name, date',
    fields: ['employee_name', 'employee_code', 'type', 'reason', 'absent_dates', 'issued_by_name', 'date'],
    defaultFields: ['employee_name', 'employee_code', 'type', 'reason', 'issued_by_name', 'date'],
    defaultOrder: { field: 'date', desc: true },
    fetch: async () => {
      const list = await dataApi.listWarnings();
      return {
        rows: list.map((w) => ({
          employee_name: w.employee_name,
          employee_code: w.employee_code,
          type: w.is_auto_generated ? 'auto' : 'manual',
          reason: w.reason,
          absent_dates: (w.absent_dates ?? []).join(','),
          issued_by_name: w.issued_by_name,
          date: fmtDateTime(w.created_at),
        })),
      };
    },
  },
  fines: {
    doc: 'employee fines — employee_name, employee_code, amount (AED), reason, issued_by_name, date',
    fields: ['employee_name', 'employee_code', 'amount', 'reason', 'issued_by_name', 'date'],
    defaultFields: ['employee_name', 'employee_code', 'amount', 'reason', 'issued_by_name', 'date'],
    defaultOrder: { field: 'date', desc: true },
    fetch: async () => {
      const list = await dataApi.listFines();
      return {
        rows: list.map((f) => ({
          employee_name: f.employee_name,
          employee_code: f.employee_code,
          amount: f.amount,
          reason: f.reason,
          issued_by_name: f.issued_by_name,
          date: fmtDateTime(f.created_at),
        })),
      };
    },
  },
  notifications: {
    doc: 'in-app notifications — type (request|warning|fine), title, message, read, date',
    fields: ['type', 'title', 'message', 'read', 'date'],
    defaultFields: ['type', 'title', 'message', 'read', 'date'],
    defaultOrder: { field: 'date', desc: true },
    fetch: async () => {
      const list = await dataApi.listNotifications();
      return {
        rows: list.map((n) => ({
          type: n.type,
          title: n.title,
          message: n.message,
          read: n.read,
          date: fmtDateTime(n.created_at),
        })),
      };
    },
  },
  uniforms: {
    doc: 'uniform tokens — token_number, employee_name, employee_id (UUID), document_type (id|passport), document_number, site_name, team_leader_name, is_renewal, previous_token_id, renewal_date, items (issued pieces)',
    fields: ['token_number', 'employee_name', 'employee_id', 'document_type', 'document_number', 'site_name', 'team_leader_name', 'is_renewal', 'previous_token_id', 'renewal_date', 'items', 'created'],
    defaultFields: ['token_number', 'employee_name', 'site_name', 'is_renewal', 'renewal_date', 'items'],
    defaultOrder: { field: 'renewal_date', desc: true },
    fetch: async () => {
      const list = await dataApi.listUniformEntries();
      return {
        rows: list.map((u) => ({
          token_number: u.token_number,
          employee_name: u.employee_name,
          employee_id: u.employee_id,
          document_type: u.document_type,
          document_number: u.document_number,
          site_name: u.site_name,
          team_leader_name: u.team_leader_name,
          is_renewal: u.is_renewal,
          previous_token_id: u.previous_token_id,
          renewal_date: u.renewal_date,
          items: Object.entries(u.items ?? {}).filter(([, v]) => v).map(([k]) => k).join('+'),
          created: fmtDate(u.created_at),
        })),
      };
    },
  },
  employee_notes: {
    doc: 'sticky notes about employees (Payroll page) — employee_code, employee_name, note, author_name, date',
    fields: ['employee_code', 'employee_name', 'note', 'author_name', 'date'],
    defaultFields: ['employee_code', 'employee_name', 'note', 'author_name', 'date'],
    defaultOrder: { field: 'date', desc: true },
    fetch: async () => {
      const [notes, active, cancelled] = await Promise.all([
        dataApi.listEmployeeNotes(),
        dataApi.listEmployees(),
        dataApi.listCancelledEmployees(),
      ]);
      const byId = new Map([...active, ...cancelled].map((e) => [e.id, e]));
      return {
        rows: notes.map((n) => {
          const e = byId.get(n.employee_id);
          return {
            employee_code: e?.employee_code ?? n.employee_id.slice(0, 8),
            employee_name: e?.full_name ?? 'unknown',
            note: n.note,
            author_name: n.author_name,
            date: fmtDateTime(n.created_at),
          };
        }),
      };
    },
  },
  site_transfers: {
    doc: 'recorded site moves — employee_code, employee_name, from_site, to_site (null = idle/unassigned), effective_date, moved_at',
    fields: ['employee_code', 'employee_name', 'from_site', 'to_site', 'effective_date', 'moved_at'],
    defaultFields: ['employee_code', 'employee_name', 'from_site', 'to_site', 'effective_date', 'moved_at'],
    defaultOrder: { field: 'moved_at', desc: true },
    fetch: async () => {
      const [transfers, active, cancelled, sites] = await Promise.all([
        dataApi.listSiteTransfers(),
        dataApi.listEmployees(),
        dataApi.listCancelledEmployees(),
        dataApi.listSites(),
      ]);
      const byId = new Map([...active, ...cancelled].map((e) => [e.id, e]));
      const siteName = (id: string | null): string | null => (id ? sites.find((s) => s.id === id)?.name ?? null : null);
      return {
        rows: transfers.map((t) => {
          const e = byId.get(t.employee_id);
          return {
            employee_code: e?.employee_code ?? t.employee_id.slice(0, 8),
            employee_name: e?.full_name ?? 'unknown',
            from_site: siteName(t.from_site_id),
            to_site: siteName(t.to_site_id),
            effective_date: t.effective_date,
            moved_at: fmtDateTime(t.created_at),
          };
        }),
      };
    },
  },
  attendance_share_links: {
    doc: 'shareable digital attendance sheets — token, site_name, month_key, status (active|submitted), created_by_name, created, submitted_at, submit_count',
    fields: ['token', 'site_name', 'month_key', 'status', 'created_by_name', 'created', 'submitted_at', 'submit_count'],
    defaultFields: ['token', 'site_name', 'month_key', 'status', 'created', 'submit_count'],
    defaultOrder: { field: 'created', desc: true },
    fetch: async () => {
      const list = (await dataApi.listAttendanceShareLinks()) as AttendanceShareLink[];
      return {
        rows: list.map((l) => ({
          token: l.token,
          site_name: l.site_name,
          month_key: l.month_key,
          status: l.status,
          created_by_name: l.created_by_name ?? null,
          created: fmtDateTime(l.created_at),
          submitted_at: fmtDateTime(l.submitted_at),
          submit_count: l.submit_count,
        })),
      };
    },
  },
  working_hours: {
    doc: 'per-employee monthly worked hours by site — month (YYYY-MM), site, hours, days. Param: {"employee_id":"…"} (required — the UUID id field of employees / cancelled_employees)',
    fields: ['month', 'site', 'hours', 'days'],
    defaultFields: ['month', 'site', 'hours', 'days'],
    defaultOrder: { field: 'month', desc: true },
    requiresEmployeeId: true,
    fetch: async (spec) => {
      const report = await dataApi.getEmployeeWorkingHours(spec.employee_id ?? '');
      const rows = report.monthlyBreakdown.flatMap((m) =>
        m.sites.map((s) => ({
          month: `${m.year}-${String(m.month).padStart(2, '0')}`,
          site: s.siteName,
          hours: s.totalHours,
          days: m.attendanceDays,
        })),
      );
      return {
        rows,
        header: `employee ${report.employeeCode} ${report.fullName} · opening ${report.openingHours} h · tracked ${report.trackedHours} h · lifetime ${report.lifetimeHours} h`,
      };
    },
  },
  admins: {
    doc: 'admin accounts — name, email, role (super_admin|admin|pending), menus (allowed menu labels), branches (supervised branch names), sites (directly assigned site names; branch sites included for super admins), created',
    fields: ['name', 'email', 'role', 'menus', 'branches', 'sites', 'created'],
    defaultFields: ['name', 'role', 'menus', 'branches', 'sites'],
    defaultOrder: { field: 'name' },
    // every account's email + grants — super admin / All-Branches only
    superOnly: true,
    fetch: async () => {
      const list = await dataApi.listAdminAccess();
      return {
        rows: list.map((a) => ({
          name: a.name,
          email: a.email,
          role: a.role,
          menus: a.role === 'super_admin' ? 'ALL' : a.menus.join(', ') || '(defaults only)',
          branches: a.role === 'super_admin' ? 'ALL' : a.branches.join(', ') || '(none)',
          sites: a.role === 'super_admin' ? 'ALL' : a.sites.join(', ') || '(none)',
          created: a.created,
        })),
      };
    },
  },
  branches: {
    doc: 'regional branches — name, location, is_active, site_count, employee_count, created',
    fields: ['name', 'location', 'is_active', 'site_count', 'employee_count', 'created'],
    defaultFields: ['name', 'location', 'is_active', 'site_count', 'employee_count'],
    defaultOrder: { field: 'name' },
    fetch: async () => {
      const list = await dataApi.listBranches();
      return {
        rows: list.map((b) => ({
          name: b.name,
          location: b.location,
          is_active: b.is_active,
          site_count: b.site_count,
          employee_count: b.employee_count,
          created: fmtDate(b.created_at),
        })),
      };
    },
  },
  sites: {
    doc: 'work sites — name, client_name, project_name, supervisor, is_active, employee_count, created',
    fields: ['name', 'client_name', 'project_name', 'supervisor', 'is_active', 'employee_count', 'created'],
    defaultFields: ['name', 'client_name', 'project_name', 'supervisor', 'is_active', 'employee_count'],
    defaultOrder: { field: 'name' },
    fetch: async () => {
      const list = await dataApi.listSites();
      return {
        rows: list.map((s) => ({
          name: s.name,
          client_name: s.client_name,
          project_name: s.project_name,
          supervisor: s.supervisor,
          is_active: s.is_active,
          employee_count: s.employee_count,
          created: fmtDate(s.created_at),
        })),
      };
    },
  },
  camps: {
    doc: 'accommodation camps — name, location, capacity, is_active, employee_count (in-scope residents for branch-scoped viewers), created',
    fields: ['name', 'location', 'capacity', 'is_active', 'employee_count', 'created'],
    defaultFields: ['name', 'location', 'capacity', 'is_active', 'employee_count'],
    defaultOrder: { field: 'name' },
    fetch: async (spec, scope) => {
      const list = await dataApi.listCamps();
      // branch-scoped viewers only see camps housing their own employees,
      // with in-scope resident counts (another branch's camp never leaks)
      const scopedList = scope && !scope.unrestricted
        ? (() => {
            const residents = new Map<string, number>();
            scope.employees.forEach((e) => {
              if (e.camp_name) residents.set(e.camp_name, (residents.get(e.camp_name) ?? 0) + 1);
            });
            return list
              .filter((c) => (residents.get(c.name) ?? 0) > 0)
              .map((c) => ({ ...c, employee_count: residents.get(c.name) ?? 0 }));
          })()
        : list;
      return {
        rows: scopedList.map((c) => ({
          name: c.name,
          location: c.location,
          capacity: c.capacity,
          is_active: c.is_active,
          employee_count: c.employee_count,
          created: fmtDate(c.created_at),
        })),
      };
    },
  },
  companies: {
    doc: 'manpower companies — name, created',
    fields: ['name', 'created'],
    defaultFields: ['name', 'created'],
    defaultOrder: { field: 'name' },
    fetch: async () => {
      const list = await dataApi.listCompanies();
      return { rows: list.map((c) => ({ name: c.name, created: fmtDate(c.created_at) })) };
    },
  },
  card_types: {
    doc: 'payroll card types — name, created',
    fields: ['name', 'created'],
    defaultFields: ['name', 'created'],
    defaultOrder: { field: 'name' },
    fetch: async () => {
      const list = await dataApi.listCardTypes();
      return { rows: list.map((c) => ({ name: c.name, created: fmtDate(c.created_at) })) };
    },
  },
  deduction_settings: {
    doc: 'the absent-deduction rule — absent_free_days (first N absences free per month), absent_deduction_amount (AED per absence after), updated_by_name',
    fields: ['absent_free_days', 'absent_deduction_amount', 'updated_by_name'],
    defaultFields: ['absent_free_days', 'absent_deduction_amount', 'updated_by_name'],
    fetch: async () => {
      const s = await dataApi.getDeductionSettings();
      return {
        rows: [{
          absent_free_days: s.absent_free_days,
          absent_deduction_amount: s.absent_deduction_amount,
          updated_by_name: s.updated_by_name,
        }],
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Directive parsing — [[QUERY]] {json}
// ---------------------------------------------------------------------------

/** Parse a model reply that is a [[QUERY]] directive. Returns null when the
 *  reply is not directive-shaped at all (a normal answer); returns {error}
 *  when it is directive-shaped but malformed — the widget feeds the error
 *  back to the model so it can retry with corrected JSON. */
export function parseAiQueryDirective(reply: string): ParsedQueryDirective {
  const text = reply.trim();
  const m = /^\[\[QUERY\]\]\s*([\s\S]+)$/i.exec(text);
  if (!m) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return { error: 'the text after [[QUERY]] is not valid JSON — resend the directive as one JSON object, e.g. [[QUERY]] {"table":"employees","where":[{"field":"nationality","op":"eq","value":"India"}]}' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'the query must be a single JSON object with at least a "table" key' };
  }
  const o = raw as Record<string, unknown>;

  const table = typeof o.table === 'string' ? o.table.trim().toLowerCase() : '';
  const def = table ? TABLES[table] : undefined;
  if (!def) {
    return { error: `unknown table "${table}" — valid tables: ${Object.keys(TABLES).join(', ')}` };
  }

  const spec: AiQuerySpec = { table };

  if (def.requiresMonth) {
    if (typeof o.month !== 'string' || !MONTH_RE.test(o.month)) {
      return { error: `table "${table}" requires "month" as "YYYY-MM"` };
    }
    spec.month = o.month;
  }
  if (typeof o.trade_id === 'string' && o.trade_id) spec.trade_id = o.trade_id;
  if (typeof o.employee_id === 'string' && o.employee_id) spec.employee_id = o.employee_id;
  if (def.requiresEmployeeId && !spec.employee_id) {
    return { error: `table "${table}" requires "employee_id" (the UUID id field of employees / cancelled_employees)` };
  }
  if (o.months !== undefined) {
    const months = Number(o.months);
    if (!Number.isFinite(months) || months < 1 || months > 36) {
      return { error: '"months" must be a number between 1 and 36' };
    }
    spec.months = Math.round(months);
  }

  if (o.where !== undefined) {
    if (!Array.isArray(o.where)) return { error: '"where" must be an array of {field, op, value}' };
    const where: AiQueryFilter[] = [];
    for (const w of o.where) {
      if (!w || typeof w !== 'object' || typeof (w as AiQueryFilter).field !== 'string') {
        return { error: 'every "where" entry needs a string "field"' };
      }
      const f = w as { field: string; op?: unknown; value?: unknown };
      const op = typeof f.op === 'string' ? f.op.toLowerCase() : 'eq';
      if (!OPS.includes(op)) {
        return { error: `unknown op "${String(f.op)}" — valid ops: ${OPS.join(', ')}` };
      }
      if (op !== 'is_null' && op !== 'not_null' && f.value === undefined) {
        return { error: `op "${op}" needs a "value"` };
      }
      where.push({ field: f.field, op: op as AiQueryOp, value: f.value });
    }
    spec.where = where;
  }

  if (o.fields !== undefined) {
    if (!Array.isArray(o.fields) || !o.fields.every((f) => typeof f === 'string')) {
      return { error: '"fields" must be an array of column names' };
    }
    spec.fields = (o.fields as string[]).slice(0, 12);
  }

  if (o.order_by !== undefined) {
    if (typeof o.order_by !== 'string' || !o.order_by) return { error: '"order_by" must be a column name' };
    spec.order_by = o.order_by;
  }
  if (typeof o.desc === 'boolean') spec.desc = o.desc;

  if (o.limit !== undefined) {
    const limit = Number(o.limit);
    if (!Number.isFinite(limit) || limit < 1) return { error: '"limit" must be a positive number' };
    spec.limit = Math.min(Math.round(limit), 200);
  }

  if (o.group_by !== undefined) {
    if (typeof o.group_by !== 'string' || !o.group_by) return { error: '"group_by" must be a column name' };
    spec.group_by = o.group_by;
  }
  if (o.aggregate !== undefined) {
    const agg = String(o.aggregate).toLowerCase();
    if (!AGGREGATES.includes(agg)) {
      return { error: `unknown aggregate "${String(o.aggregate)}" — valid: ${AGGREGATES.join(', ')}` };
    }
    spec.aggregate = agg as AiQueryAggregate;
  }
  if (o.on !== undefined) {
    if (typeof o.on !== 'string' || !o.on) return { error: '"on" must be a column name' };
    spec.on = o.on;
  }
  if (spec.aggregate && spec.aggregate !== 'count' && !spec.on) {
    return { error: `aggregate "${spec.aggregate}" needs "on" (the numeric column)` };
  }

  return { spec };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Aggregate (optionally grouped) rows into result lines. */
function aggregateLines(rows: Row[], spec: AiQuerySpec): string[] {
  const agg = spec.aggregate ?? 'count';
  const on = spec.on;

  const one = (group: Row[]): string => {
    if (agg === 'count') return String(group.length);
    const nums = group.map((r) => Number(r[on as string])).filter((n) => Number.isFinite(n));
    if (nums.length === 0) return '—';
    if (agg === 'sum') return String(round2(nums.reduce((a, b) => a + b, 0)));
    if (agg === 'avg') return String(round2(nums.reduce((a, b) => a + b, 0) / nums.length));
    if (agg === 'min') return String(Math.min(...nums));
    return String(Math.max(...nums));
  };

  if (spec.group_by) {
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = fmtVal(r[spec.group_by]);
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([k, g]) => ({ k, g, v: one(g) }))
      .sort((a, b) => compareVals(b.v, a.v))
      .map((x) => `- ${x.k}: ${agg}${on ? `(${on})` : ''} = ${x.v} (${x.g.length} row(s))`);
  }
  return [`${agg}${on ? `(${on})` : ''} = ${one(rows)} (${rows.length} row(s))`];
}

/** Validate a field name against the table's columns. */
function fieldError(table: string, def: TableDef, kind: string, field: string): string {
  return `DATABASE QUERY ERROR — table "${table}" has no ${kind} "${field}". Valid fields: ${def.fields.join(', ')}. Re-run the corrected query.`;
}

// ---------------------------------------------------------------------------
// Branch scoping — rows outside the viewer's access are dropped BEFORE any
// filter / aggregate runs, so a scoped admin can never even COUNT another
// branch's records. Tables whose fetch already narrows inside the scope
// (salary_sheet, camps) or that are server-scoped (branches, trades) or
// org-wide reference / the viewer's own inbox (companies, card_types,
// deduction_settings, notifications) pass through untouched.
// ---------------------------------------------------------------------------

/** the site-name key of a row (sites carry `name`, link rows `site_name`) */
const siteKeyOf = (r: Row): string | null => {
  const v = r.site_name ?? r.name;
  return typeof v === 'string' ? v : null;
};

function scopeRowsForTable(table: string, rows: Row[], scope: AiScope): Row[] {
  const byCode = (r: Row): boolean =>
    typeof r.employee_code === 'string' && scope.employeeByCodeInScope(r.employee_code);
  switch (table) {
    case 'employees':
    case 'cancelled_employees':
    case 'cancellation_requests':
    case 'leave_requests':
    case 'warnings':
    case 'fines':
    case 'employee_notes':
    case 'site_transfers':
    case 'attendance':
    case 'advance_book':
      // employee-linked rows — only the viewer's employees exist
      return rows.filter(byCode);
    case 'uniforms':
      return rows.filter((r) => scope.employeeByIdInScope(
        typeof r.employee_id === 'string' ? r.employee_id : null,
      ));
    case 'sites':
    case 'attendance_share_links':
      return rows.filter((r) => scope.siteNameInScope(siteKeyOf(r)));
    default:
      return rows;
  }
}

/** Run a validated spec against the live database, optionally limited to the
 *  viewer's access scope. NEVER throws — errors come back as text so the
 *  model can self-correct on the next hop. */
export async function runAiQuery(spec: AiQuerySpec, scope?: AiScope): Promise<string> {
  const def = TABLES[spec.table];
  if (!def) {
    return `DATABASE QUERY ERROR — unknown table "${spec.table}". Valid tables: ${Object.keys(TABLES).join(', ')}.`;
  }

  // ---- branch-scope guards (before anything is fetched) -------------------
  const scopedDown = scope !== undefined && !scope.unrestricted;
  if (scopedDown && def.superOnly) {
    return `DATABASE QUERY ERROR — table "${spec.table}" covers the whole organization (every admin / every branch) and is available to super admins and All-Branches admins only. It is outside this viewer's branch access; answer from the snapshot's scoped sections instead.`;
  }
  if (scopedDown && spec.table === 'working_hours' && !scope.employeeByIdInScope(spec.employee_id)) {
    return `DATABASE QUERY ERROR — that employee is outside your branch access (only employees working at your granted branches' sites — or directly assigned sites — can be queried). Pick an employee from the EMPLOYEE DIRECTORY of the snapshot.`;
  }

  // field-name validation (cheap, before fetching when possible)
  for (const f of spec.where ?? []) {
    if (!def.fields.includes(f.field)) return fieldError(spec.table, def, 'field', f.field);
  }
  if (spec.order_by && !def.fields.includes(spec.order_by)) return fieldError(spec.table, def, 'order_by column', spec.order_by);
  if (spec.group_by && !def.fields.includes(spec.group_by)) return fieldError(spec.table, def, 'group_by column', spec.group_by);
  if (spec.on && !def.fields.includes(spec.on)) return fieldError(spec.table, def, 'aggregate column', spec.on);
  const projection = spec.fields?.filter((f) => !def.fields.includes(f));
  if (projection && projection.length > 0) return fieldError(spec.table, def, 'field', projection[0]);

  let fetched: FetchResult;
  try {
    fetched = await def.fetch(spec, scope);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'the fetch failed';
    return `DATABASE QUERY ERROR — table "${spec.table}" could not be read (${msg}). Check the parameters and retry.`;
  }

  // rows outside the viewer's branch scope are dropped BEFORE any filter /
  // aggregate runs (unrestricted viewers and pass-through tables: no-op)
  const allRows = scopedDown ? scopeRowsForTable(spec.table, fetched.rows, scope) : fetched.rows;
  const filters = spec.where ?? [];
  const rows = filters.length ? allRows.filter((r) => filters.every((f) => applyFilter(r, f))) : [...allRows];

  const headerBits = [`table ${spec.table}`];
  if (fetched.header) headerBits.push(fetched.header);
  if (scopedDown) headerBits.push("scoped to the viewer's branch access");
  if (filters.length) {
    headerBits.push(`filters: ${filters.map((f) => `${f.field} ${f.op}${f.value !== undefined ? ` ${String(f.value)}` : ''}`).join(' AND ')}`);
  }

  // --- aggregate / group_by path ---
  if (spec.aggregate || spec.group_by) {
    const lines = aggregateLines(rows, spec);
    return [
      `DATABASE QUERY RESULT — ${headerBits.join(' · ')} · ${rows.length} row(s) matched`,
      ...lines,
    ].join('\n');
  }

  // --- row path: sort → limit → project ---
  const orderField = spec.order_by ?? def.defaultOrder?.field;
  if (orderField) {
    const desc = spec.desc ?? def.defaultOrder?.desc ?? false;
    rows.sort((a, b) => (desc ? -1 : 1) * compareVals(a[orderField], b[orderField]));
  }

  const limit = spec.limit ?? 25;
  const fields = spec.fields?.length ? spec.fields : def.defaultFields;
  const shown = rows.slice(0, limit);
  const lines = shown.map((r) => `- ${fields.map((f) => `${f}: ${fmtVal(r[f])}`).join(' · ')}`);
  const more = rows.length > limit ? `\n(… ${rows.length - limit} more row(s) matched — narrow with "where" or raise "limit" up to 200)` : '';

  if (shown.length === 0) {
    return `DATABASE QUERY RESULT — ${headerBits.join(' · ')} · 0 rows matched. Relax the filters or query a different table.`;
  }
  return `DATABASE QUERY RESULT — ${headerBits.join(' · ')} · ${rows.length} row(s) matched\n${lines.join('\n')}${more}`;
}

// ---------------------------------------------------------------------------
// Prompt documentation — the table dictionary for the system prompt
// ---------------------------------------------------------------------------

/** Compact dictionary of every queryable table + the query syntax. A
 *  branch-scoped viewer's dictionary drops the org-wide tables and states
 *  upfront that every result is limited to their access. */
export function queryableTablesDoc(scope?: AiScope): string {
  const scopedDown = scope !== undefined && !scope.unrestricted;
  const tableLines = Object.entries(TABLES)
    .filter(([name, def]) => !(scopedDown && def.superOnly))
    .map(([name, def]) => `- ${name} — ${def.doc}`);
  return [
    ...(scopedDown
      ? ['QUERY RESULTS ARE LIMITED TO THE VIEWER\'S BRANCH ACCESS — records of other branches / outside your access do not exist and can never be returned. The org-wide tables (admins, whole-organization attendance summary) are not queryable for you.', '']
      : []),
    'Pebby can run structured queries against every table the viewer can see. When the snapshot above omits what you need (exact timestamps, other months, filtered / sorted / aggregated / cross-table views), reply with EXACTLY one directive line and nothing else:',
    '[[QUERY]] {"table":"cancellation_requests","where":[{"field":"employee_code","op":"eq","value":"ASM-2026-016"}]}',
    'The system executes it and asks you again with the matching rows — then answer the user. You may chain up to 3 query rounds per question (e.g. resolve an employee code, then pull their records from another table). If the result is a QUERY ERROR it lists the valid fields — simply re-run the corrected query.',
    '',
    'TABLES:',
    ...tableLines,
    '',
    'QUERY OPTIONS (all optional except table):',
    '- "where":[{"field":F,"op":OP,"value":V}] — OP = eq | ne | gt | gte | lt | lte | contains (case-insensitive substring) | in (V is an array) | is_null | not_null. String eq/contains ignore case; comparing a datetime column with a plain "YYYY-MM-DD" value matches that whole day.',
    '- "fields":["a","b"] — project columns · "order_by":F with "desc":true — sort · "limit":N (default 25, max 200)',
    '- "group_by":F with "aggregate":"count|sum|avg|min|max" and "on":numericColumn — e.g. {"table":"employees","group_by":"nationality","aggregate":"count"} or {"table":"advance_book","where":[{"field":"overdue","op":"eq","value":true}],"aggregate":"sum","on":"amount"}',
    '- booleans compare with true/false (e.g. "value":true).',
    '',
    'WORKED EXAMPLES:',
    '- When was an employee cancelled? → [[QUERY]] {"table":"cancellation_requests","where":[{"field":"employee_code","op":"eq","value":"ASM-2026-016"}]} — the row\'s reviewed_at (status approved) IS the cancellation date.',
    '- Name→code first when unsure: [[QUERY]] {"table":"cancelled_employees","fields":["employee_code","full_name"],"where":[{"field":"full_name","op":"contains","value":"Hassan"}]}',
    '- History month: [[QUERY]] {"table":"attendance","month":"2026-08","where":[{"field":"employee_code","op":"eq","value":"PUL-2026-002"}]}',
    '- Top 5 by net salary: [[QUERY]] {"table":"salary_sheet","month":"2026-10","order_by":"net_salary","desc":true,"limit":5}',
  ].join('\n');
}
