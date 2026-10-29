// ============================================================================
// PULSE Workforce OS — Supabase browser client
// ----------------------------------------------------------------------------
// In production, set these in Vercel (Project → Settings → Environment Variables):
//   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
//   SUPABASE_SERVICE_ROLE_KEY=<service role key>   (server-only, for user admin)
// ============================================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
