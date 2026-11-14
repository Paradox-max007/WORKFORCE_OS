// ============================================================================
// PULSE Workforce OS — /api/ai caller helper
// ----------------------------------------------------------------------------
// Request headers for the AI proxy. In SUPABASE mode the caller's Supabase
// access token is attached so the proxy can verify the signed-in admin and
// fall back to the connection STORED in site_settings (the raw API key is
// read server-side and never returns to the browser). In DEMO mode no token
// exists — the caller supplies the connection from its local demo store.
// ============================================================================

import { supabase } from '@/lib/supabase/client';

export async function aiProxyHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!supabase) return headers;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // a failed session read must not block the request — the proxy decides
  }
  return headers;
}
