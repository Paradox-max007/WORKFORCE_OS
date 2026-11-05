'use client';

// ============================================================================
// PULSE Workforce OS — App view store (Zustand)
// ============================================================================

import { create } from 'zustand';

export type AppView =
  | 'dashboard'
  | 'employees'
  | 'employee_details'
  | 'employee_form'
  | 'sites'
  | 'camps'
  | 'attendance'
  | 'working_hours'
  | 'salary_sheet'
  | 'payroll'
  | 'trade_management'
  | 'uniform_registry'
  | 'leave_requests'
  | 'cancellation_requests'
  | 'notifications'
  | 'admins';

export const VIEW_TITLES: Record<AppView, string> = {
  dashboard: 'Dashboard',
  employees: 'Employee Management',
  employee_details: 'Employee Details',
  employee_form: 'Add / Edit Employee',
  sites: 'Site Management',
  camps: 'Camp Management',
  attendance: 'Attendance',
  working_hours: 'Working Hours',
  salary_sheet: 'Salary Sheet',
  payroll: 'Payroll',
  trade_management: 'Trade Management',
  uniform_registry: 'Uniform Registry',
  leave_requests: 'Leave Requests',
  cancellation_requests: 'Cancellation Requests',
  notifications: 'Notifications Hub',
  admins: 'Admin Management',
};

interface AppStore {
  currentView: AppView;
  sidebarOpen: boolean;
  employeeFilter: string; // 'idle' | 'working' | '' cross-page filter
  /** Employee whose dedicated details page is open (employee_details view) */
  selectedEmployeeId: string | null;
  /** Dedicated add/edit employee form page state */
  employeeFormMode: 'create' | 'edit';
  employeeFormId: string | null;
  /** Where the Back button and post-save navigation should return to */
  employeeFormReturnTo: 'employees' | 'employee_details';
  /** Shared payroll month selection — Salary Sheet and Payroll use the SAME
   *  period; switching pages keeps the month. */
  salaryPeriodYear: number;
  salaryPeriodMonth: number;
  setSalaryPeriod: (year: number, month: number) => void;
  /** Which tab the Notifications Hub opens on (deep links from other pages) */
  notificationsTab: 'requests' | 'warnings' | 'fines';
  navigateTo: (view: AppView) => void;
  navigateToNotifications: (tab?: 'requests' | 'warnings' | 'fines') => void;
  navigateToEmployees: (filter?: string) => void;
  navigateToEmployeeDetails: (employeeId: string) => void;
  navigateToEmployeeForm: (
    mode: 'create' | 'edit',
    employeeId?: string,
    returnTo?: 'employees' | 'employee_details',
  ) => void;
  setSidebarOpen: (open: boolean) => void;
  consumeEmployeeFilter: () => string;
}

export const useAppStore = create<AppStore>((set, get) => ({
  currentView: 'dashboard',
  sidebarOpen: true,
  employeeFilter: '',
  selectedEmployeeId: null,
  employeeFormMode: 'create' as const,
  employeeFormId: null,
  employeeFormReturnTo: 'employees' as const,
  salaryPeriodYear: new Date().getFullYear(),
  salaryPeriodMonth: new Date().getMonth() + 1,
  setSalaryPeriod: (year, month) => set({ salaryPeriodYear: year, salaryPeriodMonth: month }),
  notificationsTab: 'requests' as const,
  navigateTo: (view) => set(
    // plain sidebar navigation to the hub always opens the default Requests
    // tab — only the deep links (navigateToNotifications) preselect a tab
    view === 'notifications'
      ? { currentView: view, notificationsTab: 'requests' as const }
      : { currentView: view },
  ),
  navigateToNotifications: (tab = 'requests') =>
    set({ currentView: 'notifications', notificationsTab: tab }),
  navigateToEmployees: (filter = '') => set({ currentView: 'employees', employeeFilter: filter }),
  navigateToEmployeeDetails: (employeeId) =>
    set({ currentView: 'employee_details', selectedEmployeeId: employeeId }),
  navigateToEmployeeForm: (mode, employeeId, returnTo = 'employees') =>
    set({ currentView: 'employee_form', employeeFormMode: mode, employeeFormId: employeeId ?? null, employeeFormReturnTo: returnTo }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  consumeEmployeeFilter: () => {
    const f = get().employeeFilter;
    if (f) set({ employeeFilter: '' });
    return f;
  },
}));
