// ============================================================================
// PULSE Workforce OS — AI knowledge base (foundation for the in-app AI bot)
// ----------------------------------------------------------------------------
// The upcoming AI assistant (connection configured on the Site Settings page)
// has to know the app A → Z: it can READ and QUERY the whole workforce
// database. This module builds that complete knowledge package on the CLIENT
// (works in demo mode AND Supabase mode — both data layers expose the same
// dataApi):
//
//   • buildAiKnowledgeBase()  — fetches every entity of the system
//   • AI_APP_GUIDE            — what the app can do, its concepts and rules
//   • buildAiSystemPrompt()   — the full system prompt for the bot: identity,
//                               the app guide + the live data snapshot as JSON
//
// The bot chat UI (when it ships) will call /api/ai with this prompt and the
// user's question; the provider (base URL + model + key from Site Settings)
// does the rest.
// ============================================================================

import { dataApi } from '@/lib/data';
import type { SiteSettings } from '@/lib/types';

/** Everything the AI is allowed to read — one JSON-serializable snapshot. */
export interface AiKnowledgeBase {
  generated_at: string;
  /** entity → row count, shown on the Site Settings page as the AI scope */
  counts: Record<string, number>;
  data: Record<string, unknown>;
}

/** Plain-language description of the whole system — the AI's "product manual". */
export const AI_APP_GUIDE = `PULSE Workforce OS — workforce & payroll management for a UAE contracting company (currency: AED).

MODULES
- Dashboard: branch-scoped overview (employees, present/absent, monthly attendance, site breakdown).
- Employees: full directory (name, code, nationality, position, trade, company, passport/ID status, camp, site, rating, team-leader flags). Deletion goes through Cancellation Requests.
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
- Site Settings (super admin only): project/company name, org theme & accent, and THIS AI assistant connection.

PAYROLL RULES
- Pay per attendance line = hours × the trade rate for (role, experience tier) effective that day.
- Experience tier follows lifetime worked hours (history-based, per trade).
- Absent deduction = max(absent days − free days, 0) × deduction amount (Deduction Management).
- Advances cut from a chosen month's salary appear in that month's Salary Sheet.
- Time-card hours paid outside the normal flow carry over to the next period as an Advance Book record.
- FINALIZED periods are locked; drafts recalculate live.`;

/** Fetch EVERY readable entity of the system for the AI. Failures degrade to
 *  an empty section (the bot still answers with the rest). */
export async function buildAiKnowledgeBase(): Promise<AiKnowledgeBase> {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const [
    profiles, branches, sites, camps, employees, trades, leaveRequests,
    cancellationRequests, uniforms, companies, cardTypes, warnings, fines,
    notifications, attendance, salarySheet, advanceBook, deductionSettings,
  ] = await Promise.allSettled([
    dataApi.listProfiles(),
    dataApi.listBranches(),
    dataApi.listSites(),
    dataApi.listCamps(),
    dataApi.listEmployees(),
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

/** The complete system prompt for the AI bot: identity + the app guide + the
 *  live database snapshot. The chat UI sends this as the first message. */
export function buildAiSystemPrompt(kb: AiKnowledgeBase, settings: SiteSettings): string {
  return [
    `You are the built-in AI assistant of "${settings.project_name}" (${settings.company_name}), a workforce & payroll operations app.`,
    'You know the ENTIRE application — every module, rule and record. Answer questions about the data precisely, compute sums/counts/averages when asked, and explain payroll rules when relevant.',
    '',
    '=== APPLICATION GUIDE ===',
    AI_APP_GUIDE,
    '',
    '=== LIVE DATABASE SNAPSHOT (JSON) ===',
    `Generated at ${kb.generated_at}. Currency is AED. "attendance_current_month" and "salary_sheet_current_month" cover the current calendar month only.`,
    JSON.stringify(kb.data),
    '',
    'RULES: base every answer ONLY on the snapshot and the guide; if something is not in the data, say so instead of inventing it; keep answers concise and formatted with short lists when helpful.',
  ].join('\n');
}
