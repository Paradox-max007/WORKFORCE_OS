// ============================================================================
// PULSE Workforce OS — Demo mode in-memory database store
// ----------------------------------------------------------------------------
// When no Supabase credentials are configured the app runs in demo mode:
// a fully functional in-memory database persisted to localStorage and synced
// across browser tabs (BroadcastChannel) — including "realtime" events.
// In production (Supabase env vars set) none of this code path is used.
// ============================================================================

import {
  type Attendance,
  type Branch,
  type CancellationRequest,
  type Camp,
  type CardType,
  type Company,
  type DeductionSettings,
  type Employee,
  type ExperienceTier,
  type Fine,
  type LeaveRequest,
  type MenuKey,
  type Notification,
  type Profile,
  type SalaryRole,
  type SharedSheetSnapshot,
  type Site,
  type SiteTransfer,
  type Trade,
  type UniformEntry,
  type Warning,
} from '@/lib/types';
import { ABSENT_DEDUCTION_FREE_DAYS, ABSENT_DEDUCTION_RATE } from '@/lib/types';

export interface DemoProfile extends Profile {
  password: string;
}

// ---- trade & salary demo rows (mirror the Postgres tables) --------------------

export interface DemoTradeRate {
  id: string;
  trade_id: string;
  salary_role: SalaryRole;
  experience_tier: ExperienceTier;
  hourly_rate: number;
  effective_from: string; // YYYY-MM-DD
  effective_to: string | null;
  created_by: string | null;
  created_at: string;
}

export interface DemoSalaryAssignment {
  id: string;
  employee_id: string;
  trade_id: string;
  salary_role: SalaryRole;
  effective_from: string;
  effective_to: string | null;
  created_by: string | null;
  created_at: string;
}

export interface DemoPayrollPeriod {
  id: string;
  year: number;
  month: number;
  status: 'draft' | 'finalized';
  created_by: string | null;
  finalized_by: string | null;
  finalized_at: string | null;
  created_at: string;
}

export interface DemoPayrollEmployee {
  id: string;
  payroll_period_id: string;
  employee_id: string;
  opening_lifetime_hours: number;
  closing_lifetime_hours: number;
  total_hours: number;
  unrated_hours: number;
  unassigned_hours: number;
  gross_salary: number;
  advance: number;
  deduction: number;
  /** automatic absent deduction (absences beyond the configured free days
   *  × the configured amount — db.deductionSettings); when EDITED on the
   *  Payroll page this holds the ACTUAL amount and the flag below is true */
  absent_deduction: number;
  /** true → absent_deduction was hand-edited on the Payroll page — the
   *  stored amount has priority and survives every recalculation */
  absent_deduction_edited: boolean;
  net_salary: number;
  payment_status: 'unpaid' | 'paid';
  paid_at: string | null;
  paid_by: string | null;
  notes: string | null;
  trade_id_snapshot: string | null;
  salary_role_snapshot: SalaryRole;
  /** true → hand-edited in the Salary Sheet; recalculation never touches it */
  manually_edited: boolean;
}

export interface DemoPayrollSite {
  id: string;
  payroll_employee_id: string;
  site_id: string | null;
  site_name_snapshot: string;
  total_hours: number;
  below_threshold_hours: number;
  qualified_hours: number;
  standard_hours: number;
  team_leader_hours: number;
  supervisor_hours: number;
  gross_salary: number;
  has_missing_rate: boolean;
  manually_edited: boolean;
}

export interface DemoPayrollLine {
  id: string;
  payroll_employee_id: string;
  site_id: string | null;
  site_name_snapshot: string;
  attendance_date: string;
  trade_id: string | null;
  trade_name_snapshot: string;
  salary_role_snapshot: SalaryRole;
  experience_tier: ExperienceTier;
  hours: number;
  hourly_rate: number;
  gross_amount: number;
}

export interface DemoAuditEntry {
  id: string;
  period_id: string | null;
  trade_id: string | null;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  details: string | null;
  created_at: string;
}

export interface DemoDB {
  version: number;
  profiles: DemoProfile[];
  sites: Site[];
  camps: Camp[];
  employees: Employee[];
  attendance: Attendance[];
  notifications: Notification[];
  warnings: Warning[];
  fines: Fine[];
  leaveRequests: LeaveRequest[];
  cancellationRequests: CancellationRequest[];
  uniforms: UniformEntry[];
  menuPermissions: { profile_id: string; menu_key: MenuKey; allowed: boolean }[];
  siteAssignments: { profile_id: string; site_id: string }[];
  /** branches (regional site groups) + which branches each admin may access */
  branches: Branch[];
  branchAssignments: { profile_id: string; branch_id: string }[];
  siteTransfers: SiteTransfer[];
  counters: { uniform_id: number; token_number: number };
  // trade & salary system
  trades: Trade[];
  tradeRates: DemoTradeRate[];
  salaryAssignments: DemoSalaryAssignment[];
  payrollPeriods: DemoPayrollPeriod[];
  payrollEmployees: DemoPayrollEmployee[];
  payrollSites: DemoPayrollSite[];
  payrollLines: DemoPayrollLine[];
  payrollAudit: DemoAuditEntry[];
  tradeRateAudit: DemoAuditEntry[];
  // manpower companies (own table — the Add Employee company dropdown)
  companies: Company[];
  // payroll card types (own table — Lulu Card, C3 Card, …)
  cardTypes: CardType[];
  // employee sticky notes (Payroll page — quick reference comments)
  employeeNotes: DemoEmployeeNote[];
  // one-time shareable digital attendance sheets (per-site links)
  shareLinks: DemoAttendanceShareLink[];
  // effective absent-deduction rule (Trade Management → Deductions tab —
  // mirrors the deduction_settings Postgres singleton, see 20261111c)
  deductionSettings: DeductionSettings;
}

/** Raw employee-note row (author name resolved at read time from profiles) */
export interface DemoEmployeeNote {
  id: string;
  employee_id: string;
  note: string;
  created_by: string | null;
  created_at: string;
}

/** One-time shareable digital attendance sheet (mirrors the
 *  attendance_share_link Postgres table — see the 20261108 migration). */
export interface DemoAttendanceShareLink {
  id: string;
  token: string;
  site_id: string | null;
  site_name: string;
  month_key: string; // YYYY-MM
  created_by: string | null;
  created_at: string;
  status: 'active' | 'submitted';
  submitted_at: string | null;
  submitted_by: string | null;
  submit_count: number;
  edit_granted_at: string | null;
  edit_granted_by: string | null;
  sheet_data: SharedSheetSnapshot | null;
}

// ---------------------------------------------------------------------------
// Date helpers (local-time, YYYY-MM-DD strings)
// ---------------------------------------------------------------------------

export const uid = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export const toYMD = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const fromYMD = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const addDaysStr = (s: string, n: number): string => {
  const d = fromYMD(s);
  d.setDate(d.getDate() + n);
  return toYMD(d);
};

export const isFridayStr = (s: string): boolean => fromYMD(s).getDay() === 5;

export const daysInMonth = (year: number, month1: number): number => new Date(year, month1, 0).getDate();

export const nowISO = (): string => new Date().toISOString();

// Deterministic pseudo-random for stable seeding
const seededRand = (a: number, b: number): number => {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

function seedDB(): DemoDB {
  const db: DemoDB = {
    version: 15,
    profiles: [],
    sites: [],
    camps: [],
    employees: [],
    attendance: [],
    notifications: [],
    warnings: [],
    fines: [],
    leaveRequests: [],
    cancellationRequests: [],
    uniforms: [],
    menuPermissions: [],
    siteAssignments: [],
    branches: [],
    branchAssignments: [],
    siteTransfers: [],
    counters: { uniform_id: 0, token_number: 0 },
    trades: [],
    tradeRates: [],
    salaryAssignments: [],
    payrollPeriods: [],
    payrollEmployees: [],
    payrollSites: [],
    payrollLines: [],
    payrollAudit: [],
    tradeRateAudit: [],
    companies: [],
    cardTypes: [],
    employeeNotes: [],
    shareLinks: [],
    deductionSettings: {
      absent_free_days: ABSENT_DEDUCTION_FREE_DAYS,
      absent_deduction_amount: ABSENT_DEDUCTION_RATE,
      updated_at: null,
      updated_by_name: null,
    },
  };

  // ---- profiles -----------------------------------------------------------
  db.profiles = [
    { id: uid(), email: 'super@pulse.app', name: 'Amira Sultan', password: 'demo1234', role: 'super_admin', theme: 'dark', accent: 'violet', created_at: nowISO() },
    { id: uid(), email: 'admin@pulse.app', name: 'Ravi Kumar', password: 'demo1234', role: 'admin', theme: 'dark', accent: 'emerald', created_at: nowISO() },
    { id: uid(), email: 'sara@pulse.app', name: 'Sara Menon', password: 'demo1234', role: 'admin', theme: 'light', accent: 'amber', created_at: nowISO() },
  ];
  const [superP, raviP] = db.profiles;
  const saraP = db.profiles[2];
  db.menuPermissions = [
    { profile_id: raviP.id, menu_key: 'employees' as MenuKey, allowed: true },
    { profile_id: raviP.id, menu_key: 'attendance' as MenuKey, allowed: true },
    // Working Hours used to piggyback on the Employees grant — keep that
    // access in the demo seed now that it is its own toggleable menu.
    { profile_id: raviP.id, menu_key: 'working_hours' as MenuKey, allowed: true },
    // Branches + Sites so the demo shows branch-scoped site access for a
    // normal admin (Ravi → Northern Emirates Branch only)
    { profile_id: raviP.id, menu_key: 'branches' as MenuKey, allowed: true },
    { profile_id: raviP.id, menu_key: 'sites' as MenuKey, allowed: true },
  ];

  // ---- branches (regional site groups) --------------------------------------
  const mkBranch = (name: string, location: string, notes: string | null = null, active = true): Branch =>
    ({ id: uid(), name, location, notes, is_active: active, created_at: nowISO() });
  const northEmirates = mkBranch('Northern Emirates Branch', 'Umm Al Quwain · Ras Al Khaimah · Fujairah', 'Covers the northern emirates projects');
  const dubaiCentral = mkBranch('Dubai Central Branch', 'Dubai · Jebel Ali', null);
  const sharjahBranch = mkBranch('Sharjah Branch', 'Sharjah Industrial Area', null, false);
  db.branches = [northEmirates, dubaiCentral, sharjahBranch];

  // ---- sites ---------------------------------------------------------------
  const mkSite = (
    name: string, client: string, project: string, supervisor: string | null = null,
    active = true, branchId: string | null = null,
  ): Site =>
    ({
      id: uid(), name, client_name: client, project_name: project, supervisor,
      branch_id: branchId, is_active: active, created_at: nowISO(),
    });
  const npc = mkSite('NPC – Umm Al Quwain', 'NPC', 'Warehouse Expansion', 'Ibrahim Khalil', true, northEmirates.id);
  const redCoast = mkSite('Red Coast Compound', 'Red Coast Dev.', 'Villa Cluster B', 'Deepak Nair', true, dubaiCentral.id);
  const marina = mkSite('Marina Heights Tower', 'Marina Holdings', 'Facade Works', 'Carlos Reyes', true, dubaiCentral.id);
  const depot = mkSite('Old Depot Project', 'NPC', 'Depot Refit', 'Deepak Nair', false, northEmirates.id);
  const oasis = mkSite('Oasis Mall Fitout', 'Oasis Group', 'Interior Fitout', null, true, null);
  db.sites = [npc, redCoast, marina, depot, oasis];

  // manpower companies (own table — feeds the Add Employee company dropdown)
  db.companies = [
    { id: uid(), name: 'Arabian Shield Manpower', created_at: nowISO() },
    { id: uid(), name: 'Gulf Contracting LLC', created_at: nowISO() },
    { id: uid(), name: 'Emirates Facilities Services', created_at: nowISO() },
  ];

  // payroll card types (own table — feeds the Document Details card type
  // dropdown + the Payroll / Employees payment-method filters)
  const luluCard: CardType = { id: uid(), name: 'Lulu Card', created_at: nowISO() };
  const c3Card: CardType = { id: uid(), name: 'C3 Card', created_at: nowISO() };
  db.cardTypes = [luluCard, c3Card];

  // site assignments — the two normal admins can only mark their assigned sites
  db.siteAssignments = [
    { profile_id: raviP.id, site_id: npc.id },
    { profile_id: raviP.id, site_id: redCoast.id },
    { profile_id: saraP.id, site_id: marina.id },
  ];

  // branch access — Ravi manages the Northern Emirates branch only; Sara
  // manages Dubai Central (super admins always see every branch)
  db.branchAssignments = [
    { profile_id: raviP.id, branch_id: northEmirates.id },
    { profile_id: saraP.id, branch_id: dubaiCentral.id },
  ];

  // ---- camps (accommodation) ----------------------------------------------
  const mkCamp = (name: string, location: string, capacity: number, notes: string | null = null, active = true): Camp =>
    ({ id: uid(), name, location, capacity, notes, is_active: active, created_at: nowISO() });
  const alNahda = mkCamp('Al Nahda Camp', 'Al Nahda 2, Dubai', 60);
  const sonapur = mkCamp('Sonapur Labour Camp', 'Sonapur, Umm Al Quwain', 120, 'Central kitchen + clinic on site');
  const muweilah = mkCamp('Muweilah Workers Village', 'Muweilah, Sharjah', 45);
  const closed = mkCamp('Old Jebel Ali Camp', 'Jebel Ali, Dubai', 30, 'Closed for renovation', false);
  db.camps = [alNahda, sonapur, muweilah, closed];

  // ---- trades & salary rates ----------------------------------------------
  // One trade per demo position. Rates are effective-dated from 2026-01-01 so
  // the whole seeded attendance history is rated; the 3×2 grid per trade is
  // salary role (standard / team_leader / supervisor) × experience tier
  // (below_threshold / qualified).
  const TRADE_BASE: Record<string, [number, number]> = {
    // position → [below-threshold standard rate, qualified standard rate]
    Electrician: [8, 10],
    Plumber: [7.5, 9.5],
    'AC Technician': [8, 10],
    Welder: [9, 11],
    Foreman: [10, 12],
    Mason: [7, 9],
    Painter: [6.5, 8],
    'Site Supervisor': [11, 13],
    Carpenter: [7.5, 9.5],
    'Steel Fixer': [8, 10],
    'Security Guard': [5, 6.5],
    Helper: [5, 6.5],
    Cleaner: [4.5, 6],
    'General Helper': [5, 6.5],
    'Store Keeper': [6, 8],
  };
  const mkTrade = (name: string, description: string): Trade => ({
    id: uid(), name, description, is_active: true,
    created_at: nowISO(), updated_at: nowISO(),
  });
  const ROLES: SalaryRole[] = ['standard', 'team_leader', 'supervisor'];
  const TIERS: ExperienceTier[] = ['below_threshold', 'qualified'];
  Object.entries(TRADE_BASE).forEach(([name, [below, qualified]]) => {
    const t = mkTrade(name, `${name} trade`);
    db.trades.push(t);
    ROLES.forEach((role, ri) => {
      TIERS.forEach((tier) => {
        const base = tier === 'below_threshold' ? below : qualified;
        db.tradeRates.push({
          id: uid(), trade_id: t.id, salary_role: role, experience_tier: tier,
          hourly_rate: Math.round((base + ri) * 100) / 100,
          effective_from: '2026-01-01', effective_to: null,
          created_by: superP.id, created_at: nowISO(),
        });
      });
    });
  });

  // ---- employees -------------------------------------------------------------
  const year = new Date().getFullYear();
  // Home-country addresses as per passport / official documents
  const HOME_ADDRESS: Record<string, string> = {
    India: 'House 14, Gandhi Nagar, Kochi, Kerala, India',
    Pakistan: 'St. 7, Block C, Gulshan-e-Iqbal, Karachi, Pakistan',
    Bangladesh: 'Village Badda, Post Badda, Dhaka, Bangladesh',
    Nepal: 'Ward 5, Mahendranagar, Kanchanpur, Nepal',
    Philippines: 'Blk 12 Lot 4, Quezon City, Metro Manila, Philippines',
    Egypt: '12 El-Tahrir St., Nasr City, Cairo, Egypt',
    'Sri Lanka': 'No. 24, Kandy Road, Katugastota, Sri Lanka',
    Kenya: 'Plot 89, Eastleigh, Nairobi, Kenya',
    Sudan: 'House 22, Al-Amaraat, Khartoum, Sudan',
  };
  const mkEmp = (
    n: number, fullName: string, nationality: string, position: string,
    site: Site | null, leaderSite: Site | null, extra: Partial<Employee> = {},
  ): Employee => ({
    id: uid(),
    full_name: fullName,
    employee_code: `PUL-${year}-${String(n).padStart(3, '0')}`,
    nationality,
    date_of_birth: `199${(n % 9) + 1}-0${(n % 8) + 1}-1${n % 9}`,
    phone: `+966 5${n}${n} ${n}0 ${n}0${n}`,
    email: null,
    address: HOME_ADDRESS[nationality] ?? 'Home address as per passport',
    emergency_contact: `+966 5${(n % 5) + 5}1 23${n} 45${n % 7}`,
    position,
    join_date: `${year - 1}-0${(n % 9) + 1}-15`,
    company_name: 'Arabian Shield Manpower',
    passport_number: `P${n}54321${n}`,
    passport_status: n === 3 ? 'Expired' : 'Valid',
    id_number: `UAE-IQ-${year}${String(n).padStart(4, '0')}`,
    id_status: n === 7 ? 'Expired' : 'Valid',
    current_site_id: site?.id ?? null,
    camp_id: null,
    camp_block: null,
    camp_room: null,
    rating: [5, 4.8, 4.5, 4.2, 5, 4.7, 4.1, 3.5, 4.9, 4.6, 4.4, 4.8, 4.5, 4.7, 4.2][n - 1] ?? 4.5,
    status: 'active',
    photo: null,
    payment_type: null,
    card_type_id: null,
    is_team_leader: leaderSite !== null,
    team_leader_site_id: leaderSite?.id ?? null,
    // historical hours from before PULSE tracking (Working Hours module)
    opening_hours: 0,
    trade_id: null,
    salary_role: 'standard',
    created_at: nowISO(),
    updated_at: nowISO(),
    ...extra,
  });

  db.employees = [
    mkEmp(1, 'Rajesh Kumar', 'India', 'Electrician', npc, npc, { opening_hours: 2400 }),
    mkEmp(2, 'Muhammad Iqbal', 'Pakistan', 'Plumber', npc, null, { opening_hours: 1860.5 }),
    mkEmp(3, 'Arun Nair', 'India', 'AC Technician', npc, null, { opening_hours: 920 }),
    mkEmp(4, 'Kamal Hussain', 'Bangladesh', 'Welder', npc, null),
    mkEmp(5, 'Suresh Patel', 'India', 'Foreman', redCoast, redCoast, { opening_hours: 3120 }),
    mkEmp(6, 'Dilip Shrestha', 'Nepal', 'Mason', redCoast, null),
    mkEmp(7, 'Joseph Santos', 'Philippines', 'Painter', redCoast, null),
    mkEmp(8, 'Ahmed Hassan', 'Egypt', 'Site Supervisor', redCoast, null, { opening_hours: 450 }),
    mkEmp(9, 'Rahim Uddin', 'Bangladesh', 'Carpenter', marina, marina),
    mkEmp(10, 'Sandeep Singh', 'India', 'Steel Fixer', marina, null),
    mkEmp(11, 'John Mwangi', 'Kenya', 'Security Guard', marina, null),
    mkEmp(12, 'Tharindu Perera', 'Sri Lanka', 'Helper', marina, null),
    mkEmp(13, 'Ibrahim Toure', 'Sudan', 'Cleaner', null, null),
    mkEmp(14, 'Ramesh Yadav', 'India', 'General Helper', null, null),
    mkEmp(15, 'Omar Farooq', 'Pakistan', 'Store Keeper', marina, null, { status: 'pending_deletion' as Employee['status'] }),
  ];
  // assign camps (one employee → exactly one camp; two workers left unassigned)
  // with a block & room number where they stay
  const inCamp = (camp: Camp, names: string[], block: string, rooms: string[]): void => {
    names.forEach((nm, i) => {
      const e = db.employees.find((x) => x.full_name === nm);
      if (e) {
        e.camp_id = camp.id;
        e.camp_block = block;
        e.camp_room = rooms[i % rooms.length];
      }
    });
  };

  // map every employee to their trade + salary role and record the FIRST
  // salary assignment from the join date (mirrors create_employee RPC)
  db.employees.forEach((e) => {
    const trade = db.trades.find((t) => t.name === e.position);
    if (!trade) return;
    e.trade_id = trade.id;
    e.salary_role = e.position === 'Site Supervisor'
      ? 'supervisor'
      : e.is_team_leader ? 'team_leader' : 'standard';
    db.salaryAssignments.push({
      id: uid(),
      employee_id: e.id,
      trade_id: trade.id,
      salary_role: e.salary_role,
      effective_from: e.join_date ?? toYMD(new Date()),
      effective_to: null,
      created_by: superP.id,
      created_at: nowISO(),
    });
  });
  inCamp(sonapur, ['Muhammad Iqbal', 'Kamal Hussain', 'Rahim Uddin', 'Sandeep Singh', 'Tharindu Perera', 'Ibrahim Toure'], 'B', ['204', '205', '206', '207', '208', '209']);
  inCamp(alNahda, ['Arun Nair', 'Joseph Santos', 'Ahmed Hassan', 'John Mwangi'], 'A', ['101', '102', '103', '104']);
  inCamp(muweilah, ['Suresh Patel', 'Dilip Shrestha', 'Ramesh Yadav', 'Omar Farooq'], 'C', ['12', '14', '16', '18']);
  const emp = (name: string): Employee => db.employees.find((e) => e.full_name === name)!;

  // ---- payment methods (cash / card mix for the Payroll column & filter) ---
  const setPay = (name: string, type: 'cash' | 'card', card: CardType | null = null): void => {
    const e = emp(name);
    if (e) { e.payment_type = type; e.card_type_id = type === 'card' ? card?.id ?? null : null; }
  };
  setPay('Rajesh Kumar', 'card', luluCard);
  setPay('Muhammad Iqbal', 'card', c3Card);
  setPay('Arun Nair', 'cash');
  setPay('Kamal Hussain', 'card', luluCard);
  setPay('Suresh Patel', 'cash');
  setPay('Dilip Shrestha', 'card', c3Card);
  setPay('Joseph Santos', 'cash');
  setPay('Ahmed Hassan', 'card', luluCard);
  setPay('Rahim Uddin', 'cash');
  setPay('Sandeep Singh', 'card', luluCard);
  setPay('John Mwangi', 'cash');
  // Tharindu Perera + Ramesh Yadav stay unset (Not set filter demo)
  setPay('Ibrahim Toure', 'cash');
  setPay('Omar Farooq', 'card', c3Card);

  // ---- employee sticky notes (Payroll page quick-reference demo) ----------
  const mkNote = (name: string, note: string, hoursAgo: number): DemoEmployeeNote => ({
    id: uid(),
    employee_id: emp(name).id,
    note,
    created_by: superP.id,
    created_at: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
  });
  db.employeeNotes = [
    mkNote('Rajesh Kumar', 'Prefers his salary advance on the 20th — coordinate with the site supervisor first.', 30),
    mkNote('Rajesh Kumar', 'Lulu Card renewed until Dec 2026.', 6),
    mkNote('Muhammad Iqbal', 'Send salary screenshots to his brother on WhatsApp after every payout.', 54),
    mkNote('Sandeep Singh', 'Strong candidate for team leader once a slot opens at Marina Heights.', 100),
  ];

  // ---- site transfer (historical attribution demo) ---------------------------
  // Kamal Hussain (Welder) moved NPC Tower → Marina Bay 12 days ago: his
  // Salary Sheet shows him at BOTH sites — hours before the move at NPC Tower,
  // hours after it at Marina Bay (moved-out employees stay on the site list
  // with the hours worked there).
  const kamal = emp('Kamal Hussain');
  kamal.current_site_id = marina.id;
  db.siteTransfers.push({
    id: uid(),
    employee_id: kamal.id,
    from_site_id: npc.id,
    to_site_id: marina.id,
    effective_date: addDaysStr(toYMD(new Date()), -12),
    created_at: nowISO(),
  });

  // ---- attendance (last 6 months incl. current, up to today) ----------------
  // Excel-style: each worked day carries custom hours; 'A' marks an absence.
  const today = new Date();
  const absent3 = [addDaysStr(toYMD(today), -3), addDaysStr(toYMD(today), -2), addDaysStr(toYMD(today), -1)];
  for (let back = 5; back >= 0; back--) {
    const d = new Date(today.getFullYear(), today.getMonth() - back, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    const last = back === 0 ? today.getDate() : daysInMonth(y, m + 1);
    for (let day = 1; day <= last; day++) {
      const dateStr = toYMD(new Date(y, m, day));
      for (let i = 0; i < db.employees.length; i++) {
        const e = db.employees[i];
        let status: Attendance['status'];
        let hours: number | null = null;
        if (!e.current_site_id) status = 'not_marked';
        else if (e.full_name === 'Kamal Hussain' && back === 0 && absent3.includes(dateStr)) status = 'absent';
        else {
          const r = seededRand(i, day + m * 31 + back * 377);
          if (r < 0.05) status = 'absent';
          else {
            status = 'present';
            // custom hours per day: mostly 8, sometimes shorter days or overtime
            const hr = seededRand(i + 50, day);
            hours = hr < 0.12 ? 4 : hr < 0.5 ? 8 : hr < 0.85 ? 9 : 10 + (hr > 0.93 ? 2 : 0);
          }
        }
        db.attendance.push({
          id: uid(), employee_id: e.id, date: dateStr, status, hours, note: null,
          is_hidden: false, created_at: nowISO(),
        });
      }
    }
  }

  // ---- leave requests ---------------------------------------------------------
  const inDays = (n: number): string => addDaysStr(toYMD(today), n);
  db.leaveRequests = [
    {
      id: uid(), employee_id: emp('Rajesh Kumar').id, leave_type: 'annual', other_type_text: null,
      start_date: inDays(7), end_date: inDays(11), total_days: 5,
      reason: 'Family wedding in Kerala, travel already booked.', status: 'pending',
      created_by: raviP.id, reviewed_by: null, reviewed_at: null, is_hidden: false,
      created_at: new Date(Date.now() - 86400000).toISOString(),
    },
    {
      id: uid(), employee_id: emp('Arun Nair').id, leave_type: 'sick', other_type_text: null,
      start_date: inDays(-8), end_date: inDays(-7), total_days: 2,
      reason: 'High fever, medical certificate attached.', status: 'approved',
      created_by: superP.id, reviewed_by: superP.id, reviewed_at: new Date(Date.now() - 5 * 86400000).toISOString(),
      is_hidden: false, created_at: new Date(Date.now() - 9 * 86400000).toISOString(),
    },
    {
      id: uid(), employee_id: emp('Dilip Shrestha').id, leave_type: 'casual', other_type_text: null,
      start_date: inDays(-3), end_date: inDays(-3), total_days: 1,
      reason: 'Embassy document renewal appointment.', status: 'rejected',
      created_by: raviP.id, reviewed_by: superP.id, reviewed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      is_hidden: false, created_at: new Date(Date.now() - 4 * 86400000).toISOString(),
    },
  ];

  // ---- cancellation request ------------------------------------------------------
  db.cancellationRequests = [
    {
      id: uid(), employee_id: emp('Omar Farooq').id, reason: 'Project headcount reduction requested by client.',
      status: 'pending', requested_by: raviP.id, reviewed_by: null, reviewed_at: null,
      is_hidden: false, created_at: new Date(Date.now() - 3 * 86400000).toISOString(),
    },
  ];

  // ---- warnings + fines -----------------------------------------------------------
  db.warnings = [
    {
      id: uid(), employee_id: emp('Kamal Hussain').id,
      reason: `Auto-generated: 3 consecutive absences detected (${absent3.join(', ')})`,
      is_auto_generated: true, absent_dates: absent3, created_by: superP.id, is_hidden: false,
      created_at: new Date().toISOString(),
    },
    {
      id: uid(), employee_id: emp('Joseph Santos').id,
      reason: 'Negligence in safety procedures — worked without harness.',
      is_auto_generated: false, absent_dates: null, created_by: superP.id, is_hidden: false,
      created_at: new Date(Date.now() - 12 * 86400000).toISOString(),
    },
  ];
  db.fines = [
    {
      id: uid(), employee_id: emp('Sandeep Singh').id,
      reason: 'Damage to company equipment (bending machine).',
      amount: 150, created_by: superP.id, is_hidden: false,
      created_at: new Date(Date.now() - 6 * 86400000).toISOString(),
    },
  ];

  // ---- uniform registry --------------------------------------------------------------
  const monthsAgo = (n: number): string => {
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    d.setHours(9, 30, 0, 0);
    return d.toISOString();
  };
  const mkUniform = (
    n: number, e: Employee, docType: 'id' | 'passport', docNum: string,
    items: Record<string, boolean>, createdISO: string,
    extra: Partial<UniformEntry> = {},
  ): UniformEntry => {
    const siteName = e.current_site_id ? db.sites.find((s) => s.id === e.current_site_id)!.name : null;
    const leaderName = e.is_team_leader
      ? e.full_name
      : (db.employees.find((x) => x.is_team_leader && x.team_leader_site_id === e.current_site_id)?.full_name ?? null);
    return {
      id: uid(), uniform_id: n, token_number: n, employee_id: e.id, employee_name: e.full_name,
      document_type: docType, document_number: docNum, items,
      site_name: siteName, team_leader_name: leaderName,
      is_renewal: false, previous_token_id: null, is_deleted: false, is_hidden: false,
      created_at: createdISO,
      renewal_date: new Date(new Date(createdISO).getTime() + 182.5 * 86400000).toISOString(),
      ...extra,
    };
  };
  const fullItems = { uniform: true, shoes: true, helmet: true, bottle: true, safetyJacket: true, mattress: false, pillow: false };
  const basicItems = { uniform: true, shoes: true, helmet: true, bottle: false, safetyJacket: true, mattress: true, pillow: true };

  db.uniforms = [
    mkUniform(1, emp('Rajesh Kumar'), 'passport', 'P1543211', fullItems, monthsAgo(7)),
    mkUniform(2, emp('Arun Nair'), 'passport', 'P3543213', basicItems, monthsAgo(13), { is_deleted: true }),
    mkUniform(3, emp('Muhammad Iqbal'), 'id', 'UAE-IQ-20260002', fullItems, monthsAgo(5)),
    mkUniform(4, emp('Suresh Patel'), 'passport', 'P5543215', fullItems, monthsAgo(2)),
    mkUniform(5, emp('Rahim Uddin'), 'id', 'UAE-IQ-20260009', basicItems, monthsAgo(0)),
    mkUniform(6, emp('Joseph Santos'), 'id', 'UAE-IQ-20260007', fullItems, monthsAgo(4)),
    mkUniform(7, emp('Arun Nair'), 'passport', 'P3543213', fullItems, monthsAgo(7), { is_renewal: true, previous_token_id: 2 }),
  ];
  db.counters = { uniform_id: 7, token_number: 7 };

  // ---- notifications (for the super admin) ------------------------------------------
  const notif = (title: string, message: string, type: Notification['type'], hrs: number, read = false): Notification => ({
    id: uid(), profile_id: superP.id, title, message, type, read, is_hidden: false,
    created_at: new Date(Date.now() - hrs * 3600000).toISOString(),
  });
  db.notifications = [
    notif('Auto-Generated Warning', `Kamal Hussain (PUL-${year}-004) was absent 3+ consecutive days`, 'warning', 2),
    notif('New Cancellation Request', `Omar Farooq (PUL-${year}-015) is pending deletion approval — Project headcount reduction`, 'request', 72),
    notif('New Leave Request', `Rajesh Kumar (PUL-${year}-001) requested annual leave for 5 day(s)`, 'request', 26),
    notif('New Fine Issued', `Sandeep Singh (PUL-${year}-010) was fined SAR 150: Damage to company equipment`, 'fine', 144),
    notif('New Warning Issued', `Joseph Santos (PUL-${year}-007) received a warning: Negligence in safety procedures`, 'warning', 288, true),
    {
      ...notif('Leave Request Rejected', 'The leave request (casual, 1 day(s)) has been rejected.', 'request', 48),
      profile_id: raviP.id,
    },
  ];

  return db;
}

// ---------------------------------------------------------------------------
// Persistence + cross-tab realtime sync
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'pulse_demo_db_v7';
const SESSION_KEY = 'pulse_demo_session';
const CHANNEL = 'pulse-demo-realtime';

type ChangeListener = (tables: string[]) => void;
const listeners = new Set<ChangeListener>();
let channel: BroadcastChannel | null = null;

if (typeof window !== 'undefined') {
  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (ev: MessageEvent) => {
      listeners.forEach((l) => l(ev.data?.tables ?? []));
    };
  }
  window.addEventListener('storage', (ev) => {
    if (ev.key === STORAGE_KEY) {
      db = loadDB();
      listeners.forEach((l) => l(['*']));
    }
  });
}

function loadDB(): DemoDB {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoDB;
      if (parsed.version === 15) {
        // heal fields added after this DB was seeded (no version bump → no
        // reseed, existing demo data stays)
        if (!parsed.deductionSettings) {
          parsed.deductionSettings = {
            absent_free_days: ABSENT_DEDUCTION_FREE_DAYS,
            absent_deduction_amount: ABSENT_DEDUCTION_RATE,
            updated_at: null,
            updated_by_name: null,
          };
        }
        // branches shipped in DB v15 — heal older shapes defensively
        if (!parsed.branches) parsed.branches = [];
        if (!parsed.branchAssignments) parsed.branchAssignments = [];
        parsed.sites?.forEach((s) => { if (s.branch_id === undefined) s.branch_id = null; });
        // settlements persisted before the editable-absent-deduction feature
        // were never hand-edited → flag heals to false
        parsed.payrollEmployees?.forEach((pe) => {
          if (pe.absent_deduction_edited == null) pe.absent_deduction_edited = false;
        });
        return parsed;
      }
    }
  } catch {
    // corrupted → reseed
  }
  const fresh = seedDB();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  return fresh;
}

export let db: DemoDB = typeof window !== 'undefined' ? loadDB() : seedDB();

export function saveAndEmit(tables: string[]): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }
  channel?.postMessage({ tables });
  listeners.forEach((l) => l(tables));
}

export function subscribeDemo(onChange: (tables: string[]) => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function resetDemo(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SESSION_KEY);
  }
  db = seedDB();
  saveAndEmit(['*']);
}

// Demo session -------------------------------------------------------------
export function getDemoSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(SESSION_KEY);
}
export function setDemoSessionId(id: string | null): void {
  if (typeof window === 'undefined') return;
  if (id) localStorage.setItem(SESSION_KEY, id);
  else localStorage.removeItem(SESSION_KEY);
}
