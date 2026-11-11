// ============================================================================
// PULSE Workforce OS — Production data API (Supabase-backed)
// ----------------------------------------------------------------------------
// Reads use supabase-js (RLS-protected) and all business-rule writes go
// through the Postgres RPC functions defined in supabase/schema.sql.
// ============================================================================

import { type RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase/client';
import {
  type AdminSiteAssignment,
  type Attendance,
  type BulkAttendanceEntry,
  type Camp,
  type CampWithCount,
  type CardType,
  type Company,
  type CancellationRequestVM,
  type EmployeeInput,
  type EmployeeNote,
  type EmployeeSalaryAssignment,
  type EmployeeVM,
  type EmployeeWorkingHoursReport,
  type ExperienceTier,
  type FineVM,
  type LeaveRequestInput,
  type LeaveRequestVM,
  type MenuPermissionMap,
  type MonthlySummaryRow,
  type Notification,
  type PayrollAdjustmentInput,
  type PaymentType,
  type Profile,
  type RealtimeTable,
  type SalaryEligibility,
  type SalarySheetReport,
  type SalarySheetRowUpdate,
  type SalaryRole,
  type SharedSheetPayload,
  type SharedSheetSubmitEntry,
  type SharedSheetSubmitMeta,
  type SharedSheetSubmitResult,
  type AttendanceShareLink,
  type DeductionSettings,
  type DeductionSettingsInput,
  type Site,
  type SiteTransfer,
  type SiteWithCount,
  type Trade,
  type TradeInput,
  type TradeRate,
  type TradeRateInput,
  type UniformEntry,
  type UniformEntryInput,
  type UniformEntryUpdate,
  type WarningVM,
} from '@/lib/types';
import { ABSENT_DEDUCTION_FREE_DAYS, ABSENT_DEDUCTION_RATE } from '@/lib/types';
import { defaultPermissionMap } from '@/lib/menus';

const sb = () => {
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase;
};

const assertOk = (error: { message: string } | null): void => {
  if (error) throw new Error(error.message);
};

/** Local-time today as YYYY-MM-DD — the effective date of a recorded site move. */
const localTodayYMD = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// API implementation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared Realtime channel & subscriber registry (avoids duplicate channels/listeners on hot reloads & multiple components)
// ---------------------------------------------------------------------------
let activeRealtimeChannel: RealtimeChannel | null = null;
const realtimeListeners = new Set<(tables: RealtimeTable[] | string[]) => void>();
let teardownTimeout: ReturnType<typeof setTimeout> | null = null;

function ensureRealtimeChannel(): void {
  if (teardownTimeout) {
    clearTimeout(teardownTimeout);
    teardownTimeout = null;
  }

  if (activeRealtimeChannel || !supabase) return;

  const client = supabase;
  const tables: RealtimeTable[] = [
    'profiles',
    'menu_permission',
    'admin_site',
    'site',
    'camp',
    'employee',
    'attendance',
    'notification',
    'warning',
    'fine',
    'leave_request',
    'cancellation_request',
    'uniform_registry',
    'site_transfer',
    'company',
    'card_type',
    'employee_note',
    'trades',
    'trade_rate_history',
    'employee_salary_assignment',
    'payroll_period',
    'payroll_employee',
    'attendance_share_link',
  ];

  // Clean up any stale channel on the same topic before subscribing
  const existing = client.getChannels().find((c) => c.topic === 'realtime:pulse-db-changes');
  if (existing) {
    client.removeChannel(existing);
  }

  const channel = client.channel('pulse-db-changes');
  tables.forEach((t) => {
    channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => {
      realtimeListeners.forEach((listener) => {
        try {
          listener([t]);
        } catch (err) {
          console.error('Realtime listener error:', err);
        }
      });
    });
  });

  channel.subscribe();
  activeRealtimeChannel = channel;
}

export const prodApi = {
  mode: 'supabase' as const,

  // ---- auth ---------------------------------------------------------------
  async hasProfiles(): Promise<boolean> {
    const { data, error } = await sb().rpc('has_any_profiles');
    assertOk(error);
    return Boolean(data);
  },

  async signIn(email: string, password: string): Promise<Profile> {
    const { error } = await sb().auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    const profile = await this.getSessionProfile();
    if (!profile) throw new Error('Signed in but no profile found — did you run the schema.sql migration?');
    if (profile.role === 'pending') {
      await this.signOut();
      throw new Error('Your account is awaiting approval by a super admin.');
    }
    return profile;
  },

  async signUpInitial(name: string, email: string, password: string): Promise<Profile> {
    const { data, error } = await sb().auth.signUp({
      email,
      password,
      options: { data: { name } },
    });
    if (error) throw new Error(error.message);
    if (!data.session) {
      throw new Error('Email confirmation is required. Confirm your email, then sign in (or disable "Confirm email" in Supabase Auth settings).');
    }
    const profile = await this.getSessionProfile();
    if (!profile) throw new Error('Profile creation failed — did you run the schema.sql migration (handle_new_user trigger)?');
    return profile;
  },

  async signOut(): Promise<void> {
    await sb().auth.signOut();
  },

  async getSessionProfile(): Promise<Profile | null> {
    const { data: { user } } = await sb().auth.getUser();
    if (!user) return null;
    const { data, error } = await sb().from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) return null;
    return (data as Profile | null);
  },

  // ---- profiles / admins ------------------------------------------------------
  async listProfiles(): Promise<Profile[]> {
    const { data, error } = await sb().from('profiles').select('*').order('created_at');
    assertOk(error);
    return ((data ?? []) as Profile[]).sort((a, b) =>
      a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'super_admin' ? -1 : 1,
    );
  },

  async createProfile(email: string, name: string, password: string, role: 'admin' | 'super_admin'): Promise<Profile> {
    const res = await fetch('/api/admin-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', email, name, password, role }),
    });
    const json = (await res.json()) as { error?: string; profile?: Profile };
    if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to create user');
    return json.profile as Profile;
  },

  async updateProfile(
    id: string,
    input: { name?: string; email?: string; password?: string; role?: 'admin' | 'super_admin' },
  ): Promise<Profile> {
    if (input.email || input.password) {
      const res = await fetch('/api/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          id,
          email: input.email ?? undefined,
          password: input.password || undefined,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to update user');
    }
    if (input.name !== undefined || input.role !== undefined) {
      const { data: existing } = await sb().from('profiles').select('*').eq('id', id).maybeSingle();
      const { data, error } = await sb().rpc('update_profile_admin', {
        p_id: id,
        p_name: input.name ?? existing?.name ?? 'User',
        p_role: input.role ?? existing?.role,
      });
      assertOk(error);
      return data as unknown as Profile;
    }
    const profile = await this.getSessionProfile();
    const { data } = await sb().from('profiles').select('*').eq('id', id).maybeSingle();
    return (data as Profile) ?? profile!;
  },

  async deleteProfile(id: string): Promise<void> {
    const res = await fetch('/api/admin-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    });
    const json = (await res.json()) as { error?: string };
    if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to delete user');
  },

  async setPreferences(theme: 'dark' | 'light', accent: 'violet' | 'emerald' | 'amber' | 'rose', name?: string): Promise<Profile> {
    const { data, error } = await sb().rpc('set_preferences', {
      p_name: name ?? null,
      p_theme: theme,
      p_accent: accent,
    });
    assertOk(error);
    return data as unknown as Profile;
  },

  async getMenuPermissions(profileId: string): Promise<MenuPermissionMap> {
    const { data, error } = await sb().from('menu_permission')
      .select('menu_key, allowed').eq('profile_id', profileId);
    assertOk(error);
    // start from the menu config defaults (lib/menus.ts) so newly added
    // sidebar menus appear for every admin until a super admin toggles them
    const map = defaultPermissionMap();
    (data ?? []).forEach((row: { menu_key: keyof MenuPermissionMap; allowed: boolean }) => {
      if (row.menu_key in map) map[row.menu_key] = row.allowed;
    });
    return map;
  },

  async setMenuPermission(profileId: string, menuKey: keyof MenuPermissionMap, allowed: boolean): Promise<void> {
    const { error } = await sb().rpc('set_menu_permission', {
      p_profile_id: profileId, p_menu_key: menuKey, p_allowed: allowed,
    });
    assertOk(error);
  },

  // ---- admin site assignments (attendance scoping) ---------------------------
  async getSiteAssignments(profileId: string): Promise<string[]> {
    const { data, error } = await sb().from('admin_site')
      .select('site_id').eq('profile_id', profileId);
    assertOk(error);
    return ((data ?? []) as { site_id: string }[]).map((r) => r.site_id);
  },

  async setSiteAssignment(profileId: string, siteId: string, allowed: boolean): Promise<void> {
    const { error } = await sb().rpc('set_admin_site', {
      p_profile_id: profileId, p_site_id: siteId, p_allowed: allowed,
    });
    assertOk(error);
  },

  /** All admin→site assignments with the admin's display name — powers the
   *  "View by Supervisors" drill-down on the attendance page (super admins
   *  see every assignment; normal admins only their own via RLS). */
  async listAdminSiteAssignments(): Promise<AdminSiteAssignment[]> {
    const { data, error } = await sb().from('admin_site')
      .select('profile_id, site_id, profiles(name)');
    assertOk(error);
    // many-to-one embeds arrive as an object, but supabase-js types them
    // loosely — accept both shapes
    const rows = (data ?? []) as unknown as {
      profile_id: string; site_id: string;
      profiles: { name: string } | { name: string }[] | null;
    }[];
    return rows.map((r) => {
      const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
      return {
        profileId: r.profile_id,
        profileName: p?.name?.trim() || 'Unknown admin',
        siteId: r.site_id,
      };
    });
  },

  // ---- sites -----------------------------------------------------------------
  async listSites(): Promise<SiteWithCount[]> {
    const [sitesRes, empRes] = await Promise.all([
      sb().from('site').select('*').order('created_at'),
      sb().from('employee').select('current_site_id').neq('status', 'deleted'),
    ]);
    assertOk(sitesRes.error);
    assertOk(empRes.error);
    const counts = new Map<string, number>();
    ((empRes.data ?? []) as { current_site_id: string | null }[]).forEach((r) => {
      if (r.current_site_id) counts.set(r.current_site_id, (counts.get(r.current_site_id) ?? 0) + 1);
    });
    return ((sitesRes.data ?? []) as Site[]).map((s) => ({
      ...s,
      employee_count: counts.get(s.id) ?? 0,
    }));
  },

  async createSite(
    name: string, clientName: string | null, projectName: string | null, supervisor: string | null,
  ): Promise<Site> {
    const { data, error } = await sb().rpc('create_site', {
      p_name: name, p_client_name: clientName, p_project_name: projectName, p_supervisor: supervisor,
    });
    assertOk(error);
    return data as unknown as Site;
  },

  async updateSite(
    id: string,
    input: { name: string; client_name: string | null; project_name: string | null; supervisor: string | null; is_active: boolean },
  ): Promise<{ unassignedCount: number }> {
    const { data, error } = await sb().rpc('update_site', {
      p_id: id, p_name: input.name, p_client_name: input.client_name,
      p_project_name: input.project_name, p_is_active: input.is_active, p_supervisor: input.supervisor,
    });
    assertOk(error);
    const json = (data ?? {}) as { unassignedCount?: number };
    return { unassignedCount: json.unassignedCount ?? 0 };
  },

  async deleteSite(id: string): Promise<void> {
    const { error } = await sb().rpc('delete_site', { p_id: id });
    assertOk(error);
  },

  // ---- camps (accommodation) ------------------------------------------------
  async listCamps(): Promise<CampWithCount[]> {
    const [campsRes, empRes] = await Promise.all([
      sb().from('camp').select('*').order('created_at'),
      sb().from('employee').select('camp_id').neq('status', 'deleted'),
    ]);
    assertOk(campsRes.error);
    assertOk(empRes.error);
    const counts = new Map<string, number>();
    ((empRes.data ?? []) as { camp_id: string | null }[]).forEach((r) => {
      if (r.camp_id) counts.set(r.camp_id, (counts.get(r.camp_id) ?? 0) + 1);
    });
    return ((campsRes.data ?? []) as Camp[]).map((c) => ({
      ...c,
      employee_count: counts.get(c.id) ?? 0,
    }));
  },

  async createCamp(name: string, location: string | null, capacity: number | null, notes: string | null): Promise<Camp> {
    const { data, error } = await sb().rpc('create_camp', {
      p_name: name, p_location: location, p_capacity: capacity, p_notes: notes,
    });
    assertOk(error);
    return data as unknown as Camp;
  },

  async updateCamp(id: string, input: { name: string; location: string | null; capacity: number | null; notes: string | null; is_active: boolean }): Promise<Camp> {
    const { data, error } = await sb().rpc('update_camp', {
      p_id: id, p_name: input.name, p_location: input.location,
      p_capacity: input.capacity, p_notes: input.notes, p_is_active: input.is_active,
    });
    assertOk(error);
    return data as unknown as Camp;
  },

  async deleteCamp(id: string): Promise<void> {
    const { error } = await sb().rpc('delete_camp', { p_id: id });
    assertOk(error);
  },

  // ---- companies (manpower companies — own table) ------------------------------
  async listCompanies(): Promise<Company[]> {
    const { data, error } = await sb().from('company').select('*').order('name');
    assertOk(error);
    return (data ?? []) as Company[];
  },

  async createCompany(name: string): Promise<Company> {
    const { data, error } = await sb().rpc('create_company', { p_name: name });
    assertOk(error);
    return data as unknown as Company;
  },

  // ---- payroll card types (Lulu Card, C3 Card, … — own table) ---------------
  async listCardTypes(): Promise<CardType[]> {
    const { data, error } = await sb().from('card_type').select('*').order('name');
    assertOk(error);
    return (data ?? []) as CardType[];
  },

  async createCardType(name: string): Promise<CardType> {
    const { data, error } = await sb().rpc('create_card_type', { p_name: name });
    assertOk(error);
    return data as unknown as CardType;
  },

  /** Set / clear how an employee is paid (Employee Details → Document
   *  Details). 'card' requires an existing card type; 'cash'/null clears it. */
  async setEmployeePaymentMethod(
    employeeId: string,
    paymentType: PaymentType | null,
    cardTypeId: string | null,
  ): Promise<EmployeeVM> {
    const { data, error } = await sb().rpc('set_employee_payment_method', {
      p_employee_id: employeeId,
      p_payment_type: paymentType,
      p_card_type_id: cardTypeId,
    });
    assertOk(error);
    const updated = data as unknown as Record<string, unknown>;
    return {
      ...(updated as unknown as EmployeeVM),
      site_name: null,
      leader_site_name: null,
      camp_name: null,
      card_type_name: null,
    };
  },

  // ---- employee sticky notes (Payroll page quick-reference comments) --------
  async listEmployeeNotes(): Promise<EmployeeNote[]> {
    const { data, error } = await sb().rpc('list_employee_notes');
    assertOk(error);
    return (data ?? []) as EmployeeNote[];
  },

  async addEmployeeNote(employeeId: string, note: string): Promise<EmployeeNote> {
    const { data, error } = await sb().rpc('add_employee_note', {
      p_employee_id: employeeId,
      p_note: note,
    });
    assertOk(error);
    return data as unknown as EmployeeNote;
  },

  async deleteEmployeeNote(id: string): Promise<void> {
    const { error } = await sb().rpc('delete_employee_note', { p_id: id });
    assertOk(error);
  },

  async assignEmployeeCamp(
    employeeId: string, campId: string | null,
    block?: string | null, room?: string | null,
  ): Promise<EmployeeVM> {
    const { data, error } = await sb().rpc('assign_employee_camp', {
      p_employee_id: employeeId, p_camp_id: campId,
      p_block: block ?? null, p_room: room ?? null,
    });
    assertOk(error);
    const updated = data as unknown as Record<string, unknown>;
    return {
      ...(updated as unknown as EmployeeVM),
      site_name: null,
      leader_site_name: null,
      camp_name: null,
    };
  },

  // ---- employees ---------------------------------------------------------------
  async listEmployees(): Promise<EmployeeVM[]> {
    const { data, error } = await sb().from('employee')
      .select('*, site:current_site_id(name), leader_site:team_leader_site_id(name), camp:camp_id(name), trade:trade_id(name), card_type:card_type_id(name)')
      .neq('status', 'deleted')
      .order('created_at');
    assertOk(error);
    return ((data ?? []) as unknown as {
      site: { name: string } | null; leader_site: { name: string } | null; camp: { name: string } | null;
      trade: { name: string } | null; card_type: { name: string } | null;
      [k: string]: unknown;
    }[]).map((row) => ({
      ...(row as unknown as EmployeeVM),
      site_name: row.site?.name ?? null,
      leader_site_name: row.leader_site?.name ?? null,
      camp_name: row.camp?.name ?? null,
      trade_name: row.trade?.name ?? null,
      card_type_name: row.card_type?.name ?? null,
    }));
  },

  async listSiteTransfers(): Promise<SiteTransfer[]> {
    const { data, error } = await sb().from('site_transfer').select('*').order('created_at');
    assertOk(error);
    return (data ?? []) as SiteTransfer[];
  },

  /** Lifetime working-hours report — all aggregation happens in Postgres
   *  (get_employee_working_hours RPC): opening balance + per-month/per-site
   *  attendance totals with date-effective site attribution. */
  async getEmployeeWorkingHours(employeeId: string): Promise<EmployeeWorkingHoursReport> {
    const { data, error } = await sb().rpc('get_employee_working_hours', {
      p_employee_id: employeeId,
    });
    assertOk(error);
    const r = (data ?? {}) as {
      employee_id: string; full_name: string; employee_code: string; position: string | null;
      site_id: string | null; site_name: string | null; join_date: string | null;
      status: EmployeeWorkingHoursReport['status']; photo: string | null;
      opening_hours: number | string; tracked_hours: number | string; lifetime_hours: number | string;
      monthly_breakdown: {
        year: number; month: number; total_hours: number | string; attendance_days: number;
        sites: { site_id: string | null; site_name: string; total_hours: number | string }[];
      }[] | null;
    };
    return {
      employeeId: r.employee_id,
      fullName: r.full_name,
      employeeCode: r.employee_code,
      position: r.position,
      siteId: r.site_id,
      siteName: r.site_name,
      joinDate: r.join_date,
      status: r.status,
      photo: r.photo,
      openingHours: Number(r.opening_hours ?? 0),
      trackedHours: Number(r.tracked_hours ?? 0),
      lifetimeHours: Number(r.lifetime_hours ?? 0),
      monthlyBreakdown: (r.monthly_breakdown ?? []).map((m) => ({
        year: m.year,
        month: m.month,
        totalHours: Number(m.total_hours ?? 0),
        attendanceDays: m.attendance_days ?? 0,
        sites: (m.sites ?? []).map((s) => ({
          siteId: s.site_id,
          siteName: s.site_name,
          totalHours: Number(s.total_hours ?? 0),
        })),
      })),
    };
  },

  async createEmployee(input: EmployeeInput): Promise<EmployeeVM> {
    // NOTE: jsonb params must be passed as plain objects — pre-stringifying
    // (JSON.stringify) double-encodes them: PostgREST then delivers a jsonb
    // STRING scalar, `p_employee->>'full_name'` returns null and the insert
    // fails with a not-null violation.
    const { data, error } = await sb().rpc('create_employee', {
      p_employee: input,
    });
    assertOk(error);
    const created = data as unknown as Record<string, unknown>;
    return {
      ...(created as unknown as EmployeeVM),
      site_name: null,
      leader_site_name: null,
    };
  },

  async updateEmployee(id: string, input: EmployeeInput): Promise<EmployeeVM> {
    // plain object for the jsonb param — see the note in createEmployee
    const { data, error } = await sb().rpc('update_employee', {
      p_id: id, p_employee: input, p_effective_date: localTodayYMD(),
    });
    assertOk(error);
    const updated = data as unknown as Record<string, unknown>;
    return {
      ...(updated as unknown as EmployeeVM),
      site_name: null,
      leader_site_name: null,
    };
  },

  async deleteEmployeeCascade(id: string): Promise<void> {
    const { error } = await sb().rpc('delete_employee_cascade', { p_id: id });
    assertOk(error);
  },

  async requestEmployeeDeletion(id: string, reason: string | null): Promise<void> {
    const { error } = await sb().rpc('request_employee_deletion', {
      p_employee_id: id, p_reason: reason,
    });
    assertOk(error);
  },

  // ---- attendance --------------------------------------------------------------
  async getMonthAttendance(month: string): Promise<Attendance[]> {
    const { data, error } = await sb().rpc('get_month_attendance', { p_month: month });
    assertOk(error);
    return (data ?? []) as unknown as Attendance[];
  },

  async markAttendance(employeeId: string, date: string, value: string | null): Promise<void> {
    const { error } = await sb().rpc('mark_attendance', {
      p_employee_id: employeeId, p_date: date, p_value: value,
    });
    assertOk(error);
  },

  async bulkMarkAttendance(entries: BulkAttendanceEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const { error } = await sb().rpc('bulk_mark_attendance', {
      p_entries: entries.map((e) => ({
        employee_id: e.employee_id,
        date: e.date,
        value: e.value,
      })),
    });
    assertOk(error);
  },

  // ---- shareable digital attendance sheets (per-site WhatsApp links) ------
  async listAttendanceShareLinks(): Promise<AttendanceShareLink[]> {
    const { data, error } = await sb().rpc('list_attendance_share_links');
    assertOk(error);
    return (data ?? []) as unknown as AttendanceShareLink[];
  },

  async createAttendanceShareLink(siteId: string, monthKey: string): Promise<AttendanceShareLink> {
    const { data, error } = await sb().rpc('create_attendance_share_link', {
      p_site_id: siteId,
      p_month: monthKey,
    });
    assertOk(error);
    return data as unknown as AttendanceShareLink;
  },

  async grantAttendanceShareEdit(token: string): Promise<void> {
    const { error } = await sb().rpc('grant_attendance_share_edit', { p_token: token });
    assertOk(error);
  },

  /** PUBLIC — called from /share/[token] without a session (anon-key RPC). */
  async getSharedAttendanceSheet(token: string): Promise<SharedSheetPayload> {
    const { data, error } = await sb().rpc('get_shared_attendance_sheet', { p_token: token });
    assertOk(error);
    return data as unknown as SharedSheetPayload;
  },

  /** PUBLIC — one-time submit of a shared sheet (token-gated RPC). The
   * paper form's date + EXTRA EMPLOYEES rows are frozen with the snapshot;
   * signature marks flow into the same attendance table as the Excel. */
  async submitSharedAttendanceSheet(
    token: string,
    entries: SharedSheetSubmitEntry[],
    submittedBy?: string | null,
    meta?: SharedSheetSubmitMeta,
  ): Promise<SharedSheetSubmitResult> {
    const { data, error } = await sb().rpc('submit_shared_attendance_sheet', {
      p_token: token,
      p_entries: entries,
      p_submitted_by: submittedBy ?? null,
      p_paper_date: meta?.paper_date ?? null,
      p_extras: meta?.extras ?? [],
    });
    assertOk(error);
    return data as unknown as SharedSheetSubmitResult;
  },

  async getMonthlyAttendanceSummary(months = 6): Promise<MonthlySummaryRow[]> {
    const { data, error } = await sb().rpc('get_monthly_attendance_summary', { p_months: months });
    assertOk(error);
    return (data ?? []) as unknown as MonthlySummaryRow[];
  },

  // ---- leave requests --------------------------------------------------------------
  async listLeaveRequests(): Promise<LeaveRequestVM[]> {
    const { data, error } = await sb().from('leave_request')
      .select(`*, employee:employee_id(full_name, employee_code, position, phone, nationality, company_name),
        creator:created_by(name), reviewer:reviewed_by(name)`)
      .eq('is_hidden', false)
      .order('created_at', { ascending: false });
    assertOk(error);
    return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => {
      const e = row.employee as { full_name: string; employee_code: string; position: string | null; phone: string | null; nationality: string | null; company_name: string | null } | null;
      return {
        ...(row as unknown as LeaveRequestVM),
        employee_name: e?.full_name ?? 'Unknown',
        employee_code: e?.employee_code ?? '—',
        employee_position: e?.position ?? null,
        employee_phone: e?.phone ?? null,
        employee_nationality: e?.nationality ?? null,
        employee_company: e?.company_name ?? null,
        created_by_name: (row.creator as { name: string } | null)?.name ?? null,
        reviewed_by_name: (row.reviewer as { name: string } | null)?.name ?? null,
      };
    });
  },

  async createLeaveRequest(input: LeaveRequestInput): Promise<void> {
    const { error } = await sb().rpc('create_leave_request', {
      p_employee_id: input.employee_id,
      p_leave_type: input.leave_type,
      p_other_type_text: input.other_type_text,
      p_start_date: input.start_date,
      p_end_date: input.end_date,
      p_total_days: input.total_days,
      p_reason: input.reason,
    });
    assertOk(error);
  },

  async reviewLeaveRequest(id: string, approve: boolean): Promise<void> {
    const { error } = await sb().rpc('review_leave_request', { p_id: id, p_approve: approve });
    assertOk(error);
  },

  // ---- cancellation requests ------------------------------------------------------------
  async listCancellationRequests(): Promise<CancellationRequestVM[]> {
    const { data, error } = await sb().from('cancellation_request')
      .select(`*, employee:employee_id(full_name, employee_code, position, status),
        requester:requested_by(name), reviewer:reviewed_by(name)`)
      .eq('is_hidden', false)
      .order('created_at', { ascending: false });
    assertOk(error);
    return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => {
      const e = row.employee as { full_name: string; employee_code: string; position: string | null; status: CancellationRequestVM['employee_status'] } | null;
      return {
        ...(row as unknown as CancellationRequestVM),
        employee_name: e?.full_name ?? 'Unknown',
        employee_code: e?.employee_code ?? '—',
        employee_position: e?.position ?? null,
        employee_status: e?.status ?? 'deleted',
        requested_by_name: (row.requester as { name: string } | null)?.name ?? null,
        reviewed_by_name: (row.reviewer as { name: string } | null)?.name ?? null,
      };
    });
  },

  async createCancellationRequest(employeeId: string, reason: string | null): Promise<void> {
    const { error } = await sb().rpc('request_employee_deletion', {
      p_employee_id: employeeId, p_reason: reason,
    });
    assertOk(error);
  },

  async reviewCancellationRequest(id: string, approve: boolean): Promise<void> {
    const { error } = await sb().rpc('review_cancellation_request', { p_id: id, p_approve: approve });
    assertOk(error);
  },

  // ---- warnings + fines ---------------------------------------------------------------
  async listWarnings(): Promise<WarningVM[]> {
    const { data, error } = await sb().from('warning')
      .select('*, employee:employee_id(full_name, employee_code), creator:created_by(name)')
      .eq('is_hidden', false)
      .order('created_at', { ascending: false });
    assertOk(error);
    return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => {
      const e = row.employee as { full_name: string; employee_code: string } | null;
      return {
        ...(row as unknown as WarningVM),
        employee_name: e?.full_name ?? 'Unknown',
        employee_code: e?.employee_code ?? '—',
        issued_by_name: (row.creator as { name: string } | null)?.name ?? 'System',
      };
    });
  },

  async issueWarning(employeeId: string, reason: string): Promise<void> {
    const { error } = await sb().rpc('issue_warning', { p_employee_id: employeeId, p_reason: reason });
    assertOk(error);
  },

  async listFines(): Promise<FineVM[]> {
    const { data, error } = await sb().from('fine')
      .select('*, employee:employee_id(full_name, employee_code), creator:created_by(name)')
      .eq('is_hidden', false)
      .order('created_at', { ascending: false });
    assertOk(error);
    return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => {
      const e = row.employee as { full_name: string; employee_code: string } | null;
      return {
        ...(row as unknown as FineVM),
        employee_name: e?.full_name ?? 'Unknown',
        employee_code: e?.employee_code ?? '—',
        issued_by_name: (row.creator as { name: string } | null)?.name ?? 'System',
      };
    });
  },

  async issueFine(employeeId: string, reason: string, amount: number): Promise<void> {
    const { error } = await sb().rpc('issue_fine', {
      p_employee_id: employeeId, p_reason: reason, p_amount: amount,
    });
    assertOk(error);
  },

  // ---- notifications ---------------------------------------------------------------------
  async listNotifications(profileId?: string): Promise<Notification[]> {
    const { data, error } = await sb().from('notification')
      .select('*')
      .eq('is_hidden', false)
      .order('created_at', { ascending: false });
    assertOk(error);
    const rows = (data ?? []) as Notification[];
    return profileId ? rows.filter((n) => n.profile_id === profileId) : rows;
  },

  async getUnreadNotificationCount(): Promise<number> {
    const { count, error } = await sb().from('notification')
      .select('id', { count: 'exact', head: true })
      .eq('read', false)
      .eq('is_hidden', false);
    if (error) return 0;
    return count ?? 0;
  },

  async markNotificationRead(id: string): Promise<void> {
    const { error } = await sb().from('notification').update({ read: true }).eq('id', id);
    assertOk(error);
  },

  async markAllNotificationsRead(): Promise<void> {
    const { error } = await sb().rpc('mark_all_notifications_read');
    assertOk(error);
  },

  // ---- uniform registry ---------------------------------------------------------------------
  async listUniformEntries(): Promise<UniformEntry[]> {
    const { data, error } = await sb().from('uniform_registry')
      .select('*')
      .eq('is_deleted', false)
      .eq('is_hidden', false)
      .order('created_at', { ascending: false });
    assertOk(error);
    return (data ?? []) as unknown as UniformEntry[];
  },

  async listEmployeeUniforms(employeeId: string): Promise<UniformEntry[]> {
    const { data, error } = await sb().from('uniform_registry')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('is_deleted', false)
      .eq('is_hidden', false)
      .order('created_at', { ascending: false });
    assertOk(error);
    return (data ?? []) as unknown as UniformEntry[];
  },

  async createUniformEntry(input: UniformEntryInput): Promise<UniformEntry> {
    const { data, error } = await sb().rpc('create_uniform_entry', {
      p_employee_id: input.employee_id,
      p_document_type: input.document_type,
      p_document_number: input.document_number,
      // plain object for the jsonb param (double-encoding breaks item flags)
      p_items: input.items,
      p_site_name: input.site_name,
      p_team_leader_name: input.team_leader_name,
      p_created_at: input.created_at,
      p_token_number: input.token_number,
      p_is_renewal: input.is_renewal,
      p_previous_token_id: input.previous_token_id,
    });
    assertOk(error);
    return data as unknown as UniformEntry;
  },

  async updateUniformEntry(id: string, input: UniformEntryUpdate): Promise<UniformEntry> {
    const { data, error } = await sb().rpc('update_uniform_entry', {
      p_id: id,
      p_token_number: input.token_number,
      p_document_type: input.document_type,
      p_document_number: input.document_number,
      // plain object for the jsonb param (double-encoding breaks item flags)
      p_items: input.items,
      p_site_name: input.site_name,
      p_team_leader_name: input.team_leader_name,
      p_created_at: input.created_at,
    });
    assertOk(error);
    return data as unknown as UniformEntry;
  },

  async deleteUniformEntry(id: string): Promise<void> {
    const { error } = await sb().rpc('delete_uniform_entry', { p_id: id });
    assertOk(error);
  },

  // ---- trades & salary --------------------------------------------------------
  async listTrades(): Promise<(Trade & { current_rates: TradeRate[] })[]> {
    const { data, error } = await sb().rpc('list_trades');
    assertOk(error);
    return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      is_active: Boolean(row.is_active),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      current_rates: ((row.current_rates ?? []) as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        trade_id: r.trade_id as string,
        salary_role: r.salary_role as SalaryRole,
        experience_tier: r.experience_tier as ExperienceTier,
        hourly_rate: Number(r.hourly_rate ?? 0),
        effective_from: r.effective_from as string,
        effective_to: (r.effective_to as string | null) ?? null,
        created_at: r.created_at as string,
      })),
    }));
  },

  async getTradeRateHistory(tradeId: string): Promise<TradeRate[]> {
    const { data, error } = await sb().rpc('get_trade_rate_history', { p_trade_id: tradeId });
    assertOk(error);
    return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      trade_id: r.trade_id as string,
      salary_role: r.salary_role as SalaryRole,
      experience_tier: r.experience_tier as ExperienceTier,
      hourly_rate: Number(r.hourly_rate ?? 0),
      effective_from: r.effective_from as string,
      effective_to: (r.effective_to as string | null) ?? null,
      created_at: r.created_at as string,
    }));
  },

  async createTrade(input: TradeInput): Promise<Trade> {
    const { data, error } = await sb().rpc('create_trade', {
      p_name: input.name,
      p_description: input.description,
      // plain array for the jsonb param (double-encoding breaks it)
      p_rates: input.rates,
      p_activate: input.is_active ?? true,
    });
    assertOk(error);
    return data as unknown as Trade;
  },

  async updateTrade(tradeId: string, input: { name: string; description: string | null; is_active: boolean }): Promise<void> {
    const { error } = await sb().rpc('update_trade', {
      p_trade_id: tradeId,
      p_name: input.name,
      p_description: input.description,
      p_is_active: input.is_active,
    });
    assertOk(error);
  },

  async saveTradeRates(tradeId: string, rates: TradeRateInput[], effectiveFrom: string): Promise<void> {
    if (rates.length === 0) return;
    const { error } = await sb().rpc('update_trade_rates', {
      p_trade_id: tradeId,
      p_rates: rates,
      p_effective_from: effectiveFrom,
    });
    assertOk(error);
  },

  // ---- absent deduction settings (Trade Management → Deductions tab) ----------
  async getDeductionSettings(): Promise<DeductionSettings> {
    const { data, error } = await sb().rpc('get_deduction_settings');
    assertOk(error);
    const row = (data ?? {}) as Record<string, unknown>;
    return {
      absent_free_days: Number(row.absent_free_days ?? ABSENT_DEDUCTION_FREE_DAYS),
      absent_deduction_amount: Number(row.absent_deduction_amount ?? ABSENT_DEDUCTION_RATE),
      updated_at: (row.updated_at as string | null) ?? null,
      updated_by_name: (row.updated_by_name as string | null) ?? null,
    };
  },

  async updateDeductionSettings(input: DeductionSettingsInput): Promise<DeductionSettings> {
    const { data, error } = await sb().rpc('update_deduction_settings', {
      p_free_days: input.absent_free_days,
      p_amount: input.absent_deduction_amount,
    });
    assertOk(error);
    const row = (data ?? {}) as Record<string, unknown>;
    return {
      absent_free_days: Number(row.absent_free_days ?? input.absent_free_days),
      absent_deduction_amount: Number(row.absent_deduction_amount ?? input.absent_deduction_amount),
      updated_at: (row.updated_at as string | null) ?? null,
      updated_by_name: (row.updated_by_name as string | null) ?? null,
    };
  },

  async getEmployeeSalaryEligibility(employeeId: string, asOfDate?: string): Promise<SalaryEligibility> {
    const { data, error } = await sb().rpc('get_employee_salary_eligibility', {
      p_employee_id: employeeId,
      p_as_of: asOfDate ?? null,
    });
    assertOk(error);
    const r = (data ?? {}) as Record<string, unknown>;
    return {
      employee_id: r.employee_id as string,
      full_name: r.full_name as string,
      employee_code: r.employee_code as string,
      join_date: (r.join_date as string | null) ?? null,
      opening_hours: Number(r.opening_hours ?? 0),
      tracked_hours: Number(r.tracked_hours ?? 0),
      lifetime_hours: Number(r.lifetime_hours ?? 0),
      six_month_date: (r.six_month_date as string | null) ?? null,
      threshold_hours: Number(r.threshold_hours ?? 1000),
      threshold_date: (r.threshold_date as string | null) ?? null,
      hours_to_threshold: Number(r.hours_to_threshold ?? 0),
      progress_percent: Number(r.progress_percent ?? 0),
      qualified: Boolean(r.qualified),
      qualification_date: (r.qualification_date as string | null) ?? null,
      qualification_reason: (r.qualification_reason as SalaryEligibility['qualification_reason']) ?? null,
      as_of: r.as_of as string,
      trade_id: (r.trade_id as string | null) ?? null,
      trade_name: (r.trade_name as string | null) ?? null,
      salary_role: (r.salary_role as SalaryRole) ?? 'standard',
      current_rate: r.current_rate == null ? null : Number(r.current_rate),
    };
  },

  async getEmployeeSalaryHistory(employeeId: string): Promise<EmployeeSalaryAssignment[]> {
    const { data, error } = await sb().rpc('get_employee_salary_history', {
      p_employee_id: employeeId,
    });
    assertOk(error);
    return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      employee_id: r.employee_id as string,
      employee_name: r.employee_name as string,
      trade_id: r.trade_id as string,
      trade_name: r.trade_name as string,
      salary_role: r.salary_role as SalaryRole,
      effective_from: r.effective_from as string,
      effective_to: (r.effective_to as string | null) ?? null,
      created_at: r.created_at as string,
    }));
  },

  async getSalarySheet(year: number, month: number): Promise<SalarySheetReport> {
    const { data, error } = await sb().rpc('get_salary_sheet', { p_year: year, p_month: month });
    assertOk(error);
    return data as unknown as SalarySheetReport;
  },

  async generatePayroll(year: number, month: number): Promise<void> {
    const { error } = await sb().rpc('generate_payroll_period', { p_year: year, p_month: month });
    assertOk(error);
  },

  async updatePayrollAdjustment(payrollEmployeeId: string, input: PayrollAdjustmentInput): Promise<void> {
    const { error } = await sb().rpc('update_payroll_adjustment', {
      p_payroll_employee_id: payrollEmployeeId,
      p_advance: input.advance,
      p_deduction: input.deduction,
      p_notes: input.notes,
    });
    assertOk(error);
  },

  async finalizePayroll(payrollPeriodId: string): Promise<void> {
    const { error } = await sb().rpc('finalize_payroll_period', { p_payroll_period_id: payrollPeriodId });
    assertOk(error);
  },

  async reopenPayroll(payrollPeriodId: string, reason: string): Promise<void> {
    const { error } = await sb().rpc('reopen_payroll_period', {
      p_payroll_period_id: payrollPeriodId, p_reason: reason,
    });
    assertOk(error);
  },

  async markPayrollPaid(
    payrollEmployeeId: string,
    input: PayrollAdjustmentInput & { paid?: boolean },
  ): Promise<void> {
    const { error } = await sb().rpc('mark_employee_salary_paid', {
      p_payroll_employee_id: payrollEmployeeId,
      p_advance: input.advance,
      p_deduction: input.deduction,
      p_notes: input.notes,
    });
    assertOk(error);
  },

  /** Revert a payment — super admin only, reason mandatory, audited
   *  (unmark_employee_salary_paid RPC in 20261104_payroll_idle.sql). */
  async unmarkPayrollPaid(payrollEmployeeId: string, reason: string): Promise<void> {
    const { error } = await sb().rpc('unmark_employee_salary_paid', {
      p_payroll_employee_id: payrollEmployeeId,
      p_reason: reason,
    });
    assertOk(error);
  },

  /** Salary Sheet edit-mode save — the sheet record has priority (see
   *  update_salary_sheet_row RPC in 20261103b_salary_sheet_edit.sql). */
  async updateSalarySheetRow(input: SalarySheetRowUpdate): Promise<void> {
    const { error } = await sb().rpc('update_salary_sheet_row', { p_payload: input });
    assertOk(error);
  },

  /** Return a hand-edited settlement to automatic calculation (draft only). */
  async resetPayrollEmployeeAuto(payrollEmployeeId: string): Promise<void> {
    const { error } = await sb().rpc('reset_payroll_employee_auto', {
      p_payroll_employee_id: payrollEmployeeId,
    });
    assertOk(error);
  },

  // ---- realtime (Supabase postgres_changes) ------------------------------------------------
  subscribe(onChange: (tables: RealtimeTable[] | string[]) => void): () => void {
    if (!supabase) return () => undefined;

    realtimeListeners.add(onChange);
    ensureRealtimeChannel();

    return () => {
      realtimeListeners.delete(onChange);
      if (realtimeListeners.size === 0 && activeRealtimeChannel && supabase) {
        if (teardownTimeout) clearTimeout(teardownTimeout);
        teardownTimeout = setTimeout(() => {
          if (realtimeListeners.size === 0 && activeRealtimeChannel && supabase) {
            supabase.removeChannel(activeRealtimeChannel);
            activeRealtimeChannel = null;
          }
        }, 5000);
      }
    };
  },
};
