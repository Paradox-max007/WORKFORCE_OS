// ============================================================================
// PULSE Workforce OS — Demo data API (business logic mirrors supabase/schema.sql)
// ============================================================================

import {
  type AdminSiteAssignment,
  type Attendance,
  type AttendanceShareLink,
  type BulkAttendanceEntry,
  type Camp,
  type CampWithCount,
  type CardType,
  type Company,
  type CancellationRequestVM,
  type Employee,
  type EmployeeInput,
  type EmployeeNote,
  type EmployeeSalaryAssignment,
  type EmployeeVM,
  type EmployeeWorkingHoursReport,
  type ExperienceTier,
  type FineVM,
  type LeaveRequestInput,
  type LeaveRequestVM,
  type MonthlySummaryRow,
  type Notification,
  type PayrollAdjustmentInput,
  type PaymentType,
  type Profile,
  type SalaryEligibility,
  type SalarySheetReport,
  type SalarySheetRowUpdate,
  type SalaryRole,
  type SharedSheetEmployee,
  type SharedSheetPayload,
  type SharedSheetSnapshot,
  type SharedSheetSubmitEntry,
  type SharedSheetSubmitResult,
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
  type MenuPermissionMap,
  type WorkingHoursMonth,
} from '@/lib/types';
import {
  addDaysStr,
  db,
  getDemoSessionId,
  isFridayStr,
  nowISO,
  saveAndEmit,
  setDemoSessionId,
  subscribeDemo,
  toYMD,
  uid,
  daysInMonth,
  type DemoAttendanceShareLink,
} from './demo-store';
import {
  applyAssignment,
  applySalarySheetRow,
  applyTradeRates,
  assignmentHistoryOf,
  buildSalarySheet,
  calcEligibility,
  currentRatesOf,
  localTodayYMD,
  rateHistoryOf,
  refreshPayrollPeriod,
  resetPayrollEmployeeAuto,
  round2,
  tradesWithRates,
} from './demo-salary';
import { defaultPermissionMap } from '@/lib/menus';
import { getEmployeeSiteForDate, indexRecords } from '@/lib/site-timeline';

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
  camp_name: e.camp_id ? db.camps.find((c) => c.id === e.camp_id)?.name ?? null : null,
  trade_name: e.trade_id ? db.trades.find((t) => t.id === e.trade_id)?.name ?? null : null,
  card_type_name: e.card_type_id ? db.cardTypes.find((c) => c.id === e.card_type_id)?.name ?? null : null,
});

const profileName = (id: string | null): string | null =>
  id ? db.profiles.find((p) => p.id === id)?.name ?? null : null;

/** record → sheet cell text ('' | hours | 'A' | free-text marker) */
const recordToCellText = (r: Attendance | undefined): string => {
  if (!r) return '';
  if (r.status === 'absent') return 'A';
  if (r.status === 'present' && r.hours != null) return String(r.hours);
  if (r.note) return r.note;
  return '';
};

/** THE shared marking engine (mirrors the mark_attendance_core SQL
 *  function): parse → upsert → rating → 3-consecutive-absences warning.
 *  NO permission checks inside — permission-gated callers (markAttendance)
 *  and the token-gated shared-sheet submit both reuse the exact same rules. */
function markCore(employeeId: string, date: string, value: string | null, byProfileId: string | null): void {
  const e = db.employees.find((x) => x.id === employeeId);
  if (!e) throw new Error('Employee not found');

  const trimmed = (value ?? '').trim();
  const prev = db.attendance.find((a) => a.employee_id === employeeId && a.date === date);

  // cleared cell → remove the record
  if (trimmed === '') {
    if (prev) {
      db.attendance = db.attendance.filter((a) => a.id !== prev.id);
    }
    return;
  }

  let status: Attendance['status'];
  let hours: number | null = null;
  let note: string | null = null;
  if (trimmed.toLowerCase() === 'a') {
    // ONLY "A" marks a day absent — any other free text never does
    status = 'absent';
  } else {
    const n = Number(trimmed);
    if (trimmed !== '' && !Number.isNaN(n) && Number.isFinite(n)) {
      if (n < 0 || n > 24) throw new Error('Hours must be between 0 and 24');
      status = 'present';
      hours = Math.round(n * 100) / 100;
    } else {
      // free-text marker ("OT", "H", "travel", …) — present, no hours,
      // text kept on the record and displayed in the cell
      if (trimmed.length > 40) throw new Error('Free-text markers are limited to 40 characters — only A counts as absent');
      status = 'present';
      note = trimmed;
    }
  }

  const otDelta = prev
    ? Math.max(0, (hours ?? 0) - 8) - Math.max(0, (prev.hours ?? 0) - 8)
    : Math.max(0, (hours ?? 0) - 8);

  if (prev) {
    prev.status = status;
    prev.hours = hours;
    prev.note = note;
  } else {
    db.attendance.push({
      id: uid(), employee_id: employeeId, date, status, hours, note,
      is_hidden: false, created_at: nowISO(),
    });
  }

  // rating: ±0.2 stars per overtime-hour delta (hours above 8/day)
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
        created_by: byProfileId, is_hidden: false, created_at: nowISO(),
      });
      e.rating = clampRating(e.rating - 0.5);
      notifySuperAdmins(
        'Auto-Generated Warning',
        `${e.full_name} (${e.employee_code}) was absent 3+ consecutive days`,
        'warning',
      );
    }
  }
}

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

/** demo share-link row → the shared AttendanceShareLink VM (name resolved) */
const toShareLinkVM = (l: DemoAttendanceShareLink): AttendanceShareLink => ({
  id: l.id,
  token: l.token,
  site_id: l.site_id,
  site_name: l.site_name,
  month_key: l.month_key,
  created_by: l.created_by,
  created_by_name: profileName(l.created_by),
  created_at: l.created_at,
  status: l.status,
  submitted_at: l.submitted_at,
  submitted_by: l.submitted_by,
  submit_count: l.submit_count,
  edit_granted_at: l.edit_granted_at,
  edit_granted_by: l.edit_granted_by,
});

/** Build the shared-sheet payload for a link (mirrors the
 *  build_shared_sheet_snapshot SQL function): one row per employee who spent
 *  at least one day of the month at the link's site — date-effective via the
 *  shared site-timeline engine — with cell texts + row totals. */
function buildSharedSnapshot(link: DemoAttendanceShareLink): SharedSheetSnapshot & {
  employees: SharedSheetEmployee[];
} {
  const [year, month] = link.month_key.split('-').map(Number);
  const days = daysInMonth(year, month);
  const employees: SharedSheetEmployee[] = [];
  let totalHours = 0;
  let totalAbsents = 0;

  const crew = db.employees
    .filter((e) => e.status !== 'deleted')
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  for (const emp of crew) {
    const markable: string[] = [];
    for (let d = 1; d <= days; d++) {
      const date = `${link.month_key}-${String(d).padStart(2, '0')}`;
      const siteOnDate = getEmployeeSiteForDate(emp.id, date, {
        transfers: db.siteTransfers,
        records: db.attendance,
        currentSiteId: emp.current_site_id,
      });
      if ((siteOnDate ?? null) === (link.site_id ?? null)) markable.push(date);
    }
    if (markable.length === 0) continue;

    const cells: Record<string, string> = {};
    let empHours = 0;
    let empAbsents = 0;
    for (const date of markable) {
      const rec = db.attendance.find((a) => a.employee_id === emp.id && a.date === date && !a.is_hidden);
      cells[date] = recordToCellText(rec);
      if (rec?.status === 'present' && rec.hours != null) empHours += rec.hours;
      if (rec?.status === 'absent') empAbsents += 1;
    }
    empHours = Math.round(empHours * 100) / 100;
    totalHours += empHours;
    totalAbsents += empAbsents;
    employees.push({
      id: emp.id,
      name: emp.full_name,
      code: emp.employee_code,
      trade: emp.trade_id ? db.trades.find((t) => t.id === emp.trade_id)?.name ?? null : emp.position ?? null,
      cells,
      markable,
      total_hours: empHours,
      absents: empAbsents,
    });
  }

  return {
    saved_at: nowISO(),
    site_name: link.site_name,
    month_key: link.month_key,
    year,
    month,
    days,
    employees,
    totals: { hours: Math.round(totalHours * 100) / 100, absents: totalAbsents },
  };
}

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
  const prefix = `PUL-${year}-`;
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

/** Sites the current profile is allowed to mark (super admins → null = every site). */
const mySiteAllowance = (): Set<string> | null => {
  const me = currentProfile();
  if (!me) return new Set();
  if (me.role === 'super_admin') return null;
  return new Set(db.siteAssignments.filter((x) => x.profile_id === me.id).map((x) => x.site_id));
};

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
    // config defaults first (lib/menus.ts) — new sidebar menus automatically
    // visible per their defaultOn flag until a super admin toggles them
    const map = defaultPermissionMap();
    db.menuPermissions
      .filter((x) => x.profile_id === profileId)
      .forEach((x) => { if (x.menu_key in map) map[x.menu_key] = x.allowed; });
    return map;
  },

  async setMenuPermission(profileId: string, menuKey: keyof MenuPermissionMap, allowed: boolean): Promise<void> {
    const existing = db.menuPermissions.find((x) => x.profile_id === profileId && x.menu_key === menuKey);
    if (existing) existing.allowed = allowed;
    else db.menuPermissions.push({ profile_id: profileId, menu_key: menuKey, allowed });
    saveAndEmit(['menu_permission']);
  },

  // ---- admin site assignments (attendance scoping) ---------------------------
  async getSiteAssignments(profileId: string): Promise<string[]> {
    return db.siteAssignments.filter((x) => x.profile_id === profileId).map((x) => x.site_id);
  },

  async setSiteAssignment(profileId: string, siteId: string, allowed: boolean): Promise<void> {
    const me = currentProfile();
    if (!me || me.role !== 'super_admin') throw new Error('Only super admins can assign sites');
    const target = db.profiles.find((p) => p.id === profileId);
    if (!target) throw new Error('Profile not found');
    if (target.role === 'super_admin') throw new Error('Super admins can access every site already');
    if (allowed) {
      if (!db.sites.some((s) => s.id === siteId)) throw new Error('Site not found');
      if (!db.siteAssignments.some((x) => x.profile_id === profileId && x.site_id === siteId)) {
        db.siteAssignments.push({ profile_id: profileId, site_id: siteId });
      }
    } else {
      db.siteAssignments = db.siteAssignments.filter(
        (x) => !(x.profile_id === profileId && x.site_id === siteId),
      );
    }
    saveAndEmit(['admin_site']);
  },

  /** All admin→site assignments with the admin's display name — mirrors the
   *  prod API so "View by Supervisors" can group by assigned admin too. */
  async listAdminSiteAssignments(): Promise<AdminSiteAssignment[]> {
    return db.siteAssignments.map((x) => ({
      profileId: x.profile_id,
      profileName: db.profiles.find((p) => p.id === x.profile_id)?.name ?? 'Unknown admin',
      siteId: x.site_id,
    }));
  },

  // ---- sites -----------------------------------------------------------------
  async listSites(): Promise<SiteWithCount[]> {
    return db.sites.map((s) => ({
      ...s,
      employee_count: db.employees.filter((e) => e.current_site_id === s.id && e.status !== 'deleted').length,
    }));
  },

  async createSite(
    name: string, clientName: string | null, projectName: string | null, supervisor: string | null,
  ): Promise<Site> {
    if (db.sites.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('A site with this name already exists');
    }
    const site: Site = {
      id: uid(), name, client_name: clientName, project_name: projectName,
      supervisor: supervisor?.trim() || null, is_active: true, created_at: nowISO(),
    };
    db.sites.push(site);
    saveAndEmit(['site']);
    return site;
  },

  async updateSite(id: string, input: { name: string; client_name: string | null; project_name: string | null; supervisor: string | null; is_active: boolean }): Promise<{ unassignedCount: number }> {
    if (db.sites.some((s) => s.name.toLowerCase() === input.name.toLowerCase() && s.id !== id)) {
      throw new Error('A site with this name already exists');
    }
    const site = db.sites.find((s) => s.id === id);
    if (!site) throw new Error('Site not found');
    const wasActive = site.is_active;
    Object.assign(site, {
      name: input.name, client_name: input.client_name, project_name: input.project_name,
      supervisor: input.supervisor?.trim() || null, is_active: input.is_active,
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

  // ---- camps (accommodation) ------------------------------------------------
  async listCamps(): Promise<CampWithCount[]> {
    return db.camps.map((c) => ({
      ...c,
      employee_count: db.employees.filter((e) => e.camp_id === c.id && e.status !== 'deleted').length,
    }));
  },

  async createCamp(name: string, location: string | null, capacity: number | null, notes: string | null): Promise<Camp> {
    if (db.camps.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('A camp with this name already exists');
    }
    if (capacity !== null && capacity < 0) throw new Error('Capacity cannot be negative');
    const camp: Camp = {
      id: uid(), name, location, capacity, notes, is_active: true, created_at: nowISO(),
    };
    db.camps.push(camp);
    saveAndEmit(['camp']);
    return camp;
  },

  async updateCamp(id: string, input: { name: string; location: string | null; capacity: number | null; notes: string | null; is_active: boolean }): Promise<Camp> {
    if (db.camps.some((c) => c.name.toLowerCase() === input.name.toLowerCase() && c.id !== id)) {
      throw new Error('A camp with this name already exists');
    }
    if (input.capacity !== null && input.capacity < 0) throw new Error('Capacity cannot be negative');
    const camp = db.camps.find((c) => c.id === id);
    if (!camp) throw new Error('Camp not found');
    Object.assign(camp, {
      name: input.name, location: input.location, capacity: input.capacity,
      notes: input.notes, is_active: input.is_active,
    });
    saveAndEmit(['camp']);
    return camp;
  },

  async deleteCamp(id: string): Promise<void> {
    db.employees.filter((e) => e.camp_id === id).forEach((e) => { e.camp_id = null; });
    db.camps = db.camps.filter((c) => c.id !== id);
    saveAndEmit(['camp', 'employee']);
  },

  async assignEmployeeCamp(
    employeeId: string, campId: string | null,
    block?: string | null, room?: string | null,
  ): Promise<EmployeeVM> {
    const e = db.employees.find((x) => x.id === employeeId);
    if (!e) throw new Error('Employee not found');
    if (campId) {
      const camp = db.camps.find((c) => c.id === campId);
      if (!camp || !camp.is_active) throw new Error('The selected camp does not exist or is inactive');
    }
    e.camp_id = campId;
    e.camp_block = campId ? (block ?? '').trim() || null : null;
    e.camp_room = campId ? (room ?? '').trim() || null : null;
    e.updated_at = nowISO();
    saveAndEmit(['employee', 'camp']);
    return attachEmployeeVM(e);
  },

  // ---- employees ---------------------------------------------------------------
  async listEmployees(): Promise<EmployeeVM[]> {
    return db.employees.filter((e) => e.status !== 'deleted').map(attachEmployeeVM);
  },

  async listSiteTransfers(): Promise<SiteTransfer[]> {
    return [...db.siteTransfers];
  },

  /** Lifetime working-hours report — mirrors the get_employee_working_hours
   *  Postgres RPC: opening balance + Σ visible attendance hours, grouped by
   *  month and site. Every record's site is resolved through the SAME shared
   *  site-timeline engine (getEmployeeSiteForDate) the marking sheet uses, so
   *  mid-month transfers and the "marked before the move" rule attribute
   *  hours exactly like production. */
  async getEmployeeWorkingHours(employeeId: string): Promise<EmployeeWorkingHoursReport> {
    const e = db.employees.find((x) => x.id === employeeId && x.status !== 'deleted');
    if (!e) throw new Error('Employee not found');

    const opening = Math.round((e.opening_hours ?? 0) * 100) / 100;
    // ALL records (hidden included) drive the pre-marked-day transfer rule —
    // emp_site_on_date() in SQL looks at them the same way
    const records = indexRecords(db.attendance);
    const recs = db.attendance.filter(
      (a) => a.employee_id === employeeId && !a.is_hidden && a.hours != null && a.hours > 0,
    );

    // month key → { sites: siteKey → {siteId, siteName, hours, days} }
    const months = new Map<string, {
      year: number; month: number;
      sites: Map<string, { siteId: string | null; siteName: string; hours: number; days: number }>;
    }>();
    for (const a of recs) {
      const [y, m] = a.date.split('-').map(Number);
      const key = `${y}-${String(m).padStart(2, '0')}`;
      let month = months.get(key);
      if (!month) {
        month = { year: y, month: m, sites: new Map() };
        months.set(key, month);
      }
      const siteId = getEmployeeSiteForDate(employeeId, a.date, {
        transfers: db.siteTransfers,
        records,
        currentSiteId: e.current_site_id ?? null,
      });
      const siteKey = siteId ?? '__none__';
      let site = month.sites.get(siteKey);
      if (!site) {
        site = {
          siteId,
          siteName: siteId ? db.sites.find((s) => s.id === siteId)?.name ?? 'No site' : 'No site',
          hours: 0,
          days: 0,
        };
        month.sites.set(siteKey, site);
      }
      site.hours += a.hours as number;
      site.days += 1;
    }

    const round2 = (n: number): number => Math.round(n * 100) / 100;
    const monthly: WorkingHoursMonth[] = [...months.values()]
      .sort((a, b) => (a.year !== b.year ? b.year - a.year : b.month - a.month))
      .map((month) => ({
        year: month.year,
        month: month.month,
        totalHours: round2([...month.sites.values()].reduce((n, s) => n + s.hours, 0)),
        attendanceDays: [...month.sites.values()].reduce((n, s) => n + s.days, 0),
        sites: [...month.sites.values()]
          .sort((a, b) => b.hours - a.hours)
          .map((s) => ({ siteId: s.siteId, siteName: s.siteName, totalHours: round2(s.hours) })),
      }));
    const tracked = round2(monthly.reduce((n, m) => n + m.totalHours, 0));

    return {
      employeeId: e.id,
      fullName: e.full_name,
      employeeCode: e.employee_code,
      position: e.position,
      siteId: e.current_site_id ?? null,
      siteName: e.current_site_id ? db.sites.find((s) => s.id === e.current_site_id)?.name ?? null : null,
      joinDate: e.join_date,
      status: e.status,
      photo: e.photo,
      openingHours: opening,
      trackedHours: tracked,
      lifetimeHours: round2(opening + tracked),
      monthlyBreakdown: monthly,
    };
  },

  async createEmployee(input: EmployeeInput): Promise<EmployeeVM> {
    if (input.current_site_id) {
      const site = db.sites.find((s) => s.id === input.current_site_id);
      if (!site || !site.is_active) throw new Error('The selected site does not exist or is inactive');
    }
    if (input.camp_id) {
      const camp = db.camps.find((c) => c.id === input.camp_id);
      if (!camp || !camp.is_active) throw new Error('The selected camp does not exist or is inactive');
    }
    if (input.is_team_leader && input.team_leader_site_id) {
      const conflict = db.employees.find(
        (e) => e.is_team_leader && e.team_leader_site_id === input.team_leader_site_id && e.status !== 'deleted',
      );
      if (conflict) throw new Error(`Another employee (${conflict.full_name}) is already the team leader of this site`);
    }
    // manual employee ID: use it as-is; blank → auto-generate. IDs are unique.
    const manualCode = (input.employee_code ?? '').trim();
    if (manualCode) {
      const dup = db.employees.find((e) => e.employee_code.toLowerCase() === manualCode.toLowerCase());
      if (dup) throw new Error(`Employee ID "${manualCode}" is already taken by ${dup.full_name} — use another ID or leave it blank to auto-generate.`);
    }
    // historical opening balance (blank → 0, negative rejected — mirrors the RPC)
    if (input.opening_hours != null && (!Number.isFinite(input.opening_hours) || input.opening_hours < 0)) {
      throw new Error('Previous working hours cannot be negative');
    }
    const opening = Math.round((input.opening_hours ?? 0) * 100) / 100;
    const e: Employee = {
      id: uid(),
      full_name: input.full_name,
      employee_code: manualCode || nextEmployeeCode(),
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
      camp_id: input.camp_id || null,
      camp_block: input.camp_id ? (input.camp_block ?? '').trim() || null : null,
      camp_room: input.camp_id ? (input.camp_room ?? '').trim() || null : null,
      rating: 5,
      status: 'active',
      photo: input.photo || null,
      is_team_leader: input.is_team_leader,
      team_leader_site_id: input.is_team_leader ? input.team_leader_site_id || null : null,
      opening_hours: opening,
      trade_id: input.trade_id || null,
      salary_role: input.salary_role ?? 'standard',
      // payment method is set later from the Employee Details page
      payment_type: null,
      card_type_id: null,
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    if (e.trade_id && !db.trades.some((t) => t.id === e.trade_id && t.is_active)) {
      throw new Error('The selected trade does not exist or is inactive');
    }
    db.employees.push(e);
    // first salary assignment runs from the join date (mirrors create_employee RPC)
    if (e.trade_id) {
      db.salaryAssignments.push({
        id: uid(),
        employee_id: e.id,
        trade_id: e.trade_id,
        salary_role: e.salary_role,
        effective_from: e.join_date ?? toYMD(new Date()),
        effective_to: null,
        created_by: currentProfile()?.id ?? null,
        created_at: nowISO(),
      });
    }
    saveAndEmit(['employee', 'employee_salary_assignment']);
    return attachEmployeeVM(e);
  },

  async updateEmployee(id: string, input: EmployeeInput): Promise<EmployeeVM> {
    const e = db.employees.find((x) => x.id === id);
    if (!e) throw new Error('Employee not found');
    if (input.current_site_id) {
      const site = db.sites.find((s) => s.id === input.current_site_id);
      if (!site || !site.is_active) throw new Error('The selected site does not exist or is inactive');
    }
    if (input.camp_id) {
      const camp = db.camps.find((c) => c.id === input.camp_id);
      if (!camp || !camp.is_active) throw new Error('The selected camp does not exist or is inactive');
    }
    if (input.is_team_leader && input.team_leader_site_id) {
      const conflict = db.employees.find(
        (x) => x.is_team_leader && x.team_leader_site_id === input.team_leader_site_id && x.status !== 'deleted' && x.id !== id,
      );
      if (conflict) throw new Error(`Another employee (${conflict.full_name}) is already the team leader of this site`);
    }
    // remember the previous site — a change is logged as a site transfer so the
    // attendance sheet can show the move (bottom of the old crew, faded, new
    // site across the merged moved-days cells)
    const prevSiteId = e.current_site_id ?? null;
    const nextSiteId = input.current_site_id || null;
    const prevTradeId = e.trade_id ?? null;
    const prevRole = e.salary_role ?? 'standard';
    // historical opening balance: blank → keep the stored value; an actual
    // CHANGE is a super-admin-only adjustment (mirrors update_employee RPC)
    if (input.opening_hours != null && (!Number.isFinite(input.opening_hours) || input.opening_hours < 0)) {
      throw new Error('Previous working hours cannot be negative');
    }
    const openingNext = typeof input.opening_hours === 'number'
      ? Math.round(input.opening_hours * 100) / 100
      : e.opening_hours;
    if (openingNext !== (e.opening_hours ?? 0)) {
      const me = currentProfile();
      if (me?.role !== 'super_admin') {
        throw new Error('Only super admins can adjust the historical opening balance');
      }
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
      camp_id: input.camp_id || null,
      camp_block: input.camp_id ? (input.camp_block ?? '').trim() || null : null,
      camp_room: input.camp_id ? (input.camp_room ?? '').trim() || null : null,
      photo: input.photo || null,
      is_team_leader: input.is_team_leader,
      team_leader_site_id: input.is_team_leader ? input.team_leader_site_id || null : null,
      opening_hours: openingNext,
      updated_at: nowISO(),
    });
    // trade / salary-role change → replace the assignment from today (old work
    // keeps the old classification — mirrors update_employee RPC)
    const nextTradeId = input.trade_id || null;
    const nextRole = input.salary_role ?? 'standard';
    if (prevTradeId !== nextTradeId || prevRole !== nextRole) {
      if (nextTradeId && !db.trades.some((t) => t.id === nextTradeId)) {
        throw new Error('The selected trade does not exist');
      }
      applyAssignment(db, id, nextTradeId, nextRole, toYMD(new Date()), currentProfile()?.id ?? null);
      e.trade_id = nextTradeId;
      e.salary_role = nextRole;
    }
    if (prevSiteId !== nextSiteId) {
      db.siteTransfers.push({
        id: uid(),
        employee_id: id,
        from_site_id: prevSiteId,
        to_site_id: nextSiteId,
        effective_date: toYMD(new Date()),
        created_at: nowISO(),
      });
    }
    saveAndEmit(['employee', 'site_transfer', 'employee_salary_assignment']);
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
    // Only REAL records are returned — days with no record simply stay blank
    // in the marking sheet (no more auto-created 8h defaults).

    // Normal admins only see a record when the employee belonged to one of
    // their sites ON THAT RECORD'S DATE (date-effective — mirrors the
    // get_month_attendance RPC; moved employees keep old-site history).
    const allowedSites = mySiteAllowance();
    return db.attendance.filter((a) => {
      if (!a.date.startsWith(month) || a.is_hidden) return false;
      const e = db.employees.find((x) => x.id === a.employee_id);
      if (!e || e.status === 'deleted') return false;
      if (allowedSites === null) return true;
      const siteOnDate = getEmployeeSiteForDate(a.employee_id, a.date, {
        transfers: db.siteTransfers,
        records: db.attendance,
        currentSiteId: e.current_site_id,
      });
      return siteOnDate !== null && allowedSites.has(siteOnDate);
    });
  },

  /** Excel-style marking: value is 'A' (absent — the ONLY text that counts
   *  as absent), a numeric hours string ('8', '10.5'), ANY OTHER FREE TEXT
   *  (stored as a marker, shown in the cell, never absent — present day with
   *  no tracked hours) or '' / null to clear the cell. Mirrors the Postgres
   *  RPC exactly (permission checks here, shared engine in markCore). */
  async markAttendance(employeeId: string, date: string, value: string | null): Promise<void> {
    const e = db.employees.find((x) => x.id === employeeId);
    if (!e) throw new Error('Employee not found');

    // site-scoped marking is DATE-EFFECTIVE (mirrors the mark_attendance RPC):
    // normal admins only mark days the employee belonged to one of their
    // assigned sites on — an employee moved mid-month stays markable at the
    // old site for the days before the move and at the new site afterwards.
    const me = currentProfile();
    if (me && me.role !== 'super_admin') {
      const siteOnDate = getEmployeeSiteForDate(employeeId, date, {
        transfers: db.siteTransfers,
        records: db.attendance,
        currentSiteId: e.current_site_id,
      });
      if (!siteOnDate) {
        throw new Error('This employee has no site on this date — only super admins can mark idle employees');
      }
      const assigned = db.siteAssignments.some(
        (x) => x.profile_id === me.id && x.site_id === siteOnDate,
      );
      if (!assigned) {
        throw new Error('Access denied — you can only mark attendance for your assigned sites');
      }
    }

    markCore(employeeId, date, value, me?.id ?? null);
    saveAndEmit(['attendance', 'employee', 'warning', 'notification']);
  },

  /** Bulk day entry — reuses the single-cell engine (date-effective site
   *  permissions, rating, auto-warnings) so behaviour is identical to marking
   *  cells one by one. */
  async bulkMarkAttendance(entries: BulkAttendanceEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.markAttendance(entry.employee_id, entry.date, entry.value);
    }
  },

  // ---- shareable digital attendance sheets (per-site WhatsApp links) ------
  // Mirrors the 20261108 RPCs: admins generate one-time links for their
  // sites, the site supervisor opens the digital sheet without a login,
  // submits it once, and any responsible admin can re-grant edit access.
  async listAttendanceShareLinks(): Promise<AttendanceShareLink[]> {
    const me = currentProfile();
    if (!me) throw new Error('Not signed in');
    if (me.role !== 'super_admin') {
      const mine = new Set(
        db.siteAssignments.filter((x) => x.profile_id === me.id).map((x) => x.site_id),
      );
      return db.shareLinks
        .filter((l) => l.site_id !== null && mine.has(l.site_id))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(toShareLinkVM);
    }
    return [...db.shareLinks]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(toShareLinkVM);
  },

  async createAttendanceShareLink(siteId: string, monthKey: string): Promise<AttendanceShareLink> {
    const me = currentProfile();
    if (!me) throw new Error('Not signed in');
    const site = db.sites.find((s) => s.id === siteId);
    if (!site || !site.is_active) throw new Error('Site not found');
    if (me.role !== 'super_admin' &&
        !db.siteAssignments.some((x) => x.profile_id === me.id && x.site_id === siteId)) {
      throw new Error('Access denied — you can only share links for your assigned sites');
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
      throw new Error('Invalid month — expected YYYY-MM');
    }
    const link: DemoAttendanceShareLink = {
      id: uid(),
      token: (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`)
        .replace(/-/g, '').slice(0, 20),
      site_id: site.id,
      site_name: site.name,
      month_key: monthKey,
      created_by: me.id,
      created_at: nowISO(),
      status: 'active',
      submitted_at: null,
      submitted_by: null,
      submit_count: 0,
      edit_granted_at: null,
      edit_granted_by: null,
      sheet_data: null,
    };
    db.shareLinks.push(link);
    saveAndEmit(['attendance_share_link']);
    return toShareLinkVM(link);
  },

  async grantAttendanceShareEdit(token: string): Promise<void> {
    const me = currentProfile();
    if (!me) throw new Error('Not signed in');
    const link = db.shareLinks.find((l) => l.token === token);
    if (!link) throw new Error('Link not found');
    if (me.role !== 'super_admin' &&
        !db.siteAssignments.some((x) => x.profile_id === me.id && x.site_id === link.site_id)) {
      throw new Error('Access denied — you can only manage links for your assigned sites');
    }
    link.status = 'active';
    link.edit_granted_at = nowISO();
    link.edit_granted_by = me.id;
    saveAndEmit(['attendance_share_link']);
  },

  /** PUBLIC — the digital sheet behind a link (no login: the token is the
   *  capability). Active link → live crew + current marks; submitted → the
   *  frozen snapshot with its save date/time. */
  async getSharedAttendanceSheet(token: string): Promise<SharedSheetPayload> {
    const link = db.shareLinks.find((l) => l.token === token);
    if (!link) return { exists: false, token, site_name: '', month_key: '', status: 'active', submitted_at: null, submitted_by: null, edit_granted_at: null, created_at: '', today: toYMD(new Date()), employees: [], snapshot: null };

    if (link.status === 'submitted' && link.sheet_data) {
      return {
        exists: true,
        token: link.token,
        site_id: link.site_id,
        site_name: link.site_name,
        month_key: link.month_key,
        status: link.status,
        submitted_at: link.submitted_at,
        submitted_by: link.submitted_by,
        submit_count: link.submit_count,
        edit_granted_at: link.edit_granted_at,
        created_at: link.created_at,
        today: toYMD(new Date()),
        employees: [],
        snapshot: link.sheet_data,
      };
    }

    const snap = buildSharedSnapshot(link);
    return {
      exists: true,
      token: link.token,
      site_id: link.site_id,
      site_name: link.site_name,
      month_key: link.month_key,
      year: snap.year,
      month: snap.month,
      days: snap.days,
      status: link.status,
      submitted_at: link.submitted_at,
      submitted_by: link.submitted_by,
      submit_count: link.submit_count,
      edit_granted_at: link.edit_granted_at,
      created_at: link.created_at,
      today: toYMD(new Date()),
      employees: snap.employees,
      snapshot: null,
    };
  },

  /** PUBLIC — one-time submit: applies every changed cell through the shared
   *  marking engine, freezes the snapshot + save timestamp, locks the link. */
  async submitSharedAttendanceSheet(
    token: string,
    entries: SharedSheetSubmitEntry[],
    submittedBy?: string | null,
  ): Promise<SharedSheetSubmitResult> {
    const link = db.shareLinks.find((l) => l.token === token);
    if (!link) throw new Error('Link not found');
    if (link.status !== 'active') {
      throw new Error('This sheet was already submitted and is locked — ask an admin to grant edit access to the link');
    }

    const [y, m] = link.month_key.split('-').map(Number);
    const first = `${link.month_key}-01`;
    const last = `${link.month_key}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
    const today = toYMD(new Date());

    let applied = 0;
    let skipped = 0;
    for (const entry of entries) {
      const emp = db.employees.find((x) => x.id === entry.employee_id);
      if (!emp || emp.status === 'deleted') { skipped += 1; continue; }
      const date = entry.date;
      if (date < first || date > last || date > today) { skipped += 1; continue; }
      // date-effective: only days this employee belonged to the link's site
      const siteOnDate = getEmployeeSiteForDate(emp.id, date, {
        transfers: db.siteTransfers,
        records: db.attendance,
        currentSiteId: emp.current_site_id,
      });
      if ((siteOnDate ?? null) !== (link.site_id ?? null)) { skipped += 1; continue; }
      try {
        markCore(emp.id, date, entry.value ?? '', link.created_by);
        applied += 1;
      } catch (err) {
        throw new Error(`${emp.full_name} — ${err instanceof Error ? err.message : 'Invalid value'}`);
      }
    }

    const snap = buildSharedSnapshot(link);
    link.status = 'submitted';
    link.submitted_at = nowISO();
    link.submitted_by = submittedBy?.trim() || null;
    link.submit_count += 1;
    link.sheet_data = snap;
    saveAndEmit(['attendance', 'attendance_share_link', 'employee', 'warning', 'notification']);

    return { ok: true, applied, skipped, saved_at: link.submitted_at };
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
        rows.push({ month: m, status: status as Attendance['status'], count });
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

  // ---- companies (manpower companies — own table) ------------------------------
  async listCompanies(): Promise<Company[]> {
    return [...db.companies].sort((a, b) => a.name.localeCompare(b.name));
  },

  async createCompany(name: string): Promise<Company> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Company name is required');
    if (db.companies.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error('A company with this name already exists');
    }
    const company: Company = { id: uid(), name: trimmed, created_at: nowISO() };
    db.companies.push(company);
    saveAndEmit(['company']);
    return company;
  },

  // ---- payroll card types (Lulu Card, C3 Card, … — own table) ---------------
  async listCardTypes(): Promise<CardType[]> {
    return [...db.cardTypes].sort((a, b) => a.name.localeCompare(b.name));
  },

  async createCardType(name: string): Promise<CardType> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Card type name is required');
    if (db.cardTypes.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error('A card type with this name already exists');
    }
    const cardType: CardType = { id: uid(), name: trimmed, created_at: nowISO() };
    db.cardTypes.push(cardType);
    saveAndEmit(['card_type']);
    return cardType;
  },

  /** Set / clear how an employee is paid (Employee Details → Document
   *  Details). 'card' requires an existing card type; 'cash'/null clears it. */
  async setEmployeePaymentMethod(
    employeeId: string,
    paymentType: PaymentType | null,
    cardTypeId: string | null,
  ): Promise<EmployeeVM> {
    const e = db.employees.find((x) => x.id === employeeId);
    if (!e) throw new Error('Employee not found');
    if (paymentType === 'card') {
      if (!cardTypeId) throw new Error('Select the card type first');
      if (!db.cardTypes.some((c) => c.id === cardTypeId)) {
        throw new Error('The selected card type does not exist');
      }
    }
    e.payment_type = paymentType;
    e.card_type_id = paymentType === 'card' ? cardTypeId : null;
    e.updated_at = nowISO();
    saveAndEmit(['employee']);
    return attachEmployeeVM(e);
  },

  // ---- employee sticky notes (Payroll page quick-reference comments) --------
  async listEmployeeNotes(): Promise<EmployeeNote[]> {
    return db.employeeNotes
      .filter((n) => db.employees.some((e) => e.id === n.employee_id && e.status !== 'deleted'))
      .map((n) => ({
        id: n.id,
        employee_id: n.employee_id,
        note: n.note,
        author_name: profileName(n.created_by),
        created_at: n.created_at,
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async addEmployeeNote(employeeId: string, note: string): Promise<EmployeeNote> {
    const e = db.employees.find((x) => x.id === employeeId);
    if (!e) throw new Error('Employee not found');
    const trimmed = note.trim();
    if (!trimmed) throw new Error('Note text is required');
    const row = {
      id: uid(),
      employee_id: employeeId,
      note: trimmed,
      created_by: currentProfile()?.id ?? null,
      created_at: nowISO(),
    };
    db.employeeNotes.push(row);
    saveAndEmit(['employee_note']);
    return {
      id: row.id,
      employee_id: row.employee_id,
      note: row.note,
      author_name: profileName(row.created_by),
      created_at: row.created_at,
    };
  },

  async deleteEmployeeNote(id: string): Promise<void> {
    const before = db.employeeNotes.length;
    db.employeeNotes = db.employeeNotes.filter((n) => n.id !== id);
    if (db.employeeNotes.length === before) throw new Error('Note not found');
    saveAndEmit(['employee_note']);
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

  // ---- trades & salary ---------------------------------------------------------
  async listTrades(): Promise<(Trade & { current_rates: TradeRate[] })[]> {
    return tradesWithRates(db);
  },

  async getTradeRateHistory(tradeId: string): Promise<TradeRate[]> {
    return rateHistoryOf(db, tradeId);
  },

  async createTrade(input: TradeInput): Promise<Trade> {
    const name = input.name.trim();
    if (!name) throw new Error('Trade name is required');
    if (db.trades.some((t) => t.name.trim().toLowerCase() === name.toLowerCase())) {
      throw new Error(`A trade named "${name}" already exists`);
    }
    const me = currentProfile();
    const cells = new Set(
      input.rates
        .filter((r) => Number.isFinite(r.hourly_rate) && r.hourly_rate >= 0)
        .map((r) => `${r.salary_role}:${r.experience_tier}`),
    );
    const activate = input.is_active ?? true;
    if (activate && cells.size < 6) {
      throw new Error('Configure all six rate cells (3 salary roles × 2 experience tiers) before activating the trade');
    }
    const trade: Trade = {
      id: uid(), name, description: input.description?.trim() || null,
      is_active: activate, created_at: nowISO(), updated_at: nowISO(),
    };
    db.trades.push(trade);
    input.rates.forEach((r) => {
      if (!Number.isFinite(r.hourly_rate) || r.hourly_rate < 0) return;
      db.tradeRates.push({
        id: uid(), trade_id: trade.id, salary_role: r.salary_role,
        experience_tier: r.experience_tier, hourly_rate: round2(r.hourly_rate),
        // the FIRST rate set covers all history (mirrors create_trade RPC) —
        // past attendance of assigned employees finds a rate immediately
        effective_from: '1970-01-01', effective_to: null,
        created_by: me?.id ?? null, created_at: nowISO(),
      });
    });
    db.tradeRateAudit.push({
      id: uid(), period_id: null, trade_id: trade.id, action: 'create',
      actor_id: me?.id ?? null, actor_name: me?.name ?? null,
      details: `Trade "${trade.name}" created with ${cells.size} rate cells`,
      created_at: nowISO(),
    });
    saveAndEmit(['trades', 'trade_rate_history']);
    return { ...trade };
  },

  async updateTrade(tradeId: string, input: { name: string; description: string | null; is_active: boolean }): Promise<void> {
    const trade = db.trades.find((t) => t.id === tradeId);
    if (!trade) throw new Error('Trade not found');
    const name = input.name.trim();
    if (!name) throw new Error('Trade name is required');
    if (db.trades.some((t) => t.name.trim().toLowerCase() === name.toLowerCase() && t.id !== tradeId)) {
      throw new Error(`A trade named "${name}" already exists`);
    }
    trade.name = name;
    trade.description = input.description?.trim() || null;
    trade.is_active = input.is_active;
    trade.updated_at = nowISO();
    saveAndEmit(['trades']);
  },

  async saveTradeRates(tradeId: string, rates: TradeRateInput[], effectiveFrom: string): Promise<void> {
    const trade = db.trades.find((t) => t.id === tradeId);
    if (!trade) throw new Error('Trade not found');
    if (rates.length === 0) return;
    const me = currentProfile();
    if (effectiveFrom < localTodayYMD() && me?.role !== 'super_admin') {
      throw new Error('Only super admins can backdate rate changes');
    }
    rates.forEach((r) => {
      if (!Number.isFinite(r.hourly_rate) || r.hourly_rate < 0) {
        throw new Error('Hourly rate must be 0 or more');
      }
    });
    applyTradeRates(db, tradeId, rates, effectiveFrom, me?.id ?? null);
    rates.forEach((r) => {
      db.tradeRateAudit.push({
        id: uid(), period_id: null, trade_id: tradeId, action: 'rate_change',
        actor_id: me?.id ?? null, actor_name: me?.name ?? null,
        details: `${r.salary_role}/${r.experience_tier} = ${round2(r.hourly_rate)} AED/h effective ${effectiveFrom}`,
        created_at: nowISO(),
      });
    });
    saveAndEmit(['trade_rate_history', 'payroll_period', 'payroll_employee']);
  },

  async getEmployeeSalaryEligibility(employeeId: string, asOfDate?: string): Promise<SalaryEligibility> {
    return calcEligibility(db, employeeId, asOfDate);
  },

  async getEmployeeSalaryHistory(employeeId: string): Promise<EmployeeSalaryAssignment[]> {
    return assignmentHistoryOf(db, employeeId);
  },

  async getSalarySheet(year: number, month: number): Promise<SalarySheetReport> {
    // drafts stay live: attendance edits recalculate on every view
    return buildSalarySheet(db, year, month, (y, m) => {
      refreshPayrollPeriod(db, y, m, currentProfile()?.id ?? null, uid);
    });
  },

  async generatePayroll(year: number, month: number): Promise<void> {
    refreshPayrollPeriod(db, year, month, currentProfile()?.id ?? null, uid);
    saveAndEmit(['payroll_period', 'payroll_employee']);
  },

  async updatePayrollAdjustment(payrollEmployeeId: string, input: PayrollAdjustmentInput): Promise<void> {
    const pe = db.payrollEmployees.find((x) => x.id === payrollEmployeeId);
    if (!pe) throw new Error('Payroll employee not found');
    if (pe.payment_status === 'paid') {
      throw new Error('This employee is already marked paid — reopen the payroll to correct it');
    }
    if (!Number.isFinite(input.advance) || input.advance < 0) throw new Error('Advance must be 0 or more');
    if (!Number.isFinite(input.deduction) || input.deduction < 0) throw new Error('Deduction must be 0 or more');
    pe.advance = round2(input.advance);
    pe.deduction = round2(input.deduction);
    pe.notes = input.notes?.trim() || null;
    pe.net_salary = round2(pe.gross_salary - pe.advance - pe.deduction);
    saveAndEmit(['payroll_period', 'payroll_employee']);
  },

  async finalizePayroll(payrollPeriodId: string): Promise<void> {
    const me = currentProfile();
    if (me?.role !== 'super_admin') throw new Error('Access denied');
    const period = db.payrollPeriods.find((p) => p.id === payrollPeriodId);
    if (!period) throw new Error('Payroll period not found');
    if (period.status === 'finalized') throw new Error('Payroll is already finalized');
    period.status = 'finalized';
    period.finalized_by = me.id;
    period.finalized_at = nowISO();
    db.payrollAudit.push({
      id: uid(), period_id: period.id, trade_id: null, action: 'finalize',
      actor_id: me.id, actor_name: me.name,
      details: `Payroll ${period.year}/${period.month} finalized — calculation locked`,
      created_at: nowISO(),
    });
    saveAndEmit(['payroll_period', 'payroll_employee']);
  },

  async reopenPayroll(payrollPeriodId: string, reason: string): Promise<void> {
    const me = currentProfile();
    if (me?.role !== 'super_admin') throw new Error('Access denied');
    if (!reason.trim()) throw new Error('A reason is required to reopen a payroll period');
    const period = db.payrollPeriods.find((p) => p.id === payrollPeriodId);
    if (!period) throw new Error('Payroll period not found');
    if (period.status !== 'finalized') throw new Error('Payroll is not finalized');

    const pes = db.payrollEmployees.filter((pe) => pe.payroll_period_id === period.id);
    const totals = `employees=${pes.length}, gross=${round2(pes.reduce((n, p) => n + p.gross_salary, 0))}` +
      `, advances=${round2(pes.reduce((n, p) => n + p.advance, 0))}` +
      `, deductions=${round2(pes.reduce((n, p) => n + p.deduction, 0))}` +
      `, net=${round2(pes.reduce((n, p) => n + p.net_salary, 0))}` +
      `, paid=${pes.filter((p) => p.payment_status === 'paid').length}`;

    period.status = 'draft';
    period.finalized_by = null;
    period.finalized_at = null;
    db.payrollAudit.push({
      id: uid(), period_id: period.id, trade_id: null, action: 'reopen',
      actor_id: me.id, actor_name: me.name,
      details: `Reopened: ${reason.trim()} — previous snapshot: ${totals}`,
      created_at: nowISO(),
    });
    saveAndEmit(['payroll_period', 'payroll_employee']);
  },

  /** Salary Sheet edit-mode save — the sheet record has priority (mirrors
   *  update_salary_sheet_row RPC). */
  async updateSalarySheetRow(input: SalarySheetRowUpdate): Promise<void> {
    const me = currentProfile();
    applySalarySheetRow(db, input, me?.id ?? null, me?.name ?? null, uid);
    saveAndEmit(['payroll_period', 'payroll_employee', 'employee', 'employee_salary_assignment', 'trades']);
  },

  /** Return a hand-edited settlement to automatic calculation (draft only). */
  async resetPayrollEmployeeAuto(payrollEmployeeId: string): Promise<void> {
    const me = currentProfile();
    resetPayrollEmployeeAuto(db, payrollEmployeeId, me?.id ?? null, me?.name ?? null, uid);
    saveAndEmit(['payroll_period', 'payroll_employee']);
  },

  async markPayrollPaid(
    payrollEmployeeId: string,
    input: PayrollAdjustmentInput & { paid?: boolean },
  ): Promise<void> {
    const me = currentProfile();
    const pe = db.payrollEmployees.find((x) => x.id === payrollEmployeeId);
    if (!pe) throw new Error('Payroll employee not found');
    if (pe.payment_status === 'paid') throw new Error('Already marked paid');
    const period = db.payrollPeriods.find((p) => p.id === pe.payroll_period_id);
    if (!period) throw new Error('Payroll period not found');
    // the ONLY requirement: the employee actually has a salary this month
    // (marking paid no longer requires a finalized period)
    if (!(pe.gross_salary > 0)) {
      throw new Error('No salary calculated for this employee this month');
    }
    // optional last-second adjustment values from the payment dialog
    if (input.advance != null || input.deduction != null || input.notes != null) {
      await this.updatePayrollAdjustment(payrollEmployeeId, {
        advance: input.advance ?? pe.advance,
        deduction: input.deduction ?? pe.deduction,
        notes: input.notes ?? pe.notes,
      });
    }
    pe.payment_status = 'paid';
    pe.paid_at = nowISO();
    pe.paid_by = me?.id ?? null;
    const paidEmp = db.employees.find((x) => x.id === pe.employee_id);
    db.payrollAudit.push({
      id: uid(), period_id: period.id, trade_id: null, action: 'payment',
      actor_id: me?.id ?? null, actor_name: me?.name ?? null,
      details: `${paidEmp ? `${paidEmp.full_name} (${paidEmp.employee_code})` : 'Unknown employee'} marked paid`,
      created_at: nowISO(),
    });
    saveAndEmit(['payroll_period', 'payroll_employee']);
  },

  /** Revert a payment — super admin only, reason mandatory, audited
   *  (mirrors unmark_employee_salary_paid RPC). */
  async unmarkPayrollPaid(payrollEmployeeId: string, reason: string): Promise<void> {
    const me = currentProfile();
    if (me?.role !== 'super_admin') {
      throw new Error('Only a super admin can revert a paid salary');
    }
    if (!reason.trim()) throw new Error('A reason is required to revert a paid salary');
    const pe = db.payrollEmployees.find((x) => x.id === payrollEmployeeId);
    if (!pe) throw new Error('Payroll employee not found');
    if (pe.payment_status !== 'paid') throw new Error('This salary is not marked paid');
    const period = db.payrollPeriods.find((p) => p.id === pe.payroll_period_id);
    pe.payment_status = 'unpaid';
    pe.paid_at = null;
    pe.paid_by = null;
    const unpaidEmp = db.employees.find((x) => x.id === pe.employee_id);
    db.payrollAudit.push({
      id: uid(), period_id: period?.id ?? null, trade_id: null, action: 'unpayment',
      actor_id: me.id, actor_name: me.name,
      details: `${unpaidEmp ? `${unpaidEmp.full_name} (${unpaidEmp.employee_code})` : 'Unknown employee'} reverted to unpaid — reason: ${reason.trim()}`,
      created_at: nowISO(),
    });
    saveAndEmit(['payroll_period', 'payroll_employee']);
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
