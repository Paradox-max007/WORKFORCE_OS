// ============================================================================
// PULSE Workforce OS — Shared domain types
// ============================================================================

// Menu configuration lives in lib/menus.ts (single source of truth) — the
// key type is re-exported here for convenience.
import type { MenuKey } from './menus';
export type { MenuKey };

export type Role = 'super_admin' | 'admin' | 'pending';
export type ThemeMode = 'dark' | 'light';
export type AccentColor = 'violet' | 'emerald' | 'amber' | 'rose';

export interface Profile {
  id: string;
  email: string;
  name: string;
  role: Role;
  theme: ThemeMode;
  accent: AccentColor;
  created_at: string;
}

export interface Site {
  id: string;
  name: string;
  client_name: string | null;
  project_name: string | null;
  /** attendance marker who marks this site's sheet (free-text person name) */
  supervisor: string | null;
  /** owner branch — a branch owns multiple sites; null = not assigned yet */
  branch_id: string | null;
  is_active: boolean;
  created_at: string;
}

export interface SiteWithCount extends Site {
  employee_count: number;
}

/** A regional branch that owns multiple work sites. Normal admins only see
 *  the branches assigned to them (admin_branch); super admins see all. */
export interface Branch {
  id: string;
  name: string;
  location: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
}

export interface BranchWithCount extends Branch {
  /** sites owned by this branch */
  site_count: number;
  /** employees currently working at those sites */
  employee_count: number;
}

/** An admin account assigned to mark a site's attendance (Admins page).
 *  Powers "View by Supervisors" alongside the free-text Site.supervisor. */
export interface AdminSiteAssignment {
  profileId: string;
  profileName: string;
  siteId: string;
}

// Accommodation camp where employees stay (one employee → at most one camp)
export interface Camp {
  id: string;
  name: string;
  location: string | null;
  capacity: number | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
}

export interface CampWithCount extends Camp {
  employee_count: number;
}

export type EmployeeStatus = 'active' | 'pending_deletion' | 'deleted';
export type DocumentStatus = 'Valid' | 'Expired' | 'N/A';

/** A manpower / contracting company employees work under (its own table). */
export interface Company {
  id: string;
  name: string;
  created_at: string;
}

/** How an employee receives their salary: cash or a payroll card. */
export type PaymentType = 'cash' | 'card';

/** A payroll card type (Lulu Card, C3 Card, …) — its own table, grows via
 *  the "+ Add New Card Type…" option in the employee Document Details card. */
export interface CardType {
  id: string;
  name: string;
  created_at: string;
}

/** A quick sticky-note style comment about an employee (Payroll page icon).
 *  Employee-level — not tied to a payroll period. */
export interface EmployeeNote {
  id: string;
  employee_id: string;
  note: string;
  author_name: string | null;
  created_at: string;
}

export interface Employee {
  id: string;
  full_name: string;
  employee_code: string; // PUL-YYYY-NNN
  nationality: string | null;
  date_of_birth: string | null; // YYYY-MM-DD
  phone: string | null;
  email: string | null;
  address: string | null;
  emergency_contact: string | null;
  position: string | null;
  join_date: string | null; // YYYY-MM-DD
  company_name: string | null;
  passport_number: string | null;
  passport_status: DocumentStatus | null;
  id_number: string | null;
  id_status: DocumentStatus | null;
  current_site_id: string | null;
  camp_id: string | null;
  /** Block number within the assigned camp */
  camp_block: string | null;
  /** Room number within the assigned camp */
  camp_room: string | null;
  rating: number;
  status: EmployeeStatus;
  photo: string | null;
  /** How this employee is paid: cash / card (set from the details page) */
  payment_type: PaymentType | null;
  /** Which payroll card (card_type table) — meaningful when payment_type = 'card' */
  card_type_id: string | null;
  is_team_leader: boolean;
  team_leader_site_id: string | null;
  /** Historical working hours accumulated BEFORE PULSE started tracking
   *  attendance (opening balance). Lifetime hours = this + Σ attendance.hours.
   *  Kept separate from attendance — never imported as fake daily records. */
  opening_hours: number;
  /** Trade driving the salary rate (Trade Management list) */
  trade_id: string | null;
  /** Salary classification: standard / team_leader / supervisor */
  salary_role: SalaryRole;
  created_at: string;
  updated_at: string;
}

export interface EmployeeVM extends Employee {
  site_name: string | null;
  /** owner branch of the employee's current site (null = idle / no branch) */
  branch_name: string | null;
  leader_site_name: string | null;
  camp_name: string | null;
  trade_name: string | null;
  card_type_name: string | null;
}

export type AttendanceStatus = 'present' | 'absent' | 'not_marked';

/**
 * One recorded site move. Written automatically whenever an employee's work
 * site changes (employee form, site transfer, remove-from-site). The
 * attendance sheet uses this log to keep moved employees under the site they
 * started the month at — bottom of the crew, faded — with the destination site
 * shown across the merged moved-days cells.
 */
export interface SiteTransfer {
  id: string;
  employee_id: string;
  from_site_id: string | null; // null = was unassigned / idle
  to_site_id: string | null;   // null = moved to unassigned / idle
  effective_date: string;      // YYYY-MM-DD — the day the move takes effect
  created_at: string;          // exact timestamp of the move (e.g. 25th 8 PM)
}

export interface Attendance {
  id: string;
  employee_id: string;
  date: string; // YYYY-MM-DD
  status: AttendanceStatus;
  /** Worked hours for the day (custom hours per site); null when absent/unmarked */
  hours: number | null;
  /** Free-text marker typed into the sheet (e.g. "OT", "H", "travel").
   *  ANY text other than "A" is stored here, shown in the cell and is NEVER
   *  counted as absent — it is a present day with no tracked hours.
   *  Optional: records persisted before this field existed don't have it. */
  note?: string | null;
  is_hidden: boolean;
  created_at: string;
}

export interface Notification {
  id: string;
  profile_id: string;
  title: string;
  message: string;
  type: 'request' | 'warning' | 'fine';
  read: boolean;
  is_hidden: boolean;
  created_at: string;
}

export interface Warning {
  id: string;
  employee_id: string;
  reason: string;
  is_auto_generated: boolean;
  absent_dates: string[] | null;
  created_by: string | null;
  is_hidden: boolean;
  created_at: string;
}

export interface WarningVM extends Warning {
  employee_name: string;
  employee_code: string;
  issued_by_name: string;
}

export interface Fine {
  id: string;
  employee_id: string;
  reason: string;
  amount: number;
  created_by: string | null;
  is_hidden: boolean;
  created_at: string;
}

export interface FineVM extends Fine {
  employee_name: string;
  employee_code: string;
  issued_by_name: string;
}

export type LeaveType = 'casual' | 'sick' | 'annual' | 'emergency' | 'marriage' | 'other';

export interface LeaveRequest {
  id: string;
  employee_id: string;
  leave_type: LeaveType;
  other_type_text: string | null;
  start_date: string;
  end_date: string;
  total_days: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  is_hidden: boolean;
  created_at: string;
}

export interface LeaveRequestVM extends LeaveRequest {
  employee_name: string;
  employee_code: string;
  employee_position: string | null;
  employee_phone: string | null;
  employee_nationality: string | null;
  employee_company: string | null;
  created_by_name: string | null;
  reviewed_by_name: string | null;
}

export interface CancellationRequest {
  id: string;
  employee_id: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requested_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  is_hidden: boolean;
  created_at: string;
}

export interface CancellationRequestVM extends CancellationRequest {
  employee_name: string;
  employee_code: string;
  employee_position: string | null;
  employee_status: EmployeeStatus;
  requested_by_name: string | null;
  reviewed_by_name: string | null;
}

export interface UniformEntry {
  id: string;
  uniform_id: number;
  token_number: number;
  employee_id: string;
  employee_name: string;
  document_type: 'id' | 'passport';
  document_number: string;
  items: Record<string, boolean>;
  site_name: string | null;
  team_leader_name: string | null;
  is_renewal: boolean;
  previous_token_id: number | null;
  is_deleted: boolean;
  is_hidden: boolean;
  created_at: string;
  renewal_date: string;
}

import type { PermissionKey } from './menus';

/** Per-admin permission map: every sidebar menu key plus the permission-only
 *  extras (EXTRA_PERMISSIONS in lib/menus.ts — e.g. employees_all_branches). */
export type MenuPermissionMap = {
  [K in PermissionKey]: boolean;
};

// ============================================================================
// Input payloads
// ============================================================================

export interface EmployeeInput {
  full_name: string;
  /** Manual employee ID — when blank the system auto-generates one (PUL-YYYY-NNN) */
  employee_code?: string | null;
  nationality: string | null;
  date_of_birth: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  emergency_contact: string | null;
  position: string | null;
  join_date: string | null;
  company_name: string | null;
  passport_number: string | null;
  passport_status: DocumentStatus | null;
  id_number: string | null;
  id_status: DocumentStatus | null;
  current_site_id: string | null;
  camp_id: string | null;
  camp_block: string | null;
  camp_room: string | null;
  photo: string | null;
  is_team_leader: boolean;
  team_leader_site_id: string | null;
  /** Opening balance — blank/null keeps the stored value on update, 0 on create */
  opening_hours?: number | null;
  /** Trade (from the Trade Management list) driving the salary rate */
  trade_id?: string | null;
  /** Salary classification: standard / team_leader / supervisor */
  salary_role?: SalaryRole | null;
}

// ============================================================================
// Working Hours report (Employee Working Hours module)
// ============================================================================

/** Hours one employee accumulated at one site within one month. */
export interface WorkingHoursSiteTotal {
  siteId: string | null; // null → recorded without a site (idle)
  siteName: string;
  totalHours: number;
}

/** One month of an employee's tracked working hours, split by site. */
export interface WorkingHoursMonth {
  year: number;
  month: number; // 1–12
  totalHours: number;
  /** Days with recorded working hours (absent / unmarked days excluded) */
  attendanceDays: number;
  sites: WorkingHoursSiteTotal[];
}

/** Lifetime working-hours report for one employee (database-side aggregation).
 *  Invariants: lifetimeHours = openingHours + Σ monthlyBreakdown.totalHours and
 *  every month's totalHours = Σ its sites' totalHours. */
export interface EmployeeWorkingHoursReport {
  employeeId: string;
  fullName: string;
  employeeCode: string;
  position: string | null;
  siteId: string | null;
  siteName: string | null;
  joinDate: string | null;
  status: EmployeeStatus;
  photo: string | null;
  /** historical balance from before PULSE tracking (never spread over months) */
  openingHours: number;
  /** Σ attendance.hours over all visible records (date-effective per site) */
  trackedHours: number;
  /** openingHours + trackedHours */
  lifetimeHours: number;
  /** newest month first; empty when the employee has no attendance history */
  monthlyBreakdown: WorkingHoursMonth[];
}

export interface LeaveRequestInput {
  employee_id: string;
  leave_type: LeaveType;
  other_type_text: string | null;
  start_date: string;
  end_date: string;
  total_days: number;
  reason: string;
}

export interface UniformEntryInput {
  employee_id: string;
  document_type: 'id' | 'passport';
  document_number: string;
  items: Record<string, boolean>;
  site_name: string | null;
  team_leader_name: string | null;
  created_at: string; // ISO or YYYY-MM-DD
  token_number: number | null;
  is_renewal: boolean;
  previous_token_id: number | null;
}

export interface UniformEntryUpdate {
  token_number: number;
  document_type: 'id' | 'passport';
  document_number: string;
  items: Record<string, boolean>;
  site_name: string | null;
  team_leader_name: string | null;
  created_at: string;
}

// ============================================================================
// Trade & Salary system
// ============================================================================

export type SalaryRole = 'standard' | 'team_leader' | 'supervisor';
/** 'manual' marks a salary line created by a Salary Sheet manual edit */
export type ExperienceTier = 'below_threshold' | 'qualified' | 'manual';

export const SALARY_ROLES: { value: SalaryRole; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'team_leader', label: 'Team Leader' },
  { value: 'supervisor', label: 'Supervisor' },
];

export const EXPERIENCE_TIERS: { value: ExperienceTier; label: string }[] = [
  { value: 'below_threshold', label: 'Below threshold' },
  { value: 'qualified', label: 'Qualified' },
];
/** Hours at which an employee qualifies for the experienced rate (lifetime) */
export const SALARY_THRESHOLD_HOURS = 1000;

/** Calendar months of employment after which the experienced rate applies */
export const SALARY_THRESHOLD_MONTHS = 6;

/** ABSENT DEDUCTION RULE — the first N absent days of a payroll month are
 *  free; every absent day from the (N+1)th onwards costs
 *  `absent_deduction_amount` (AED). N and the amount are CONFIGURABLE in
 *  Trade Management → Deductions (stored in the deduction_settings table,
 *  see the 20261111c SQL migration); these constants are only the DEFAULTS
 *  used when no settings row exists. The deduction is computed when the
 *  payroll is generated and stored on the settlement as `absent_deduction`
 *  (separate from the manually edited `deduction`). */
export const ABSENT_DEDUCTION_FREE_DAYS = 2;
export const ABSENT_DEDUCTION_RATE = 25;

/** Effective absent-deduction rule (Trade Management → Deductions tab).
 *  `absent_free_days` = how many absences per payroll month are free;
 *  `absent_deduction_amount` = AED charged per absence beyond those. */
export interface DeductionSettings {
  absent_free_days: number;
  absent_deduction_amount: number;
  updated_at: string | null;
  updated_by_name: string | null;
}

/** Payload for updating the absent-deduction rule. */
export interface DeductionSettingsInput {
  absent_free_days: number;
  absent_deduction_amount: number;
}

/** Fallback when no settings row exists yet (fresh DB / RPC failure). */
export const DEFAULT_DEDUCTION_SETTINGS: DeductionSettings = {
  absent_free_days: ABSENT_DEDUCTION_FREE_DAYS,
  absent_deduction_amount: ABSENT_DEDUCTION_RATE,
  updated_at: null,
  updated_by_name: null,
};

export interface Trade {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** One effective-dated rate cell (trade × salary role × experience tier) */
export interface TradeRate {
  id: string;
  trade_id: string;
  salary_role: SalaryRole;
  experience_tier: ExperienceTier;
  hourly_rate: number;
  effective_from: string; // YYYY-MM-DD
  effective_to: string | null;
  created_at: string;
}

export interface TradeRateInput {
  salary_role: SalaryRole;
  experience_tier: ExperienceTier;
  hourly_rate: number;
}

export interface TradeInput {
  name: string;
  description: string | null;
  /** false → inactive draft (hidden from new employee selection, not used for salary) */
  is_active?: boolean;
  /** initial effective-dated rates (today); may be partial when is_active=false */
  rates: TradeRateInput[];
}

/** Effective-dated employee trade/role assignment (historical payroll accuracy) */
export interface EmployeeSalaryAssignment {
  id: string;
  employee_id: string;
  employee_name: string;
  trade_id: string;
  trade_name: string;
  salary_role: SalaryRole;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
}

/** Eligibility snapshot for the experienced (qualified) rate.
 *  Q = min(join_date + 6 calendar months, date lifetime hours reach 1,000). */
export interface SalaryEligibility {
  employee_id: string;
  full_name: string;
  employee_code: string;
  join_date: string | null;
  opening_hours: number;
  tracked_hours: number;
  lifetime_hours: number;
  /** join_date + 6 calendar months (month-end clamped) */
  six_month_date: string | null;
  threshold_hours: number;
  /** date on which cumulative lifetime hours reach the threshold (null if never) */
  threshold_date: string | null;
  /** hours still needed to reach the threshold (0 when reached) */
  hours_to_threshold: number;
  /** 0–100 progress toward the threshold */
  progress_percent: number;
  qualified: boolean;
  qualification_date: string | null;
  qualification_reason: 'opening_balance' | 'six_months' | 'thousand_hours' | null;
  as_of: string;
  trade_id: string | null;
  trade_name: string | null;
  salary_role: SalaryRole;
  /** rate applicable right now for trade × role × current tier */
  current_rate: number | null;
}

export type PayrollPeriodStatus = 'draft' | 'finalized';
export type PaymentStatus = 'unpaid' | 'paid';

export interface PayrollPeriodVM {
  id: string;
  year: number;
  month: number;
  status: PayrollPeriodStatus;
  created_by: string | null;
  finalized_by: string | null;
  finalized_at: string | null;
  created_at: string;
}

/** One rate-segment salary line (explainable, auditable payroll) */
export interface PayrollSalaryLineVM {
  site_id: string | null;
  site_name: string;
  date: string;
  trade_id: string | null;
  trade_name: string;
  salary_role: SalaryRole;
  experience_tier: ExperienceTier;
  hours: number;
  hourly_rate: number;
  gross_amount: number;
}

/** Employee × site × month aggregate (Salary Sheet site group row) */
export interface PayrollEmployeeSiteVM {
  site_id: string | null;
  site_name: string;
  total_hours: number;
  below_threshold_hours: number;
  qualified_hours: number;
  standard_hours: number;
  team_leader_hours: number;
  supervisor_hours: number;
  gross_salary: number;
  has_missing_rate: boolean;
  /** true → hand-edited in the Salary Sheet; recalculation never touches it */
  manually_edited?: boolean;
  /** true → Idle Employees placeholder row (no real site row behind it) */
  synthetic?: boolean;
  lines: PayrollSalaryLineVM[];
}

/** Employee × month consolidated settlement (advance/deduction/net once) */
export interface PayrollEmployeeVM {
  id: string;
  payroll_period_id: string;
  employee_id: string;
  full_name: string;
  employee_code: string;
  nationality: string | null;
  photo: string | null;
  status: EmployeeStatus;
  /** accommodation camp (Payroll filters — same data as the Employees page) */
  camp_id: string | null;
  camp_name: string | null;
  trade_id: string | null;
  trade_name: string | null;
  /** how this employee is paid (live employee field — read at report time) */
  payment_type: PaymentType | null;
  /** card type NAME when payment_type = 'card' (Payroll column + filter) */
  card_type: string | null;
  salary_role: SalaryRole;
  total_hours: number;
  opening_lifetime_hours: number;
  closing_lifetime_hours: number;
  below_threshold_hours: number;
  qualified_hours: number;
  /** hours with a trade but no effective rate on that date */
  unrated_hours: number;
  /** hours without any trade assigned */
  unassigned_hours: number;
  gross_salary: number;
  advance: number;
  deduction: number;
  /** automatic absent deduction — absences beyond the configured free days
 *  of the month × the configured amount (Trade Management → Deductions);
 *  counted from attendance records with status 'absent'. When edited on the
 *  Payroll page this holds the ACTUAL (hand-entered) amount and
 *  absent_deduction_edited is true — the Payroll page value has priority
 *  over the rule and survives every recalculation */
  absent_deduction: number;
  /** true → absent_deduction was hand-edited on the Payroll page (the stored
 *   amount is the actual deduction; reset returns it to the rule) */
  absent_deduction_edited?: boolean;
  net_salary: number;
  payment_status: PaymentStatus;
  paid_at: string | null;
  paid_by: string | null;
  paid_by_name: string | null;
  notes: string | null;
  /** true → hand-edited in the Salary Sheet; recalculation never touches it */
  manually_edited?: boolean;
  /** qualification inputs for the Payroll hours tooltip (from sheet data) */
  join_date: string | null;
  /** join date + 6 calendar months (the alternative qualification route) */
  six_month_date: string | null;
  /** first date the lifetime cumulative (opening + tracked hours) reached 1,000 h */
  threshold_date: string | null;
  sites: PayrollEmployeeSiteVM[];
}

export interface SalarySheetTotals {
  employees: number;
  total_hours: number;
  gross_salary: number;
  advances: number;
  deductions: number;
  net_payable: number;
  paid_count: number;
  unpaid_count: number;
}

export interface SalarySheetSiteGroup {
  site_id: string | null;
  site_name: string;
  employees: number;
  total_hours: number;
  gross_salary: number;
  /** true → the trailing "Idle Employees" group (no current site / unassigned hours) */
  idle?: boolean;
  rows: (PayrollEmployeeSiteVM & {
    employee_id: string;
    full_name: string;
    employee_code: string;
    nationality: string | null;
    photo: string | null;
    trade_name: string | null;
    salary_role: SalaryRole;
  })[];
}

export interface SalarySheetReport {
  exists: boolean;
  period: PayrollPeriodVM | null;
  totals: SalarySheetTotals;
  sites: SalarySheetSiteGroup[];
  employees: PayrollEmployeeVM[];
  audit: {
    id: string;
    action: string;
    actor_name: string | null;
    details: string | null;
    created_at: string;
  }[];
}

export interface PayrollAdjustmentInput {
  advance: number;
  deduction: number;
  notes: string | null;
  /** PRESENT → store this as the ACTUAL absent deduction (flagged — the
   *  Payroll page value has priority and survives every recalculation).
 *  Omit it to leave the absent deduction untouched. */
  absent_deduction?: number;
  /** true → recompute the absent deduction from the configured rule and
   *  clear the edited flag (ignored when absent_deduction is present). */
  absent_auto?: boolean;
}

/** One manually overridden employee × site row of the Salary Sheet */
export interface SalarySheetSiteUpdate {
  /** null → the "No site" row */
  site_id: string | null;
  total_hours: number;
  hourly_rate: number | null;
  gross_salary: number;
}

/** Salary Sheet edit-mode save. THE SHEET RECORD HAS PRIORITY: manual site
 *  values overwrite the calculated data and are preserved on recalculation;
 *  a trade picked here overwrites the employee's stored trade. The absent
 *  deduction follows the SAME rule as the Payroll page: a value present in
 *  the payload is stored as the actual amount (flagged); absent_auto returns
 *  it to the configured rule. */
export interface SalarySheetRowUpdate {
  payroll_employee_id: string;
  /** present → overwrite the stored trade (null = no trade) */
  trade_id?: string | null;
  advance?: number;
  deduction?: number;
  notes?: string | null;
  /** present → store as the ACTUAL absent deduction (flagged, priority) */
  absent_deduction?: number;
  /** true → absent deduction back to the configured rule */
  absent_auto?: boolean;
  /** manual site-row overrides; any entry freezes the settlement */
  sites?: SalarySheetSiteUpdate[];
}

// ============================================================================
// Realtime
// ============================================================================

export type RealtimeTable =
  | 'profiles'
  | 'menu_permission'
  | 'admin_site'
  | 'branch'
  | 'admin_branch'
  | 'site'
  | 'camp'
  | 'employee'
  | 'attendance'
  | 'notification'
  | 'warning'
  | 'fine'
  | 'leave_request'
  | 'cancellation_request'
  | 'uniform_registry'
  | 'site_transfer'
  | 'company'
  | 'card_type'
  | 'employee_note'
  | 'trades'
  | 'trade_rate_history'
  | 'employee_salary_assignment'
  | 'payroll_period'
  | 'payroll_employee'
  | 'deduction_settings'
  | 'attendance_share_link';

export interface MonthlySummaryRow {
  month: string; // YYYY-MM
  status: AttendanceStatus;
  count: number;
}

/** One row of a bulk day-entry batch (same value semantics as markAttendance) */
export interface BulkAttendanceEntry {
  employee_id: string;
  date: string; // YYYY-MM-DD
  /** 'A' (absent) | numeric hours text ('10', '8.5') | '' / null (clear) */
  value: string | null;
}

// ============================================================================
// Shareable digital attendance sheets (per-site links sent over WhatsApp)
// ============================================================================

/** A one-time share link row as shown in the attendance page's right sidebar */
export interface AttendanceShareLink {
  id: string;
  token: string;
  site_id: string | null;
  site_name: string;
  month_key: string; // YYYY-MM
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
  /** active = editable through the link; submitted = locked (saved sheet) */
  status: 'active' | 'submitted';
  submitted_at: string | null;
  submitted_by: string | null;
  submit_count: number;
  edit_granted_at: string | null;
  edit_granted_by: string | null;
  /** create only: true when today's link for this site + month already
   *  existed and was handed back instead of creating a new one (ONE link
   *  per site per day — clicking Send Link again just opens the sidebar) */
  reused?: boolean;
}

/** One employee row of a shared digital sheet */
export interface SharedSheetEmployee {
  id: string;
  name: string;
  code: string;
  trade: string | null;
  /** paper row tints + trade suffixes (TL / SUPERVISOR), as on the A4 form */
  is_team_leader?: boolean;
  is_supervisor?: boolean;
  /** 'YYYY-MM-DD' → cell text ('' | hours | 'A' | free-text marker) */
  cells: Record<string, string>;
  /** dates the employee belongs to the link's site (date-effective) */
  markable: string[];
  /** snapshot rows carry their frozen totals */
  total_hours?: number;
  absents?: number;
}

/** An EXTRA EMPLOYEES row of the shared paper (walk-ins: kept with the saved
 * form only — they have no employee record, so they never reach the
 * attendance table) */
export interface SharedSheetExtra {
  name: string;
  code: string;
  trade: string;
  /** signature-column mark: hours | 'A' | short free text | '' */
  mark: string;
}

/** The frozen copy stored when a shared sheet is submitted */
export interface SharedSheetSnapshot {
  saved_at: string;
  site_name: string;
  client_name?: string | null;
  project_name?: string | null;
  month_key: string;
  year: number;
  month: number;
  days: number;
  employees: SharedSheetEmployee[];
  totals: { hours: number; absents: number };
  /** the date the submitted paper was showing (YYYY-MM-DD) */
  paper_date?: string;
  /** the paper's EXTRA EMPLOYEES rows at save time */
  extras?: SharedSheetExtra[];
  /** the paper's TOTAL PRESENT / TOTAL ABSENT boxes (server-computed) */
  total_present?: number;
  total_absent?: number;
}

/** get_shared_attendance_sheet payload — active link: live crew; submitted: snapshot */
export interface SharedSheetPayload {
  exists: boolean;
  token: string;
  site_id?: string | null;
  site_name: string;
  month_key: string;
  year?: number;
  month?: number;
  days?: number;
  /** paper header fields (active links; submitted → snapshot carries them) */
  client_name?: string | null;
  project_name?: string | null;
  status: 'active' | 'submitted';
  submitted_at: string | null;
  submitted_by: string | null;
  submit_count?: number;
  edit_granted_at: string | null;
  created_at: string;
  today: string;
  /** crew + current marks (status = 'active' only) */
  employees: SharedSheetEmployee[];
  /** the saved sheet (status = 'submitted' only) */
  snapshot: SharedSheetSnapshot | null;
}

/** One changed cell of a shared-sheet submission */
export interface SharedSheetSubmitEntry {
  employee_id: string;
  date: string; // YYYY-MM-DD
  value: string | null;
}

/** The paper-form metadata frozen with a submission (20261108b): the date
 * the paper was showing and its EXTRA EMPLOYEES rows. Totals are computed
 * server-side from the final marks. */
export interface SharedSheetSubmitMeta {
  paper_date: string; // YYYY-MM-DD
  extras: SharedSheetExtra[];
}

/** submit_shared_attendance_sheet result */
export interface SharedSheetSubmitResult {
  ok: boolean;
  applied: number;
  skipped: number;
  saved_at: string;
  paper_date?: string;
  total_present?: number;
  total_absent?: number;
}

// ============================================================================
// Constants used across the app
// ============================================================================

export const UNIFORM_ITEMS: { key: string; label: string; emoji: string }[] = [
  { key: 'uniform', label: 'Uniform', emoji: '👕' },
  { key: 'shoes', label: 'Shoes', emoji: '👟' },
  { key: 'helmet', label: 'Helmet', emoji: '🪖' },
  { key: 'bottle', label: 'Bottle', emoji: '🧴' },
  { key: 'safetyJacket', label: 'Safety Jacket', emoji: '🦺' },
  { key: 'mattress', label: 'Mattress', emoji: '🛏️' },
  { key: 'pillow', label: 'Pillow', emoji: '🛋️' },
];

export const LEAVE_TYPES: { value: LeaveType; label: string }[] = [
  { value: 'casual', label: 'Casual Leave' },
  { value: 'sick', label: 'Sick Leave' },
  { value: 'annual', label: 'Annual Leave' },
  { value: 'emergency', label: 'Emergency Leave' },
  { value: 'marriage', label: 'Marriage Leave' },
  { value: 'other', label: 'Other' },
];

export const ATTENDANCE_STATUSES: {
  value: AttendanceStatus;
  label: string;
  short: string;
  color: string;
}[] = [
  { value: 'present', label: 'Present', short: 'P', color: '#22c55e' },
  { value: 'absent', label: 'Absent', short: 'A', color: '#ef4444' },
];

// MENU_KEYS / MenuKey now live in lib/menus.ts (auto-synced with the sidebar).
export { MENU_KEYS } from './menus';
export type { PermissionKey, ExtraPermissionKey } from './menus';
