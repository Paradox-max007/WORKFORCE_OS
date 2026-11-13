-- ============================================================================
-- 20261113b — AUTH USER NULL-BACKFILL (fixes "Database error querying schema")
-- ----------------------------------------------------------------------------
-- PROBLEM: signing in as an admin fails with Supabase Auth's 500
--   "Database error querying schema"
--
-- ROOT CAUSE: GoTrue (Supabase Auth) scans every auth.users row into a Go
-- struct in which these text columns are plain, NON-NULLABLE strings:
--   confirmation_token, recovery_token, email_change_token_current,
--   email_change_token_new, email_change, phone_change_token,
--   phone_change, reauthentication_token
-- Users created through the Auth API always have '' (empty string) there.
-- Rows inserted with hand-written SQL (seed scripts, the 20261113 repair
-- fallback) that did not list those columns carry SQL NULL, so the scan
-- fails with "converting NULL to string is unsupported" and sign-in
-- returns the generic 500 above. ("email" and "phone" are nullable in
-- GoTrue — those do not need backfilling.)
--
-- FIX, part 1: backfill every NULL with '' (GoTrue's own "no token"
-- value) for EVERY auth user — this immediately repairs sign-in for all
-- SQL-seeded accounts. Idempotent; column existence is checked first so
-- the script also runs on older auth schemas.
--
-- FIX, part 2: replace public.admin_repair_auth_user with a version that
-- applies the same backfill to every user it repairs, so the password
-- update fallback can never leave a sign-in-broken row behind again.
--
-- Run this file in the Supabase SQL Editor (Dashboard → SQL → paste → Run).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Global backfill: NULL -> '' for all GoTrue non-nullable string columns
-- ---------------------------------------------------------------------------
do $backfill$
declare
  v_col  text;
  v_cols text[] := array[
    'confirmation_token',
    'recovery_token',
    'email_change_token_current',
    'email_change_token_new',
    'email_change',
    'phone_change_token',
    'phone_change',
    'reauthentication_token'
  ];
begin
  foreach v_col in array v_cols loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'auth'
                 and table_name  = 'users'
                 and column_name = v_col) then
      execute format('update auth.users set %I = '''' where %I is null', v_col, v_col);
    end if;
  end loop;
end $backfill$;

-- ---------------------------------------------------------------------------
-- 2. admin_repair_auth_user v2 — same contract as 20261113, plus the NULL
--    backfill for the repaired user (both for re-created logins and for
--    pre-existing rows with NULL token columns).
-- ---------------------------------------------------------------------------
create or replace function public.admin_repair_auth_user(
  p_user_id  uuid,
  p_password text default null,
  p_email    text default null
) returns jsonb
language plpgsql volatile
security definer
set search_path = public, extensions
as $$
declare
  v_user             record;
  v_profile          public.profiles%rowtype;
  v_email            text;
  v_col              text;
  v_identity_created boolean := false;
  v_identity_fixed   boolean := false;
begin
  -- the target must be an existing profile (the route already verified this
  -- before calling, but double-check — never repair a ghost)
  select * into v_profile from public.profiles where id = p_user_id;
  if v_profile.id is null then
    return jsonb_build_object('ok', false, 'reason', 'profile_missing');
  end if;

  -- password sanity (GoTrue enforces the same minimum)
  if p_password is not null and length(btrim(p_password)) < 6 then
    raise exception 'Password must be at least 6 characters';
  end if;

  select id, lower(email) as email into v_user from auth.users where id = p_user_id;

  -- effective email: explicit argument > existing auth email > profile email
  v_email := coalesce(nullif(lower(btrim(p_email)), ''), v_user.email, lower(v_profile.email));

  if v_user.id is null then
    ------------------------------------------------------------------
    -- CASE 1: the profile exists but the auth login is gone entirely —
    -- re-create auth.users + auth.identities with the SAME id so the
    -- admin keeps role, permissions and grants. Requires a password:
    -- an account without one could never sign in anyway.
    ------------------------------------------------------------------
    if p_password is null or length(btrim(p_password)) = 0 then
      return jsonb_build_object('ok', false, 'reason', 'auth_user_missing');
    end if;

    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                            created_at, updated_at)
    values (p_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            v_email, crypt(btrim(p_password), gen_salt('bf')),
            now(), '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('name', v_profile.name), now(), now());
    -- the on_auth_user_created trigger inserts a profile with
    -- ON CONFLICT (id) DO NOTHING — the existing profile is preserved.

    insert into auth.identities (provider_id, user_id, identity_data, provider,
                                 last_sign_in_at, created_at, updated_at)
    values (p_user_id::text, p_user_id,
            jsonb_build_object('sub', p_user_id::text, 'email', v_email,
                               'email_verified', true),
            'email', now(), now(), now());
    v_identity_created := true;
  else
    ------------------------------------------------------------------
    -- CASE 2: the auth user exists — set password / email, then repair
    -- the identities rows if they are missing or corrupted.
    ------------------------------------------------------------------
    if p_password is not null and length(btrim(p_password)) > 0 then
      update auth.users
         set encrypted_password = crypt(btrim(p_password), gen_salt('bf')),
             updated_at = now()
       where id = p_user_id;
    end if;

    if v_email <> coalesce(v_user.email, '') then
      update auth.users
         set email = v_email,
             email_confirmed_at = coalesce(email_confirmed_at, now()),
             updated_at = now()
       where id = p_user_id;
    end if;

    if not exists (select 1 from auth.identities i where i.user_id = p_user_id) then
      insert into auth.identities (provider_id, user_id, identity_data, provider,
                                   last_sign_in_at, created_at, updated_at)
      values (p_user_id::text, p_user_id,
              jsonb_build_object('sub', p_user_id::text, 'email', v_email,
                                 'email_verified', true),
              'email', now(), now(), now());
      v_identity_created := true;
    else
      -- repair identity rows with a missing/broken identity_data or a stale
      -- email (identity_data is rebuilt whole; the identities.email column
      -- is generated from it on current Supabase versions, so it is NOT
      -- written directly)
      update auth.identities
         set identity_data = jsonb_build_object(
               'sub', p_user_id::text, 'email', v_email, 'email_verified', true),
             provider_id = coalesce(nullif(btrim(provider_id), ''), p_user_id::text),
             updated_at = now()
       where user_id = p_user_id
         and (identity_data->>'sub' is null
              or identity_data->>'email' is null
              or identity_data->>'email' <> v_email);
      v_identity_fixed := found;
    end if;
  end if;

  ------------------------------------------------------------------
  -- GoTrue scans the token columns below as non-nullable strings: a
  -- NULL in any of them makes sign-in fail with
  -- "Database error querying schema". Backfill '' for this user so the
  -- repaired / re-created account can actually log in. (Column
  -- existence is checked to stay compatible with older auth schemas.)
  ------------------------------------------------------------------
  foreach v_col in array array[
    'confirmation_token',
    'recovery_token',
    'email_change_token_current',
    'email_change_token_new',
    'email_change',
    'phone_change_token',
    'phone_change',
    'reauthentication_token'
  ] loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'auth'
                 and table_name  = 'users'
                 and column_name = v_col) then
      execute format('update auth.users set %I = '''' where id = $1 and %I is null', v_col, v_col)
        using p_user_id;
    end if;
  end loop;

  -- keep the profile email aligned with the (possibly repaired) auth email
  update public.profiles set email = v_email where id = p_user_id and email <> v_email;

  return jsonb_build_object(
    'ok',               true,
    'auth_user_created', v_user.id is null,
    'password_set',     p_password is not null and length(btrim(p_password)) > 0,
    'email_set',        v_email <> coalesce(v_user.email, ''),
    'identity_created', v_identity_created,
    'identity_fixed',   v_identity_fixed);
end; $$;

-- Lockdown (unchanged): only the service role (the /api/admin-users route,
-- which first verifies the caller is a super admin) may execute this function.
revoke execute on function public.admin_repair_auth_user(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.admin_repair_auth_user(uuid, text, text) to service_role;
