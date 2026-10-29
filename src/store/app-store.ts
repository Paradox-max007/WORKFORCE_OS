'use client';

// ============================================================================
// PULSE Workforce OS — App view store (Zustand)
// ============================================================================

import { create } from 'zustand';

export type AppView =
  | 'dashboard'
  | 'employees'
  | 'employee_details'
  | 'sites'
  | 'camps'
  | 'attendance'
  | 'uniform_registry'
  | 'leave_requests'
  | 'cancellation_requests'
  | 'notifications'
  | 'admins';

export const VIEW_TITLES: Record<AppView, string> = {
  dashboard: 'Dashboard',
  employees: 'Employee Management',
  employee_details: 'Employee Details',
  sites: 'Site Management',
  camps: 'Camp Management',
  attendance: 'Attendance',
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
  /** Employee to auto-open in the edit dialog when arriving on the employees view */
  pendingEditEmployeeId: string | null;
  navigateTo: (view: AppView) => void;
  navigateToEmployees: (filter?: string) => void;
  navigateToEmployeeDetails: (employeeId: string) => void;
  navigateToEmployeesWithEdit: (employeeId: string) => void;
  setSidebarOpen: (open: boolean) => void;
  consumeEmployeeFilter: () => string;
  consumePendingEditEmployeeId: () => string | null;
}

export const useAppStore = create<AppStore>((set, get) => ({
  currentView: 'dashboard',
  sidebarOpen: true,
  employeeFilter: '',
  selectedEmployeeId: null,
  pendingEditEmployeeId: null,
  navigateTo: (view) => set({ currentView: view }),
  navigateToEmployees: (filter = '') => set({ currentView: 'employees', employeeFilter: filter }),
  navigateToEmployeeDetails: (employeeId) =>
    set({ currentView: 'employee_details', selectedEmployeeId: employeeId }),
  navigateToEmployeesWithEdit: (employeeId) =>
    set({ currentView: 'employees', pendingEditEmployeeId: employeeId }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  consumeEmployeeFilter: () => {
    const f = get().employeeFilter;
    if (f) set({ employeeFilter: '' });
    return f;
  },
  consumePendingEditEmployeeId: () => {
    const id = get().pendingEditEmployeeId;
    if (id) set({ pendingEditEmployeeId: null });
    return id;
  },
}));
