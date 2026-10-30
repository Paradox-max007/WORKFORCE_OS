// ============================================================================
// PULSE Workforce OS — Production data API (Supabase-backed)
// ----------------------------------------------------------------------------
// Reads use supabase-js (RLS-protected) and all business-rule writes go
// through the Postgres RPC functions defined in supabase/schema.sql.
// ============================================================================

import { supabase } from '@/lib/supabase/client';
import {
  type Attendance,
  type BulkAttendanceEntry,
  type Camp,
  type CampWithCount,
  type CancellationRequestVM,
  type EmployeeInput,
  type EmployeeVM,
  type FineVM,
  type LeaveRequestInput,
  type LeaveRequestVM,
  type MenuPermissionMap,
  type MonthlySummaryRow,
  type Notification,
  type Profile,
  type RealtimeTable,
  type Site,
  type SiteTransfer,
  type SiteWithCount,
  type UniformEntry,
  type UniformEntryInput,
  type UniformEntryUpdate,
  type WarningVM,
} from '@/lib/types';

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
    const map: MenuPermissionMap = {
      employees: false, sites: false, camps: false, attendance: false,
      leave_requests: false, cancellation_requests: false, notifications: false,
    };
    (data ?? []).forEach((row: { menu_key: keyof MenuPermissionMap; allowed: boolean }) => {
      map[row.menu_key] = row.allowed;
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

  async createSite(name: string, clientName: string | null, projectName: string | null): Promise<Site> {
    const { data, error } = await sb().rpc('create_site', {
      p_name: name, p_client_name: clientName, p_project_name: projectName,
    });
    assertOk(error);
    return data as unknown as Site;
  },

  async updateSite(
    id: string,
    input: { name: string; client_name: string | null; project_name: string | null; is_active: boolean },
  ): Promise<{ unassignedCount: number }> {
    const { data, error } = await sb().rpc('update_site', {
      p_id: id, p_name: input.name, p_client_name: input.client_name,
      p_project_name: input.project_name, p_is_active: input.is_active,
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
      .select('*, site:current_site_id(name), leader_site:team_leader_site_id(name), camp:camp_id(name)')
      .neq('status', 'deleted')
      .order('created_at');
    assertOk(error);
    return ((data ?? []) as unknown as {
      site: { name: string } | null; leader_site: { name: string } | null; camp: { name: string } | null;
      [k: string]: unknown;
    }[]).map((row) => ({
      ...(row as unknown as EmployeeVM),
      site_name: row.site?.name ?? null,
      leader_site_name: row.leader_site?.name ?? null,
      camp_name: row.camp?.name ?? null,
    }));
  },

  async listSiteTransfers(): Promise<SiteTransfer[]> {
    const { data, error } = await sb().from('site_transfer').select('*').order('created_at');
    assertOk(error);
    return (data ?? []) as SiteTransfer[];
  },

  async createEmployee(input: EmployeeInput): Promise<EmployeeVM> {
    const { data, error } = await sb().rpc('create_employee', {
      p_employee: JSON.stringify(input),
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
    const { data, error } = await sb().rpc('update_employee', {
      p_id: id, p_employee: JSON.stringify(input), p_effective_date: localTodayYMD(),
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
      p_items: JSON.stringify(input.items),
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
      p_items: JSON.stringify(input.items),
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

  // ---- realtime (Supabase postgres_changes) ------------------------------------------------
  subscribe(onChange: (tables: RealtimeTable[] | string[]) => void): () => void {
    const client = supabase;
    if (!client) return () => undefined;
    const tables: RealtimeTable[] = [
      'profiles', 'menu_permission', 'admin_site', 'site', 'camp', 'employee', 'attendance', 'notification',
      'warning', 'fine', 'leave_request', 'cancellation_request', 'uniform_registry',
    ];
    const channel = client.channel('pulse-db-changes');
    tables.forEach((t) => {
      channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => onChange([t]));
    });
    channel.subscribe();
    return () => {
      client.removeChannel(channel);
    };
  },
};
