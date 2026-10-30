// ============================================================================
// PULSE Workforce OS — Shared domain types
// ============================================================================

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
  is_active: boolean;
  created_at: string;
}

export interface SiteWithCount extends Site {
  employee_count: number;
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
  is_team_leader: boolean;
  team_leader_site_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmployeeVM extends Employee {
  site_name: string | null;
  leader_site_name: string | null;
  camp_name: string | null;
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

export interface MenuPermissionMap {
  employees: boolean;
  sites: boolean;
  camps: boolean;
  attendance: boolean;
  leave_requests: boolean;
  cancellation_requests: boolean;
  notifications: boolean;
}

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
// Realtime
// ============================================================================

export type RealtimeTable =
  | 'profiles'
  | 'menu_permission'
  | 'admin_site'
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
  | 'site_transfer';

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

export const MENU_KEYS = [
  'employees',
  'sites',
  'camps',
  'attendance',
  'leave_requests',
  'cancellation_requests',
  'notifications',
] as const;

export type MenuKey = (typeof MENU_KEYS)[number];
