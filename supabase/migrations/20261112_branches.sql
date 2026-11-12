-- ============================================================================
-- 20261112 — BRANCHES (regional site groups + admin branch access)
-- ----------------------------------------------------------------------------
-- A BRANCH owns multiple work sites; every site gets an owner branch
-- (site.branch_id, nullable — sites without a branch stay visible to every
-- admin until they are assigned).
--
--   • new menu "Branches" (permission-managed like every other menu)
--   • super admins see & manage ALL branches and sites
--   • normal admins only see the branches assigned to them
--     (public.admin_branch) — enforced by RLS on public.branch and by the
--     scoped list_branches() RPC (Branches page + Sites page grouping)
--   • super admin's Sites page shows sites BRANCH-WISE: each branch is a
--     collapsible row; expanding it lists that branch's sites
--
-- Tables:
--   public.branch        (id, name unique, location, notes, is_active, created_at)
--   public.admin_branch  (profile_id, branch_id — which branches an admin
--                         may access; unique pair)
--   public.site.branch_id → branch(id) on delete set null
--
-- RPCs (all super-admin gated except the scoped reads):
--   list_branches()      — branches + site_count + employee_count, scoped
--                          (super → all; admin → assigned only)
--   create_branch / update_branch / delete_branch
--   set_site_branch      — move a site to another branch (null = unassign)
--   set_admin_branch     — grant/revoke a branch to a normal admin
--   create_site / update_site — now accept p_branch_id (owner branch)
--
-- NOTE on data-plane scoping: public.site stays readable by every signed-in
-- staff member (is_staff()) on purpose — historical records (payroll
-- snapshots, transfers, working-hours history) reference sites across
-- branches and must keep resolving. Branch ACCESS enforcement happens on the
-- Branches/Sites pages (list_branches + client-side grouping); attendance
-- marking keeps its own admin_site scoping.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.branch (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  location   text,
  notes      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- sites get an owner branch (nullable — "no branch" is allowed)
alter table public.site add column if not exists branch_id uuid references public.branch(id) on delete set null;

-- which branches a normal admin may access (super admins always see all)
create table if not exists public.admin_branch (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  branch_id  uuid not null references public.branch(id) on delete cascade,
  unique (profile_id, branch_id)
);

alter table public.branch       enable row level security;
alter table public.admin_branch enable row level security;

-- ---------------------------------------------------------------------------
-- 2. RLS
-- ---------------------------------------------------------------------------
-- branches: super admins read all; normal admins read only their assigned
-- branches (the Branches page + Sites page grouping source their data here)
drop policy if exists branch_select on public.branch;
create policy branch_select on public.branch
  for select using (
    public.is_super_admin()
    or exists (
      select 1 from public.admin_branch ab
      where ab.profile_id = auth.uid() and ab.branch_id = branch.id
    )
  );

-- branch assignments: read self, super admins read all (writes via RPC below)
drop policy if exists admin_branch_select on public.admin_branch;
create policy admin_branch_select on public.admin_branch
  for select using (profile_id = auth.uid() or public.is_super_admin());

-- ---------------------------------------------------------------------------
-- 3. Branch RPCs
-- ---------------------------------------------------------------------------
-- Scoped branch list with live counts. Powers the Branches page and the
-- branch-wise Sites page (super admin: every branch; admin: assigned only).
create or replace function public.list_branches()
returns jsonb language sql stable
security definer set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(t) order by t.name), '[]'::jsonb)
  from (
    select
      b.id, b.name, b.location, b.notes, b.is_active, b.created_at,
      (select count(*)::int from public.site s where s.branch_id = b.id) as site_count,
      (select count(*)::int from public.employee e
         join public.site s on s.id = e.current_site_id
        where s.branch_id = b.id and e.status <> 'deleted') as employee_count
    from public.branch b
    where public.is_super_admin()
       or exists (
         select 1 from public.admin_branch ab
         where ab.profile_id = auth.uid() and ab.branch_id = b.id
       )
  ) t;
$$;

create or replace function public.create_branch(
  p_name text, p_location text default null, p_notes text default null
)
returns public.branch language plpgsql
security definer set search_path = public
as $$
declare result public.branch;
begin
  if not public.is_super_admin() then raise exception 'Only super admins can manage branches'; end if;
  if exists (select 1 from public.branch where lower(name) = lower(p_name)) then
    raise exception 'A branch with this name already exists';
  end if;
  insert into public.branch (name, location, notes)
  values (p_name, nullif(trim(p_location), ''), nullif(trim(p_notes), ''))
  returning * into result;
  return result;
end; $$;

create or replace function public.update_branch(
  p_id uuid, p_name text, p_location text, p_notes text, p_is_active boolean
)
returns public.branch language plpgsql
security definer set search_path = public
as $$
declare result public.branch;
begin
  if not public.is_super_admin() then raise exception 'Only super admins can manage branches'; end if;
  if exists (select 1 from public.branch where lower(name) = lower(p_name) and id <> p_id) then
    raise exception 'A branch with this name already exists';
  end if;
  update public.branch set name = p_name, location = nullif(trim(p_location), ''),
    notes = nullif(trim(p_notes), ''), is_active = p_is_active
  where id = p_id returning * into result;
  return result;
end; $$;

create or replace function public.delete_branch(p_id uuid)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Only super admins can manage branches'; end if;
  -- sites fall back to "no branch" (FK on delete set null); admin_branch
  -- rows cascade; employees are untouched
  delete from public.branch where id = p_id;
end; $$;

-- Move a site to another branch (null = unassign). Super admin only.
create or replace function public.set_site_branch(
  p_site_id uuid, p_branch_id uuid default null
)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Only super admins can assign sites to branches'; end if;
  if p_branch_id is not null and not exists (select 1 from public.branch where id = p_branch_id) then
    raise exception 'Branch not found';
  end if;
  update public.site set branch_id = p_branch_id where id = p_site_id;
end; $$;

-- Grant / revoke a branch to a normal admin (super admin only). Assigned
-- admins see that branch (and its sites) on the Branches & Sites pages.
create or replace function public.set_admin_branch(
  p_profile_id uuid, p_branch_id uuid, p_allowed boolean
)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Only super admins can assign branches'; end if;
  if (select role from public.profiles where id = p_profile_id) = 'super_admin' then
    raise exception 'Super admins can access every branch already';
  end if;
  if p_allowed then
    if not exists (select 1 from public.branch where id = p_branch_id) then
      raise exception 'Branch not found';
    end if;
    insert into public.admin_branch (profile_id, branch_id) values (p_profile_id, p_branch_id)
    on conflict (profile_id, branch_id) do nothing;
  else
    delete from public.admin_branch where profile_id = p_profile_id and branch_id = p_branch_id;
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- 4. create_site / update_site — owner branch parameter
-- ---------------------------------------------------------------------------
-- drop previous signatures first (create or replace with a different
-- parameter count creates an OVERLOAD PostgREST could still resolve to)
drop function if exists public.create_site(text, text, text);
drop function if exists public.create_site(text, text, text, text);
drop function if exists public.update_site(uuid, text, text, text, boolean);
drop function if exists public.update_site(uuid, text, text, text, boolean, text);

create or replace function public.create_site(
  p_name text, p_client_name text default null, p_project_name text default null,
  p_supervisor text default null, p_branch_id uuid default null
)
returns public.site language plpgsql
security definer set search_path = public
as $$
declare result public.site;
begin
  if not public.has_menu_permission('sites') then raise exception 'Access denied'; end if;
  if exists (select 1 from public.site where lower(name) = lower(p_name)) then
    raise exception 'A site with this name already exists';
  end if;
  if p_branch_id is not null and not exists (select 1 from public.branch where id = p_branch_id) then
    raise exception 'Branch not found';
  end if;
  insert into public.site (name, client_name, project_name, supervisor, branch_id)
  values (p_name, p_client_name, p_project_name, nullif(trim(p_supervisor), ''), p_branch_id)
  returning * into result;
  return result;
end; $$;

-- Returns the site + how many employees got unassigned when deactivating.
create or replace function public.update_site(
  p_id uuid, p_name text, p_client_name text, p_project_name text, p_is_active boolean,
  p_supervisor text default null, p_branch_id uuid default null
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
  if p_branch_id is not null and not exists (select 1 from public.branch where id = p_branch_id) then
    raise exception 'Branch not found';
  end if;

  select is_active into was_active from public.site where id = p_id;
  update public.site set name = p_name, client_name = p_client_name, project_name = p_project_name,
    supervisor = nullif(trim(p_supervisor), ''), is_active = p_is_active, branch_id = p_branch_id
  where id = p_id returning * into result;

  if was_active = true and p_is_active = false then
    select count(*) into unassigned_count from public.employee where current_site_id = p_id and status <> 'deleted';
    update public.employee set current_site_id = null where current_site_id = p_id;
    update public.employee set is_team_leader = false, team_leader_site_id = null
      where team_leader_site_id = p_id or (current_site_id = p_id and is_team_leader);
  end if;

  return jsonb_build_object('site', to_jsonb(result), 'unassignedCount', unassigned_count);
end; $$;

-- ---------------------------------------------------------------------------
-- 5. Realtime — the sidebar/pages refresh when branches or access change
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.branch;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.admin_branch;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 6. Grants — business RPCs are authenticated-only (guards live inside);
-- anon gets nothing new here
-- ---------------------------------------------------------------------------
revoke execute on function public.list_branches() from public, anon;
revoke execute on function public.create_branch(text, text, text) from public, anon;
revoke execute on function public.update_branch(uuid, text, text, text, boolean) from public, anon;
revoke execute on function public.delete_branch(uuid) from public, anon;
revoke execute on function public.set_site_branch(uuid, uuid) from public, anon;
revoke execute on function public.set_admin_branch(uuid, uuid, boolean) from public, anon;
grant execute on function public.list_branches() to authenticated, service_role;
grant execute on function public.create_branch(text, text, text) to authenticated, service_role;
grant execute on function public.update_branch(uuid, text, text, text, boolean) to authenticated, service_role;
grant execute on function public.delete_branch(uuid) to authenticated, service_role;
grant execute on function public.set_site_branch(uuid, uuid) to authenticated, service_role;
grant execute on function public.set_admin_branch(uuid, uuid, boolean) to authenticated, service_role;
