'use client';

// ============================================================================
// PULSE Workforce OS — Site settings store (Zustand)
// ----------------------------------------------------------------------------
// Org-wide settings edited on the Site Settings page (super admin only):
// branding (project + company name), the default look (theme + accent) and
// the AI assistant connection. Every consumer (sidebar brand, browser title,
// attendance paper company line, theme application) reads from here so a
// change propagates everywhere — realtime re-fetches keep other signed-in
// browsers in sync.
// ============================================================================

import { create } from 'zustand';
import { dataApi } from '@/lib/data';
import { DEFAULT_SITE_SETTINGS, type SiteSettings, type SiteSettingsInput } from '@/lib/types';

interface SettingsStore {
  settings: SiteSettings;
  loaded: boolean;
  /** Fetch the settings once (or force a refresh after a realtime ping). */
  load: (force?: boolean) => Promise<void>;
  /** Patch the settings — dataApi enforces the super-admin gate. */
  update: (input: SiteSettingsInput) => Promise<SiteSettings>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: { ...DEFAULT_SITE_SETTINGS },
  loaded: false,

  load: async (force = false) => {
    if (get().loaded && !force) return;
    try {
      const settings = await dataApi.getSiteSettings();
      set({ settings, loaded: true });
    } catch {
      // unreadable settings must never break the app — defaults stay active
      set({ loaded: true });
    }
  },

  update: async (input) => {
    const settings = await dataApi.updateSiteSettings(input);
    set({ settings, loaded: true });
    return settings;
  },
}));
