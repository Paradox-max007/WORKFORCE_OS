-- ============================================================================
-- PULSE Workforce OS — Migration 2026-10-31: site supervisors
-- ----------------------------------------------------------------------------
-- Backports the "View by Supervisors" feature (commit 8b50abf) to databases
-- created BEFORE the site.supervisor column existed.
--
-- The app saves/reads each site's attendance marker ("supervisor") through the
-- create_site / update_site RPCs; on an unmigrated database every site save
-- fails with PGRST202 ("could not find the function update_site(...p_supervisor)")
-- and the attendance sheet shows no "Supervised by" chips at all.
--
-- Fully idempotent — safe to run any number of times (matches schema.sql).
-- Run this in the Supabase SQL editor (or psql) against the project database.
-- ============================================================================

-- 1. the column (fresh databases already have it via create table)
alter table public.site add column if not exists supervisor text;

-- 2. create_site with the marker name (trimmed, '' → null).
--    The old 3-arg version is dropped first — create or replace with a
--    different parameter count would create an OVERLOAD, and PostgREST could
--    then still resolve calls without p_supervisor to the stale function.
drop function if exists public.create_site(text, text, text);
create or replace function public.create_site(p_name text, p_client_name text default null, p_project_name text default null, p_supervisor text default null)
returns public.site language plpgsql
security definer set search_path = public
as $$
declare result public.site;
begin
  if not public.has_menu_permission('sites') then raise exception 'Access denied'; end if;
  if exists (select 1 from public.site where lower(name) = lower(p_name)) then
    raise exception 'A site with this name already exists';
  end if;
  insert into public.site (name, client_name, project_name, supervisor) values (p_name, p_client_name, p_project_name, nullif(trim(p_supervisor), ''))
  returning * into result;
  return result;
end; $$;

-- 3. update_site with the marker name (trimmed, '' → null);
--    returns the site + how many employees got unassigned when deactivating.
--    The old 5-arg version is dropped first (same overload concern as above).
drop function if exists public.update_site(uuid, text, text, text, boolean);
create or replace function public.update_site(
  p_id uuid, p_name text, p_client_name text, p_project_name text, p_is_active boolean,
  p_supervisor text default null
)
returns jsonb language plpgsql
security definer set search_path = public
as $$
declare result public.site;
declare unassigned_count int := 0;
declare was_active boolean;
begin
  if not public.has_menu_permission('sites') then raise exception 'Access denied'; end if;
  if exists (select 1 from public.site where lower(name) = lower(p_name) and id <> p_id) then
    raise exception 'A site with this name already exists';
  end if;

  select is_active into was_active from public.site where id = p_id;
  update public.site set name = p_name, client_name = p_client_name, project_name = p_project_name,
    supervisor = nullif(trim(p_supervisor), ''), is_active = p_is_active
  where id = p_id returning * into result;

  if was_active = true and p_is_active = false then
    select count(*) into unassigned_count from public.employee where current_site_id = p_id and status <> 'deleted';
    update public.employee set current_site_id = null where current_site_id = p_id;
    update public.employee set is_team_leader = false, team_leader_site_id = null
      where team_leader_site_id = p_id or (current_site_id = p_id and is_team_leader);
  end if;

  return jsonb_build_object('site', to_jsonb(result), 'unassignedCount', unassigned_count);
end; $$;

-- 4. keep the function grants from the schema's final pass
revoke execute on function public.create_site(text, text, text, text) from public;
revoke execute on function public.create_site(text, text, text, text) from anon;
grant execute on function public.create_site(text, text, text, text) to authenticated, service_role;
revoke execute on function public.update_site(uuid, text, text, text, boolean, text) from public;
revoke execute on function public.update_site(uuid, text, text, text, boolean, text) from anon;
grant execute on function public.update_site(uuid, text, text, text, boolean, text) to authenticated, service_role;
