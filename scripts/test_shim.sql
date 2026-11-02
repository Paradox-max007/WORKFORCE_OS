-- Vanilla-PostgreSQL shims for Supabase-only objects, so the real
-- supabase/schema.sql can load on a local test cluster.

create schema if not exists auth;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

-- auth.users stand-in (raw_user_meta_data is used by handle_new_user)
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  name               text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- session-settable auth.uid():  SET app.current_uid = '<uuid>'
create or replace function auth.uid() returns uuid
language sql stable as
$$ select nullif(current_setting('app.current_uid', true), '')::uuid $$;

-- the migration alters this publication (exists on every Supabase project)
do $$ begin
  create publication supabase_realtime;
exception when duplicate_object then null; end $$;
