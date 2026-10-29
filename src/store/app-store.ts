'use client';

// ============================================================================
// PULSE Workforce OS — App view store (Zustand)
// ============================================================================

import { create } from 'zustand';

export type AppView =
  | 'dashboard'
  | 'employees'
  | 'sites'
  | 'attendance'
  | 'uniform_registry'
  | 'leave_requests'
  | 'cancellation_requests'
  | 'notifications'
  | 'admins';

export const VIEW_TITLES: Record<AppView, string> = {
  dashboard: 'Dashboard',
  employees: 'Employee Management',
  sites: 'Site Management',
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
  navigateTo: (view: AppView) => void;
  navigateToEmployees: (filter?: string) => void;
  setSidebarOpen: (open: boolean) => void;
  consumeEmployeeFilter: () => string;
}

export const useAppStore = create<AppStore>((set, get) => ({
  currentView: 'dashboard',
  sidebarOpen: true,
  employeeFilter: '',
  navigateTo: (view) => set({ currentView: view }),
  navigateToEmployees: (filter = '') => set({ currentView: 'employees', employeeFilter: filter }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  consumeEmployeeFilter: () => {
    const f = get().employeeFilter;
    if (f) set({ employeeFilter: '' });
    return f;
  },
}));
