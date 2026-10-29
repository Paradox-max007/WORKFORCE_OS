// ============================================================================
// PULSE Workforce OS — Demo data API (business logic mirrors supabase/schema.sql)
// ============================================================================

import {
  type Attendance,
  type AttendanceStatus,
  type CancellationRequestVM,
  type Employee,
  type EmployeeInput,
  type EmployeeVM,
  type FineVM,
  type LeaveRequestInput,
  type LeaveRequestVM,
  type MonthlySummaryRow,
  type Notification,
  type Profile,
  type Site,
  type SiteWithCount,
  type UniformEntry,
  type UniformEntryInput,
  type UniformEntryUpdate,
  type WarningVM,
  type MenuPermissionMap,
} from '@/lib/types';
import {
  addDaysStr,
  db,
  fromYMD,
  getDemoSessionId,
  isFridayStr,
  nowISO,
  saveAndEmit,
  setDemoSessionId,
  subscribeDemo,
  toYMD,
  uid,
} from './demo-store';

type VM = Record<string, unknown>;

const clampRating = (v: number): number => Math.round(Math.max(0, Math.min(5, v)) * 10) / 10;

const stripPassword = (p: (typeof db.profiles)[number]): Profile => {
  const { password: _pw, ...rest } = p;
  return rest;
};

const currentProfile = (): Profile | null => {
  const id = getDemoSessionId();
  if (!id) return null;
  const p = db.profiles.find((x) => x.id === id);
  return p ? stripPassword(p) : null;
};

const notifySuperAdmins = (title: string, message: string, type: Notification['type']): void => {
  db.profiles
    .filter((p) => p.role === 'super_admin')
    .forEach((p) => {
      db.notifications.push({
        id: uid(), profile_id: p.id, title, message, type, read: false, is_hidden: false, created_at: nowISO(),
      });
    });
};

const attachEmployeeVM = (e: Employee): EmployeeVM => ({
  ...e,
  site_name: e.current_site_id ? db.sites.find((s) => s.id === e.current_site_id)?.name ?? null : null,
  leader_site_name: e.team_leader_site_id ? db.sites.find((s) => s.id === e.team_leader_site_id)?.name ?? null : null,
});

const profileName = (id: string | null): string | null =>
  id ? db.profiles.find((p) => p.id === id)?.name ?? null : null;

const attachLeaveVM = (r: (typeof db.leaveRequests)[number]): LeaveRequestVM => {
  const e = db.employees.find((x) => x.id === r.employee_id);
  return {
    ...r,
    employee_name: e?.full_name ?? 'Unknown',
    employee_code: e?.employee_code ?? '—',
    employee_position: e?.position ?? null,
    employee_phone: e?.phone ?? null,
    employee_nationality: e?.nationality ?? null,
    employee_company: e?.company_name ?? null,
    created_by_name: profileName(r.created_by),
    reviewed_by_name: profileName(r.reviewed_by),
  };
};

const attachCancelVM = (r: (typeof db.cancellationRequests)[number]): CancellationRequestVM => {
  const e = db.employees.find((x) => x.id === r.employee_id);
  return {
    ...r,
    employee_name: e?.full_name ?? 'Unknown',
    employee_code: e?.employee_code ?? '—',
    employee_position: e?.position ?? null,
    employee_status: e?.status ?? 'deleted',
    requested_by_name: profileName(r.requested_by),
    reviewed_by_name: profileName(r.reviewed_by),
  };
};

const attachWarningVM = (w: (typeof db.warnings)[number]): WarningVM => {
  const e = db.employees.find((x) => x.id === w.employee_id);
  return {
    ...w,
    employee_name: e?.full_name ?? 'Unknown',
    employee_code: e?.employee_code ?? '—',
    issued_by_name: profileName(w.created_by) ?? 'System',
  };
};

const attachFineVM = (f: (typeof db.fines)[number]): FineVM => {
  const e = db.employees.find((x) => x.id === f.employee_id);
  return {
    ...f,
    employee_name: e?.full_name ?? 'Unknown',
    employee_code: e?.employee_code ?? '—',
    issued_by_name: profileName(f.created_by) ?? 'System',
  };
};

const nextEmployeeCode = (): string => {
  const year = new Date().getFullYear();
  const prefix = `ASM-${year}-`;
  const max = db.employees.reduce((m, e) => {
    if (e.employee_code.startsWith(prefix)) {
      const n = parseInt(e.employee_code.slice(prefix.length), 10);
      return Number.isNaN(n) ? m : Math.max(m, n);
    }
    return m;
  }, 0);
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
};

// ---------------------------------------------------------------------------
// API implementation
// ---------------------------------------------------------------------------

export const demoApi = {
  mode: 'demo' as const,

  // ---- auth ---------------------------------------------------------------
  async hasProfiles(): Promise<boolean> {
    return db.profiles.some((p) => p.role === 'super_admin');
  },

  async signIn(email: string, password: string): Promise<Profile> {
    const p = db.profiles.find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (!p || p.password !== password) throw new Error('Invalid email or password');
    setDemoSessionId(p.id);
    return stripPassword(p);
  },

  async signUpInitial(name: string, email: string, password: string): Promise<Profile> {
    if (db.profiles.some((p) => p.role === 'super_admin')) {
      throw new Error('A super admin account already exists');
    }
    const p = {
      id: uid(), email: email.toLowerCase(), name, password,
      role: 'super_admin' as const, theme: 'dark' as const, accent: 'violet' as const,
      created_at: nowISO(),
    };
    db.profiles.push(p);
    saveAndEmit(['profiles']);
    setDemoSessionId(p.id);
    return stripPassword(p);
  },

  async signOut(): Promise<void> {
    setDemoSessionId(null);
  },

  async getSessionProfile(): Promise<Profile | null> {
    return currentProfile();
  },

  // ---- profiles / admins ------------------------------------------------------
  async listProfiles(): Promise<Profile[]> {
    return db.profiles.map(stripPassword).sort((a, b) =>
      a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'super_admin' ? -1 : 1,
    );
  },

  async createProfile(email: string, name: string, password: string, role: 'admin' | 'super_admin'): Promise<Profile> {
    if (db.profiles.some((p) => p.email.toLowerCase() === email.toLowerCase())) {
      throw new Error('An account with this email already exists');
    }
    const p = {
      id: uid(), email: email.toLowerCase(), name, password, role,
      theme: 'dark' as const, accent: 'violet' as const, created_at: nowISO(),
    };
    db.profiles.push(p);
    saveAndEmit(['profiles']);
    return stripPassword(p);
  },

  async updateProfile(id: string, input: { name?: string; email?: string; password?: string; role?: 'admin' | 'super_admin' }): Promise<Profile> {
    const p = db.profiles.find((x) => x.id === id);
    if (!p) throw new Error('Profile not found');
    if (input.name !== undefined) p.name = input.name;
    if (input.email !== undefined) p.email = input.email.toLowerCase();
    if (input.password) p.password = input.password;
    if (input.role !== undefined) {
      if (p.role === 'super_admin' && input.role !== 'super_admin') {
        const superCount = db.profiles.filter((x) => x.role === 'super_admin').length;
        if (superCount <= 1) throw new Error('Cannot demote the last super admin');
      }
      p.role = input.role;
    }
    saveAndEmit(['profiles']);
    return stripPassword(p);
  },

  async deleteProfile(id: string): Promise<void> {
    const p = db.profiles.find((x) => x.id === id);
    if (!p) return;
    if (p.role === 'super_admin') {
      const superCount = db.profiles.filter((x) => x.role === 'super_admin').length;
      if (superCount <= 1) throw new Error('Cannot delete the last super admin');
    }
    db.profiles = db.profiles.filter((x) => x.id !== id);
    db.menuPermissions = db.menuPermissions.filter((x) => x.profile_id !== id);
    saveAndEmit(['profiles', 'menu_permission']);
  },

  async setPreferences(theme: 'dark' | 'light', accent: 'violet' | 'emerald' | 'amber' | 'rose', name?: string): Promise<Profile> {
    const p = currentProfile();
    if (!p) throw new Error('Not signed in');
    const row = db.profiles.find((x) => x.id === p.id)!;
    row.theme = theme;
    row.accent = accent;
    if (name) row.name = name;
    saveAndEmit(['profiles']);
    return stripPassword(row);
  },

  async getMenuPermissions(profileId: string): Promise<MenuPermissionMap> {
    const map = {
      employees: false, sites: false, attendance: false,
      leave_requests: false, cancellation_requests: false, notifications: false,
    };
    db.menuPermissions
      .filter((x) => x.profile_id === profileId)
      .forEach((x) => { map[x.menu_key] = x.allowed; });
    return map;
  },

  async setMenuPermission(profileId: string, menuKey: keyof MenuPermissionMap, allowed: boolean): Promise<void> {
    const existing = db.menuPermissions.find((x) => x.profile_id === profileId && x.menu_key === menuKey);
    if (existing) existing.allowed = allowed;
    else db.menuPermissions.push({ profile_id: profileId, menu_key: menuKey, allowed });
    saveAndEmit(['menu_permission']);
  },

  // ---- sites -----------------------------------------------------------------
  async listSites(): Promise<SiteWithCount[]> {
    return db.sites.map((s) => ({
      ...s,
      employee_count: db.employees.filter((e) => e.current_site_id === s.id && e.status !== 'deleted').length,
    }));
  },

  async createSite(name: string, clientName: string | null, projectName: string | null): Promise<Site> {
    if (db.sites.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('A site with this name already exists');
    }
    const site: Site = {
      id: uid(), name, client_name: clientName, project_name: projectName, is_active: true, created_at: nowISO(),
    };
    db.sites.push(site);
    saveAndEmit(['site']);
    return site;
  },

  async updateSite(id: string, input: { name: string; client_name: string | null; project_name: string | null; is_active: boolean }): Promise<{ unassignedCount: number }> {
    if (db.sites.some((s) => s.name.toLowerCase() === input.name.toLowerCase() && s.id !== id)) {
      throw new Error('A site with this name already exists');
    }
    const site = db.sites.find((s) => s.id === id);
    if (!site) throw new Error('Site not found');
    const wasActive = site.is_active;
    Object.assign(site, {
      name: input.name, client_name: input.client_name, project_name: input.project_name, is_active: input.is_active,
    });

    let unassignedCount = 0;
    if (wasActive && !input.is_active) {
      db.employees
        .filter((e) => e.current_site_id === id && e.status !== 'deleted')
        .forEach((e) => { e.current_site_id = null; unassignedCount += 1; });
      db.employees
        .filter((e) => e.team_leader_site_id === id)
        .forEach((e) => { e.is_team_leader = false; e.team_leader_site_id = null; });
    }
    saveAndEmit(['site', 'employee']);
    return { unassignedCount };
  },

  async deleteSite(id: string): Promise<void> {
    db.employees.filter((e) => e.current_site_id === id).forEach((e) => { e.current_site_id = null; });
    db.employees.filter((e) => e.team_leader_site_id === id).forEach((e) => { e.is_team_leader = false; e.team_leader_site_id = null; });
    db.sites = db.sites.filter((s) => s.id !== id);
    saveAndEmit(['site', 'employee']);
  },

  // ---- employees ---------------------------------------------------------------
  async listEmployees(): Promise<EmployeeVM[]> {
    return db.employees.filter((e) => e.status !== 'deleted').map(attachEmployeeVM);
  },

  async createEmployee(input: EmployeeInput): Promise<EmployeeVM> {
    if (input.current_site_id) {
      const site = db.sites.find((s) => s.id === input.current_site_id);
      if (!site || !site.is_active) throw new Error('The selected site does not exist or is inactive');
    }
    if (input.is_team_leader && input.team_leader_site_id) {
      const conflict = db.employees.find(
        (e) => e.is_team_leader && e.team_leader_site_id === input.team_leader_site_id && e.status !== 'deleted',
      );
      if (conflict) throw new Error(`Another employee (${conflict.full_name}) is already the team leader of this site`);
    }
    const e: Employee = {
      id: uid(),
      full_name: input.full_name,
      employee_code: nextEmployeeCode(),
      nationality: input.nationality || null,
      date_of_birth: input.date_of_birth || null,
      phone: input.phone || null,
      email: input.email || null,
      address: input.address || null,
      emergency_contact: input.emergency_contact || null,
      position: input.position || null,
      join_date: input.join_date || null,
      company_name: input.company_name || null,
      passport_number: input.passport_number || null,
      passport_status: input.passport_status,
      id_number: input.id_number || null,
      id_status: input.id_status,
      current_site_id: input.current_site_id || null,
      rating: 5,
      status: 'active',
      photo: input.photo || null,
      is_team_leader: input.is_team_leader,
      team_leader_site_id: input.is_team_leader ? input.team_leader_site_id || null : null,
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    db.employees.push(e);
    saveAndEmit(['employee']);
    return attachEmployeeVM(e);
  },

  async updateEmployee(id: string, input: EmployeeInput): Promise<EmployeeVM> {
    const e = db.employees.find((x) => x.id === id);
    if (!e) throw new Error('Employee not found');
    if (input.current_site_id) {
      const site = db.sites.find((s) => s.id === input.current_site_id);
      if (!site || !site.is_active) throw new Error('The selected site does not exist or is inactive');
    }
    if (input.is_team_leader && input.team_leader_site_id) {
      const conflict = db.employees.find(
        (x) => x.is_team_leader && x.team_leader_site_id === input.team_leader_site_id && x.status !== 'deleted' && x.id !== id,
      );
      if (conflict) throw new Error(`Another employee (${conflict.full_name}) is already the team leader of this site`);
    }
    Object.assign(e, {
      full_name: input.full_name,
      nationality: input.nationality || null,
      date_of_birth: input.date_of_birth || null,
      phone: input.phone || null,
      email: input.email || null,
      address: input.address || null,
      emergency_contact: input.emergency_contact || null,
      position: input.position || null,
      join_date: input.join_date || null,
      company_name: input.company_name || null,
      passport_number: input.passport_number || null,
      passport_status: input.passport_status,
      id_number: input.id_number || null,
      id_status: input.id_status,
      current_site_id: input.current_site_id || null,
      photo: input.photo || null,
      is_team_leader: input.is_team_leader,
      team_leader_site_id: input.is_team_leader ? input.team_leader_site_id || null : null,
      updated_at: nowISO(),
    });
    saveAndEmit(['employee']);
    return attachEmployeeVM(e);
  },

  async deleteEmployeeCascade(id: string): Promise<void> {
    const e = db.employees.find((x) => x.id === id);
    if (!e) throw new Error('Employee not found');
    if (e.status === 'pending_deletion') throw new Error('This employee already has a pending deletion request');

    db.attendance.filter((a) => a.employee_id === id).forEach((a) => { a.is_hidden = true; });
    db.warnings.filter((w) => w.employee_id === id).forEach((w) => { w.is_hidden = true; });
    db.fines.filter((f) => f.employee_id === id).forEach((f) => { f.is_hidden = true; });
    db.leaveRequests.filter((r) => r.employee_id === id).forEach((r) => { r.is_hidden = true; });
    db.cancellationRequests.filter((r) => r.employee_id === id).forEach((r) => { r.is_hidden = true; });
    db.uniforms.filter((u) => u.employee_id === id).forEach((u) => { u.is_deleted = true; u.is_hidden = true; });
    const nameLc = e.full_name.toLowerCase();
    const codeLc = e.employee_code.toLowerCase();
    db.notifications.filter((n) =>
      n.title.toLowerCase().includes(nameLc)
      || n.message.toLowerCase().includes(nameLc)
      || n.message.toLowerCase().includes(codeLc),
    ).forEach((n) => { n.is_hidden = true; });

    e.status = 'deleted';
    e.current_site_id = null;
    e.is_team_leader = false;
    e.team_leader_site_id = null;
    saveAndEmit(['employee', 'attendance', 'warning', 'fine', 'leave_request', 'cancellation_request', 'uniform_registry', 'notification']);
  },

  async requestEmployeeDeletion(id: string, reason: string | null): Promise<void> {
    const e = db.employees.find((x) => x.id === id);
    if (!e) throw new Error('Employee not found');
    if (e.status === 'deleted') throw new Error('This employee is already deleted');
    if (e.status === 'pending_deletion') throw new Error('This employee already has a pending deletion request');

    db.cancellationRequests.push({
      id: uid(), employee_id: id, reason, status: 'pending',
      requested_by: currentProfile()?.id ?? null, reviewed_by: null, reviewed_at: null,
      is_hidden: false, created_at: nowISO(),
    });
    e.status = 'pending_deletion';
    notifySuperAdmins(
      'New Cancellation Request',
      `${e.full_name} (${e.employee_code}) is pending deletion approval${reason ? ' — ' + reason : ''}`,
      'request',
    );
    saveAndEmit(['cancellation_request', 'employee', 'notification']);
  },

  // ---- attendance --------------------------------------------------------------
  async getMonthAttendance(month: string): Promise<Attendance[]> {
    const today = toYMD(new Date());
    const [y, m] = month.split('-').map(Number);
    const first = `${month}-01`;
    const monthEnd = toYMD(new Date(y, m, 0));
    const lastDay = today < first ? null : today < monthEnd ? today : monthEnd;

    // auto-create missing records for non-deleted employees
    if (lastDay) {
      for (const e of db.employees) {
        if (e.status === 'deleted') continue;
        for (let d = fromYMD(first); toYMD(d) <= lastDay; d.setDate(d.getDate() + 1)) {
          const dateStr = toYMD(d);
          const exists = db.attendance.some((a) => a.employee_id === e.id && a.date === dateStr);
          if (!exists) {
            db.attendance.push({
              id: uid(), employee_id: e.id, date: dateStr,
              status: e.current_site_id ? 'present' : 'no_site',
              overtime_hours: null, is_hidden: false, created_at: nowISO(),
            });
          }
        }
      }
      saveAndEmit(['attendance']);
    }

    return db.attendance.filter((a) => {
      if (!a.date.startsWith(month) || a.is_hidden) return false;
      const e = db.employees.find((x) => x.id === a.employee_id);
      return e ? e.status !== 'deleted' : false;
    });
  },

  async markAttendance(employeeId: string, date: string, status: AttendanceStatus, overtimeHours: number | null): Promise<void> {
    const e = db.employees.find((x) => x.id === employeeId);
    if (!e) throw new Error('Employee not found');

    const prev = db.attendance.find((a) => a.employee_id === employeeId && a.date === date);
    const otDelta = prev ? (overtimeHours ?? 0) - (prev.overtime_hours ?? 0) : (status === 'overtime' ? overtimeHours ?? 0 : 0);

    if (prev) {
      prev.status = status;
      prev.overtime_hours = status === 'overtime' ? overtimeHours : null;
    } else {
      db.attendance.push({
        id: uid(), employee_id: employeeId, date, status,
        overtime_hours: status === 'overtime' ? overtimeHours : null,
        is_hidden: false, created_at: nowISO(),
      });
    }

    // rating: ±0.2 stars per overtime hour delta
    if (otDelta !== 0) {
      e.rating = clampRating(e.rating + 0.2 * otDelta);
    }

    // auto-warning on 3+ consecutive absences (skipping Fridays)
    if (status === 'absent') {
      const absentDates: string[] = [date];
      let walk = addDaysStr(date, -1);
      const floorDate = addDaysStr(date, -7);
      while (walk >= floorDate) {
        if (isFridayStr(walk)) { walk = addDaysStr(walk, -1); continue; }
        const rec = db.attendance.find((a) => a.employee_id === employeeId && a.date === walk && !a.is_hidden);
        if (rec && rec.status === 'absent') {
          absentDates.unshift(walk);
          walk = addDaysStr(walk, -1);
        } else break;
      }
      if (absentDates.length >= 3) {
        db.warnings.push({
          id: uid(), employee_id: employeeId,
          reason: `Auto-generated: ${absentDates.length} consecutive absences detected (${absentDates.join(', ')})`,
          is_auto_generated: true, absent_dates: absentDates,
          created_by: currentProfile()?.id ?? null, is_hidden: false, created_at: nowISO(),
        });
        e.rating = clampRating(e.rating - 0.5);
        notifySuperAdmins(
          'Auto-Generated Warning',
          `${e.full_name} (${e.employee_code}) was absent 3+ consecutive days`,
          'warning',
        );
        saveAndEmit(['warning', 'notification', 'employee', 'attendance']);
        return;
      }
    }
    saveAndEmit(['attendance', 'employee']);
  },

  async getMonthlyAttendanceSummary(months = 6): Promise<MonthlySummaryRow[]> {
    const rows: MonthlySummaryRow[] = [];
    const now = new Date();
    for (let back = months - 1; back >= 0; back--) {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const counts: Record<string, number> = {};
      for (const a of db.attendance) {
        if (!a.date.startsWith(m) || a.is_hidden || a.status === 'not_marked') continue;
        const e = db.employees.find((x) => x.id === a.employee_id);
        if (!e || e.status === 'deleted') continue;
        counts[a.status] = (counts[a.status] ?? 0) + 1;
      }
      for (const [status, count] of Object.entries(counts)) {
        rows.push({ month: m, status: status as AttendanceStatus, count });
      }
    }
    return rows;
  },

  // ---- leave requests --------------------------------------------------------------
  async listLeaveRequests(): Promise<LeaveRequestVM[]> {
    return db.leaveRequests
      .filter((r) => !r.is_hidden)
      .filter((r) => { const e = db.employees.find((x) => x.id === r.employee_id); return e ? e.status !== 'deleted' : false; })
      .map(attachLeaveVM)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async createLeaveRequest(input: LeaveRequestInput): Promise<void> {
    const e = db.employees.find((x) => x.id === input.employee_id);
    if (!e) throw new Error('Employee not found');
    db.leaveRequests.push({
      id: uid(), ...input, status: 'pending',
      created_by: currentProfile()?.id ?? null, reviewed_by: null, reviewed_at: null,
      is_hidden: false, created_at: nowISO(),
    });
    notifySuperAdmins(
      'New Leave Request',
      `${e.full_name} (${e.employee_code}) requested ${input.other_type_text || input.leave_type} leave for ${input.total_days} day(s)`,
      'request',
    );
    saveAndEmit(['leave_request', 'notification']);
  },

  async reviewLeaveRequest(id: string, approve: boolean): Promise<void> {
    const r = db.leaveRequests.find((x) => x.id === id);
    if (!r) throw new Error('Request not found');
    if (r.status !== 'pending') throw new Error('Only pending requests can be reviewed');
    r.status = approve ? 'approved' : 'rejected';
    r.reviewed_by = currentProfile()?.id ?? null;
    r.reviewed_at = nowISO();
    if (r.created_by) {
      const label = r.other_type_text || r.leave_type;
      db.notifications.push({
        id: uid(), profile_id: r.created_by,
        title: `Leave Request ${approve ? 'Approved' : 'Rejected'}`,
        message: `The leave request (${label}, ${r.total_days} day(s)) has been ${approve ? 'approved' : 'rejected'}.`,
        type: 'request', read: false, is_hidden: false, created_at: nowISO(),
      });
    }
    saveAndEmit(['leave_request', 'notification']);
  },

  // ---- cancellation requests ------------------------------------------------------------
  async listCancellationRequests(): Promise<CancellationRequestVM[]> {
    return db.cancellationRequests
      .filter((r) => !r.is_hidden)
      .filter((r) => { const e = db.employees.find((x) => x.id === r.employee_id); return e ? e.status !== 'deleted' : false; })
      .map(attachCancelVM)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async createCancellationRequest(employeeId: string, reason: string | null): Promise<void> {
    await demoApi.requestEmployeeDeletion(employeeId, reason);
  },

  async reviewCancellationRequest(id: string, approve: boolean): Promise<void> {
    const r = db.cancellationRequests.find((x) => x.id === id);
    if (!r) throw new Error('Request not found');
    if (r.status !== 'pending') throw new Error('Only pending requests can be reviewed');
    r.status = approve ? 'approved' : 'rejected';
    r.reviewed_by = currentProfile()?.id ?? null;
    r.reviewed_at = nowISO();

    const e = db.employees.find((x) => x.id === r.employee_id);
    if (approve && e) {
      e.status = 'deleted';
      e.current_site_id = null;
      e.is_team_leader = false;
      e.team_leader_site_id = null;
      db.uniforms.filter((u) => u.employee_id === e.id).forEach((u) => { u.is_deleted = true; u.is_hidden = true; });
    } else if (!approve && e && e.status === 'pending_deletion') {
      e.status = 'active';
    }

    if (r.requested_by && e) {
      db.notifications.push({
        id: uid(), profile_id: r.requested_by,
        title: `Cancellation Request ${approve ? 'Approved' : 'Rejected'}`,
        message: `The removal request for ${e.full_name} has been ${approve ? 'approved and the employee was removed.' : 'rejected and the employee was restored.'}`,
        type: 'request', read: false, is_hidden: false, created_at: nowISO(),
      });
    }
    saveAndEmit(['cancellation_request', 'employee', 'uniform_registry', 'notification']);
  },

  // ---- warnings + fines ---------------------------------------------------------------
  async listWarnings(): Promise<WarningVM[]> {
    return db.warnings
      .filter((w) => !w.is_hidden)
      .filter((w) => { const e = db.employees.find((x) => x.id === w.employee_id); return e ? e.status !== 'deleted' : false; })
      .map(attachWarningVM)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async issueWarning(employeeId: string, reason: string): Promise<void> {
    const e = db.employees.find((x) => x.id === employeeId);
    if (!e) throw new Error('Employee not found');
    db.warnings.push({
      id: uid(), employee_id: employeeId, reason,
      is_auto_generated: false, absent_dates: null,
      created_by: currentProfile()?.id ?? null, is_hidden: false, created_at: nowISO(),
    });
    e.rating = clampRating(e.rating - 0.5);
    notifySuperAdmins('New Warning Issued', `${e.full_name} (${e.employee_code}) received a warning: ${reason}`, 'warning');
    saveAndEmit(['warning', 'notification', 'employee']);
  },

  async listFines(): Promise<FineVM[]> {
    return db.fines
      .filter((f) => !f.is_hidden)
      .filter((f) => { const e = db.employees.find((x) => x.id === f.employee_id); return e ? e.status !== 'deleted' : false; })
      .map(attachFineVM)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async issueFine(employeeId: string, reason: string, amount: number): Promise<void> {
    const e = db.employees.find((x) => x.id === employeeId);
    if (!e) throw new Error('Employee not found');
    if (amount < 0) throw new Error('Fine amount cannot be negative');
    db.fines.push({
      id: uid(), employee_id: employeeId, reason, amount,
      created_by: currentProfile()?.id ?? null, is_hidden: false, created_at: nowISO(),
    });
    e.rating = clampRating(e.rating - 1.0);
    notifySuperAdmins('New Fine Issued', `${e.full_name} (${e.employee_code}) was fined SAR ${amount}: ${reason}`, 'fine');
    saveAndEmit(['fine', 'notification', 'employee']);
  },

  // ---- notifications ---------------------------------------------------------------------
  async listNotifications(profileId?: string): Promise<Notification[]> {
    const pid = profileId ?? getDemoSessionId() ?? '';
    return db.notifications
      .filter((n) => n.profile_id === pid && !n.is_hidden)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async getUnreadNotificationCount(): Promise<number> {
    const pid = getDemoSessionId() ?? '';
    return db.notifications.filter((n) => n.profile_id === pid && !n.read && !n.is_hidden).length;
  },

  async markNotificationRead(id: string): Promise<void> {
    const n = db.notifications.find((x) => x.id === id);
    if (n) n.read = true;
    saveAndEmit(['notification']);
  },

  async markAllNotificationsRead(): Promise<void> {
    const pid = getDemoSessionId() ?? '';
    db.notifications.filter((n) => n.profile_id === pid && !n.read).forEach((n) => { n.read = true; });
    saveAndEmit(['notification']);
  },

  // ---- uniform registry ---------------------------------------------------------------------
  async listUniformEntries(): Promise<UniformEntry[]> {
    return db.uniforms
      .filter((u) => !u.is_deleted && !u.is_hidden)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async listEmployeeUniforms(employeeId: string): Promise<UniformEntry[]> {
    return db.uniforms
      .filter((u) => u.employee_id === employeeId && !u.is_deleted && !u.is_hidden)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async createUniformEntry(input: UniformEntryInput): Promise<UniformEntry> {
    const e = db.employees.find((x) => x.id === input.employee_id);
    if (!e) throw new Error('Employee not found');

    const uniformId = db.counters.uniform_id + 1;
    let token = db.counters.token_number + 1;
    if (input.token_number && input.token_number > 0) token = input.token_number;
    db.counters.uniform_id = uniformId;
    db.counters.token_number = token;

    const created = new Date(input.created_at);
    if (Number.isNaN(created.getTime())) throw new Error('Invalid created date');
    const entry: UniformEntry = {
      id: uid(), uniform_id: uniformId, token_number: token,
      employee_id: e.id, employee_name: e.full_name,
      document_type: input.document_type, document_number: input.document_number,
      items: input.items, site_name: input.site_name, team_leader_name: input.team_leader_name,
      is_renewal: input.is_renewal, previous_token_id: input.previous_token_id,
      is_deleted: false, is_hidden: false,
      created_at: created.toISOString(),
      renewal_date: new Date(created.getTime() + 182.5 * 86400000).toISOString(),
    };
    db.uniforms.push(entry);
    saveAndEmit(['uniform_registry']);
    return entry;
  },

  async updateUniformEntry(id: string, input: UniformEntryUpdate): Promise<UniformEntry> {
    const u = db.uniforms.find((x) => x.id === id);
    if (!u || u.is_deleted || u.is_hidden) throw new Error('Entry not found');
    const created = new Date(input.created_at);
    if (Number.isNaN(created.getTime())) throw new Error('Invalid created date');
    Object.assign(u, {
      token_number: input.token_number,
      document_type: input.document_type,
      document_number: input.document_number,
      items: input.items,
      site_name: input.site_name,
      team_leader_name: input.team_leader_name,
      created_at: created.toISOString(),
      renewal_date: new Date(created.getTime() + 182.5 * 86400000).toISOString(),
    });
    saveAndEmit(['uniform_registry']);
    return u;
  },

  async deleteUniformEntry(id: string): Promise<void> {
    const u = db.uniforms.find((x) => x.id === id);
    if (!u) return;
    u.is_deleted = true;
    saveAndEmit(['uniform_registry']);
  },

  // ---- realtime ------------------------------------------------------------------------------
  subscribe(onChange: (tables: string[]) => void): () => void {
    return subscribeDemo(onChange);
  },

  // demo-only helpers
  async resetDemoData(): Promise<void> {
    const { resetDemo } = await import('./demo-store');
    resetDemo();
  },
};

export type { VM };
