// ============================================================================
// PULSE Workforce OS — Single source of truth for sidebar menus
// ----------------------------------------------------------------------------
// ADDING A NEW SIDEBAR MENU = adding ONE entry to MENUS below. Everything
// else updates automatically:
//   • the sidebar shows it (order = array order),
//   • it appears in Admin Management → Manage Permissions as a super-admin
//     on/off toggle (when managed: true),
//   • new admins pick up the `defaultOn` access until a super admin decides.
//
// Flags:
//   managed   true  → permission-managed: super admins toggle it per admin.
//                     Data RPCs should gate on has_menu_permission('<id>').
//           false  → fixed access for every signed-in admin (see defaultOn).
//   defaultOn  access for an admin with NO explicit menu_permission row.
//             Explicit rows (Admin Management toggles) always win.
//             Keep the SQL default-allow set in
//             supabase/migrations/20261102c_menu_automation.sql in sync with
//             the menus that ship defaultOn: true.
//
// NOTE for data-layer gating of report-style pages that also list employees:
// follow the lenient "own key OR employees" pattern used by attendance, so an
// admin granted either menu keeps the page working (see get_employee_working_
// hours / uniform RPCs).
// ============================================================================

import {
  LayoutDashboard, Users, Building2, Tent, CalendarCheck, Clock, Shirt,
  FileWarning, Ban, Bell, UserSquare2, Wallet, Banknote, Wrench, type LucideIcon,
} from 'lucide-react';
import type { AppView } from '@/store/app-store';
import type { MenuPermissionMap } from '@/lib/types';

export interface MenuDef {
  /** sidebar view id (must exist in AppView) */
  id: AppView;
  /** label shown in the sidebar */
  label: string;
  /** description shown in the permission UI */
  hint: string;
  icon: LucideIcon;
  /** true → super-admin toggleable in Admin Management */
  managed: boolean;
  /** access for admins with no explicit permission row */
  defaultOn: boolean;
  /** optional group id — grouped menus render under one collapsible parent
   *  (see MENU_GROUPS). Permissions stay per menu id. */
  group?: string;
}

/** Collapsible sidebar groups (e.g. "Salary Details"). The children keep
 *  their own permission keys — grouping is presentation only. */
export interface MenuGroupDef {
  id: string;
  label: string;
  icon: LucideIcon;
}

export const MENU_GROUPS: Record<string, MenuGroupDef> = {
  salary_details: { id: 'salary_details', label: 'Salary Details', icon: Wallet },
};

export const MENUS = [
  { id: 'dashboard', label: 'Dashboard', hint: 'Operations overview & stats', icon: LayoutDashboard, managed: false, defaultOn: true },
  { id: 'employees', label: 'Employees', hint: 'Directory, records & ratings', icon: Users, managed: true, defaultOn: false },
  { id: 'sites', label: 'Sites', hint: 'Work sites & client projects', icon: Building2, managed: true, defaultOn: false },
  { id: 'camps', label: 'Camps', hint: 'Accommodation & room assignments', icon: Tent, managed: true, defaultOn: false },
  { id: 'attendance', label: 'Attendance', hint: 'Sitewise hours marking — assigned sites only', icon: CalendarCheck, managed: true, defaultOn: false },
  { id: 'working_hours', label: 'Working Hours', hint: 'Total hours & monthly history per employee', icon: Clock, managed: true, defaultOn: false },
  { id: 'salary_sheet', label: 'Salary Sheet', hint: 'Monthly payroll — sitewise salary, advances & payments', icon: Wallet, managed: true, defaultOn: false, group: 'salary_details' },
  { id: 'payroll', label: 'Payroll', hint: 'One row per employee — consolidated hours & salary', icon: Banknote, managed: true, defaultOn: false, group: 'salary_details' },
  { id: 'trade_management', label: 'Trade Management', hint: 'Trades & effective-dated hourly rates', icon: Wrench, managed: true, defaultOn: false, group: 'salary_details' },
  { id: 'uniform_registry', label: 'Uniform Registry', hint: 'Uniform tokens & renewals', icon: Shirt, managed: true, defaultOn: true },
  { id: 'leave_requests', label: 'Leave Requests', hint: 'Leave applications & review', icon: FileWarning, managed: true, defaultOn: false },
  { id: 'cancellation_requests', label: 'Cancellations', hint: 'Employee deletion requests', icon: Ban, managed: true, defaultOn: false },
  { id: 'notifications', label: 'Notifications', hint: 'Alerts & announcements', icon: Bell, managed: true, defaultOn: false },
  // super admin only — never listed as an admin toggle
  { id: 'admins', label: 'Admin Management', hint: 'Accounts, roles & permissions', icon: UserSquare2, managed: false, defaultOn: false },
] as const satisfies readonly MenuDef[];

/** Every sidebar menu id. */
export type MenuId = (typeof MENUS)[number]['id'];

/** Ordered render list: menus and group blocks interleaved (a group replaces
 *  its children's slots — children render nested under the group header). */
export interface MenuEntry {
  /** single menu */
  menu?: MenuDef;
  /** grouped menus (rendered under one collapsible parent) */
  group?: MenuGroupDef;
  items: MenuDef[];
}

export function menuRenderList(menus: readonly MenuDef[]): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const seen = new Set<string>();
  menus.forEach((m) => {
    if (m.group && !seen.has(m.group)) {
      seen.add(m.group);
      const group = MENU_GROUPS[m.group];
      if (group) {
        entries.push({ group, items: menus.filter((x) => x.group === m.group) });
        return;
      }
    }
    if (!m.group || !MENU_GROUPS[m.group]) entries.push({ menu: m, items: [m] });
  });
  return entries;
}

/** Permission-managed menu ids (the super-admin toggle list). */
export type MenuKey = Extract<(typeof MENUS)[number], { managed: true }>['id'];

/** Ordered list of toggleable menu keys — the Admin Management permission list. */
export const MENU_KEYS: readonly MenuKey[] = MENUS.filter((m) => m.managed).map((m) => m.id as MenuKey);

/** Fast lookup by view id. */
export const MENU_BY_ID = Object.fromEntries(MENUS.map((m) => [m.id, m])) as Record<MenuId, (typeof MENUS)[number]>;

/** Menus every admin can always reach (shown as "Always available"). */
export const ALWAYS_ON_MENUS = MENUS.filter((m) => !m.managed && m.defaultOn);

/** Default permission map for an admin with no explicit rows (defaultOn flags). */
export function defaultPermissionMap(): MenuPermissionMap {
  const map = {} as Record<MenuKey, boolean>;
  MENU_KEYS.forEach((k) => { map[k] = MENU_BY_ID[k].defaultOn; });
  return map;
}

/**
 * Effective access for a normal admin to a view.
 * • super admins are handled by the caller (always allowed);
 * • sub-views without their own menu entry (employee details/form) follow
 *   the Employees module;
 * • a permission row wins; missing rows fall back to the menu's defaultOn.
 */
export function menuAllows(perms: MenuPermissionMap | null | undefined, id: AppView): boolean {
  const menu = (MENU_BY_ID as Record<string, (typeof MENUS)[number] | undefined>)[id];
  if (!menu) {
    if (id === 'employee_details' || id === 'employee_form') return menuAllows(perms, 'employees');
    return false;
  }
  if (!menu.managed) return menu.defaultOn;
  const fromRow = perms?.[menu.id as MenuKey];
  return fromRow ?? menu.defaultOn;
}
