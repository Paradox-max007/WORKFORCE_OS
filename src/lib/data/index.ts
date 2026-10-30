// ============================================================================
// PULSE Workforce OS — Data layer facade
// ----------------------------------------------------------------------------
// Picks the Supabase-backed implementation when env vars are configured,
// otherwise falls back to the fully-seeded demo engine (in-memory + localStorage
// + BroadcastChannel "realtime"), so the product is always runnable.
// ============================================================================

import { isSupabaseConfigured } from '@/lib/supabase/client';
import { demoApi } from './demo-api';
import { prodApi } from './prod-api';

export type DataApi = typeof prodApi | typeof demoApi;

export const dataApi: DataApi = isSupabaseConfigured ? prodApi : demoApi;
export const isDemoMode: boolean = !isSupabaseConfigured;
export { demoApi, prodApi };
