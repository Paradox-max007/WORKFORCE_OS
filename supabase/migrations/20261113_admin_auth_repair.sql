-- ============================================================================
-- 20261113 — ADMIN AUTH REPAIR (password updates on corrupted accounts)
-- ----------------------------------------------------------------------------
-- PROBLEM: the /api/admin-users route updates passwords through the GoTrue
-- Admin API (auth.admin.updateUserById). That API can fail with
--   "Database error loading user" (HTTP 500)
-- when the target account's auth data is damaged. Known causes:
--   1. auth.users row seeded via SQL WITHOUT a matching auth.identities row
--      (or with a corrupted identity_data JSON) — GoTrue cannot load the user;
--   2. a public.profiles row whose auth.users login is missing entirely;
--   3. a temporarily unhealthy GoTrue/Auth service (project restore etc.).
--
-- FIX: public.admin_repair_auth_user — SECURITY DEFINER, executable ONLY by
-- service_role (the /api/admin-users route calls it with the service key
-- AFTER verifying the caller is a super admin). It:
--   1. re-creates auth.users + auth.identities when the login is missing
--      entirely — with the SAME user id, so the admin keeps their profile,
--      role, menu permissions and site/branch grants;
--   2. repairs a missing or corrupted auth.identities row;
--   3. sets the password (bcrypt via crypt/gen_salt, identical to GoTrue)
--      and/or the email directly in auth.users;
--   4. keeps public.profiles.email in sync.
--
-- Idempotent: safe to call repeatedly; a healthy account only gets the
-- password/email change it was asked for. After the repair the standard
-- Admin API works again for that account.
-- ============================================================================

create extension if not exists pgcrypto;

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

-- Lockdown: only the service role (the /api/admin-users route, which first
-- verifies the caller is a super admin) may execute this function.
revoke execute on function public.admin_repair_auth_user(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.admin_repair_auth_user(uuid, text, text) to service_role;
