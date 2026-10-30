'use client';

// ============================================================================
// PULSE Workforce OS — Auth store (Zustand)
// ============================================================================

import { create } from 'zustand';
import { dataApi } from '@/lib/data';
import { isSupabaseConfigured } from '@/lib/supabase/client';
import type { AccentColor, MenuPermissionMap, Profile, ThemeMode } from '@/lib/types';

interface AuthStore {
  user: Profile | null;
  isLoading: boolean;
  menuPermissions: MenuPermissionMap | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUpInitial: (name: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  bootstrap: () => Promise<void>;
  updateLocalUser: (patch: Partial<Profile>) => void;
  setTheme: (theme: ThemeMode) => Promise<void>;
  setAccent: (accent: AccentColor) => Promise<void>;
  refreshPermissions: () => Promise<void>;
}

const DEFAULT_PERMISSIONS: MenuPermissionMap = {
  employees: false, sites: false, camps: false, attendance: false,
  leave_requests: false, cancellation_requests: false, notifications: false,
};

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  isLoading: true,
  menuPermissions: null,

  signIn: async (email, password) => {
    const user = await dataApi.signIn(email, password);
    if (user.role === 'pending') throw new Error('Your account is awaiting approval by a super admin.');
    set({ user });
    await get().refreshPermissions();
  },

  signUpInitial: async (name, email, password) => {
    const user = await dataApi.signUpInitial(name, email, password);
    set({ user });
    await get().refreshPermissions();
  },

  signOut: async () => {
    await dataApi.signOut();
    set({ user: null, menuPermissions: null });
  },

  bootstrap: async () => {
    try {
      const user = await dataApi.getSessionProfile();
      if (user && user.role === 'pending') {
        await dataApi.signOut();
        set({ user: null, isLoading: false });
        return;
      }
      set({ user });
      if (user) await get().refreshPermissions();
    } catch {
      set({ user: null });
    } finally {
      set({ isLoading: false });
    }
  },

  updateLocalUser: (patch) => {
    set((s) => (s.user ? { user: { ...s.user, ...patch } } : s));
  },

  setTheme: async (theme) => {
    get().updateLocalUser({ theme });
    if (isSupabaseConfigured && get().user) {
      await dataApi.setPreferences(theme, get().user!.accent);
    }
  },

  setAccent: async (accent) => {
    get().updateLocalUser({ accent });
    if (isSupabaseConfigured && get().user) {
      await dataApi.setPreferences(get().user!.theme, accent);
    }
  },

  refreshPermissions: async () => {
    const user = get().user;
    if (!user || user.role === 'super_admin') {
      set({ menuPermissions: null });
      return;
    }
    try {
      const map = await dataApi.getMenuPermissions(user.id);
      set({ menuPermissions: map });
    } catch {
      set({ menuPermissions: DEFAULT_PERMISSIONS });
    }
  },
}));

// Convenience: is a given menu accessible for the current user?
export const isMenuAllowed = (
  user: Profile | null,
  perms: MenuPermissionMap | null,
  menuKey: 'dashboard' | 'employees' | 'sites' | 'attendance' | 'uniform_registry' | 'leave_requests' | 'cancellation_requests' | 'notifications' | 'admins',
): boolean => {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (menuKey === 'dashboard' || menuKey === 'uniform_registry') return true;
  return perms ? perms[menuKey as keyof MenuPermissionMap] ?? false : false;
};
