// ============================================================================
// PULSE Workforce OS — Service-role user administration endpoint
// ----------------------------------------------------------------------------
// Only used in production (Supabase mode). Verifies the CALLER is a super
// admin (via their JWT + RLS-guarded RPC), then uses the service-role key to
// create / update / delete auth.users + profiles.
// Env required: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
//               SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import { createClient } from '@supabase/supabase-js';

interface AdminUserRequest {
  action: 'create' | 'update' | 'delete';
  id?: string;
  email?: string;
  name?: string;
  password?: string;
  role?: 'admin' | 'super_admin';
}

export async function POST(request: Request): Promise<Response> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anonKey || !serviceKey) {
    return Response.json(
      { error: 'Server is missing Supabase configuration. Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.' },
      { status: 500 },
    );
  }

  let body: AdminUserRequest;
  try {
    body = (await request.json()) as AdminUserRequest;
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // --- verify the caller is a super admin using their own JWT ---------------
  const bearer = request.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  if (!bearer) return Response.json({ error: 'Missing authorization' }, { status: 401 });

  const callerClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: isSuper } = await callerClient.rpc('is_super_admin');
  if (!isSuper) {
    return Response.json({ error: 'Only super admins can manage user accounts' }, { status: 403 });
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    switch (body.action) {
      case 'create': {
        if (!body.email || !body.password || !body.name || !body.role) {
          return Response.json({ error: 'email, name, password and role are required' }, { status: 400 });
        }
        const email = body.email.toLowerCase();
        const { data: created, error } = await admin.auth.admin.createUser({
          email,
          password: body.password,
          email_confirm: true,
          user_metadata: { name: body.name },
        });
        if (error || !created.user) {
          return Response.json({ error: error?.message ?? 'Failed to create user' }, { status: 400 });
        }
        // handle_new_user trigger creates a 'pending' profile — promote it now
        const { data: profile, error: upsertError } = await admin
          .from('profiles')
          .upsert({ id: created.user.id, email, name: body.name, role: body.role }, { onConflict: 'id' })
          .select()
          .single();
        if (upsertError) {
          await admin.auth.admin.deleteUser(created.user.id); // rollback
          return Response.json({ error: upsertError.message }, { status: 400 });
        }
        return Response.json({ profile });
      }

      case 'update': {
        if (!body.id) return Response.json({ error: 'id is required' }, { status: 400 });
        const patch: { email?: string; password?: string } = {};
        if (body.email) patch.email = body.email.toLowerCase();
        if (body.password) patch.password = body.password;
        if (Object.keys(patch).length > 0) {
          const { error } = await admin.auth.admin.updateUserById(body.id, { ...patch, email_confirm: true });
          if (error) return Response.json({ error: error.message }, { status: 400 });
        }
        if (body.email) {
          const { error } = await admin.from('profiles').update({ email: body.email.toLowerCase() }).eq('id', body.id);
          if (error) return Response.json({ error: error.message }, { status: 400 });
        }
        return Response.json({ ok: true });
      }

      case 'delete': {
        if (!body.id) return Response.json({ error: 'id is required' }, { status: 400 });
        // last-super-admin protection (mirror of delete_profile_admin)
        const { data: target } = await admin.from('profiles').select('role').eq('id', body.id).maybeSingle();
        if (target?.role === 'super_admin') {
          const { count } = await admin.from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('role', 'super_admin');
          if ((count ?? 0) <= 1) {
            return Response.json({ error: 'Cannot delete the last super admin' }, { status: 400 });
          }
        }
        const { error: profileError } = await admin.from('profiles').delete().eq('id', body.id);
        if (profileError) return Response.json({ error: profileError.message }, { status: 400 });
        const { error } = await admin.auth.admin.deleteUser(body.id);
        if (error) return Response.json({ error: error.message }, { status: 400 });
        return Response.json({ ok: true });
      }

      default:
        return Response.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Unexpected server error' },
      { status: 500 },
    );
  }
}
