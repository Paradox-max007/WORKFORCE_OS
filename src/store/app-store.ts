'use client';

// ============================================================================
// PULSE Workforce OS — App view store (Zustand)
// ============================================================================

import { create } from 'zustand';
import type { EmployeeVM, PayrollEmployeeVM } from '@/lib/types';

export type AppView =
  | 'dashboard'
  | 'employees'
  | 'employee_details'
  | 'employee_form'
  | 'employee_export'
  | 'branches'
  | 'sites'
  | 'camps'
  | 'attendance'
  | 'working_hours'
  | 'salary_sheet'
  | 'payroll'
  | 'payroll_export'
  | 'attendance_calendar'
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
  employee_export: 'Excel Export Preview',
  branches: 'Branch Management',
  sites: 'Site Management',
  camps: 'Camp Management',
  attendance: 'Attendance',
  working_hours: 'Working Hours',
  salary_sheet: 'Salary Sheet',
  payroll: 'Payroll',
  payroll_export: 'Payroll Excel Preview',
  attendance_calendar: 'Attendance Record',
  trade_management: 'Trade / Deduction Management',
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
  /** Payload of the Excel export preview page (filtered rows + filename) */
  exportPreview: { rows: EmployeeVM[]; fileName: string } | null;
  /** Payload of the PAYROLL Excel export preview page — the currently
   *  filtered rows of the selected period, the active filter chips and the
   *  pre-built download filename. */
  payrollExportPreview: {
    rows: PayrollEmployeeVM[];
    year: number;
    month: number;
    fileName: string;
    filters: string[];
    totalCount: number;
  } | null;
  /** Payload of the dedicated ATTENDANCE CALENDAR page — opened by clicking
   *  the deduction amount of an employee on the Payroll page. Shows the
   *  employee's month as one calendar per site (absent deduction breakdown). */
  attendanceCalendar: {
    employee: PayrollEmployeeVM;
    year: number;
    month: number;
  } | null;
  /** Shared payroll month selection — Salary Sheet and Payroll use the SAME
   *  period; switching pages keeps the month. */
  salaryPeriodYear: number;
  salaryPeriodMonth: number;
  setSalaryPeriod: (year: number, month: number) => void;
  /** Shared payroll BRANCH scope — Salary Sheet and Payroll are separated
   *  branch-wise: 'all' (every branch the viewer may access), a branch id,
   * or '__none__' (sites without an owner branch). Switching pages keeps it. */
  salaryPeriodBranchId: string;
  setSalaryPeriodBranch: (branchId: string) => void;
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
  /** Export Excel flow — opens the preview page for the filtered rows */
  navigateToExportPreview: (rows: EmployeeVM[], fileName: string) => void;
  /** Payroll Export Excel flow — opens the payroll preview page for the
   *  currently filtered rows (columns are picked on the preview itself). */
  navigateToPayrollExport: (
    rows: PayrollEmployeeVM[],
    year: number,
    month: number,
    fileName: string,
    filters: string[],
    totalCount: number,
  ) => void;
  /** Attendance calendar flow — opens the dedicated per-site calendar page
   *  for one employee's payroll month (click on the deduction amount). */
  navigateToAttendanceCalendar: (
    employee: PayrollEmployeeVM,
    year: number,
    month: number,
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
  exportPreview: null,
  payrollExportPreview: null,
  attendanceCalendar: null,
  salaryPeriodYear: new Date().getFullYear(),
  salaryPeriodMonth: new Date().getMonth() + 1,
  setSalaryPeriod: (year, month) => set({ salaryPeriodYear: year, salaryPeriodMonth: month }),
  salaryPeriodBranchId: 'all',
  setSalaryPeriodBranch: (branchId) => set({ salaryPeriodBranchId: branchId }),
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
  navigateToExportPreview: (rows, fileName) =>
    set({ currentView: 'employee_export', exportPreview: { rows, fileName } }),
  navigateToPayrollExport: (rows, year, month, fileName, filters, totalCount) =>
    set({
      currentView: 'payroll_export',
      payrollExportPreview: { rows, year, month, fileName, filters, totalCount },
    }),
  navigateToAttendanceCalendar: (employee, year, month) =>
    set({ currentView: 'attendance_calendar', attendanceCalendar: { employee, year, month } }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  consumeEmployeeFilter: () => {
    const f = get().employeeFilter;
    if (f) set({ employeeFilter: '' });
    return f;
  },
}));
