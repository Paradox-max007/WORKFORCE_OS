// ============================================================================
// PULSE Workforce OS — Pebby knowledge base (the in-app Smart Assistant)
// ----------------------------------------------------------------------------
// Pebby answers EVERY question with a fresh database search: before each
// message the chat widget rebuilds this knowledge package from the live
// dataApi (demo store OR Supabase — both expose the same interface) and
// sends it as the system prompt.
//
//   • buildAiKnowledgeBase()  — fetches every readable entity of the system
//   • buildAiSystemPrompt()   — identity + app guide + a COMPACT, COMPLETE
//                               text snapshot (employee directory never
//                               dropped, every request carries its dates) +
//                               the table dictionary + answer protocol below
//   • formatEmployeeDeepDive / formatAttendanceMonth / formatSalarySheetPeriod
//                             — on-demand deep records for [[LOOKUP]] rounds
//   • complex querying       — the [[QUERY]] directive (query-engine.ts) lets
//                               Pebby filter / sort / group / aggregate EVERY
//                               table of the database on demand; the widget
//                               runs the query and re-asks (up to 3 hops)
//   • off-topic questions     — the model replies with a [[WEB: query]]
//                               directive; the /api/ai proxy researches the
//                               web (news RSS + Wikipedia) and re-asks, so
//                               Pebby can answer current-affairs questions too.
// ============================================================================

import { dataApi } from '@/lib/data';
import { queryableTablesDoc } from '@/lib/ai/query-engine';
import type {
  Attendance, EmployeeVM, LeaveRequestVM, Notification, SalarySheetReport,
  SiteSettings, UniformEntry, WarningVM, FineVM, CancellationRequestVM,
} from '@/lib/types';

/** Everything the AI is allowed to read — one serializable snapshot. */
export interface AiKnowledgeBase {
  generated_at: string;
  /** entity → row count, shown on the Site Settings page as the AI scope */
  counts: Record<string, number>;
  data: Record<string, unknown>;
}

/** The bot's display name (floating widget + settings page). */
export const BOT_NAME = 'Pebby';
export const BOT_TITLE = 'Pebby — Smart Assistant';

/** Plain-language description of the whole system — Pebby's "product manual". */
export const AI_APP_GUIDE = `PULSE Workforce OS — workforce & payroll management for a UAE contracting company (currency: AED).

MODULES
- Dashboard: branch-scoped overview (employees, present/absent, monthly attendance, site breakdown).
- Employees: full directory (name, code, nationality, position, trade, company, passport/ID status, camp, site, rating, team-leader flags). Deletion goes through Cancellation Requests — an APPROVED request CANCELS the employee (status 'cancelled'): they leave every working list but keep ALL records; super admins can restore them (status 'active') from the Cancelled filter. Every request stores exact timestamps: requested_at (who raised it, when) and reviewed_at (who approved/rejected it, when) — reviewed_at of an APPROVED request IS the employee's cancellation date.
- Cancelled employees: archived workforce (Employees page → status filter "Cancelled"). Their attendance, salary history, advances, uniforms, warnings and fines remain readable everywhere for future reference.
- Branches: regional groups owning sites; admins are granted branches (or direct site access).
- Sites: work sites (client, project, supervisor, team leader, live status); printable A4 Daily Attendance paper per site.
- Camps: accommodation with block/room assignments.
- Attendance: per-site monthly marking. Markers: 'A' = absent, a number (e.g. 8 / 8.5) = worked hours, blank = no record. Free text can also count as present.
- Working Hours: total & monthly history per employee; lifetime hours drive the experience tier.
- Salary Details (per month, per branch):
  • Salary Sheet — one settlement row per employee (gross, absent deduction, advance, deduction, net, paid/unpaid, finalize/reopen).
  • Payroll — consolidated view; time-card hours (carryover between periods) become Advance Book records; advance cuts link back to the ledger.
  • Advance Book — advance ledger: given date, amount, cut month/year, cleared/due status, source (manual / time-card carryover).
  • Trade/Ded Management — trades with hourly rates per role (standard/team leader/supervisor) and experience tier; the absent-deduction rule (first N absences free, AED X per absence after).
- Uniform Registry: uniform tokens & renewals per employee.
- Leave Requests: casual/annual/sick/other with approval flow.
- Notifications: request/warning/fine alerts.
- Admin Management: accounts, roles (super_admin/admin), per-menu permissions, branch/site access.
- Site Settings (super admin only): project/company name, company logo, org theme & accent, and the AI connection powering Pebby (presets or any custom OpenAI-compatible provider).

PAYROLL RULES
- Pay per attendance line = hours × the trade rate for (role, experience tier) effective that day.
- Experience tier follows lifetime worked hours (history-based, per trade).
- Absent deduction = max(absent days − free days, 0) × deduction amount (Deduction Management).
- Advances cut from a chosen month's salary appear in that month's Salary Sheet.
- Time-card hours paid outside the normal flow carry over to the next period as an Advance Book record.
- FINALIZED periods are locked; drafts recalculate live.`;

// ---------------------------------------------------------------------------
// Knowledge base fetch — every readable entity (same keys as before so the
// Site Settings scope grid keeps working)
// ---------------------------------------------------------------------------
// NOTE: request dates. Every request table carries exact timestamps:
//   cancellation_requests.requested_at (raised) / reviewed_at (decision —
//   for an APPROVED request reviewed_at IS the employee's cancellation date)
//   leave_requests.requested_at / reviewed_at
// They are serialized into the snapshot below and are also queryable via
// the [[QUERY]] engine (src/lib/ai/query-engine.ts).

export async function buildAiKnowledgeBase(): Promise<AiKnowledgeBase> {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const [
    profiles, branches, sites, camps, employees, cancelledEmployees, trades, leaveRequests,
    cancellationRequests, uniforms, companies, cardTypes, warnings, fines,
    notifications, attendance, salarySheet, advanceBook, deductionSettings,
  ] = await Promise.allSettled([
    dataApi.listProfiles(),
    dataApi.listBranches(),
    dataApi.listSites(),
    dataApi.listCamps(),
    dataApi.listEmployees(),
    dataApi.listCancelledEmployees(),
    dataApi.listTrades(),
    dataApi.listLeaveRequests(),
    dataApi.listCancellationRequests(),
    dataApi.listUniformEntries(),
    dataApi.listCompanies(),
    dataApi.listCardTypes(),
    dataApi.listWarnings(),
    dataApi.listFines(),
    dataApi.listNotifications(),
    dataApi.getMonthAttendance(month),
    dataApi.getSalarySheet(now.getFullYear(), now.getMonth() + 1),
    dataApi.getAdvanceBook(),
    dataApi.getDeductionSettings(),
  ]);

  const val = <T,>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === 'fulfilled' ? r.value : fallback;

  const data: Record<string, unknown> = {
    admins: val(profiles, []),
    branches: val(branches, []),
    sites: val(sites, []),
    camps: val(camps, []),
    employees: val(employees, []),
    cancelled_employees: val(cancelledEmployees, []),
    trades: val(trades, []),
    leave_requests: val(leaveRequests, []),
    cancellation_requests: val(cancellationRequests, []),
    uniforms: val(uniforms, []),
    companies: val(companies, []),
    card_types: val(cardTypes, []),
    warnings: val(warnings, []),
    fines: val(fines, []),
    notifications: val(notifications, []),
    attendance_current_month: { month, records: val(attendance, []) },
    salary_sheet_current_month: {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      report: val(salarySheet, null),
    },
    advance_book: val(advanceBook, null),
    deduction_settings: val(deductionSettings, null),
  };

  const counts: Record<string, number> = Object.fromEntries(
    Object.entries(data).map(([k, v]) => {
      if (k === 'salary_sheet_current_month') {
        const rep = (v as { employees?: unknown[] } | null)?.employees;
        return [k, Array.isArray(rep) ? rep.length : 0];
      }
      if (k === 'advance_book') {
        const rep = (v as { records?: unknown[] } | null)?.records;
        return [k, Array.isArray(rep) ? rep.length : 0];
      }
      if (k === 'attendance_current_month') {
        const rep = (v as { records?: unknown[] }).records;
        return [k, Array.isArray(rep) ? rep.length : 0];
      }
      if (k === 'deduction_settings') return [k, v ? 1 : 0];
      return [k, Array.isArray(v) ? v.length : 0];
    }),
  );

  return {
    generated_at: now.toISOString(),
    counts,
    data,
  };
}

// ---------------------------------------------------------------------------
// Compact text serializers — the snapshot is plain text (5-8× smaller than
// the raw JSON) and the employee directory is NEVER dropped
// ---------------------------------------------------------------------------

const dayOf = (date: string): string => date.slice(8, 10); // YYYY-MM-DD → DD

function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

/** ISO datetime → "YYYY-MM-DD HH:MM" (the precision "when" questions need). */
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/** One employee → one compact directory line (the fields people ask about). */
function employeeLine(e: EmployeeVM, extra = ''): string {
  const bits = [
    e.employee_code,
    e.full_name,
    e.nationality ?? 'nationality unknown',
    e.position ?? 'no position',
  ];
  if (e.trade_name) bits.push(`trade: ${e.trade_name}${e.salary_role && e.salary_role !== 'standard' ? ` (${e.salary_role.replace('_', ' ')})` : ''}`);
  bits.push(e.site_name ? `site: ${e.site_name}` : 'site: none (idle)');
  if (e.camp_name) bits.push(`camp: ${e.camp_name}${e.camp_block ? ` ${e.camp_block}-${e.camp_room ?? '?'}` : ''}`);
  if (e.is_team_leader) bits.push(`team leader${e.leader_site_name ? ` of ${e.leader_site_name}` : ''}`);
  if (e.company_name) bits.push(`company: ${e.company_name}`);
  bits.push(`status: ${e.status.replace('_', ' ')}`);
  if (e.join_date) bits.push(`joined ${e.join_date}`);
  if (e.phone) bits.push(`tel ${e.phone}`);
  if (e.payment_type) bits.push(`pay: ${e.payment_type}${e.card_type_name ? ` (${e.card_type_name})` : ''}`);
  if (e.opening_hours) bits.push(`opening hrs ${e.opening_hours}`);
  if (e.rating) bits.push(`rating ${e.rating.toFixed(1)}`);
  return `- ${bits.join(' · ')}${extra}`;
}

/** Full-detail block for on-demand [[LOOKUP]] employees=… (deep fields). */
export function formatEmployeeDeepDive(employees: EmployeeVM[]): string {
  if (employees.length === 0) return 'No employee matched those codes.';
  return employees.map((e) => {
    const deep = [
      `passport: ${e.passport_number ?? '—'} (${e.passport_status ?? 'unknown'})`,
      `ID: ${e.id_number ?? '—'} (${e.id_status ?? 'unknown'})`,
      `date of birth: ${fmtDateShort(e.date_of_birth)}`,
      `email: ${e.email ?? '—'}`,
      `home address: ${e.address ?? '—'}`,
      `emergency contact: ${e.emergency_contact ?? '—'}`,
    ].join('\n  ');
    return `${employeeLine(e)}\n  ${deep}`;
  }).join('\n');
}

/** Attendance month → per-employee compact day map + totals. */
export function formatAttendanceMonth(
  month: string,
  records: Attendance[],
  employees: EmployeeVM[],
): string {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const perEmp = new Map<string, Attendance[]>();
  for (const r of records) {
    if (r.is_hidden) continue;
    const list = perEmp.get(r.employee_id) ?? [];
    list.push(r);
    perEmp.set(r.employee_id, list);
  }
  const lines: string[] = [];
  for (const [empId, recs] of perEmp) {
    const e = byId.get(empId);
    const label = e ? `${e.employee_code} ${e.full_name}` : empId.slice(0, 8);
    const days = recs
      .filter((r) => r.status !== 'not_marked' || r.note)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => {
        const marker = r.status === 'absent' ? 'A' : (r.hours ?? r.note ?? 'P');
        return `${dayOf(r.date)}=${marker}`;
      });
    const present = recs.filter((r) => r.status === 'present').length;
    const absent = recs.filter((r) => r.status === 'absent').length;
    const hours = recs.reduce((n, r) => n + (r.hours ?? 0), 0);
    lines.push(`- ${label}: ${days.join(', ') || 'no marks'} · present ${present} · absent ${absent} · hours ${Math.round(hours * 10) / 10}`);
  }
  return `ATTENDANCE ${month} (${records.length} records)\n${lines.join('\n') || '(no records)'}`;
}

/** Salary sheet period → totals + one compact settlement line per employee. */
export function formatSalarySheetPeriod(
  year: number,
  month: number,
  report: SalarySheetReport | null,
): string {
  if (!report || !report.exists) return `No salary sheet exists for ${year}-${String(month).padStart(2, '0')}.`;
  const head = [
    `SALARY SHEET ${year}-${String(month).padStart(2, '0')} · period: ${report.period?.status ?? 'unknown'}`,
    `totals: ${report.totals.employees} employees · ${report.totals.total_hours} h · gross AED ${report.totals.gross_salary} · advances AED ${report.totals.advances} · deductions AED ${report.totals.deductions} · net AED ${report.totals.net_payable} · paid ${report.totals.paid_count} / unpaid ${report.totals.unpaid_count}`,
  ];
  const rows = report.employees.map((p) => {
    const parts = [
      p.employee_code,
      p.full_name,
      `${p.total_hours} h (lifetime ${p.closing_lifetime_hours})`,
      `gross AED ${p.gross_salary}`,
    ];
    if (p.absent_deduction) parts.push(`absent-ded AED ${p.absent_deduction}`);
    if (p.advance) parts.push(`advance AED ${p.advance}`);
    if (p.deduction) parts.push(`ded AED ${p.deduction}`);
    parts.push(`net AED ${p.net_salary}`, p.payment_status);
    return `- ${parts.join(' · ')}`;
  });
  return [...head, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// The compact snapshot — section builders with graceful size control
// ---------------------------------------------------------------------------

interface SnapshotInput {
  admins: { name: string; role: string; email: string }[];
  branches: { name: string; location: string | null; is_active: boolean; site_count: number; employee_count: number }[];
  sites: { name: string; client_name: string | null; project_name: string | null; supervisor: string | null; is_active: boolean; employee_count: number }[];
  camps: { name: string; location: string | null; capacity: number | null; is_active: boolean; employee_count: number }[];
  employees: EmployeeVM[];
  cancelledEmployees: EmployeeVM[];
  trades: { name: string; is_active: boolean; description: string | null }[];
  companies: { name: string }[];
  cardTypes: { name: string }[];
  leaveRequests: LeaveRequestVM[];
  cancellationRequests: CancellationRequestVM[];
  uniforms: UniformEntry[];
  warnings: WarningVM[];
  fines: FineVM[];
  notifications: Notification[];
  attendance: { month: string; records: Attendance[] };
  salarySheet: { year: number; month: number; report: SalarySheetReport | null };
  advanceBook: { records: { full_name: string; employee_code: string; amount: number; given_date: string; cut_year: number; cut_month: number; note: string | null; cleared: boolean; overdue: boolean; from_time_card?: boolean }[]; totals: { due_count: number; due_amount: number; overdue_count: number; overdue_amount: number; cleared_count: number; cleared_amount: number } } | null;
  deductionSettings: { absent_free_days: number; absent_deduction_amount: number; updated_by_name: string | null } | null;
}

/** Soft ceiling for the snapshot text. The /api/ai proxy accepts messages up
 *  to 150k chars; the guide + framing need headroom, so trim at ~110k. */
const MAX_SNAPSHOT_CHARS = 110_000;

function buildSnapshotText(d: SnapshotInput): string {
  const sections: string[] = [];

  sections.push([
    `ADMINS (${d.admins.length})`,
    ...d.admins.map((a) => `- ${a.name} · ${a.role} · ${a.email}`),
  ].join('\n'));

  sections.push([
    `BRANCHES (${d.branches.length})`,
    ...d.branches.map((b) => `- ${b.name}${b.location ? ` · ${b.location}` : ''} · ${b.is_active ? 'active' : 'inactive'} · ${b.site_count} site(s) · ${b.employee_count} employee(s)`),
  ].join('\n'));

  sections.push([
    `SITES (${d.sites.length})`,
    ...d.sites.map((s) => `- ${s.name}${s.client_name ? ` · client: ${s.client_name}` : ''}${s.project_name ? ` · project: ${s.project_name}` : ''}${s.supervisor ? ` · supervisor: ${s.supervisor}` : ''} · ${s.is_active ? 'active' : 'inactive'} · crew ${s.employee_count}`),
  ].join('\n'));

  sections.push([
    `CAMPS (${d.camps.length})`,
    ...d.camps.map((c) => `- ${c.name}${c.location ? ` · ${c.location}` : ''}${c.capacity ? ` · capacity ${c.capacity}` : ''} · ${c.is_active ? 'active' : 'inactive'} · ${c.employee_count} resident(s)`),
  ].join('\n'));

  // ---- EMPLOYEE DIRECTORY — the core lookup table, never dropped ----------
  const dir = [
    `EMPLOYEE DIRECTORY (${d.employees.length} on the roster)`,
    ...d.employees.map((e) => employeeLine(e)),
  ].join('\n');
  sections.push(dir);

  if (d.cancelledEmployees.length > 0) {
    // join with APPROVED cancellation requests so the directory line itself
    // answers "when was X cancelled" without any extra round-trip
    const cancelledOn = new Map<string, string>();
    for (const c of d.cancellationRequests) {
      if (c.status === 'approved' && c.reviewed_at) cancelledOn.set(c.employee_code, fmtDateTime(c.reviewed_at));
    }
    sections.push([
      `CANCELLED EMPLOYEES (${d.cancelledEmployees.length} — records kept for reference)`,
      ...d.cancelledEmployees.map((e) => employeeLine(e, cancelledOn.has(e.employee_code) ? ` · cancelled ${cancelledOn.get(e.employee_code)}` : '')),
    ].join('\n'));
  }

  sections.push([
    `TRADES (${d.trades.length})`,
    ...d.trades.map((t) => `- ${t.name} · ${t.is_active ? 'active' : 'inactive'}${t.description ? ` · ${t.description}` : ''}`),
  ].join('\n'));

  if (d.companies.length) {
    sections.push(`COMPANIES: ${d.companies.map((c) => c.name).join(', ')}`);
  }
  if (d.cardTypes.length) {
    sections.push(`CARD TYPES: ${d.cardTypes.map((c) => c.name).join(', ')}`);
  }

  sections.push([
    `LEAVE REQUESTS (${d.leaveRequests.length})`,
    ...d.leaveRequests.map((l) => `- ${l.employee_name} (${l.employee_code}) · ${l.other_type_text || l.leave_type} · ${l.start_date}→${l.end_date} (${l.total_days}d) · ${l.status} · requested ${fmtDateTime(l.created_at)}${l.reviewed_at ? ` · reviewed ${fmtDateTime(l.reviewed_at)}${l.reviewed_by_name ? ` by ${l.reviewed_by_name}` : ''}` : ''}${l.reason ? ` · "${l.reason}"` : ''}`),
  ].join('\n'));

  // dates included by design: "when was X cancelled" = reviewed_at of the
  // APPROVED request (requested_at = when it was raised)
  sections.push([
    `CANCELLATION REQUESTS (${d.cancellationRequests.length})`,
    ...d.cancellationRequests.map((c) => `- ${c.employee_name} (${c.employee_code}) · ${c.status} · requested ${fmtDateTime(c.created_at)}${c.requested_by_name ? ` by ${c.requested_by_name}` : ''}${c.reviewed_at ? ` · reviewed ${fmtDateTime(c.reviewed_at)}${c.reviewed_by_name ? ` by ${c.reviewed_by_name}` : ''}` : ''}${c.reason ? ` · "${c.reason}"` : ''}`),
  ].join('\n'));

  sections.push([
    `UNIFORM ENTRIES (${d.uniforms.length})`,
    ...d.uniforms.map((u) => {
      const items = Object.values(u.items ?? {});
      return `- token ${u.token_number} · ${u.employee_name}${u.site_name ? ` · site: ${u.site_name}` : ''}${u.team_leader_name ? ` · leader: ${u.team_leader_name}` : ''} · ${u.is_renewal ? `renewal (prev ${u.previous_token_id ?? '—'})` : 'new'} · items ${items.filter(Boolean).length}/${items.length} · ${u.renewal_date}`;
    }),
  ].join('\n'));

  sections.push([
    `WARNINGS (${d.warnings.length})`,
    ...d.warnings.map((w) => `- ${w.employee_name} (${w.employee_code}) · ${w.is_auto_generated ? 'auto' : 'manual'} · "${w.reason}" · by ${w.issued_by_name || '—'} · ${fmtDateTime(w.created_at)}`),
  ].join('\n'));

  sections.push([
    `FINES (${d.fines.length})`,
    ...d.fines.map((f) => `- ${f.employee_name} (${f.employee_code}) · AED ${f.amount} · "${f.reason}" · by ${f.issued_by_name || '—'} · ${fmtDateTime(f.created_at)}`),
  ].join('\n'));

  sections.push([
    `NOTIFICATIONS (${d.notifications.length} — latest 30)`,
    ...d.notifications.slice(-30).reverse().map((n) => `- [${n.type}] ${n.title} — ${n.message} · ${n.read ? 'read' : 'unread'} · ${fmtDateTime(n.created_at)}`),
  ].join('\n'));

  sections.push(formatAttendanceMonth(d.attendance.month, d.attendance.records, [...d.employees, ...d.cancelledEmployees]));

  sections.push(formatSalarySheetPeriod(d.salarySheet.year, d.salarySheet.month, d.salarySheet.report));

  if (d.advanceBook) {
    const t = d.advanceBook.totals;
    sections.push([
      `ADVANCE BOOK — totals: due ${t.due_count} (AED ${t.due_amount}) · overdue ${t.overdue_count} (AED ${t.overdue_amount}) · cleared ${t.cleared_count} (AED ${t.cleared_amount})`,
      ...d.advanceBook.records.map((r) => `- ${r.employee_code} ${r.full_name} · AED ${r.amount} · given ${r.given_date} · cut ${r.cut_year}-${String(r.cut_month).padStart(2, '0')}${r.from_time_card ? ' · from time-card' : ''} · ${r.cleared ? 'cleared' : r.overdue ? 'OVERDUE' : 'due'}${r.note ? ` · "${r.note}"` : ''}`),
    ].join('\n'));
  }

  if (d.deductionSettings) {
    sections.push(`DEDUCTION RULE — first ${d.deductionSettings.absent_free_days} absence(s) per month free, then AED ${d.deductionSettings.absent_deduction_amount} per absence${d.deductionSettings.updated_by_name ? ` · last updated by ${d.deductionSettings.updated_by_name}` : ''}`);
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// System prompt — Pebby identity + snapshot + answer protocol
// ---------------------------------------------------------------------------

/** The complete system prompt: identity + guide + compact snapshot + the
 *  [[LOOKUP]] / [[WEB]] answer protocol. */
export function buildAiSystemPrompt(kb: AiKnowledgeBase, settings: SiteSettings): string {
  // map the snake_case knowledge-base keys onto the snapshot builder's shape
  const raw = kb.data as Record<string, unknown>;
  const list = <T,>(key: string): T[] => (Array.isArray(raw[key]) ? raw[key] as T[] : []);
  const d: SnapshotInput = {
    admins: list('admins'),
    branches: list('branches'),
    sites: list('sites'),
    camps: list('camps'),
    employees: list('employees'),
    cancelledEmployees: list('cancelled_employees'),
    trades: list('trades'),
    companies: list('companies'),
    cardTypes: list('card_types'),
    leaveRequests: list('leave_requests'),
    cancellationRequests: list('cancellation_requests'),
    uniforms: list('uniforms'),
    warnings: list('warnings'),
    fines: list('fines'),
    notifications: list('notifications'),
    attendance: (raw.attendance_current_month as SnapshotInput['attendance']) ?? { month: '', records: [] },
    salarySheet: (raw.salary_sheet_current_month as SnapshotInput['salarySheet']) ?? { year: 0, month: 0, report: null },
    advanceBook: (raw.advance_book as SnapshotInput['advanceBook']) ?? null,
    deductionSettings: (raw.deduction_settings as SnapshotInput['deductionSettings']) ?? null,
  };
  const snapshot = buildSnapshotText(d);

  return [
    `You are Pebby — the Smart Assistant built into "${settings.project_name}" (${settings.company_name}), a workforce & payroll operations app. When you refer to yourself, use the name Pebby.`,
    'You know the ENTIRE application — every module, rule and record — and the database snapshot below is refreshed before EVERY question, so treat it as current. You are a senior workforce-operations analyst: reason across tables, compute precisely, and always cite names with employee codes.',
    '',
    '=== APPLICATION GUIDE ===',
    AI_APP_GUIDE,
    '',
    `=== LIVE DATABASE SNAPSHOT (text, currency AED, generated ${kb.generated_at}) ===`,
    snapshot,
    '',
    '=== DATABASE QUERY ENGINE — complex querying on EVERY table ===',
    queryableTablesDoc(),
    '',
    '=== ANSWER PROTOCOL ===',
    '1. App/workforce/payroll questions: SEARCH the snapshot carefully first — match names, employee codes (e.g. PUL-2026-NNN), sites, dates — then answer precisely; compute sums, counts and averages when asked. The snapshot carries every request\'s timestamps (requested_at / reviewed_at): e.g. "when was X cancelled" = the reviewed_at of X\'s APPROVED cancellation request, and the CANCELLED EMPLOYEES directory line already carries it.',
    '2. [[QUERY]] — when the snapshot omits the detail you need (exact timestamps of a specific row, other months, filtered / sorted / aggregated / cross-table views), reply with EXACTLY one directive line (see the query engine section for syntax and examples). The system executes it and asks you again — then answer. You may chain up to 3 query rounds (e.g. resolve a name to a code, then pull that employee\'s records from another table, then aggregate).',
    '3. [[LOOKUP]] — pre-formatted deep records, same one-line style, when you need: full employee documents (passport & ID numbers/status, date of birth, email, home address, emergency contact), a whole attendance month, or a whole salary-sheet month:',
    '   [[LOOKUP]] employees=PUL-2026-015,PUL-2026-003',
    '   [[LOOKUP]] attendance=2026-10',
    '   [[LOOKUP]] salary=2026-09',
    '4. Anything UNRELATED to this app (news, weather, sports, general knowledge, current affairs): reply with EXACTLY one directive line and nothing else:',
    '   [[WEB: short search query]]',
    '   The system researches the web and asks you again — then answer the user using the results.',
    '5. Never invent data. If the snapshot (plus queries/lookups) cannot answer, say so plainly and point to the right module of the app.',
    '6. Keep answers concise and well formatted: short paragraphs, compact lists, amounts in AED, dates as YYYY-MM-DD. Mention employee codes with names so answers are verifiable. When a question involves a date, state the exact date (and time when useful) from the record.',
  ].join('\n');
}
