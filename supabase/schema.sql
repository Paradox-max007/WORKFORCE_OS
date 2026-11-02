-- ============================================================================
-- PULSE Workforce OS — Complete Supabase Database Schema
-- ============================================================================
-- Run this file in the Supabase SQL Editor (Dashboard → SQL → New query).
-- It creates everything from scratch:
--   • Tables with proper FK relationships + indexes
--   • Row Level Security policies
--   • All business logic as Postgres functions (RPC)
--   • Triggers (new-user profile, updated_at, attendance engine)
--   • Realtime publication for live updates
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- 1. TABLES
-- ============================================================================

-- App users (mirrors auth.users — first ever user becomes super_admin)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique,
  name        text not null default 'User',
  role        text not null default 'pending' check (role in ('super_admin','admin','pending')),
  theme       text not null default 'dark'    check (theme in ('dark','light')),
  accent      text not null default 'violet'  check (accent in ('violet','emerald','amber','rose')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Per-admin menu access toggles (UI-level gating for admins)
create table if not exists public.menu_permission (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  -- menu keys are driven by the client config (src/lib/menus.ts) — no CHECK
  -- constraint here, so newly added sidebar menus can be toggled without a
  -- schema change
  menu_key    text not null,
  allowed     boolean not null default false,
  unique (profile_id, menu_key)
);

-- Work sites
create table if not exists public.site (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  client_name  text,
  project_name text,
  supervisor   text,                            -- attendance marker who marks this site's sheet
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

-- attendance marker (supervisor) — added for existing databases; the create
-- table above already covers fresh ones
alter table public.site add column if not exists supervisor text;

-- Accommodation camps (where employees stay; one employee → at most one camp)
-- NOTE: created BEFORE public.employee because employee.camp_id references it —
-- on a fresh database a forward FK reference aborts the whole script with
-- "relation public.camp does not exist".
create table if not exists public.camp (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  location    text,
  capacity    int check (capacity is null or capacity >= 0),
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Employees
create table if not exists public.employee (
  id                  uuid primary key default gen_random_uuid(),
  full_name           text not null,
  employee_code       text not null unique,            -- ASM-YYYY-NNN
  nationality         text,
  date_of_birth       date,
  phone               text,
  email               text,
  address             text,
  emergency_contact   text,
  position            text,
  join_date           date,
  company_name        text,
  passport_number     text,
  passport_status     text check (passport_status in ('Valid','Expired','N/A')),
  id_number           text,
  id_status           text check (id_status in ('Valid','Expired','N/A')),
  current_site_id     uuid references public.site(id) on delete set null,
  camp_id             uuid references public.camp(id) on delete set null,
  camp_block          text,                           -- block number inside the camp
  camp_room           text,                           -- room number inside the camp
  rating              numeric(2,1) not null default 5.0 check (rating >= 0 and rating <= 5),
  status              text not null default 'active' check (status in ('active','pending_deletion','deleted')),
  photo               text,                            -- base64 data-url
  is_team_leader      boolean not null default false,
  team_leader_site_id uuid references public.site(id) on delete set null,
  -- lifetime working hours = opening_hours (accumulated before PULSE started
  -- tracking attendance) + SUM(attendance.hours). Never written into the
  -- attendance table — it stays a separate, super-admin-adjustable balance.
  opening_hours       numeric(12,2) not null default 0 check (opening_hours >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Sites assigned to normal admins: they can only MARK ATTENDANCE for the crews
-- of the sites assigned here (super admins can mark every site).
create table if not exists public.admin_site (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  site_id    uuid not null references public.site(id) on delete cascade,
  unique (profile_id, site_id)
);

-- Site transfer log: one row is written automatically whenever an employee's
-- work site changes (employee form, per-site transfer, remove-from-site).
-- The attendance sheet uses it to place moved employees at the bottom of their
-- original site's crew (faded) with the new site shown across the moved days.
create table if not exists public.site_transfer (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employee(id) on delete cascade,
  from_site_id   uuid references public.site(id) on delete set null,
  to_site_id     uuid references public.site(id) on delete set null,
  effective_date date not null default current_date,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Migration guards (make re-running this file safe on older installs)
-- ---------------------------------------------------------------------------
-- older installs created menu_permission with a hardcoded menu key CHECK —
-- drop it so any menu key from the client config (src/lib/menus.ts) is valid
alter table public.menu_permission drop constraint if exists menu_permission_menu_key_check;
-- camp block / room columns for older installs
alter table public.employee add column if not exists camp_block text;
alter table public.employee add column if not exists camp_room text;
-- historical opening-hours balance (Working Hours module) for older installs;
-- the create table above already covers fresh ones
alter table public.employee add column if not exists opening_hours numeric(12,2) not null default 0;
alter table public.employee drop constraint if exists employee_opening_hours_check;
alter table public.employee add constraint employee_opening_hours_check check (opening_hours >= 0);

-- Daily attendance (Excel-style marking: hours worked, or absent)
create table if not exists public.attendance (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employee(id) on delete cascade,
  date           date not null,
  status         text not null default 'present' check (status in ('present','absent','not_marked')),
  hours          numeric(4,2) check (hours is null or (hours >= 0 and hours <= 24)),
  is_hidden      boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (employee_id, date)
);

-- In-app notifications for admin profiles
create table if not exists public.notification (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  title       text not null,
  message     text not null,
  type        text not null check (type in ('request','warning','fine')),
  read        boolean not null default false,
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Disciplinary warnings
create table if not exists public.warning (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references public.employee(id) on delete cascade,
  reason           text not null,
  is_auto_generated boolean not null default false,
  absent_dates     jsonb,          -- array of "YYYY-MM-DD" for auto warnings
  created_by       uuid references public.profiles(id) on delete set null,
  is_hidden        boolean not null default false,
  created_at       timestamptz not null default now()
);

-- Fines
create table if not exists public.fine (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employee(id) on delete cascade,
  reason      text not null,
  amount      numeric(10,2) not null default 0 check (amount >= 0),
  created_by  uuid references public.profiles(id) on delete set null,
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Leave requests
create table if not exists public.leave_request (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employee(id) on delete cascade,
  leave_type      text not null check (leave_type in ('casual','sick','annual','emergency','marriage','other')),
  other_type_text text,
  start_date      date not null,
  end_date        date not null,
  total_days      int not null default 1 check (total_days >= 1),
  reason          text not null,
  status          text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_by      uuid references public.profiles(id) on delete set null,
  reviewed_by     uuid references public.profiles(id) on delete set null,
  reviewed_at     timestamptz,
  is_hidden       boolean not null default false,
  created_at      timestamptz not null default now()
);

-- Cancellation requests (employee removal workflow)
create table if not exists public.cancellation_request (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.employee(id) on delete cascade,
  reason       text,
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by uuid references public.profiles(id) on delete set null,
  reviewed_by  uuid references public.profiles(id) on delete set null,
  reviewed_at  timestamptz,
  is_hidden    boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Uniform registry (6-month renewal cycle)
create table if not exists public.uniform_registry (
  id                uuid primary key default gen_random_uuid(),
  uniform_id        int not null unique,
  token_number      int not null,
  employee_id       uuid not null references public.employee(id) on delete cascade,
  employee_name     text not null,
  document_type     text not null check (document_type in ('id','passport')),
  document_number   text not null,
  items             jsonb not null default '{}',
  site_name         text,
  team_leader_name  text,
  is_renewal        boolean not null default false,
  previous_token_id int,
  is_deleted        boolean not null default false,
  is_hidden         boolean not null default false,
  created_at        timestamptz not null default now(),
  renewal_date      timestamptz not null default (now() + interval '6 months')
);

-- ============================================================================
-- 2. INDEXES
-- ============================================================================
create index if not exists idx_employee_site        on public.employee(current_site_id);
create index if not exists idx_employee_camp        on public.employee(camp_id);
create index if not exists idx_employee_status      on public.employee(status);
create index if not exists idx_employee_code        on public.employee(employee_code);
create index if not exists idx_camp_active          on public.camp(is_active);
create index if not exists idx_attendance_emp       on public.attendance(employee_id);
create index if not exists idx_attendance_date      on public.attendance(date);
create index if not exists idx_attendance_hidden    on public.attendance(is_hidden);
-- working-hours aggregation scans one employee's visible records
create index if not exists idx_attendance_emp_hours on public.attendance(employee_id, date) where is_hidden = false;
create index if not exists idx_notification_profile on public.notification(profile_id);
create index if not exists idx_notification_hidden  on public.notification(is_hidden);
create index if not exists idx_warning_emp          on public.warning(employee_id);
create index if not exists idx_warning_hidden       on public.warning(is_hidden);
create index if not exists idx_fine_emp             on public.fine(employee_id);
create index if not exists idx_fine_hidden          on public.fine(is_hidden);
create index if not exists idx_leave_emp            on public.leave_request(employee_id);
create index if not exists idx_leave_status         on public.leave_request(status);
create index if not exists idx_leave_created        on public.leave_request(created_at);
create index if not exists idx_cancellation_emp     on public.cancellation_request(employee_id);
create index if not exists idx_cancellation_status  on public.cancellation_request(status);
create index if not exists idx_uniform_emp          on public.uniform_registry(employee_id);
create index if not exists idx_uniform_token        on public.uniform_registry(token_number);
create index if not exists idx_uniform_created      on public.uniform_registry(created_at);
create index if not exists idx_menu_perm_profile    on public.menu_permission(profile_id);
create index if not exists idx_admin_site_profile   on public.admin_site(profile_id);
create index if not exists idx_admin_site_site      on public.admin_site(site_id);
create index if not exists idx_site_transfer_emp   on public.site_transfer(employee_id);
create index if not exists idx_site_transfer_date  on public.site_transfer(effective_date);

-- ============================================================================
-- 3. HELPER + SECURITY FUNCTIONS
-- ============================================================================

-- Am I a super admin?
create or replace function public.is_super_admin()
returns boolean language sql stable
security definer set search_path = public
as $$ select exists(select 1 from public.profiles where id = auth.uid() and role = 'super_admin'); $$;

-- Am I staff (admin or super_admin)?
create or replace function public.is_staff()
returns boolean language sql stable
security definer set search_path = public
as $$ select exists(select 1 from public.profiles where id = auth.uid() and role in ('super_admin','admin')); $$;

-- Does the current admin hold a given menu permission (super admins always true)?
-- A missing row falls back to the default-allow set: menus that ship visible to
-- every admin (keep in sync with defaultOn:true in src/lib/menus.ts).
create or replace function public.has_menu_permission(p_menu_key text)
returns boolean language sql stable
security definer set search_path = public
as $$
  select
    exists(select 1 from public.profiles where id = auth.uid() and role = 'super_admin')
    or coalesce(
      (
        select mp.allowed
        from public.menu_permission mp
        join public.profiles p on p.id = mp.profile_id
        where mp.profile_id = auth.uid() and mp.menu_key = p_menu_key and p.role = 'admin'
      ),
      p_menu_key in ('uniform_registry')
    );
$$;

-- Fan-out a notification to every super admin
create or replace function public.notify_super_admins(p_title text, p_message text, p_type text)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'Access denied'; end if;
  insert into public.notification (profile_id, title, message, type)
  select id, p_title, p_message, p_type from public.profiles where role = 'super_admin';
end; $$;

-- Clamp helper for rating adjustments
create or replace function public.clamp_rating(v numeric)
returns numeric language sql immutable as $$ select greatest(0, least(5, round(v, 1))); $$;

-- Anon-accessible check: does the system have a super admin yet?
-- (used by the login page to show "Initialize System" instead of "Sign In")
create or replace function public.has_any_profiles()
returns boolean language sql stable
security definer set search_path = public
as $$ select exists(select 1 from public.profiles where role = 'super_admin'); $$;

-- Function execution grants:
--   • authenticated users may call every business function (guards inside)
--   • anonymous users may ONLY check whether initial setup is needed
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.has_any_profiles() to anon;

-- ============================================================================
-- 4. TRIGGERS
-- ============================================================================

-- New auth user → profile row (first user becomes super_admin, others 'pending'
-- until a super admin promotes them from Admin Management)
create or replace function public.handle_new_user()
returns trigger language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, role)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    case when (select count(*) from public.profiles) = 0 then 'super_admin' else 'pending' end
  )
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at touch for employee + profiles
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists trg_employee_touch on public.employee;
create trigger trg_employee_touch before update on public.employee
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================================

alter table public.profiles            enable row level security;
alter table public.menu_permission     enable row level security;
alter table public.admin_site         enable row level security;
alter table public.site                enable row level security;
alter table public.camp                enable row level security;
alter table public.employee            enable row level security;
alter table public.attendance          enable row level security;
alter table public.notification        enable row level security;
alter table public.warning             enable row level security;
alter table public.fine                enable row level security;
alter table public.leave_request       enable row level security;
alter table public.cancellation_request enable row level security;
alter table public.uniform_registry    enable row level security;
alter table public.site_transfer       enable row level security;

-- profiles: read self, super admins read all
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_super_admin());

-- menu permissions: read self, super admins read all
drop policy if exists menu_perm_select on public.menu_permission;
create policy menu_perm_select on public.menu_permission
  for select using (profile_id = auth.uid() or public.is_super_admin());

-- site assignments: read self, super admins read all (writes via RPC below)
drop policy if exists admin_site_select on public.admin_site;
create policy admin_site_select on public.admin_site
  for select using (profile_id = auth.uid() or public.is_super_admin());

-- notifications: read + update (mark read) own rows
drop policy if exists notification_select on public.notification;
create policy notification_select on public.notification
  for select using (profile_id = auth.uid() or public.is_super_admin());
drop policy if exists notification_update on public.notification;
create policy notification_update on public.notification
  for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- operational data: every signed-in staff member can READ (menu-level
-- restrictions are enforced in the UI + RPC write guards below)
drop policy if exists site_select on public.site;
create policy site_select on public.site for select using (public.is_staff());
drop policy if exists camp_select on public.camp;
create policy camp_select on public.camp for select using (public.is_staff());
drop policy if exists employee_select on public.employee;
create policy employee_select on public.employee for select using (public.is_staff());
drop policy if exists site_transfer_select on public.site_transfer;
create policy site_transfer_select on public.site_transfer
  for select using (public.is_staff());
drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance for select using (public.is_staff());
drop policy if exists warning_select on public.warning;
create policy warning_select on public.warning for select using (public.is_staff());
drop policy if exists fine_select on public.fine;
create policy fine_select on public.fine for select using (public.is_staff());
drop policy if exists leave_select on public.leave_request;
create policy leave_select on public.leave_request for select using (public.is_staff());
drop policy if exists cancellation_select on public.cancellation_request;
create policy cancellation_select on public.cancellation_request for select using (public.is_staff());
drop policy if exists uniform_select on public.uniform_registry;
create policy uniform_select on public.uniform_registry for select using (public.is_staff());

-- All WRITES go through the RPC functions below (security definer with their
-- own role/permission guards) or the service-role API route for user admin.

-- ============================================================================
-- 6. SELF-SERVICE / ADMIN PROFILE RPCs
-- ============================================================================

-- Update own display name + theme + accent
create or replace function public.set_preferences(p_name text default null, p_theme text default null, p_accent text default null)
returns public.profiles language plpgsql
security definer set search_path = public
as $$
declare result public.profiles;
begin
  update public.profiles set
    name   = coalesce(p_name, name),
    theme  = coalesce(nullif(p_theme, ''), theme),
    accent = coalesce(nullif(p_accent, ''), accent)
  where id = auth.uid()
  returning * into result;
  return result;
end; $$;

-- Super admin edits another profile's name / role (email + password go via the
-- service-role API route). Last-super-admin protection included.
create or replace function public.update_profile_admin(p_id uuid, p_name text, p_role text)
returns public.profiles language plpgsql
security definer set search_path = public
as $$
declare result public.profiles;
declare target_count int;
begin
  if not public.is_super_admin() then raise exception 'Only super admins can manage profiles'; end if;
  if p_role not in ('admin','super_admin') then raise exception 'Invalid role'; end if;

  -- last super admin protection
  if (select role from public.profiles where id = p_id) = 'super_admin' and p_role <> 'super_admin' then
    select count(*) into target_count from public.profiles where role = 'super_admin';
    if target_count <= 1 then raise exception 'Cannot demote the last super admin'; end if;
  end if;

  update public.profiles set name = p_name, role = p_role, updated_at = now()
  where id = p_id returning * into result;
  return result;
end; $$;

-- Super admin deletes a profile (last-super-admin protected). The auth.users
-- row is removed separately by the service-role API route.
create or replace function public.delete_profile_admin(p_id uuid)
returns void language plpgsql
security definer set search_path = public
as $$
declare target_count int;
begin
  if not public.is_super_admin() then raise exception 'Only super admins can delete profiles'; end if;
  if (select role from public.profiles where id = p_id) = 'super_admin' then
    select count(*) into target_count from public.profiles where role = 'super_admin';
    if target_count <= 1 then raise exception 'Cannot delete the last super admin'; end if;
  end if;
  delete from public.profiles where id = p_id;
end; $$;

-- Grant / revoke a menu permission for an admin
create or replace function public.set_menu_permission(p_profile_id uuid, p_menu_key text, p_allowed boolean)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Only super admins can manage permissions'; end if;
  if (select role from public.profiles where id = p_profile_id) = 'super_admin' then
    raise exception 'Super admins always have full access';
  end if;
  insert into public.menu_permission (profile_id, menu_key, allowed)
  values (p_profile_id, p_menu_key, p_allowed)
  on conflict (profile_id, menu_key) do update set allowed = p_allowed;
end; $$;

-- Assign / unassign a site to a normal admin (super admin only). Assigned admins
-- can mark attendance for the crews of their assigned sites only.
create or replace function public.set_admin_site(p_profile_id uuid, p_site_id uuid, p_allowed boolean)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Only super admins can assign sites'; end if;
  if (select role from public.profiles where id = p_profile_id) = 'super_admin' then
    raise exception 'Super admins can access every site already';
  end if;
  if p_allowed then
    if not exists (select 1 from public.site where id = p_site_id) then
      raise exception 'Site not found';
    end if;
    insert into public.admin_site (profile_id, site_id) values (p_profile_id, p_site_id)
    on conflict (profile_id, site_id) do nothing;
  else
    delete from public.admin_site where profile_id = p_profile_id and site_id = p_site_id;
  end if;
end; $$;

-- ============================================================================
-- 7. SITE RPCs
-- ============================================================================
-- drop pre-supervisor signatures first: create or replace with a different
-- parameter count creates an OVERLOAD, leaving a stale function PostgREST
-- could still resolve to (no-ops on fresh databases)
drop function if exists public.create_site(text, text, text);
drop function if exists public.update_site(uuid, text, text, text, boolean);

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

-- Returns the site + how many employees got unassigned when deactivating.
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

create or replace function public.delete_site(p_id uuid)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not public.has_menu_permission('sites') then raise exception 'Access denied'; end if;
  update public.employee set current_site_id = null where current_site_id = p_id;
  update public.employee set is_team_leader = false, team_leader_site_id = null where team_leader_site_id = p_id;
  delete from public.site where id = p_id;
end; $$;

-- ============================================================================
-- 7b. CAMP RPCs (accommodation management)
-- ============================================================================

create or replace function public.create_camp(
  p_name text, p_location text default null, p_capacity int default null, p_notes text default null
)
returns public.camp language plpgsql
security definer set search_path = public
as $$
declare result public.camp;
begin
  if not public.has_menu_permission('camps') then raise exception 'Access denied'; end if;
  if exists (select 1 from public.camp where lower(name) = lower(p_name)) then
    raise exception 'A camp with this name already exists';
  end if;
  if p_capacity is not null and p_capacity < 0 then raise exception 'Capacity cannot be negative'; end if;
  insert into public.camp (name, location, capacity, notes)
  values (p_name, nullif(p_location,''), p_capacity, nullif(p_notes,''))
  returning * into result;
  return result;
end; $$;

-- Update a camp. Deactivating keeps assignments (unlike sites) — camps are
-- living quarters; an inactive camp just stops accepting new assignments.
create or replace function public.update_camp(
  p_id uuid, p_name text, p_location text, p_capacity int, p_notes text, p_is_active boolean
)
returns public.camp language plpgsql
security definer set search_path = public
as $$
declare result public.camp;
begin
  if not public.has_menu_permission('camps') then raise exception 'Access denied'; end if;
  if exists (select 1 from public.camp where lower(name) = lower(p_name) and id <> p_id) then
    raise exception 'A camp with this name already exists';
  end if;
  if p_capacity is not null and p_capacity < 0 then raise exception 'Capacity cannot be negative'; end if;
  update public.camp set
    name = p_name, location = nullif(p_location,''), capacity = p_capacity,
    notes = nullif(p_notes,''), is_active = p_is_active
  where id = p_id returning * into result;
  if result.id is null then raise exception 'Camp not found'; end if;
  return result;
end; $$;

-- Delete a camp (employees fall back to "no camp"; they are never deleted)
create or replace function public.delete_camp(p_id uuid)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not public.has_menu_permission('camps') then raise exception 'Access denied'; end if;
  update public.employee set camp_id = null where camp_id = p_id;
  delete from public.camp where id = p_id;
end; $$;

-- Move an employee to a camp (one employee → exactly one camp; p_camp_id null
-- unassigns and clears the block/room). p_block / p_room capture where inside
-- the camp the employee stays.
create or replace function public.assign_employee_camp(
  p_employee_id uuid, p_camp_id uuid default null,
  p_block text default null, p_room text default null
)
returns public.employee language plpgsql
security definer set search_path = public
as $$
declare result public.employee;
begin
  if not public.has_menu_permission('camps') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;
  if p_camp_id is not null and not exists (select 1 from public.camp where id = p_camp_id and is_active) then
    raise exception 'The selected camp does not exist or is inactive';
  end if;
  update public.employee
     set camp_id    = p_camp_id,
         camp_block = case when p_camp_id is null then null else nullif(btrim(coalesce(p_block, '')), '') end,
         camp_room  = case when p_camp_id is null then null else nullif(btrim(coalesce(p_room, '')), '') end,
         updated_at = now()
   where id = p_employee_id and status <> 'deleted'
  returning * into result;
  if result.id is null then raise exception 'Employee not found'; end if;
  return result;
end; $$;

-- ============================================================================
-- 8. EMPLOYEE RPCs
-- ============================================================================

-- Next employee code in the ASM-YYYY-NNN sequence (max NNN for the year + 1)
create or replace function public.next_employee_code()
returns text language sql stable
security definer set search_path = public
as $$
  select 'ASM-' || to_char(now(), 'YYYY') || '-' ||
         lpad((coalesce(max(substring(employee_code from '[0-9]+$')::int), 0) + 1)::text, 3, '0')
  from public.employee
  where employee_code like 'ASM-' || to_char(now(), 'YYYY') || '-%';
$$;

create or replace function public.create_employee(p_employee jsonb)
returns public.employee language plpgsql
security definer set search_path = public
as $$
declare result public.employee;
-- tolerate double-encoded payloads: an app build that sent JSON.stringify(p_employee)
-- delivers a jsonb STRING — unwrap it once, up front, so every `->>` below works
-- (declare defaults run before the body, so the unwrap must live HERE)
declare v_payload jsonb := case when jsonb_typeof(p_employee) = 'string'
                                 then (p_employee #>> '{}')::jsonb else p_employee end;
declare v_site uuid := nullif(v_payload->>'current_site_id','');
declare v_camp uuid := nullif(v_payload->>'camp_id','');
declare v_block text := nullif(btrim(coalesce(v_payload->>'camp_block','')), '');
declare v_room  text := nullif(btrim(coalesce(v_payload->>'camp_room','')), '');
declare v_leader_site uuid := nullif(v_payload->>'team_leader_site_id','');
declare v_is_leader boolean := coalesce((v_payload->>'is_team_leader')::boolean, false);
-- historical opening balance: blank / missing / null → 0 (new employees)
declare v_opening numeric := coalesce(nullif(v_payload->>'opening_hours','')::numeric, 0);
-- manual employee ID: use it as-is; blank → auto-generate (PUL-YYYY-NNN)
declare v_code text := nullif(btrim(coalesce(v_payload->>'employee_code','')), '');
declare conflicting public.employee;
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;

  -- the payload must be a JSON object (after unwrapping) — anything else is a
  -- broken client and must fail loudly instead of silently nulling columns
  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'Invalid employee payload — expected a JSON object';
  end if;

  -- full_name is required — fail with a clear message instead of the raw
  -- not-null constraint error
  if coalesce(btrim(v_payload->>'full_name'), '') = '' then
    raise exception 'Full name is required';
  end if;

  -- manual IDs must be unique (case-insensitive)
  if v_code is not null then
    select * into conflicting from public.employee
      where lower(employee_code) = lower(v_code) limit 1;
    if conflicting.id is not null then
      raise exception 'Employee ID "%" is already taken by % — use another ID or leave it blank to auto-generate', v_code, conflicting.full_name;
    end if;
  end if;

  -- site must exist and be active
  if v_site is not null and not exists (select 1 from public.site where id = v_site and is_active) then
    raise exception 'The selected site does not exist or is inactive';
  end if;
  -- camp must exist and be active
  if v_camp is not null and not exists (select 1 from public.camp where id = v_camp and is_active) then
    raise exception 'The selected camp does not exist or is inactive';
  end if;
  -- block/room only make sense while the employee stays in a camp
  if v_camp is null then
    v_block := null;
    v_room := null;
  end if;

  -- opening balance validation (frontend validates too — never trust it alone)
  if v_opening < 0 or v_opening <> v_opening then
    raise exception 'Previous working hours cannot be negative';
  end if;
  if v_opening > 9999999999.99 then
    raise exception 'Previous working hours are unrealistically large';
  end if;

  -- one team leader per site
  if v_is_leader and v_leader_site is not null then
    select * into conflicting from public.employee
      where is_team_leader and team_leader_site_id = v_leader_site and status <> 'deleted' limit 1;
    if conflicting.id is not null then
      raise exception 'Another employee (%) is already the team leader of this site', conflicting.full_name;
    end if;
  end if;

  insert into public.employee (
    full_name, employee_code, nationality, date_of_birth, phone, email, address,
    emergency_contact, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, rating, status, photo, is_team_leader, team_leader_site_id,
    camp_id, camp_block, camp_room, opening_hours
  ) values (
    btrim(v_payload->>'full_name'), coalesce(v_code, public.next_employee_code()),
    nullif(v_payload->>'nationality',''), (v_payload->>'date_of_birth')::date,
    nullif(v_payload->>'phone',''), nullif(v_payload->>'email',''), nullif(v_payload->>'address',''),
    nullif(v_payload->>'emergency_contact',''), nullif(v_payload->>'position',''),
    (v_payload->>'join_date')::date, nullif(v_payload->>'company_name',''),
    nullif(v_payload->>'passport_number',''), nullif(v_payload->>'passport_status',''),
    nullif(v_payload->>'id_number',''), nullif(v_payload->>'id_status',''),
    v_site, 5.0, 'active', nullif(v_payload->>'photo',''), v_is_leader, v_leader_site, v_camp,
    v_block, v_room, round(v_opening, 2)
  ) returning * into result;
  return result;
end; $$;

create or replace function public.update_employee(p_id uuid, p_employee jsonb, p_effective_date date default null)
returns public.employee language plpgsql
security definer set search_path = public
as $$
declare result public.employee;
-- tolerate double-encoded payloads (see create_employee)
declare v_payload jsonb := case when jsonb_typeof(p_employee) = 'string'
                                 then (p_employee #>> '{}')::jsonb else p_employee end;
declare v_site uuid := nullif(v_payload->>'current_site_id','');
declare v_camp uuid := nullif(v_payload->>'camp_id','');
declare v_block text := nullif(btrim(coalesce(v_payload->>'camp_block','')), '');
declare v_room  text := nullif(btrim(coalesce(v_payload->>'camp_room','')), '');
declare v_leader_site uuid := nullif(v_payload->>'team_leader_site_id','');
declare v_is_leader boolean := coalesce((v_payload->>'is_team_leader')::boolean, false);
-- opening balance: NULL/blank in the payload → keep the stored value; a number
-- → set it, but only a super admin may actually CHANGE it (the form always
-- sends the current value back, so normal edits pass through untouched)
declare v_opening numeric := nullif(v_payload->>'opening_hours','')::numeric;
declare v_prev_site uuid;
declare v_prev_opening numeric;
declare conflicting public.employee;
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;

  -- the payload must be a JSON object (after unwrapping) — anything else is a
  -- broken client and must fail loudly instead of silently nulling columns
  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'Invalid employee payload — expected a JSON object';
  end if;

  if v_site is not null and not exists (select 1 from public.site where id = v_site and is_active) then
    raise exception 'The selected site does not exist or is inactive';
  end if;
  if v_camp is not null and not exists (select 1 from public.camp where id = v_camp and is_active) then
    raise exception 'The selected camp does not exist or is inactive';
  end if;
  -- block/room only make sense while the employee stays in a camp
  if v_camp is null then
    v_block := null;
    v_room := null;
  end if;

  if v_is_leader and v_leader_site is not null then
    select * into conflicting from public.employee
      where is_team_leader and team_leader_site_id = v_leader_site
        and status <> 'deleted' and id <> p_id limit 1;
    if conflicting.id is not null then
      raise exception 'Another employee (%) is already the team leader of this site', conflicting.full_name;
    end if;
  end if;

  -- remember the previous site so the move can be logged below
  select current_site_id, opening_hours into v_prev_site, v_prev_opening from public.employee where id = p_id;

  -- historical opening balance: validated like on create; changing it is a
  -- super-admin-only adjustment so a lifetime total can never drift silently
  if v_opening is not null then
    if v_opening < 0 or v_opening <> v_opening then
      raise exception 'Previous working hours cannot be negative';
    end if;
    if v_opening > 9999999999.99 then
      raise exception 'Previous working hours are unrealistically large';
    end if;
    if v_opening <> v_prev_opening and not public.is_super_admin() then
      raise exception 'Only super admins can adjust the historical opening balance';
    end if;
  end if;

  update public.employee set
    -- keep the stored name when a partial payload arrives without one —
    -- never null out a NOT NULL column
    full_name         = coalesce(nullif(btrim(coalesce(v_payload->>'full_name','')), ''), public.employee.full_name),
    nationality       = nullif(v_payload->>'nationality',''),
    date_of_birth     = (v_payload->>'date_of_birth')::date,
    phone             = nullif(v_payload->>'phone',''),
    email             = nullif(v_payload->>'email',''),
    address           = nullif(v_payload->>'address',''),
    emergency_contact = nullif(v_payload->>'emergency_contact',''),
    position          = nullif(v_payload->>'position',''),
    join_date         = (v_payload->>'join_date')::date,
    company_name      = nullif(v_payload->>'company_name',''),
    passport_number   = nullif(v_payload->>'passport_number',''),
    passport_status   = nullif(v_payload->>'passport_status',''),
    id_number         = nullif(v_payload->>'id_number',''),
    id_status         = nullif(v_payload->>'id_status',''),
    current_site_id   = v_site,
    camp_id           = v_camp,
    camp_block        = v_block,
    camp_room         = v_room,
    photo             = nullif(v_payload->>'photo',''),
    is_team_leader    = v_is_leader,
    team_leader_site_id = case when v_is_leader then v_leader_site else null end,
    opening_hours     = coalesce(round(v_opening, 2), public.employee.opening_hours),
    updated_at        = now()
  where id = p_id returning * into result;

  -- log the site move (site → site, site → idle, idle → site) so the attendance
  -- sheet can keep the row under the original site with the new site shown
  -- across the merged moved-days cells
  if v_prev_site is distinct from v_site then
    insert into public.site_transfer (employee_id, from_site_id, to_site_id, effective_date)
    values (p_id, v_prev_site, v_site,
            coalesce(p_effective_date, (now() at time zone 'Asia/Dubai')::date));
  end if;
  return result;
end; $$;

-- Super-admin hard delete: soft-hide cascade (all related data preserved but hidden)
create or replace function public.delete_employee_cascade(p_id uuid)
returns void language plpgsql
security definer set search_path = public
as $$
declare emp public.employee;
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;
  select * into emp from public.employee where id = p_id;
  if emp.id is null then raise exception 'Employee not found'; end if;
  if emp.status = 'pending_deletion' then
    raise exception 'This employee already has a pending deletion request';
  end if;

  update public.attendance           set is_hidden = true where employee_id = p_id;
  update public.warning              set is_hidden = true where employee_id = p_id;
  update public.fine                 set is_hidden = true where employee_id = p_id;
  update public.leave_request        set is_hidden = true where employee_id = p_id;
  update public.cancellation_request set is_hidden = true where employee_id = p_id;
  update public.uniform_registry     set is_deleted = true, is_hidden = true where employee_id = p_id;

  -- hide notifications that mention this employee
  update public.notification set is_hidden = true
  where (lower(title) like '%' || lower(emp.full_name) || '%'
      or lower(message) like '%' || lower(emp.full_name) || '%'
      or lower(message) like '%' || lower(emp.employee_code) || '%');

  update public.employee set status = 'deleted', current_site_id = null,
    is_team_leader = false, team_leader_site_id = null
  where id = p_id;
end; $$;

-- Admin-initiated removal request → CancellationRequest + pending_deletion + notify
create or replace function public.request_employee_deletion(p_employee_id uuid, p_reason text default null)
returns public.cancellation_request language plpgsql
security definer set search_path = public
as $$
declare result public.cancellation_request;
declare emp public.employee;
begin
  if not public.is_staff() then raise exception 'Access denied'; end if;
  select * into emp from public.employee where id = p_employee_id;
  if emp.id is null then raise exception 'Employee not found'; end if;
  if emp.status = 'deleted' then raise exception 'This employee is already deleted'; end if;
  if emp.status = 'pending_deletion' then raise exception 'This employee already has a pending deletion request'; end if;

  insert into public.cancellation_request (employee_id, reason, status, requested_by)
  values (p_employee_id, p_reason, 'pending', auth.uid()) returning * into result;

  update public.employee set status = 'pending_deletion' where id = p_employee_id;

  perform public.notify_super_admins(
    'New Cancellation Request',
    emp.full_name || ' (' || emp.employee_code || ') is pending deletion approval' ||
    case when coalesce(p_reason,'') <> '' then ' — ' || p_reason else '' end,
    'request'
  );
  return result;
end; $$;

-- Review a cancellation request (super admin only)
create or replace function public.review_cancellation_request(p_id uuid, p_approve boolean)
returns void language plpgsql
security definer set search_path = public
as $$
declare req public.cancellation_request;
declare emp public.employee;
begin
  if not public.is_super_admin() then raise exception 'Only super admins can review requests'; end if;
  select * into req from public.cancellation_request where id = p_id;
  if req.id is null then raise exception 'Request not found'; end if;
  if req.status <> 'pending' then raise exception 'Only pending requests can be reviewed'; end if;
  select * into emp from public.employee where id = req.employee_id;

  if p_approve then
    update public.cancellation_request set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
    update public.employee set status = 'deleted', current_site_id = null, is_team_leader = false, team_leader_site_id = null
      where id = req.employee_id;
    update public.uniform_registry set is_deleted = true, is_hidden = true where employee_id = req.employee_id;
  else
    update public.cancellation_request set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
    update public.employee set status = 'active' where id = req.employee_id and status = 'pending_deletion';
  end if;

  if req.requested_by is not null then
    insert into public.notification (profile_id, title, message, type)
    values (req.requested_by,
      'Cancellation Request ' || case when p_approve then 'Approved' else 'Rejected' end,
      'The removal request for ' || coalesce(emp.full_name,'the employee') || ' has been ' ||
        case when p_approve then 'approved and the employee was removed.' else 'rejected and the employee was restored.' end,
      'request');
  end if;
end; $$;

-- ============================================================================
-- 9. ATTENDANCE RPCs
-- ============================================================================

-- Fetch one month's REAL attendance records (un-entered days stay blank in the
-- marking sheet). Normal admins only receive rows for employees working at THEIR assigned sites.
-- ---------------------------------------------------------------------------
-- Date-effective employee site assignment (mirrors src/lib/site-timeline.ts).
--
-- Answers "which site did this employee belong to on THIS date" from the
-- site_transfer log — NOT from employee.current_site_id (that only reflects
-- the present and breaks historical attendance after a move).
--
-- The "25th at 8 PM" rule: a day already marked at the OLD site before the
-- move was recorded keeps its old-site assignment — the move is enforced from
-- the first day that was NOT already marked (marked on the 25th + moved on
-- the 25th → effective from the 26th). Existing attendance records are never
-- rewritten. Multiple transfers fold chronologically (effective_date, then
-- created_at), so A → B → C in one month resolves correctly per date.
-- ---------------------------------------------------------------------------
create or replace function public.emp_site_on_date(p_emp uuid, p_date date)
returns uuid
language plpgsql
stable
security definer set search_path = public
as $$
declare
  t record;
  v_site uuid;
  v_first uuid;
  v_start date;
begin
  -- no logged move → the employee simply sits at their current site
  if not exists (select 1 from public.site_transfer where employee_id = p_emp) then
    return (select current_site_id from public.employee where id = p_emp);
  end if;

  -- site before any logged move = where the earliest move started from
  select st.from_site_id into v_first
    from public.site_transfer st
    where st.employee_id = p_emp
    order by st.effective_date, st.created_at
    limit 1;
  v_site := v_first;

  -- fold every move whose display date is on/before the requested date
  for t in
    select st.from_site_id, st.to_site_id, st.effective_date, st.created_at
    from public.site_transfer st
    where st.employee_id = p_emp
    order by st.effective_date, st.created_at
  loop
    -- display date: skip days already marked at the old site BEFORE this
    -- move was recorded (bounded by the requested date)
    v_start := t.effective_date;
    while v_start <= p_date and exists (
      select 1 from public.attendance a
      where a.employee_id = p_emp
        and a.date = v_start
        and a.created_at <= t.created_at
    ) loop
      v_start := v_start + 1;
    end loop;
    if v_start <= p_date then
      v_site := t.to_site_id;
    end if;
  end loop;

  return v_site;
end; $$;

grant execute on function public.emp_site_on_date(uuid, date) to authenticated;

create or replace function public.get_month_attendance(p_month text)
returns setof public.attendance language plpgsql
security definer set search_path = public
as $$
begin
  if not public.has_menu_permission('attendance') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;

  -- Only REAL records are returned: days with no record simply stay blank in
  -- the marking sheet (no auto-created 8h defaults). Future days render blank
  -- and are locked client-side.
  -- Site authorization is DATE-EFFECTIVE: a normal admin sees a record when
  -- the employee belonged to one of their sites on that record's date (an
  -- employee moved mid-month keeps their old site's history visible there).
  return query
    select a.* from public.attendance a
    join public.employee e on e.id = a.employee_id
    where to_char(a.date, 'YYYY-MM') = p_month
      and not a.is_hidden
      and e.status <> 'deleted'
      and (
        public.is_super_admin()
        or exists (
          select 1 from public.admin_site s
          where s.profile_id = auth.uid()
            and s.site_id = public.emp_site_on_date(e.id, a.date)
        )
      )
    order by a.date;
end; $$;

-- Mark one day Excel-style (upsert) with rating engine + auto-warning on 3 consecutive absences.
--   p_value: 'A' (absent) | numeric hours text e.g. '8', '10.5' (present) | '' / null (clear cell)
create or replace function public.mark_attendance(
  p_employee_id uuid, p_date date, p_value text default null
)
returns public.attendance language plpgsql
security definer set search_path = public
as $$
declare
  result public.attendance;
  prev public.attendance;
  v_hours numeric := null;
  v_status text;
  ot_delta numeric := 0;
  walk date;
  absent_dates date[] := array[p_date];
  v_emp_site uuid;
begin
  if not public.has_menu_permission('attendance') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;

  -- site-scoped marking is DATE-EFFECTIVE: normal admins may only mark days
  -- the employee belonged to one of their assigned sites on (an employee
  -- moved mid-month stays markable at the old site for the days before the
  -- move and at the new site afterwards). Idle days remain super-admin only.
  select public.emp_site_on_date(p_employee_id, p_date) into v_emp_site;
  if not public.is_super_admin() then
    if v_emp_site is null then
      raise exception 'This employee has no site on this date — only super admins can mark idle employees';
    end if;
    if not exists (
      select 1 from public.admin_site where profile_id = auth.uid() and site_id = v_emp_site
    ) then
      raise exception 'Access denied — you can only mark attendance for your assigned sites';
    end if;
  end if;

  -- parse the cell value
  if p_value is null or btrim(p_value) = '' then
    -- cleared cell: remove the record entirely
    delete from public.attendance where employee_id = p_employee_id and date = p_date;
    return prev;
  elsif lower(btrim(p_value)) in ('a', 'absent') then
    v_status := 'absent';
  else
    begin
      v_hours := btrim(p_value)::numeric;
    exception when others then
      raise exception 'Invalid value %. Enter hours (e.g. 8, 10.5) or A for absent', p_value;
    end;
    if v_hours < 0 or v_hours > 24 then
      raise exception 'Hours must be between 0 and 24';
    end if;
    v_status := 'present';
  end if;

  select * into prev from public.attendance
    where employee_id = p_employee_id and date = p_date;
  if prev.id is not null then
    ot_delta := greatest(0, coalesce(v_hours,0) - 8) - greatest(0, coalesce(prev.hours,0) - 8);
  else
    ot_delta := greatest(0, coalesce(v_hours,0) - 8);
  end if;

  insert into public.attendance (employee_id, date, status, hours)
  values (p_employee_id, p_date, v_status, case when v_status = 'present' then v_hours else null end)
  on conflict (employee_id, date) do update set
    status = excluded.status,
    hours = excluded.hours
  returning * into result;

  -- rating: +/- 0.2 stars per overtime-hour delta (hours above 8/day)
  if ot_delta <> 0 then
    update public.employee set rating = public.clamp_rating(rating + 0.2 * ot_delta) where id = p_employee_id;
  end if;

  -- auto-warning: 3 consecutive absences (walking back, skipping Fridays)
  if v_status = 'absent' then
    walk := p_date - 1;
    while walk >= p_date - 7 loop
      if extract(isodow from walk) = 5 then walk := walk - 1; continue; end if;
      exit when not exists (
        select 1 from public.attendance
        where employee_id = p_employee_id and date = walk and status = 'absent' and not is_hidden
      );
      absent_dates := walk || absent_dates;
      walk := walk - 1;
    end loop;

    if array_length(absent_dates, 1) >= 3 then
      insert into public.warning (employee_id, reason, is_auto_generated, absent_dates, created_by)
      values (p_employee_id,
              'Auto-generated: ' || array_length(absent_dates,1) || ' consecutive absences detected (' ||
              (select string_agg(to_char(d,'YYYY-MM-DD'), ', ') from unnest(absent_dates) d) || ')',
              true, to_jsonb(absent_dates), auth.uid());
      update public.employee set rating = public.clamp_rating(rating - 0.5) where id = p_employee_id;
      perform public.notify_super_admins(
        'Auto-Generated Warning',
        (select full_name || ' (' || employee_code || ') was absent 3+ consecutive days' from public.employee where id = p_employee_id),
        'warning'
      );
    end if;
  end if;

  return result;
end; $$;

-- Bulk day entry: apply the same Excel-style marking to many employees in ONE
-- round-trip (used by the "Bulk Day Entry" dialog). Each entry reuses the full
-- mark_attendance engine — including the DATE-EFFECTIVE site authorization
-- (emp_site_on_date), rating, auto-warnings — so bulk and single-cell marking
-- can never disagree.
--   p_entries: [{"employee_id": uuid, "date": "YYYY-MM-DD", "value": "10" | "A" | ""}]
-- Returns the number of applied entries.
create or replace function public.bulk_mark_attendance(p_entries jsonb)
returns integer language plpgsql
security definer set search_path = public
as $$
declare
  entry jsonb;
  v_emp uuid;
  v_date date;
  v_value text;
  applied integer := 0;
begin
  if not public.has_menu_permission('attendance') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;

  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'p_entries must be a JSON array';
  end if;

  for entry in select * from jsonb_array_elements(p_entries) loop
    v_emp := null; v_date := null; v_value := null;
    begin
      v_emp := (entry->>'employee_id')::uuid;
      v_date := (entry->>'date')::date;
      v_value := entry->>'value';
    exception when others then
      raise exception 'Invalid bulk entry: %', entry::text;
    end;

    if v_emp is null or v_date is null then
      raise exception 'Invalid bulk entry (missing employee_id or date): %', entry::text;
    end if;

    perform public.mark_attendance(v_emp, v_date, v_value);
    applied := applied + 1;
  end loop;

  return applied;
end; $$;

-- Full rating recompute from a month's attendance:
-- (worked days / working days excluding Fridays) * 5
create or replace function public.recalc_employee_rating(p_employee_id uuid, p_month text)
returns numeric language plpgsql
security definer set search_path = public
as $$
declare
  worked int;
  workdays int;
  new_rating numeric;
begin
  select count(*) into worked from public.attendance
    where employee_id = p_employee_id and to_char(date,'YYYY-MM') = p_month
      and status = 'present' and not is_hidden;
  select count(*) into workdays from generate_series(
    to_date(p_month || '-01','YYYY-MM-DD'),
    least(current_date, (to_date(p_month || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date),
    interval '1 day') d
  where extract(isodow from d) <> 5;

  new_rating := public.clamp_rating(case when workdays > 0 then (worked::numeric / workdays) * 5 else 5 end);
  update public.employee set rating = new_rating where id = p_employee_id;
  return new_rating;
end; $$;

-- Dashboard chart data: per-status counts for the last N months (incl current)
create or replace function public.get_monthly_attendance_summary(p_months int default 6)
returns table (month text, status text, count bigint) language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'Access denied'; end if;
  return query
    with months as (
      select to_char(date_trunc('month', current_date) - (n || ' month')::interval, 'YYYY-MM') as m
      from generate_series(0, p_months - 1) n
    )
    select months.m,
           a.status,
           count(*)::bigint
    from months
    join public.attendance a on to_char(a.date, 'YYYY-MM') = months.m
    join public.employee e on e.id = a.employee_id
    where not a.is_hidden and e.status <> 'deleted' and a.status <> 'not_marked'
    group by months.m, a.status
    order by months.m;
end; $$;

-- ============================================================================
-- 9b. WORKING HOURS REPORT RPC (Employee Working Hours module)
-- ----------------------------------------------------------------------------
-- One database-side aggregation answers "how many hours has this employee
-- worked in their life, split by month and site":
--   • opening_hours (historical balance from before PULSE tracking) +
--   • SUM(attendance.hours) over every non-hidden record, where each record's
--     site is resolved by emp_site_on_date() — the SAME date-effective transfer
--     rule the marking sheet uses (a day already marked at the old site before
--     the move was recorded stays at the old site).
-- Reconciliation guarantees: monthly total = sum of its site totals, and
-- lifetime = opening + sum of all monthly totals (never counted twice).
-- Requires the 'employees' menu permission (Working Hours shares it).
-- ============================================================================
create or replace function public.get_employee_working_hours(p_employee_id uuid)
returns jsonb language plpgsql
stable
security definer set search_path = public
as $$
declare
  emp record;
  v_opening numeric;
  v_tracked numeric;
  v_monthly jsonb;
begin
  if not public.has_menu_permission('working_hours') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;

  select e.*, s.name as site_name into emp
  from public.employee e
  left join public.site s on s.id = e.current_site_id
  where e.id = p_employee_id and e.status <> 'deleted';
  if emp.id is null then raise exception 'Employee not found'; end if;

  v_opening := coalesce(emp.opening_hours, 0);

  with recs as (
    select a.date,
           a.hours,
           public.emp_site_on_date(p_employee_id, a.date) as site_id
    from public.attendance a
    where a.employee_id = p_employee_id
      and not a.is_hidden
      and a.hours is not null
      and a.hours > 0
  ),
  site_month as (
    select extract(year from date)::int  as yr,
           extract(month from date)::int as mo,
           site_id,
           sum(hours)  as hrs,
           count(*)    as days
    from recs
    group by 1, 2, 3
  ),
  month_agg as (
    select sm.yr, sm.mo,
           sum(sm.hrs)::numeric  as total,
           sum(sm.days)::int     as days,
           jsonb_agg(
             jsonb_build_object(
               'site_id',     sm.site_id,
               'site_name',   coalesce(s.name, 'No site'),
               'total_hours', round(sm.hrs::numeric, 2)
             ) order by sm.hrs desc
           ) as sites
    from site_month sm
    left join public.site s on s.id = sm.site_id
    group by sm.yr, sm.mo
  )
  select
    coalesce((select round(sum(total), 2) from month_agg), 0),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'year',            yr,
          'month',           mo,
          'total_hours',     round(total, 2),
          'attendance_days', days,
          'sites',           sites
        ) order by yr desc, mo desc
      ) from month_agg
    ), '[]'::jsonb)
  into v_tracked, v_monthly;

  return jsonb_build_object(
    'employee_id',       emp.id,
    'full_name',         emp.full_name,
    'employee_code',     emp.employee_code,
    'position',          emp.position,
    'site_id',           emp.current_site_id,
    'site_name',         emp.site_name,
    'join_date',         emp.join_date,
    'status',            emp.status,
    'is_team_leader',    emp.is_team_leader,
    'photo',             emp.photo,
    'opening_hours',     round(v_opening, 2),
    'tracked_hours',     v_tracked,
    'lifetime_hours',    round(v_opening + v_tracked, 2),
    'monthly_breakdown', v_monthly
  );
end; $$;

-- ============================================================================
-- 10. LEAVE REQUEST RPCs
-- ============================================================================

create or replace function public.create_leave_request(
  p_employee_id uuid, p_leave_type text,
  p_start_date date, p_end_date date, p_total_days int, p_reason text,
  p_other_type_text text default null
)
returns public.leave_request language plpgsql
security definer set search_path = public
as $$
declare result public.leave_request;
declare emp public.employee;
begin
  if p_leave_type not in ('casual','sick','annual','emergency','marriage','other') then
    raise exception 'Invalid leave type';
  end if;
  if not public.is_staff() then raise exception 'Access denied'; end if;
  select * into emp from public.employee where id = p_employee_id;
  if emp.id is null then raise exception 'Employee not found'; end if;

  insert into public.leave_request
    (employee_id, leave_type, other_type_text, start_date, end_date, total_days, reason, status, created_by)
  values
    (p_employee_id, p_leave_type, nullif(p_other_type_text,''), p_start_date, p_end_date, p_total_days, p_reason, 'pending', auth.uid())
  returning * into result;

  perform public.notify_super_admins(
    'New Leave Request',
    emp.full_name || ' (' || emp.employee_code || ') requested ' ||
      coalesce(nullif(p_other_type_text,''), p_leave_type) || ' leave for ' || p_total_days || ' day(s)',
    'request'
  );
  return result;
end; $$;

create or replace function public.review_leave_request(p_id uuid, p_approve boolean)
returns void language plpgsql
security definer set search_path = public
as $$
declare req public.leave_request;
begin
  if not public.is_super_admin() then raise exception 'Only super admins can review requests'; end if;
  select * into req from public.leave_request where id = p_id;
  if req.id is null then raise exception 'Request not found'; end if;
  if req.status <> 'pending' then raise exception 'Only pending requests can be reviewed'; end if;

  update public.leave_request
    set status = case when p_approve then 'approved' else 'rejected' end,
        reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_id;

  if req.created_by is not null then
    insert into public.notification (profile_id, title, message, type)
    values (req.created_by,
      'Leave Request ' || case when p_approve then 'Approved' else 'Rejected' end,
      'The leave request (' || coalesce(nullif(req.other_type_text,''), req.leave_type) || ', ' || req.total_days || ' day(s)) has been ' ||
        case when p_approve then 'approved.' else 'rejected.' end,
      'request');
  end if;
end; $$;

-- ============================================================================
-- 11. WARNING + FINE RPCs
-- ============================================================================

create or replace function public.issue_warning(p_employee_id uuid, p_reason text)
returns public.warning language plpgsql
security definer set search_path = public
as $$
declare result public.warning;
declare emp public.employee;
begin
  if not public.has_menu_permission('notifications') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;
  select * into emp from public.employee where id = p_employee_id;
  if emp.id is null then raise exception 'Employee not found'; end if;

  insert into public.warning (employee_id, reason, created_by) values (p_employee_id, p_reason, auth.uid())
  returning * into result;

  update public.employee set rating = public.clamp_rating(rating - 0.5) where id = p_employee_id;

  perform public.notify_super_admins('New Warning Issued',
    emp.full_name || ' (' || emp.employee_code || ') received a warning: ' || p_reason, 'warning');
  return result;
end; $$;

create or replace function public.issue_fine(p_employee_id uuid, p_reason text, p_amount numeric)
returns public.fine language plpgsql
security definer set search_path = public
as $$
declare result public.fine;
declare emp public.employee;
begin
  if not public.has_menu_permission('notifications') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;
  if p_amount < 0 then raise exception 'Fine amount cannot be negative'; end if;
  select * into emp from public.employee where id = p_employee_id;
  if emp.id is null then raise exception 'Employee not found'; end if;

  insert into public.fine (employee_id, reason, amount, created_by) values (p_employee_id, p_reason, p_amount, auth.uid())
  returning * into result;

  update public.employee set rating = public.clamp_rating(rating - 1.0) where id = p_employee_id;

  perform public.notify_super_admins('New Fine Issued',
    emp.full_name || ' (' || emp.employee_code || ') was fined SAR ' || p_amount::text || ': ' || p_reason, 'fine');
  return result;
end; $$;

-- ============================================================================
-- 12. NOTIFICATION RPCs
-- ============================================================================

create or replace function public.mark_all_notifications_read(p_type text default null)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  update public.notification set read = true
  where profile_id = auth.uid() and not read
    and (p_type is null or type = p_type);
end; $$;

-- ============================================================================
-- 13. UNIFORM REGISTRY RPCs
-- ============================================================================

create or replace function public.create_uniform_entry(
  p_employee_id uuid, p_document_type text, p_document_number text, p_items jsonb,
  p_site_name text default null, p_team_leader_name text default null,
  p_created_at timestamptz default now(), p_token_number int default null,
  p_is_renewal boolean default false, p_previous_token_id int default null
)
returns public.uniform_registry language plpgsql
security definer set search_path = public
as $$
declare
  result public.uniform_registry;
  emp public.employee;
  v_uniform_id int;
  v_token int;
  -- tolerate double-encoded payloads (see create_employee)
  v_items jsonb := case when jsonb_typeof(p_items) = 'string'
                        then (p_items #>> '{}')::jsonb else p_items end;
begin
  if not public.has_menu_permission('uniform_registry') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;
  if p_document_type not in ('id','passport') then raise exception 'Invalid document type'; end if;
  select * into emp from public.employee where id = p_employee_id;
  if emp.id is null then raise exception 'Employee not found'; end if;

  select coalesce(max(uniform_id),0) + 1 into v_uniform_id from public.uniform_registry;
  select coalesce(max(token_number),0) + 1 into v_token from public.uniform_registry;
  if p_token_number is not null and p_token_number > 0 then v_token := p_token_number; end if;
  if exists (select 1 from public.uniform_registry where uniform_id = v_uniform_id) then
    v_uniform_id := v_uniform_id + 1;
  end if;

  insert into public.uniform_registry
    (uniform_id, token_number, employee_id, employee_name, document_type, document_number,
     items, site_name, team_leader_name, is_renewal, previous_token_id, created_at, renewal_date)
  values
    (v_uniform_id, v_token, p_employee_id, emp.full_name, p_document_type, p_document_number,
     v_items, nullif(p_site_name,''), nullif(p_team_leader_name,''), p_is_renewal, p_previous_token_id,
     p_created_at, p_created_at + interval '6 months')
  returning * into result;
  return result;
end; $$;

create or replace function public.update_uniform_entry(
  p_id uuid, p_token_number int, p_document_type text, p_document_number text,
  p_items jsonb, p_site_name text default null, p_team_leader_name text default null,
  p_created_at timestamptz default now()
)
returns public.uniform_registry language plpgsql
security definer set search_path = public
as $$
declare result public.uniform_registry;
-- tolerate double-encoded payloads (see create_employee)
declare v_items jsonb := case when jsonb_typeof(p_items) = 'string'
                               then (p_items #>> '{}')::jsonb else p_items end;
begin
  if not public.has_menu_permission('uniform_registry') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;
  if p_document_type not in ('id','passport') then raise exception 'Invalid document type'; end if;
  update public.uniform_registry set
    token_number = p_token_number,
    document_type = p_document_type,
    document_number = p_document_number,
    items = v_items,
    site_name = nullif(p_site_name,''),
    team_leader_name = nullif(p_team_leader_name,''),
    created_at = p_created_at,
    renewal_date = p_created_at + interval '6 months'
  where id = p_id and not is_deleted and not is_hidden
  returning * into result;
  if result.id is null then raise exception 'Entry not found'; end if;
  return result;
end; $$;

create or replace function public.delete_uniform_entry(p_id uuid)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not public.has_menu_permission('uniform_registry') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;
  update public.uniform_registry set is_deleted = true where id = p_id and not is_deleted;
end; $$;

-- ============================================================================
-- 14. REALTIME PUBLICATION
-- ============================================================================
-- Adds every operational table to the Supabase Realtime stream so the UI gets
-- live updates (postgres_changes) as data changes anywhere.
do $$
begin
  alter publication supabase_realtime add table public.profiles;
  alter publication supabase_realtime add table public.menu_permission;
  alter publication supabase_realtime add table public.admin_site;
  alter publication supabase_realtime add table public.site;
  alter publication supabase_realtime add table public.camp;
  alter publication supabase_realtime add table public.employee;
  alter publication supabase_realtime add table public.attendance;
  alter publication supabase_realtime add table public.notification;
  alter publication supabase_realtime add table public.warning;
  alter publication supabase_realtime add table public.fine;
  alter publication supabase_realtime add table public.leave_request;
  alter publication supabase_realtime add table public.cancellation_request;
  alter publication supabase_realtime add table public.uniform_registry;
  alter publication supabase_realtime add table public.site_transfer;
exception
  when duplicate_object then null; -- already in publication
end $$;

-- ============================================================================
-- 15. FUNCTION GRANTS (final pass)
-- ============================================================================
-- The grant block in section 3 only covers functions that existed when it ran.
-- The RPCs in sections 6–13 are created AFTER it, so they fall back to the
-- Postgres default (PUBLIC = everyone, including anon). Re-applying the grants
-- here — at the very end — keeps the rule true for every function no matter
-- where it lives in this file:
--   • authenticated + service_role may call every business function
--     (the permission guards live inside each function)
--   • anonymous users may ONLY check whether initial setup is needed
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated, service_role;
grant execute on function public.has_any_profiles() to anon;


-- ============================================================================
-- 20261103 — Trade & Salary system
-- ----------------------------------------------------------------------------
-- Implements the confirmed business rules:
--   • Eligibility is OR: 6 calendar months from join_date OR 1,000 lifetime
--     working hours (opening balance INCLUDED), whichever happens first.
--   • Hours are split at the qualification point (mid-shift for the 1,000-hour
--     route; whole-day for the six-month anniversary date).
--   • No retroactive rate changes — rates are effective-dated
--     (trade_rate_history), assignments are effective-dated
--     (employee_salary_assignment).
--   • Site attribution is historical: every hour belongs to the site the
--     employee actually worked at on that date (emp_site_on_date).
--   • Payroll is a snapshot: drafts recalculate live, finalization locks the
--     calculation, reopening is audited.
--
-- ADDITIVE only — no existing table or column is dropped or narrowed.
-- Idempotent: safe to run any number of times.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------------

-- 1a. Trades (Electrician, Plumber, …) --------------------------------------
create table if not exists public.trades (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- case/whitespace-insensitive unique trade name
create unique index if not exists trades_name_unique_idx
  on public.trades (lower(trim(name)));

-- 1b. Employee columns (trade + salary classification) ----------------------
alter table public.employee add column if not exists trade_id uuid references public.trades(id);
alter table public.employee add column if not exists salary_role text not null default 'standard';
alter table public.employee drop constraint if exists employee_salary_role_check;
alter table public.employee add constraint employee_salary_role_check
  check (salary_role in ('standard', 'team_leader', 'supervisor'));

-- 1c. Effective-dated trade rates --------------------------------------------
-- An admin edits a rate → the previous period is closed (effective_to) and a
-- new record starts. Historical payroll never re-prices itself silently.
create table if not exists public.trade_rate_history (
  id               uuid primary key default gen_random_uuid(),
  trade_id         uuid not null references public.trades(id) on delete cascade,
  salary_role      text not null check (salary_role in ('standard', 'team_leader', 'supervisor')),
  experience_tier  text not null check (experience_tier in ('below_threshold', 'qualified')),
  hourly_rate      numeric(10,2) not null check (hourly_rate >= 0),
  effective_from   date not null,
  effective_to     date,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);
create index if not exists idx_trade_rate_trade on public.trade_rate_history(trade_id);
create index if not exists idx_trade_rate_cell on public.trade_rate_history(trade_id, salary_role, experience_tier, effective_from);

-- 1d. Effective-dated employee trade/role assignments ------------------------
-- Changing trade or salary role mid-month keeps old work at the old
-- classification — the old assignment applies before the effective date.
create table if not exists public.employee_salary_assignment (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employee(id) on delete cascade,
  trade_id       uuid not null references public.trades(id) on delete restrict,
  salary_role    text not null check (salary_role in ('standard', 'team_leader', 'supervisor')),
  effective_from date not null,
  effective_to   date,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index if not exists idx_salary_assign_emp on public.employee_salary_assignment(employee_id, effective_from);

-- 1e. Payroll period (one per month) -----------------------------------------
create table if not exists public.payroll_period (
  id           uuid primary key default gen_random_uuid(),
  year         int  not null check (year between 2000 and 2100),
  month        int  not null check (month between 1 and 12),
  status       text not null default 'draft' check (status in ('draft', 'finalized')),
  created_by   uuid,
  finalized_by uuid,
  finalized_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (year, month)
);

-- 1f. Payroll employee (one per employee per month — settlement unit) --------
create table if not exists public.payroll_employee (
  id                      uuid primary key default gen_random_uuid(),
  payroll_period_id       uuid not null references public.payroll_period(id) on delete cascade,
  employee_id             uuid not null references public.employee(id) on delete cascade,
  opening_lifetime_hours  numeric(12,2) not null default 0,
  closing_lifetime_hours  numeric(12,2) not null default 0,
  total_hours             numeric(12,2) not null default 0,
  below_threshold_hours   numeric(12,2) not null default 0,
  qualified_hours         numeric(12,2) not null default 0,
  unrated_hours           numeric(12,2) not null default 0,
  unassigned_hours        numeric(12,2) not null default 0,
  gross_salary            numeric(12,2) not null default 0,
  advance                 numeric(12,2) not null default 0 check (advance >= 0),
  deduction               numeric(12,2) not null default 0 check (deduction >= 0),
  net_salary              numeric(12,2) not null default 0,
  payment_status          text not null default 'unpaid' check (payment_status in ('unpaid', 'paid')),
  paid_at                 timestamptz,
  paid_by                 uuid,
  notes                   text,
  trade_id_snapshot       uuid,
  salary_role_snapshot    text,
  updated_at              timestamptz not null default now(),
  unique (payroll_period_id, employee_id)
);
create index if not exists idx_payroll_emp_period on public.payroll_employee(payroll_period_id);

-- 1g. Payroll employee × site (Salary Sheet site-group rows) ------------------
create table if not exists public.payroll_employee_site (
  id                    uuid primary key default gen_random_uuid(),
  payroll_employee_id   uuid not null references public.payroll_employee(id) on delete cascade,
  site_id               uuid,
  site_name_snapshot    text not null,
  total_hours           numeric(12,2) not null default 0,
  below_threshold_hours numeric(12,2) not null default 0,
  qualified_hours       numeric(12,2) not null default 0,
  standard_hours        numeric(12,2) not null default 0,
  team_leader_hours     numeric(12,2) not null default 0,
  supervisor_hours      numeric(12,2) not null default 0,
  gross_salary          numeric(12,2) not null default 0,
  has_missing_rate      boolean not null default false,
  calculation_details   jsonb
);
-- site_id is nullable (hours at no site) — a plain UNIQUE would treat NULLs as
-- distinct, so uniqueness is enforced on the coalesced key.
create unique index if not exists idx_payroll_emp_site_key
  on public.payroll_employee_site (payroll_employee_id, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- 1h. Salary lines (one row = hours × one rate; explainable payroll) ---------
create table if not exists public.payroll_salary_line (
  id                  uuid primary key default gen_random_uuid(),
  payroll_employee_id uuid not null references public.payroll_employee(id) on delete cascade,
  site_id             uuid,
  site_name_snapshot  text not null,
  attendance_date     date not null,
  trade_id            uuid,
  trade_name_snapshot text not null,
  salary_role_snapshot text not null,
  experience_tier     text not null check (experience_tier in ('below_threshold', 'qualified')),
  hours               numeric(12,2) not null check (hours > 0),
  hourly_rate         numeric(10,2) not null,
  gross_amount        numeric(12,2) not null
);
create index if not exists idx_payroll_line_emp on public.payroll_salary_line(payroll_employee_id);

-- 1i. Payroll audit log (finalize / reopen / payment / backdated rates) -------
create table if not exists public.payroll_audit_log (
  id          uuid primary key default gen_random_uuid(),
  period_id   uuid references public.payroll_period(id) on delete cascade,
  action      text not null,
  actor_id    uuid,
  actor_name  text,
  details     text,
  -- clock_timestamp(): events logged inside one transaction still order
  -- chronologically (now() is transaction-stable and would tie)
  created_at  timestamptz not null default clock_timestamp()
);
create index if not exists idx_payroll_audit_period on public.payroll_audit_log(period_id, created_at);

-- rate-change audit (works even outside payroll periods)
create table if not exists public.trade_rate_audit_log (
  id          uuid primary key default gen_random_uuid(),
  trade_id    uuid not null references public.trades(id) on delete cascade,
  action      text not null,
  actor_id    uuid,
  actor_name  text,
  details     text,
  created_at  timestamptz not null default clock_timestamp()
);
-- re-run safety: fix tables created by an earlier partial run of this migration
alter table public.payroll_audit_log   alter column created_at set default clock_timestamp();
alter table public.trade_rate_audit_log alter column created_at set default clock_timestamp();

-- ---------------------------------------------------------------------------
-- 2. NON-OVERLAP GUARDS (triggers — no extension required)
-- ---------------------------------------------------------------------------

create or replace function public.trg_trade_rate_no_overlap()
returns trigger language plpgsql as $$
declare v_overlap int;
begin
  select count(*) into v_overlap from public.trade_rate_history r
  where r.trade_id = new.trade_id
    and r.salary_role = new.salary_role
    and r.experience_tier = new.experience_tier
    and r.id <> new.id
    and coalesce(new.effective_to, 'infinity'::date) >= r.effective_from
    and coalesce(r.effective_to, 'infinity'::date) >= new.effective_from;
  if v_overlap > 0 then
    raise exception 'Overlapping rate periods for trade % (% / %) — close the previous period first',
      new.trade_id, new.salary_role, new.experience_tier;
  end if;
  return new;
end; $$;
drop trigger if exists trade_rate_no_overlap on public.trade_rate_history;
create trigger trade_rate_no_overlap before insert or update on public.trade_rate_history
  for each row execute function public.trg_trade_rate_no_overlap();

create or replace function public.trg_salary_assign_no_overlap()
returns trigger language plpgsql as $$
declare v_overlap int;
begin
  select count(*) into v_overlap from public.employee_salary_assignment a
  where a.employee_id = new.employee_id
    and a.id <> new.id
    and coalesce(new.effective_to, 'infinity'::date) >= a.effective_from
    and coalesce(a.effective_to, 'infinity'::date) >= new.effective_from;
  if v_overlap > 0 then
    raise exception 'Overlapping trade assignments for employee % — close the previous assignment first',
      new.employee_id;
  end if;
  return new;
end; $$;
drop trigger if exists salary_assign_no_overlap on public.employee_salary_assignment;
create trigger salary_assign_no_overlap before insert or update on public.employee_salary_assignment
  for each row execute function public.trg_salary_assign_no_overlap();

-- trades.updated_at touch
drop trigger if exists trg_trades_touch on public.trades;
create trigger trg_trades_touch before update on public.trades
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. RLS — salary data is RPC-only; trades readable by staff
-- ---------------------------------------------------------------------------
alter table public.trades                  enable row level security;
alter table public.trade_rate_history      enable row level security;
alter table public.employee_salary_assignment enable row level security;
alter table public.payroll_period          enable row level security;
alter table public.payroll_employee        enable row level security;
alter table public.payroll_employee_site   enable row level security;
alter table public.payroll_salary_line     enable row level security;
alter table public.payroll_audit_log       enable row level security;
alter table public.trade_rate_audit_log    enable row level security;

drop policy if exists trades_select on public.trades;
create policy trades_select on public.trades for select using (public.is_staff());

-- payroll / rate history / assignments: NO direct table policies — every read
-- and write goes through the security-definer RPCs below, which check menu
-- permissions (has_menu_permission) per operation.

-- ---------------------------------------------------------------------------
-- 4. HELPER LOOKUPS
-- ---------------------------------------------------------------------------

-- Trade + salary role applicable to an employee on a given date.
-- Prefers the effective-dated assignment; falls back to the employee row
-- (legacy employees mapped before the assignment table existed).
create or replace function public.emp_trade_on_date(p_employee_id uuid, p_date date)
returns jsonb language sql stable
security definer set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object('trade_id', a.trade_id, 'salary_role', a.salary_role)
     from public.employee_salary_assignment a
     where a.employee_id = p_employee_id
       and a.effective_from <= p_date
       and (a.effective_to is null or a.effective_to >= p_date)
     order by a.effective_from desc limit 1),
    (select jsonb_build_object('trade_id', e.trade_id, 'salary_role', e.salary_role)
     from public.employee e where e.id = p_employee_id)
  );
$$;

-- Effective hourly rate for a trade × role × tier on a date (null = unrated).
create or replace function public.trade_rate_on(
  p_trade_id uuid, p_salary_role text, p_experience_tier text, p_date date
) returns numeric language sql stable
security definer set search_path = public
as $$
  select r.hourly_rate
  from public.trade_rate_history r
  where r.trade_id = p_trade_id
    and r.salary_role = p_salary_role
    and r.experience_tier = p_experience_tier
    and r.effective_from <= p_date
    and (r.effective_to is null or r.effective_to >= p_date)
  order by r.effective_from desc limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 5. ELIGIBILITY
--    Q = min(join_date + 6 calendar months, date lifetime hours reach 1,000)
--    Opening balance counts toward the 1,000 hours; >= 1,000 opening hours
--    qualifies from the employment start date.
-- ---------------------------------------------------------------------------
create or replace function public.get_employee_salary_eligibility(
  p_employee_id uuid, p_as_of date default null
) returns jsonb language plpgsql stable
security definer set search_path = public
as $$
declare
  emp record;
  v_as_of date := coalesce(p_as_of, (now() at time zone 'Asia/Dubai')::date);
  v_six_month date;
  v_threshold_date date;
  v_tracked numeric;
  v_lifetime numeric;
  v_opening numeric;
  v_qual_date date;
  v_reason text;
  v_current jsonb;
  v_current_rate numeric;
  v_tier text;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;

  select e.*, t.name as trade_name into emp
  from public.employee e
  left join public.trades t on t.id = e.trade_id
  where e.id = p_employee_id and e.status <> 'deleted';
  if emp.id is null then raise exception 'Employee not found'; end if;

  v_opening := coalesce(emp.opening_hours, 0);

  -- six calendar months from employment start (Postgres clamps month-end:
  -- Aug 31 + 6 months = Feb 28/29)
  v_six_month := (coalesce(emp.join_date, emp.created_at::date) + interval '6 months')::date;

  -- first date where opening + cumulative attendance hours reach the threshold
  select d, cum into v_threshold_date, v_lifetime from (
    select a.date as d,
           v_opening + sum(a.hours) over (order by a.date) as cum
    from public.attendance a
    where a.employee_id = p_employee_id
      and not a.is_hidden and a.hours is not null and a.hours > 0
    order by a.date
  ) t where cum >= 1000 order by d limit 1;

  select coalesce(sum(a.hours), 0) into v_tracked
  from public.attendance a
  where a.employee_id = p_employee_id
    and not a.is_hidden and a.hours is not null and a.hours > 0;

  v_lifetime := round(v_opening + v_tracked, 2);

  -- qualification = the EARLIER route (opening >= 1000 → from employment start)
  if v_opening >= 1000 then
    v_qual_date := coalesce(emp.join_date, emp.created_at::date);
    v_reason := 'opening_balance';
  else
    v_qual_date := least(v_six_month, coalesce(v_threshold_date, '9999-12-31'::date));
    if v_qual_date = '9999-12-31'::date then
      v_qual_date := null;
    elsif v_threshold_date is not null and v_threshold_date < v_six_month then
      v_reason := 'thousand_hours';
    else
      v_reason := 'six_months';
    end if;
  end if;

  -- current applicable rate (trade × role × current tier, as of v_as_of)
  v_current := public.emp_trade_on_date(p_employee_id, v_as_of);
  if (v_current->>'trade_id') is not null then
    v_tier := case when v_qual_date is not null and v_as_of >= v_qual_date
                   then 'qualified' else 'below_threshold' end;
    v_current_rate := public.trade_rate_on(
      (v_current->>'trade_id')::uuid, v_current->>'salary_role', v_tier, v_as_of);
  end if;

  return jsonb_build_object(
    'employee_id',        emp.id,
    'full_name',          emp.full_name,
    'employee_code',      emp.employee_code,
    'join_date',          emp.join_date,
    'opening_hours',      round(v_opening, 2),
    'tracked_hours',      round(v_tracked, 2),
    'lifetime_hours',     v_lifetime,
    'six_month_date',     v_six_month,
    'threshold_hours',    1000,
    'threshold_date',     v_threshold_date,
    'hours_to_threshold', greatest(0, round(1000 - v_lifetime, 2)),
    'progress_percent',   least(100, round(100.0 * v_lifetime / 1000, 1)),
    'qualified',          v_qual_date is not null and v_as_of >= v_qual_date,
    'qualification_date', v_qual_date,
    'qualification_reason', v_reason,
    'as_of',              v_as_of,
    'trade_id',           (v_current->>'trade_id'),
    'trade_name',         case when (v_current->>'trade_id') is not null
                               then coalesce((select name from public.trades where id = (v_current->>'trade_id')::uuid), null)
                          end,
    'salary_role',        coalesce(v_current->>'salary_role', emp.salary_role),
    'current_rate',       v_current_rate
  );
end; $$;

-- Assignment history for one employee (newest first).
create or replace function public.get_employee_salary_history(p_employee_id uuid)
returns jsonb language plpgsql stable
security definer set search_path = public
as $$
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;
  return (
    select coalesce(jsonb_agg(
             jsonb_build_object(
               'id', a.id,
               'employee_id', a.employee_id,
               'employee_name', e.full_name,
               'trade_id', a.trade_id,
               'trade_name', t.name,
               'salary_role', a.salary_role,
               'effective_from', a.effective_from,
               'effective_to', a.effective_to,
               'created_at', a.created_at
             ) order by a.effective_from desc
           ), '[]'::jsonb)
    from public.employee_salary_assignment a
    join public.employee e on e.id = a.employee_id
    join public.trades t on t.id = a.trade_id
    where a.employee_id = p_employee_id
  );
end; $$;

-- ---------------------------------------------------------------------------
-- 6. THE CALCULATION ENGINE (single source of truth — frontend never computes)
-- ---------------------------------------------------------------------------
create or replace function public.calculate_employee_payroll(
  p_employee_id uuid, p_year int, p_month int
) returns jsonb language plpgsql stable
security definer set search_path = public
as $$
declare
  emp record;
  v_month_start date := make_date(p_year, p_month, 1);
  v_month_end   date := (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day')::date;
  v_six_month date;
  v_cum numeric;              -- lifetime hours BEFORE the current record
  v_opening numeric;
  v_total_hours numeric := 0;
  v_opening_lifetime numeric := 0;
  v_closing_lifetime numeric := 0;
  v_b numeric; v_q numeric;   -- below-threshold / qualified hours of the record
  v_day_qualified boolean;
  v_rate numeric;
  v_assignment jsonb;
  v_trade_id uuid; v_role text; v_trade_name text;
  v_site_id uuid; v_site_name text;
  r record;
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_unrated numeric := 0;
  v_unassigned numeric := 0;
  v_gross numeric := 0;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;

  select e.* into emp from public.employee e
  where e.id = p_employee_id and e.status <> 'deleted';
  if emp.id is null then raise exception 'Employee not found'; end if;

  v_opening := coalesce(emp.opening_hours, 0);
  v_six_month := (coalesce(emp.join_date, emp.created_at::date) + interval '6 months')::date;
  v_cum := v_opening;

  for r in
    select a.date, a.hours, public.emp_site_on_date(p_employee_id, a.date) as site_id
    from public.attendance a
    where a.employee_id = p_employee_id
      and not a.is_hidden
      and a.hours is not null and a.hours > 0
      and a.date <= v_month_end          -- history after the month cannot affect cumulation
    order by a.date
  loop
    -- resolve trade & role for THAT date (effective-dated, historical)
    v_assignment := public.emp_trade_on_date(p_employee_id, r.date);
    v_trade_id := (v_assignment->>'trade_id')::uuid;
    v_role     := v_assignment->>'salary_role';

    -- tier split at the qualification point
    --   • whole-day qualified on/after the six-month anniversary (start of day)
    --   • mid-record split when the 1,000-hour threshold is crossed
    --   • already >= 1,000 cumulative (incl. opening) → qualified
    v_day_qualified := (r.date >= v_six_month) or (v_cum >= 1000);
    if v_day_qualified then
      v_b := 0; v_q := r.hours;
    elsif v_cum + r.hours >= 1000 then
      v_b := 1000 - v_cum;                -- hours still below the threshold
      v_q := r.hours - v_b;               -- remainder at the qualified rate
    else
      v_b := r.hours; v_q := 0;
    end if;
    v_cum := v_cum + r.hours;

    if r.date < v_month_start then
      v_opening_lifetime := v_cum;        -- lifetime balance entering the month
    else
      v_total_hours := v_total_hours + r.hours;
      v_closing_lifetime := v_cum;

      if v_trade_id is null then
        v_unassigned := v_unassigned + r.hours;
      else
        select name into v_trade_name from public.trades where id = v_trade_id;
        select coalesce(s.name, 'No site') into v_site_name
        from public.site s where s.id = r.site_id;
        -- below-threshold segment
        if v_b > 0 then
          v_rate := public.trade_rate_on(v_trade_id, v_role, 'below_threshold', r.date);
          if v_rate is null then v_unrated := v_unrated + v_b;
          else
            v_line := jsonb_build_object(
              'site_id', r.site_id, 'site_name', v_site_name, 'date', r.date,
              'trade_id', v_trade_id, 'trade_name', v_trade_name,
              'salary_role', v_role, 'experience_tier', 'below_threshold',
              'hours', round(v_b, 2), 'hourly_rate', v_rate,
              'gross_amount', round(v_b * v_rate, 2));
            v_lines := v_lines || v_line;
            v_gross := v_gross + (v_line->>'gross_amount')::numeric;
          end if;
        end if;
        -- qualified segment
        if v_q > 0 then
          v_rate := public.trade_rate_on(v_trade_id, v_role, 'qualified', r.date);
          if v_rate is null then v_unrated := v_unrated + v_q;
          else
            v_line := jsonb_build_object(
              'site_id', r.site_id, 'site_name', v_site_name, 'date', r.date,
              'trade_id', v_trade_id, 'trade_name', v_trade_name,
              'salary_role', v_role, 'experience_tier', 'qualified',
              'hours', round(v_q, 2), 'hourly_rate', v_rate,
              'gross_amount', round(v_q * v_rate, 2));
            v_lines := v_lines || v_line;
            v_gross := v_gross + (v_line->>'gross_amount')::numeric;
          end if;
        end if;
      end if;
    end if;
  end loop;

  if v_opening_lifetime = 0 then v_opening_lifetime := v_opening; end if;
  if v_closing_lifetime = 0 then v_closing_lifetime := v_opening_lifetime; end if;

  return jsonb_build_object(
    'employee_id',              p_employee_id,
    'total_hours',              round(v_total_hours, 2),
    'opening_lifetime_hours',   round(v_opening_lifetime, 2),
    'closing_lifetime_hours',   round(v_closing_lifetime, 2),
    'below_threshold_hours',    0,  -- filled by the aggregates below
    'qualified_hours',          0,
    'unrated_hours',            round(v_unrated, 2),
    'unassigned_hours',         round(v_unassigned, 2),
    'gross_salary',             round(v_gross, 2),
    'lines',                    v_lines
  );
end; $$;

-- ---------------------------------------------------------------------------
-- 7. PAYROLL GENERATION / LIFECYCLE
-- ---------------------------------------------------------------------------

-- Internal: recalculate one employee's month into the (draft) period.
-- Preserves manually entered advance / deduction / notes / payment state.
create or replace function public.payroll_upsert_employee(
  p_period public.payroll_period, p_employee_id uuid
) returns void language plpgsql
security definer set search_path = public
as $$
declare
  emp record;
  calc jsonb;
  v_pe public.payroll_employee;
  v_pe_id uuid;
  v_site jsonb;
  v_line jsonb;
  v_role_hours numeric;
  v_tier_hours numeric;
  v_site_row jsonb;
  v_key text;
  v_sites jsonb := '{}'::jsonb;   -- coalesced site key → aggregate object
  v_agg jsonb;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;

  select e.*, t.name as trade_name into emp
  from public.employee e left join public.trades t on t.id = e.trade_id
  where e.id = p_employee_id and e.status <> 'deleted';
  if emp.id is null then return; end if;

  calc := public.calculate_employee_payroll(p_employee_id, p_period.year, p_period.month);

  -- aggregate lines into site buckets
  for v_line in select * from jsonb_array_elements(calc->'lines') loop
    v_key := coalesce(v_line->>'site_id', '__none__');
    v_agg := v_sites->v_key;
    if v_agg is null then
      v_agg := jsonb_build_object(
        'site_id', (v_line->'site_id'),
        'site_name', v_line->>'site_name',
        'total_hours', 0, 'below_threshold_hours', 0, 'qualified_hours', 0,
        'standard_hours', 0, 'team_leader_hours', 0, 'supervisor_hours', 0,
        'gross_salary', 0, 'has_missing_rate', false);
    end if;
    v_agg := jsonb_set(v_agg, '{total_hours}',
      to_jsonb(round(((v_agg->>'total_hours')::numeric + (v_line->>'hours')::numeric), 2)));
    v_tier_hours := (v_line->>'hours')::numeric;
    v_agg := jsonb_set(v_agg, array[(v_line->>'experience_tier') || '_hours'],
      to_jsonb(round(((v_agg->((v_line->>'experience_tier') || '_hours'))::numeric + v_tier_hours), 2)));
    v_role_hours := (v_agg->((v_line->>'salary_role') || '_hours'))::numeric + v_tier_hours;
    v_agg := jsonb_set(v_agg, array[(v_line->>'salary_role') || '_hours'], to_jsonb(round(v_role_hours, 2)));
    v_agg := jsonb_set(v_agg, '{gross_salary}',
      to_jsonb(round(((v_agg->>'gross_salary')::numeric + (v_line->>'gross_amount')::numeric), 2)));
    v_sites := jsonb_set(v_sites, array[v_key], v_agg);
  end loop;

  -- unassigned/unrated hours still appear under "No site" so hours reconcile
  if (calc->>'unassigned_hours')::numeric > 0 or (calc->>'unrated_hours')::numeric > 0 then
    v_agg := v_sites->'__none__';
    if v_agg is null then
      v_agg := jsonb_build_object(
        'site_id', null, 'site_name', 'No site',
        'total_hours', 0, 'below_threshold_hours', 0, 'qualified_hours', 0,
        'standard_hours', 0, 'team_leader_hours', 0, 'supervisor_hours', 0,
        'gross_salary', 0, 'has_missing_rate', false);
    end if;
    v_agg := jsonb_set(v_agg, '{total_hours}', to_jsonb(round(
      (v_agg->>'total_hours')::numeric + (calc->>'unassigned_hours')::numeric + (calc->>'unrated_hours')::numeric, 2)));
    if (calc->>'unrated_hours')::numeric > 0 then
      v_agg := jsonb_set(v_agg, '{has_missing_rate}', 'true');
    end if;
    v_sites := jsonb_set(v_sites, array['__none__'], v_agg);
  end if;

  -- upsert the employee settlement row (adjustments preserved)
  insert into public.payroll_employee (
    payroll_period_id, employee_id,
    opening_lifetime_hours, closing_lifetime_hours,
    total_hours, unrated_hours, unassigned_hours, gross_salary,
    trade_id_snapshot, salary_role_snapshot, net_salary
  ) values (
    p_period.id, p_employee_id,
    (calc->>'opening_lifetime_hours')::numeric, (calc->>'closing_lifetime_hours')::numeric,
    (calc->>'total_hours')::numeric,
    (calc->>'unrated_hours')::numeric, (calc->>'unassigned_hours')::numeric,
    (calc->>'gross_salary')::numeric,
    emp.trade_id, emp.salary_role,
    (calc->>'gross_salary')::numeric
  )
  on conflict (payroll_period_id, employee_id) do update set
    opening_lifetime_hours = excluded.opening_lifetime_hours,
    closing_lifetime_hours = excluded.closing_lifetime_hours,
    total_hours            = excluded.total_hours,
    unrated_hours          = excluded.unrated_hours,
    unassigned_hours       = excluded.unassigned_hours,
    gross_salary           = excluded.gross_salary,
    trade_id_snapshot      = excluded.trade_id_snapshot,
    salary_role_snapshot   = excluded.salary_role_snapshot,
    net_salary             = excluded.gross_salary
                              - public.payroll_employee.advance
                              - public.payroll_employee.deduction,
    updated_at             = now()
  returning * into v_pe;
  v_pe_id := v_pe.id;

  -- refresh the pure-calculation children (site rows + lines)
  delete from public.payroll_employee_site where payroll_employee_id = v_pe_id;
  delete from public.payroll_salary_line  where payroll_employee_id = v_pe_id;

  for v_key in select jsonb_object_keys(v_sites) loop
    v_site_row := v_sites->v_key;
    insert into public.payroll_employee_site (
      payroll_employee_id, site_id, site_name_snapshot,
      total_hours, below_threshold_hours, qualified_hours,
      standard_hours, team_leader_hours, supervisor_hours,
      gross_salary, has_missing_rate, calculation_details
    ) values (
      v_pe_id,
      nullif(v_key, '__none__')::uuid,
      v_site_row->>'site_name',
      (v_site_row->>'total_hours')::numeric,
      (v_site_row->>'below_threshold_hours')::numeric,
      (v_site_row->>'qualified_hours')::numeric,
      (v_site_row->>'standard_hours')::numeric,
      (v_site_row->>'team_leader_hours')::numeric,
      (v_site_row->>'supervisor_hours')::numeric,
      (v_site_row->>'gross_salary')::numeric,
      coalesce((v_site_row->>'has_missing_rate')::boolean, false),
      v_site_row
    );
  end loop;

  for v_line in select * from jsonb_array_elements(calc->'lines') loop
    insert into public.payroll_salary_line (
      payroll_employee_id, site_id, site_name_snapshot, attendance_date,
      trade_id, trade_name_snapshot, salary_role_snapshot, experience_tier,
      hours, hourly_rate, gross_amount
    ) values (
      v_pe_id,
      (v_line->>'site_id')::uuid,
      v_line->>'site_name',
      (v_line->>'date')::date,
      (v_line->>'trade_id')::uuid,
      v_line->>'trade_name',
      v_line->>'salary_role',
      v_line->>'experience_tier',
      (v_line->>'hours')::numeric,
      (v_line->>'hourly_rate')::numeric,
      (v_line->>'gross_amount')::numeric
    );
  end loop;
end; $$;

-- Generate (or refresh) a month's draft payroll.
create or replace function public.generate_payroll_period(p_year int, p_month int)
returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_period public.payroll_period;
  v_month_end date := (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day')::date;
  v_emp record;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;

  insert into public.payroll_period (year, month, created_by)
  values (p_year, p_month, auth.uid())
  on conflict (year, month) do update set year = public.payroll_period.year
  returning * into v_period;

  if v_period.status = 'finalized' then
    raise exception 'Payroll for %/% is finalized — reopen it (with a reason) before regenerating', p_year, p_month;
  end if;

  for v_emp in
    select e.id from public.employee e
    where e.status <> 'deleted'
      and coalesce(e.join_date, e.created_at::date) <= v_month_end
    order by e.created_at
  loop
    perform public.payroll_upsert_employee(v_period, v_emp.id);
  end loop;

  -- drop employees that left the scope (e.g. hard-deleted since last generate)
  delete from public.payroll_employee pe
  where pe.payroll_period_id = v_period.id
    and (pe.employee_id is null or not exists (
      select 1 from public.employee e
      where e.id = pe.employee_id and e.status <> 'deleted'));

  return jsonb_build_object('id', v_period.id, 'year', v_period.year,
    'month', v_period.month, 'status', v_period.status);
end; $$;

-- Finalize: lock the calculation snapshot.
create or replace function public.finalize_payroll_period(p_payroll_period_id uuid)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_period public.payroll_period;
declare v_actor text;
begin
  if not public.has_menu_permission('salary_sheet') or not public.is_super_admin() then
    raise exception 'Access denied';
  end if;
  select * into v_period from public.payroll_period where id = p_payroll_period_id;
  if v_period.id is null then raise exception 'Payroll period not found'; end if;
  if v_period.status = 'finalized' then raise exception 'Payroll is already finalized'; end if;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  update public.payroll_period
    set status = 'finalized', finalized_by = auth.uid(), finalized_at = now()
    where id = p_payroll_period_id;
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (p_payroll_period_id, 'finalize', auth.uid(), v_actor,
          'Payroll ' || v_period.year || '/' || v_period.month || ' finalized — calculation locked');
end; $$;

-- Reopen: audited (a reason is mandatory; pre-reopen totals are recorded).
create or replace function public.reopen_payroll_period(p_payroll_period_id uuid, p_reason text)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_period public.payroll_period;
  v_actor text;
  v_totals text;
begin
  if not public.has_menu_permission('salary_sheet') or not public.is_super_admin() then
    raise exception 'Access denied';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to reopen a payroll period';
  end if;
  select * into v_period from public.payroll_period where id = p_payroll_period_id;
  if v_period.id is null then raise exception 'Payroll period not found'; end if;
  if v_period.status <> 'finalized' then raise exception 'Payroll is not finalized'; end if;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  select 'employees=' || count(*) || ', gross=' || coalesce(sum(gross_salary), 0) ||
         ', advances=' || coalesce(sum(advance), 0) || ', deductions=' || coalesce(sum(deduction), 0) ||
         ', net=' || coalesce(sum(net_salary), 0) || ', paid=' || count(*) filter (where payment_status = 'paid')
    into v_totals
  from public.payroll_employee where payroll_period_id = p_payroll_period_id;

  update public.payroll_period
    set status = 'draft', finalized_by = null, finalized_at = null
    where id = p_payroll_period_id;
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (p_payroll_period_id, 'reopen', auth.uid(), v_actor,
          'Reopened: ' || btrim(p_reason) || ' — previous snapshot: ' || v_totals);
end; $$;

-- Edit advance / deduction / notes (allowed while unpaid — draft or finalized).
create or replace function public.update_payroll_adjustment(
  p_payroll_employee_id uuid, p_advance numeric, p_deduction numeric, p_notes text
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_pe public.payroll_employee;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;
  if p_advance is null or p_advance < 0 then raise exception 'Advance must be 0 or more'; end if;
  if p_deduction is null or p_deduction < 0 then raise exception 'Deduction must be 0 or more'; end if;

  select * into v_pe from public.payroll_employee where id = p_payroll_employee_id;
  if v_pe.id is null then raise exception 'Payroll employee not found'; end if;
  if v_pe.payment_status = 'paid' then
    raise exception 'This employee is already marked paid — reopen the payroll to correct it';
  end if;

  update public.payroll_employee set
    advance = round(p_advance, 2),
    deduction = round(p_deduction, 2),
    notes = nullif(btrim(coalesce(p_notes, '')), ''),
    net_salary = gross_salary - round(p_advance, 2) - round(p_deduction, 2),
    updated_at = now()
  where id = p_payroll_employee_id;
end; $$;

-- Record payment (requires a finalized period).
create or replace function public.mark_employee_salary_paid(
  p_payroll_employee_id uuid, p_advance numeric default null,
  p_deduction numeric default null, p_notes text default null
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_pe public.payroll_employee;
  v_period public.payroll_period;
  v_actor text;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;
  select * into v_pe from public.payroll_employee where id = p_payroll_employee_id;
  if v_pe.id is null then raise exception 'Payroll employee not found'; end if;
  if v_pe.payment_status = 'paid' then raise exception 'Already marked paid'; end if;

  select * into v_period from public.payroll_period where id = v_pe.payroll_period_id;
  if v_period.status <> 'finalized' then
    raise exception 'Finalize the payroll before marking salaries paid';
  end if;

  -- optional last-second adjustment values from the payment dialog
  if p_advance is not null or p_deduction is not null or p_notes is not null then
    perform public.update_payroll_adjustment(
      p_payroll_employee_id,
      coalesce(round(p_advance, 2), v_pe.advance),
      coalesce(round(p_deduction, 2), v_pe.deduction),
      coalesce(nullif(btrim(coalesce(p_notes, '')), ''), v_pe.notes));
  end if;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  update public.payroll_employee set
    payment_status = 'paid',
    paid_at = now(),
    paid_by = auth.uid(),
    updated_at = now()
  where id = p_payroll_employee_id;
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (v_period.id, 'payment', auth.uid(), v_actor,
          'Employee ' || v_pe.employee_id || ' marked paid');
end; $$;

-- ---------------------------------------------------------------------------
-- 8. SALARY SHEET READ (grouped by site, consolidated settlement)
-- ---------------------------------------------------------------------------
create or replace function public.get_salary_sheet(p_year int, p_month int)
returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_period public.payroll_period;
  v_totals jsonb;
  v_sites jsonb := '[]'::jsonb;
  v_employees jsonb;
  v_audit jsonb;
  v_rows jsonb;
  v_group record;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;

  select * into v_period from public.payroll_period
  where year = p_year and month = p_month;
  if v_period.id is null then
    return jsonb_build_object('exists', false, 'period', null, 'totals', null,
                              'sites', '[]'::jsonb, 'employees', '[]'::jsonb, 'audit', '[]'::jsonb);
  end if;

  -- drafts stay live: attendance edits recalculate on every view
  if v_period.status = 'draft' then
    perform public.generate_payroll_period(p_year, p_month);
    select * into v_period from public.payroll_period where id = v_period.id;
  end if;

  select jsonb_build_object(
    'employees', count(*),
    'total_hours', round(coalesce(sum(total_hours), 0), 2),
    'gross_salary', round(coalesce(sum(gross_salary), 0), 2),
    'advances', round(coalesce(sum(advance), 0), 2),
    'deductions', round(coalesce(sum(deduction), 0), 2),
    'net_payable', round(coalesce(sum(net_salary), 0), 2),
    'paid_count', count(*) filter (where payment_status = 'paid'),
    'unpaid_count', count(*) filter (where payment_status <> 'paid')
  ) into v_totals
  from public.payroll_employee where payroll_period_id = v_period.id;

  -- site groups (employee × site rows, gross at that site) — keyed by site id,
  -- never by name (two sites may share a name)
  for v_group in
    select s.site_id, s.site_name_snapshot as site_name,
           count(*)::int as employees,
           round(sum(s.total_hours), 2) as total_hours,
           round(sum(s.gross_salary), 2) as gross_salary
    from public.payroll_employee_site s
    join public.payroll_employee pe on pe.id = s.payroll_employee_id
    where pe.payroll_period_id = v_period.id
    group by s.site_id, s.site_name_snapshot
    order by sum(s.gross_salary) desc nulls last
  loop
    select coalesce(jsonb_agg(jsonb_build_object(
      'site_id', r.site_id,
      'site_name', r.site_name_snapshot,
      'total_hours', r.total_hours,
      'below_threshold_hours', r.below_threshold_hours,
      'qualified_hours', r.qualified_hours,
      'standard_hours', r.standard_hours,
      'team_leader_hours', r.team_leader_hours,
      'supervisor_hours', r.supervisor_hours,
      'gross_salary', r.gross_salary,
      'has_missing_rate', r.has_missing_rate,
      'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                  'site_id', l.site_id, 'site_name', l.site_name_snapshot,
                  'date', l.attendance_date, 'trade_id', l.trade_id,
                  'trade_name', l.trade_name_snapshot,
                  'salary_role', l.salary_role_snapshot,
                  'experience_tier', l.experience_tier,
                  'hours', l.hours, 'hourly_rate', l.hourly_rate,
                  'gross_amount', l.gross_amount) order by l.attendance_date), '[]'::jsonb)
                from public.payroll_salary_line l
                where l.payroll_employee_id = pe.id
                  and (l.site_id is not distinct from r.site_id)),
      'employee_id', pe.employee_id,
      'full_name', e.full_name,
      'employee_code', e.employee_code,
      'nationality', e.nationality,
      'photo', e.photo,
      'trade_name', t.name,
      'salary_role', pe.salary_role_snapshot
    ) order by e.full_name), '[]'::jsonb) into v_rows
    from public.payroll_employee_site r
    join public.payroll_employee pe on pe.id = r.payroll_employee_id
    join public.employee e on e.id = pe.employee_id
    left join public.trades t on t.id = pe.trade_id_snapshot
    where pe.payroll_period_id = v_period.id
      and (r.site_id is not distinct from v_group.site_id);

    v_sites := v_sites || jsonb_build_object(
      'site_id', v_group.site_id,
      'site_name', v_group.site_name,
      'employees', v_group.employees,
      'total_hours', v_group.total_hours,
      'gross_salary', v_group.gross_salary,
      'rows', v_rows
    );
  end loop;

  -- consolidated per-employee settlements (advance/deduction/net exactly once)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', pe.id,
    'payroll_period_id', pe.payroll_period_id,
    'employee_id', pe.employee_id,
    'full_name', e.full_name,
    'employee_code', e.employee_code,
    'nationality', e.nationality,
    'photo', e.photo,
    'status', e.status,
    'trade_id', pe.trade_id_snapshot,
    'trade_name', t.name,
    'salary_role', pe.salary_role_snapshot,
    'total_hours', pe.total_hours,
    'opening_lifetime_hours', pe.opening_lifetime_hours,
    'closing_lifetime_hours', pe.closing_lifetime_hours,
    'below_threshold_hours', (select coalesce(sum(s.below_threshold_hours), 0)
                              from public.payroll_employee_site s
                              where s.payroll_employee_id = pe.id),
    'qualified_hours', (select coalesce(sum(s.qualified_hours), 0)
                        from public.payroll_employee_site s
                        where s.payroll_employee_id = pe.id),
    'unrated_hours', pe.unrated_hours,
    'unassigned_hours', pe.unassigned_hours,
    'gross_salary', pe.gross_salary,
    'advance', pe.advance,
    'deduction', pe.deduction,
    'net_salary', pe.net_salary,
    'payment_status', pe.payment_status,
    'paid_at', pe.paid_at,
    'paid_by', pe.paid_by,
    'paid_by_name', (select coalesce(name, email) from public.profiles where id = pe.paid_by),
    'notes', pe.notes,
    'sites', (select coalesce(jsonb_agg(jsonb_build_object(
                'site_id', s.site_id, 'site_name', s.site_name_snapshot,
                'total_hours', s.total_hours,
                'below_threshold_hours', s.below_threshold_hours,
                'qualified_hours', s.qualified_hours,
                'standard_hours', s.standard_hours,
                'team_leader_hours', s.team_leader_hours,
                'supervisor_hours', s.supervisor_hours,
                'gross_salary', s.gross_salary,
                'has_missing_rate', s.has_missing_rate,
                'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                            'site_id', l.site_id, 'site_name', l.site_name_snapshot,
                            'date', l.attendance_date, 'trade_id', l.trade_id,
                            'trade_name', l.trade_name_snapshot,
                            'salary_role', l.salary_role_snapshot,
                            'experience_tier', l.experience_tier,
                            'hours', l.hours, 'hourly_rate', l.hourly_rate,
                            'gross_amount', l.gross_amount) order by l.attendance_date), '[]'::jsonb)
                          from public.payroll_salary_line l
                          where l.payroll_employee_id = pe.id
                            and (l.site_id is not distinct from s.site_id))
              ) order by s.gross_salary desc), '[]'::jsonb)
              from public.payroll_employee_site s where s.payroll_employee_id = pe.id)
  ) order by e.full_name), '[]'::jsonb) into v_employees
  from public.payroll_employee pe
  join public.employee e on e.id = pe.employee_id
  left join public.trades t on t.id = pe.trade_id_snapshot
  where pe.payroll_period_id = v_period.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'action', a.action, 'actor_name', a.actor_name,
    'details', a.details, 'created_at', a.created_at
  ) order by a.created_at desc), '[]'::jsonb) into v_audit
  from public.payroll_audit_log a where a.period_id = v_period.id;

  return jsonb_build_object(
    'exists', true,
    'period', jsonb_build_object(
      'id', v_period.id, 'year', v_period.year, 'month', v_period.month,
      'status', v_period.status, 'created_by', v_period.created_by,
      'finalized_by', v_period.finalized_by, 'finalized_at', v_period.finalized_at,
      'created_at', v_period.created_at),
    'totals', v_totals,
    'sites', v_sites,
    'employees', v_employees,
    'audit', v_audit
  );
end; $$;

-- ---------------------------------------------------------------------------
-- 9. TRADE MANAGEMENT RPCs
-- ---------------------------------------------------------------------------
create or replace function public.list_trades()
returns jsonb language plpgsql stable
security definer set search_path = public
as $$
begin
  -- the employee form's trade dropdown needs this for every staff member
  -- (mirrors the trades_select table policy)
  if not public.is_staff() then raise exception 'Access denied'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'description', t.description,
      'is_active', t.is_active, 'created_at', t.created_at, 'updated_at', t.updated_at,
      'current_rates', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', r.id, 'trade_id', r.trade_id, 'salary_role', r.salary_role,
          'experience_tier', r.experience_tier, 'hourly_rate', r.hourly_rate,
          'effective_from', r.effective_from, 'effective_to', r.effective_to,
          'created_at', r.created_at) order by r.salary_role, r.experience_tier),
          '[]'::jsonb)
        from public.trade_rate_history r
        where r.trade_id = t.id
          and r.effective_from <= current_date
          and (r.effective_to is null or r.effective_to >= current_date))
    ) order by t.name), '[]'::jsonb)
    from public.trades t
  );
end; $$;

create or replace function public.get_trade_rate_history(p_trade_id uuid)
returns jsonb language plpgsql stable
security definer set search_path = public
as $$
begin
  if not public.has_menu_permission('trade_management')
     and not public.has_menu_permission('salary_sheet') then
    raise exception 'Access denied';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'trade_id', r.trade_id, 'salary_role', r.salary_role,
      'experience_tier', r.experience_tier, 'hourly_rate', r.hourly_rate,
      'effective_from', r.effective_from, 'effective_to', r.effective_to,
      'created_at', r.created_at
    ) order by r.salary_role, r.experience_tier, r.effective_from desc), '[]'::jsonb)
    from public.trade_rate_history r where r.trade_id = p_trade_id
  );
end; $$;

-- p_rates: [{"salary_role":"standard","experience_tier":"below_threshold","hourly_rate":8}, …]
-- p_activate requires ALL six rate cells.
create or replace function public.create_trade(
  p_name text, p_description text default null,
  p_rates jsonb default '[]'::jsonb, p_activate boolean default true
) returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_trade public.trades;
  v_actor text;
  v_rate jsonb;
  v_cells int := 0;
  v_expected text := 'standard:below_threshold,standard:qualified,team_leader:below_threshold,team_leader:qualified,supervisor:below_threshold,supervisor:qualified';
begin
  if not public.has_menu_permission('trade_management') then raise exception 'Access denied'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Trade name is required'; end if;

  if exists (select 1 from public.trades where lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A trade named "%" already exists', btrim(p_name);
  end if;

  -- tolerate double-encoded payloads (see create_employee)
  if jsonb_typeof(p_rates) = 'string' then p_rates := (p_rates #>> '{}')::jsonb; end if;
  if p_rates is null or jsonb_typeof(p_rates) <> 'array' then
    raise exception 'Rates must be a JSON array';
  end if;

  select count(distinct (r->>'salary_role') || ':' || (r->>'experience_tier')) into v_cells
  from jsonb_array_elements(p_rates) r
  where (r->>'hourly_rate')::numeric >= 0;
  if p_activate and v_cells < 6 then
    raise exception 'Configure all six rate cells (3 salary roles × 2 experience tiers) before activating the trade';
  end if;

  insert into public.trades (name, description, is_active)
  values (btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_activate, false))
  returning * into v_trade;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  for v_rate in select * from jsonb_array_elements(p_rates) loop
    if (v_rate->>'salary_role') in ('standard','team_leader','supervisor')
       and (v_rate->>'experience_tier') in ('below_threshold','qualified')
       and (v_rate->>'hourly_rate')::numeric >= 0 then
      insert into public.trade_rate_history (
        trade_id, salary_role, experience_tier, hourly_rate, effective_from, created_by
      ) values (
        v_trade.id, v_rate->>'salary_role', v_rate->>'experience_tier',
        round((v_rate->>'hourly_rate')::numeric, 2), current_date, auth.uid()
      );
    end if;
  end loop;

  insert into public.trade_rate_audit_log (trade_id, action, actor_id, actor_name, details)
  values (v_trade.id, 'create', auth.uid(), v_actor,
          'Trade "' || v_trade.name || '" created with ' || v_cells || ' rate cells');

  return jsonb_build_object('id', v_trade.id, 'name', v_trade.name,
    'is_active', v_trade.is_active);
end; $$;

create or replace function public.update_trade(
  p_trade_id uuid, p_name text, p_description text default null,
  p_is_active boolean default null
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_actor text;
begin
  if not public.has_menu_permission('trade_management') then raise exception 'Access denied'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Trade name is required'; end if;
  if exists (select 1 from public.trades
             where lower(trim(name)) = lower(trim(p_name)) and id <> p_trade_id) then
    raise exception 'A trade named "%" already exists', btrim(p_name);
  end if;
  if not exists (select 1 from public.trades where id = p_trade_id) then
    raise exception 'Trade not found';
  end if;

  update public.trades set
    name = btrim(p_name),
    description = nullif(btrim(coalesce(p_description, '')), ''),
    is_active = coalesce(p_is_active, public.trades.is_active)
  where id = p_trade_id;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  insert into public.trade_rate_audit_log (trade_id, action, actor_id, actor_name, details)
  values (p_trade_id, 'update', auth.uid(), v_actor, 'Trade details updated');
end; $$;

-- Close the open period for the provided cells and start a new one.
-- Backdated effective dates (before today) need a super admin.
create or replace function public.update_trade_rates(
  p_trade_id uuid, p_rates jsonb, p_effective_from date default null
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_actor text;
  v_rate jsonb;
  v_eff date := coalesce(p_effective_from, current_date);
  v_cell text;
  v_cap date;
begin
  if not public.has_menu_permission('trade_management') then raise exception 'Access denied'; end if;
  if not exists (select 1 from public.trades where id = p_trade_id) then
    raise exception 'Trade not found';
  end if;
  if v_eff < current_date and not public.is_super_admin() then
    raise exception 'Only super admins can backdate rate changes';
  end if;

  -- tolerate double-encoded payloads (see create_employee)
  if jsonb_typeof(p_rates) = 'string' then p_rates := (p_rates #>> '{}')::jsonb; end if;
  if p_rates is null or jsonb_typeof(p_rates) <> 'array' or jsonb_array_length(p_rates) = 0 then
    raise exception 'Provide at least one rate to change';
  end if;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();

  for v_rate in select * from jsonb_array_elements(p_rates) loop
    if (v_rate->>'salary_role') not in ('standard','team_leader','supervisor')
       or (v_rate->>'experience_tier') not in ('below_threshold','qualified') then
      raise exception 'Invalid rate cell';
    end if;
    if (v_rate->>'hourly_rate')::numeric is null or (v_rate->>'hourly_rate')::numeric < 0 then
      raise exception 'Hourly rate must be 0 or more';
    end if;
    v_cell := (v_rate->>'salary_role') || '/' || (v_rate->>'experience_tier');

    -- a rate scheduled for exactly this date is replaced by the new one
    delete from public.trade_rate_history
      where trade_id = p_trade_id
        and salary_role = (v_rate->>'salary_role')
        and experience_tier = (v_rate->>'experience_tier')
        and effective_from = v_eff;

    -- a strictly future-scheduled rate caps the new period (it wins from its date)
    select min(effective_from) - 1 into v_cap
    from public.trade_rate_history
    where trade_id = p_trade_id
      and salary_role = (v_rate->>'salary_role')
      and experience_tier = (v_rate->>'experience_tier')
      and effective_from > v_eff;

    -- close the currently open period the day before the new effective date
    update public.trade_rate_history
      set effective_to = v_eff - 1
      where trade_id = p_trade_id
        and salary_role = (v_rate->>'salary_role')
        and experience_tier = (v_rate->>'experience_tier')
        and effective_from < v_eff
        and (effective_to is null or effective_to >= v_eff);

    insert into public.trade_rate_history (
      trade_id, salary_role, experience_tier, hourly_rate, effective_from, effective_to, created_by
    ) values (
      p_trade_id, v_rate->>'salary_role', v_rate->>'experience_tier',
      round((v_rate->>'hourly_rate')::numeric, 2), v_eff, v_cap, auth.uid()
    );

    insert into public.trade_rate_audit_log (trade_id, action, actor_id, actor_name, details)
    values (p_trade_id, 'rate_change', auth.uid(), v_actor,
            v_cell || ' = ' || round((v_rate->>'hourly_rate')::numeric, 2) ||
            ' AED/h effective ' || v_eff ||
            case when v_cap is not null then ' (until ' || v_cap || ')' else '' end);
  end loop;
end; $$;

-- Explicit trade/role change with an effective date (also used by the form).
create or replace function public.assign_employee_trade(
  p_employee_id uuid, p_trade_id uuid, p_salary_role text,
  p_effective_date date default null
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_eff date := coalesce(p_effective_date, (now() at time zone 'Asia/Dubai')::date);
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;
  if p_salary_role not in ('standard','team_leader','supervisor') then
    raise exception 'Invalid salary role';
  end if;
  if not exists (select 1 from public.employee where id = p_employee_id) then
    raise exception 'Employee not found';
  end if;

  perform public.apply_employee_assignment(p_employee_id, p_trade_id, p_salary_role, v_eff);

  if p_trade_id is not null then
    update public.employee set trade_id = p_trade_id, salary_role = p_salary_role, updated_at = now()
      where id = p_employee_id;
  else
    update public.employee set trade_id = null, updated_at = now() where id = p_employee_id;
  end if;
end; $$;

-- Internal: replace the assignment effective from p_eff.
--   • an assignment starting exactly on p_eff is replaced (same-day re-assignment)
--   • a strictly future-scheduled assignment caps the new one (it wins from its date)
--   • the currently open assignment is closed the day before p_eff
--   • p_trade_id null → the history just ends (trade removed)
create or replace function public.apply_employee_assignment(
  p_employee_id uuid, p_trade_id uuid, p_salary_role text, p_eff date
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_cap date;
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;

  delete from public.employee_salary_assignment
    where employee_id = p_employee_id and effective_from = p_eff;

  select min(effective_from) - 1 into v_cap
  from public.employee_salary_assignment
  where employee_id = p_employee_id and effective_from > p_eff;

  update public.employee_salary_assignment
    set effective_to = p_eff - 1
    where employee_id = p_employee_id
      and effective_from < p_eff
      and (effective_to is null or effective_to >= p_eff);

  if p_trade_id is not null then
    if not exists (select 1 from public.trades where id = p_trade_id) then
      raise exception 'Trade not found';
    end if;
    insert into public.employee_salary_assignment (
      employee_id, trade_id, salary_role, effective_from, effective_to, created_by
    ) values (
      p_employee_id, p_trade_id, p_salary_role, p_eff, v_cap, auth.uid()
    );
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- 10. WIRE TRADES INTO create_employee / update_employee
--     (first assignment from the join date; changes close the old assignment)
-- ---------------------------------------------------------------------------
create or replace function public.create_employee(p_employee jsonb)
returns public.employee language plpgsql
security definer set search_path = public
as $$
declare result public.employee;
-- tolerate double-encoded payloads: an app build that sent JSON.stringify(p_employee)
-- delivers a jsonb STRING — unwrap it once, up front, so every `->>` below works
-- (declare defaults run before the body, so the unwrap must live HERE)
declare v_payload jsonb := case when jsonb_typeof(p_employee) = 'string'
                                 then (p_employee #>> '{}')::jsonb else p_employee end;
declare v_site uuid := nullif(v_payload->>'current_site_id','');
declare v_camp uuid := nullif(v_payload->>'camp_id','');
declare v_block text := nullif(btrim(coalesce(v_payload->>'camp_block','')), '');
declare v_room  text := nullif(btrim(coalesce(v_payload->>'camp_room','')), '');
declare v_leader_site uuid := nullif(v_payload->>'team_leader_site_id','');
declare v_is_leader boolean := coalesce((v_payload->>'is_team_leader')::boolean, false);
-- historical opening balance: blank / missing / null → 0 (new employees)
declare v_opening numeric := coalesce(nullif(v_payload->>'opening_hours','')::numeric, 0);
-- manual employee ID: use it as-is; blank → auto-generate (PUL-YYYY-NNN)
declare v_code text := nullif(btrim(coalesce(v_payload->>'employee_code','')), '');
declare v_trade uuid := nullif(v_payload->>'trade_id','');
declare v_role text := coalesce(nullif(v_payload->>'salary_role',''), 'standard');
declare conflicting public.employee;
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;

  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'Invalid employee payload — expected a JSON object';
  end if;
  if coalesce(btrim(v_payload->>'full_name'), '') = '' then
    raise exception 'Full name is required';
  end if;
  if v_role not in ('standard','team_leader','supervisor') then
    raise exception 'Invalid salary role';
  end if;
  if v_trade is not null and not exists (select 1 from public.trades where id = v_trade and is_active) then
    raise exception 'The selected trade does not exist or is inactive';
  end if;

  if v_code is not null then
    select * into conflicting from public.employee
      where lower(employee_code) = lower(v_code) limit 1;
    if conflicting.id is not null then
      raise exception 'Employee ID "%" is already taken by % — use another ID or leave it blank to auto-generate', v_code, conflicting.full_name;
    end if;
  end if;

  if v_site is not null and not exists (select 1 from public.site where id = v_site and is_active) then
    raise exception 'The selected site does not exist or is inactive';
  end if;
  if v_camp is not null and not exists (select 1 from public.camp where id = v_camp and is_active) then
    raise exception 'The selected camp does not exist or is inactive';
  end if;
  if v_camp is null then
    v_block := null;
    v_room := null;
  end if;

  if v_opening < 0 or v_opening <> v_opening then
    raise exception 'Previous working hours cannot be negative';
  end if;
  if v_opening > 9999999999.99 then
    raise exception 'Previous working hours are unrealistically large';
  end if;

  if v_is_leader and v_leader_site is not null then
    select * into conflicting from public.employee
      where is_team_leader and team_leader_site_id = v_leader_site and status <> 'deleted' limit 1;
    if conflicting.id is not null then
      raise exception 'Another employee (%) is already the team leader of this site', conflicting.full_name;
    end if;
  end if;

  insert into public.employee (
    full_name, employee_code, nationality, date_of_birth, phone, email, address,
    emergency_contact, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, rating, status, photo, is_team_leader, team_leader_site_id,
    camp_id, camp_block, camp_room, opening_hours, trade_id, salary_role
  ) values (
    btrim(v_payload->>'full_name'), coalesce(v_code, public.next_employee_code()),
    nullif(v_payload->>'nationality',''), (v_payload->>'date_of_birth')::date,
    nullif(v_payload->>'phone',''), nullif(v_payload->>'email',''), nullif(v_payload->>'address',''),
    nullif(v_payload->>'emergency_contact',''), nullif(v_payload->>'position',''),
    (v_payload->>'join_date')::date, nullif(v_payload->>'company_name',''),
    nullif(v_payload->>'passport_number',''), nullif(v_payload->>'passport_status',''),
    nullif(v_payload->>'id_number',''), nullif(v_payload->>'id_status',''),
    v_site, 5.0, 'active', nullif(v_payload->>'photo',''), v_is_leader, v_leader_site, v_camp,
    v_block, v_room, round(v_opening, 2), v_trade, v_role
  ) returning * into result;

  -- first salary assignment runs from the join date (or today when unknown)
  if v_trade is not null then
    insert into public.employee_salary_assignment (employee_id, trade_id, salary_role, effective_from, created_by)
    values (result.id, v_trade, v_role,
            coalesce(result.join_date, (now() at time zone 'Asia/Dubai')::date), auth.uid());
  end if;

  return result;
end; $$;

create or replace function public.update_employee(p_id uuid, p_employee jsonb, p_effective_date date default null)
returns public.employee language plpgsql
security definer set search_path = public
as $$
declare result public.employee;
-- tolerate double-encoded payloads (see create_employee)
declare v_payload jsonb := case when jsonb_typeof(p_employee) = 'string'
                                 then (p_employee #>> '{}')::jsonb else p_employee end;
declare v_site uuid := nullif(v_payload->>'current_site_id','');
declare v_camp uuid := nullif(v_payload->>'camp_id','');
declare v_block text := nullif(btrim(coalesce(v_payload->>'camp_block','')), '');
declare v_room  text := nullif(btrim(coalesce(v_payload->>'camp_room','')), '');
declare v_leader_site uuid := nullif(v_payload->>'team_leader_site_id','');
declare v_is_leader boolean := coalesce((v_payload->>'is_team_leader')::boolean, false);
declare v_opening numeric := nullif(v_payload->>'opening_hours','')::numeric;
declare v_trade uuid := nullif(v_payload->>'trade_id','');
declare v_role text := coalesce(nullif(v_payload->>'salary_role',''), 'standard');
declare v_prev_site uuid;
declare v_prev_opening numeric;
declare v_prev_trade uuid;
declare v_prev_role text;
declare v_eff date := coalesce(p_effective_date, (now() at time zone 'Asia/Dubai')::date);
declare conflicting public.employee;
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;

  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'Invalid employee payload — expected a JSON object';
  end if;
  if v_role not in ('standard','team_leader','supervisor') then
    raise exception 'Invalid salary role';
  end if;
  if v_trade is not null and not exists (select 1 from public.trades where id = v_trade) then
    raise exception 'The selected trade does not exist';
  end if;

  if v_site is not null and not exists (select 1 from public.site where id = v_site and is_active) then
    raise exception 'The selected site does not exist or is inactive';
  end if;
  if v_camp is not null and not exists (select 1 from public.camp where id = v_camp and is_active) then
    raise exception 'The selected camp does not exist or is inactive';
  end if;
  if v_camp is null then
    v_block := null;
    v_room := null;
  end if;

  if v_is_leader and v_leader_site is not null then
    select * into conflicting from public.employee
      where is_team_leader and team_leader_site_id = v_leader_site
        and status <> 'deleted' and id <> p_id limit 1;
    if conflicting.id is not null then
      raise exception 'Another employee (%) is already the team leader of this site', conflicting.full_name;
    end if;
  end if;

  select current_site_id, opening_hours, trade_id, salary_role
    into v_prev_site, v_prev_opening, v_prev_trade, v_prev_role
  from public.employee where id = p_id;

  if v_opening is not null then
    if v_opening < 0 or v_opening <> v_opening then
      raise exception 'Previous working hours cannot be negative';
    end if;
    if v_opening > 9999999999.99 then
      raise exception 'Previous working hours are unrealistically large';
    end if;
    if v_opening <> v_prev_opening and not public.is_super_admin() then
      raise exception 'Only super admins can adjust the historical opening balance';
    end if;
  end if;

  update public.employee set
    full_name         = coalesce(nullif(btrim(coalesce(v_payload->>'full_name','')), ''), public.employee.full_name),
    nationality       = nullif(v_payload->>'nationality',''),
    date_of_birth     = (v_payload->>'date_of_birth')::date,
    phone             = nullif(v_payload->>'phone',''),
    email             = nullif(v_payload->>'email',''),
    address           = nullif(v_payload->>'address',''),
    emergency_contact = nullif(v_payload->>'emergency_contact',''),
    position          = nullif(v_payload->>'position',''),
    join_date         = (v_payload->>'join_date')::date,
    company_name      = nullif(v_payload->>'company_name',''),
    passport_number   = nullif(v_payload->>'passport_number',''),
    passport_status   = nullif(v_payload->>'passport_status',''),
    id_number         = nullif(v_payload->>'id_number',''),
    id_status         = nullif(v_payload->>'id_status',''),
    current_site_id   = v_site,
    camp_id           = v_camp,
    camp_block        = v_block,
    camp_room         = v_room,
    photo             = nullif(v_payload->>'photo',''),
    is_team_leader    = v_is_leader,
    team_leader_site_id = case when v_is_leader then v_leader_site else null end,
    opening_hours     = coalesce(round(v_opening, 2), public.employee.opening_hours),
    trade_id          = v_trade,
    salary_role       = v_role,
    updated_at        = now()
  where id = p_id returning * into result;

  -- log the site move (site → site, site → idle, idle → site)
  if v_prev_site is distinct from v_site then
    insert into public.site_transfer (employee_id, from_site_id, to_site_id, effective_date)
    values (p_id, v_prev_site, v_site, v_eff);
  end if;

  -- trade / salary-role change → replace the assignment from the effective
  -- date (old work keeps the old classification)
  if v_prev_trade is distinct from v_trade or v_prev_role is distinct from v_role then
    perform public.apply_employee_assignment(p_id, v_trade, v_role, v_eff);
  end if;

  return result;
end; $$;

-- ---------------------------------------------------------------------------
-- 11. DEFAULT PERMISSIONS for the two new menus (trade_management,
--     salary_sheet): admins get NO access until a super admin grants it —
--     they are financial menus. Super admins always pass has_menu_permission.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 12. REALTIME — publish the new tables so the UI refreshes live
--     (each statement is individually idempotent)
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.trades;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.trade_rate_history;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.employee_salary_assignment;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.payroll_period;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.payroll_employee;
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 20261103b — Salary Sheet: rate fix, sitewise breakdown, sheet editing
-- ----------------------------------------------------------------------------
-- 1. RATE FIX ("rate for the trade is not added"):
--    A trade's FIRST rate set now covers ALL HISTORY (effective 1900-01-01)
--    instead of only "from today". Previously every attendance day before
--    the trade's creation date was unrated → the salary sheet showed
--    "missing rate". Existing first periods are repaired by §2c.
-- 2. SITEWISE BREAKDOWN:
--    Unpriced hours (no trade / no effective rate) are attributed to the
--    site where they were WORKED — not to a generic "No site" bucket. An
--    employee who moved mid-month appears at EVERY site they worked at
--    (historical attribution), including moved-out employees.
-- 3. SHEET EDITING (the sheet record has priority):
--    Edit Mode in the Salary Sheet overrides hours, rate, gross, trade,
--    advance and deduction. A manually edited settlement is NEVER
--    overwritten by the automatic recalculation, and a trade picked in the
--    sheet overwrites the employee's stored trade/assignment data.
--    reset_payroll_employee_auto returns an employee to automatic pricing.
--
-- Idempotent — safe to run any number of times.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. manual-edit flags + 'manual' salary-line tier
-- ---------------------------------------------------------------------------
alter table public.payroll_employee      add column if not exists manually_edited boolean not null default false;
alter table public.payroll_employee_site add column if not exists manually_edited boolean not null default false;

-- a hand-edited site row collapses into one "manual" rate line
alter table public.payroll_salary_line drop constraint if exists payroll_salary_line_experience_tier_check;
do $$ begin
  alter table public.payroll_salary_line add constraint payroll_salary_line_experience_tier_check
    check (experience_tier in ('below_threshold', 'qualified', 'manual'));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. TRADE RATES — first rate of a cell covers history
-- ---------------------------------------------------------------------------

-- 2a. create_trade: initial rates effective from the beginning of time
--     (the trade did not exist before, so nothing is retroactively re-priced;
--     all past attendance of assigned employees now finds a rate).
create or replace function public.create_trade(
  p_name text, p_description text default null,
  p_rates jsonb default '[]'::jsonb, p_activate boolean default true
) returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_trade public.trades;
  v_actor text;
  v_rate jsonb;
  v_cells int := 0;
  v_expected text := 'standard:below_threshold,standard:qualified,team_leader:below_threshold,team_leader:qualified,supervisor:below_threshold,supervisor:qualified';
begin
  if not public.has_menu_permission('trade_management') then raise exception 'Access denied'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Trade name is required'; end if;

  if exists (select 1 from public.trades where lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A trade named "%" already exists', btrim(p_name);
  end if;

  -- tolerate double-encoded payloads (see create_employee)
  if jsonb_typeof(p_rates) = 'string' then p_rates := (p_rates #>> '{}')::jsonb; end if;
  if p_rates is null or jsonb_typeof(p_rates) <> 'array' then
    raise exception 'Rates must be a JSON array';
  end if;

  select count(distinct (r->>'salary_role') || ':' || (r->>'experience_tier')) into v_cells
  from jsonb_array_elements(p_rates) r
  where (r->>'hourly_rate')::numeric >= 0;
  if p_activate and v_cells < 6 then
    raise exception 'Configure all six rate cells (3 salary roles × 2 experience tiers) before activating the trade';
  end if;

  insert into public.trades (name, description, is_active)
  values (btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_activate, false))
  returning * into v_trade;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  for v_rate in select * from jsonb_array_elements(p_rates) loop
    if (v_rate->>'salary_role') in ('standard','team_leader','supervisor')
       and (v_rate->>'experience_tier') in ('below_threshold','qualified')
       and (v_rate->>'hourly_rate')::numeric >= 0 then
      insert into public.trade_rate_history (
        trade_id, salary_role, experience_tier, hourly_rate, effective_from, created_by
      ) values (
        v_trade.id, v_rate->>'salary_role', v_rate->>'experience_tier',
        round((v_rate->>'hourly_rate')::numeric, 2), date '1900-01-01', auth.uid()
      );
    end if;
  end loop;

  insert into public.trade_rate_audit_log (trade_id, action, actor_id, actor_name, details)
  values (v_trade.id, 'create', auth.uid(), v_actor,
          'Trade "' || v_trade.name || '" created with ' || v_cells || ' rate cells');

  return jsonb_build_object('id', v_trade.id, 'name', v_trade.name,
    'is_active', v_trade.is_active);
end; $$;

-- 2b. update_trade_rates: when a cell had NO earlier rate, the new (first)
--     rate is backdated to 1900-01-01 — "adding the missing rate" fixes past
--     months instead of leaving them unrated. Cells with an earlier period
--     keep the effective-dated behaviour (no retroactive re-pricing).
create or replace function public.update_trade_rates(
  p_trade_id uuid, p_rates jsonb, p_effective_from date default null
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_actor text;
  v_rate jsonb;
  v_eff date := coalesce(p_effective_from, current_date);
  v_eff_cell date;               -- effective date used for this cell
  v_cell text;
  v_cap date;
begin
  if not public.has_menu_permission('trade_management') then raise exception 'Access denied'; end if;
  if not exists (select 1 from public.trades where id = p_trade_id) then
    raise exception 'Trade not found';
  end if;
  if v_eff < current_date and not public.is_super_admin() then
    raise exception 'Only super admins can backdate rate changes';
  end if;

  -- tolerate double-encoded payloads (see create_employee)
  if jsonb_typeof(p_rates) = 'string' then p_rates := (p_rates #>> '{}')::jsonb; end if;
  if p_rates is null or jsonb_typeof(p_rates) <> 'array' or jsonb_array_length(p_rates) = 0 then
    raise exception 'Provide at least one rate to change';
  end if;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();

  for v_rate in select * from jsonb_array_elements(p_rates) loop
    if (v_rate->>'salary_role') not in ('standard','team_leader','supervisor')
       or (v_rate->>'experience_tier') not in ('below_threshold','qualified') then
      raise exception 'Invalid rate cell';
    end if;
    if (v_rate->>'hourly_rate')::numeric is null or (v_rate->>'hourly_rate')::numeric < 0 then
      raise exception 'Hourly rate must be 0 or more';
    end if;
    v_cell := (v_rate->>'salary_role') || '/' || (v_rate->>'experience_tier');

    -- first rate ever for this cell → covers history (1900-01-01)
    if not exists (
      select 1 from public.trade_rate_history h
      where h.trade_id = p_trade_id
        and h.salary_role = (v_rate->>'salary_role')
        and h.experience_tier = (v_rate->>'experience_tier')
        and h.effective_from < v_eff
    ) then
      v_eff_cell := date '1900-01-01';
    else
      v_eff_cell := v_eff;
    end if;

    -- a rate scheduled for exactly this date is replaced by the new one
    delete from public.trade_rate_history
      where trade_id = p_trade_id
        and salary_role = (v_rate->>'salary_role')
        and experience_tier = (v_rate->>'experience_tier')
        and effective_from = v_eff;

    -- a strictly future-scheduled rate caps the new period (it wins from its date)
    select min(effective_from) - 1 into v_cap
    from public.trade_rate_history
    where trade_id = p_trade_id
      and salary_role = (v_rate->>'salary_role')
      and experience_tier = (v_rate->>'experience_tier')
      and effective_from > v_eff;

    -- close the currently open period the day before the new effective date
    update public.trade_rate_history
      set effective_to = v_eff_cell - 1
      where trade_id = p_trade_id
        and salary_role = (v_rate->>'salary_role')
        and experience_tier = (v_rate->>'experience_tier')
        and effective_from < v_eff_cell
        and (effective_to is null or effective_to >= v_eff_cell);

    insert into public.trade_rate_history (
      trade_id, salary_role, experience_tier, hourly_rate, effective_from, effective_to, created_by
    ) values (
      p_trade_id, v_rate->>'salary_role', v_rate->>'experience_tier',
      round((v_rate->>'hourly_rate')::numeric, 2), v_eff_cell, v_cap, auth.uid()
    );

    insert into public.trade_rate_audit_log (trade_id, action, actor_id, actor_name, details)
    values (p_trade_id, 'rate_change', auth.uid(), v_actor,
            v_cell || ' = ' || round((v_rate->>'hourly_rate')::numeric, 2) ||
            ' AED/h effective ' || v_eff_cell ||
            case when v_cap is not null then ' (until ' || v_cap || ')' else '' end);
  end loop;
end; $$;

-- 2c. DATA REPAIR: backdate the earliest period of every rate cell to
--     1900-01-01 (trades created by the previous version started their rates
--     "today", leaving all earlier attendance unrated).
update public.trade_rate_history r
  set effective_from = date '1900-01-01'
  where r.effective_from > date '1900-01-01'
    and not exists (
      select 1 from public.trade_rate_history e
      where e.trade_id = r.trade_id
        and e.salary_role = r.salary_role
        and e.experience_tier = r.experience_tier
        and e.effective_from < r.effective_from);

-- ---------------------------------------------------------------------------
-- 3. CALCULATION ENGINE — unpriced hours attributed to the worked site
-- ---------------------------------------------------------------------------
create or replace function public.calculate_employee_payroll(
  p_employee_id uuid, p_year int, p_month int
) returns jsonb language plpgsql stable
security definer set search_path = public
as $$
declare
  emp record;
  v_month_start date := make_date(p_year, p_month, 1);
  v_month_end   date := (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day')::date;
  v_six_month date;
  v_cum numeric;              -- lifetime hours BEFORE the current record
  v_opening numeric;
  v_total_hours numeric := 0;
  v_opening_lifetime numeric := 0;
  v_closing_lifetime numeric := 0;
  v_b numeric; v_q numeric;   -- below-threshold / qualified hours of the record
  v_day_qualified boolean;
  v_rate numeric;
  v_assignment jsonb;
  v_trade_id uuid; v_role text; v_trade_name text;
  v_site_id uuid; v_site_name text;
  v_key text;
  r record;
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_unrated numeric := 0;
  v_unassigned numeric := 0;
  v_unassigned_sites jsonb := '{}'::jsonb;  -- site key → unassigned hours
  v_unrated_sites jsonb := '{}'::jsonb;     -- site key → unrated hours
  v_gross numeric := 0;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;

  select e.* into emp from public.employee e
  where e.id = p_employee_id and e.status <> 'deleted';
  if emp.id is null then raise exception 'Employee not found'; end if;

  v_opening := coalesce(emp.opening_hours, 0);
  v_six_month := (coalesce(emp.join_date, emp.created_at::date) + interval '6 months')::date;
  v_cum := v_opening;

  for r in
    select a.date, a.hours, public.emp_site_on_date(p_employee_id, a.date) as site_id
    from public.attendance a
    where a.employee_id = p_employee_id
      and not a.is_hidden
      and a.hours is not null and a.hours > 0
      and a.date <= v_month_end          -- history after the month cannot affect cumulation
    order by a.date
  loop
    -- resolve trade & role for THAT date (effective-dated, historical)
    v_assignment := public.emp_trade_on_date(p_employee_id, r.date);
    v_trade_id := (v_assignment->>'trade_id')::uuid;
    v_role     := v_assignment->>'salary_role';

    -- tier split at the qualification point
    --   • whole-day qualified on/after the six-month anniversary (start of day)
    --   • mid-record split when the 1,000-hour threshold is crossed
    --   • already >= 1,000 cumulative (incl. opening) → qualified
    v_day_qualified := (r.date >= v_six_month) or (v_cum >= 1000);
    if v_day_qualified then
      v_b := 0; v_q := r.hours;
    elsif v_cum + r.hours >= 1000 then
      v_b := 1000 - v_cum;                -- hours still below the threshold
      v_q := r.hours - v_b;               -- remainder at the qualified rate
    else
      v_b := r.hours; v_q := 0;
    end if;
    v_cum := v_cum + r.hours;

    if r.date < v_month_start then
      v_opening_lifetime := v_cum;        -- lifetime balance entering the month
    else
      v_total_hours := v_total_hours + r.hours;
      v_closing_lifetime := v_cum;

      if v_trade_id is null then
        -- no trade: the hours still belong to the site where they were worked
        v_unassigned := v_unassigned + r.hours;
        v_key := coalesce(r.site_id::text, '__none__');
        v_unassigned_sites := jsonb_set(v_unassigned_sites, array[v_key],
          to_jsonb(round(coalesce((v_unassigned_sites->>v_key)::numeric, 0) + r.hours, 2)));
      else
        select name into v_trade_name from public.trades where id = v_trade_id;
        select coalesce(s.name, 'No site') into v_site_name
        from public.site s where s.id = r.site_id;
        -- below-threshold segment
        if v_b > 0 then
          v_rate := public.trade_rate_on(v_trade_id, v_role, 'below_threshold', r.date);
          if v_rate is null then
            v_unrated := v_unrated + v_b;
            v_key := coalesce(r.site_id::text, '__none__');
            v_unrated_sites := jsonb_set(v_unrated_sites, array[v_key],
              to_jsonb(round(coalesce((v_unrated_sites->>v_key)::numeric, 0) + v_b, 2)));
          else
            v_line := jsonb_build_object(
              'site_id', r.site_id, 'site_name', v_site_name, 'date', r.date,
              'trade_id', v_trade_id, 'trade_name', v_trade_name,
              'salary_role', v_role, 'experience_tier', 'below_threshold',
              'hours', round(v_b, 2), 'hourly_rate', v_rate,
              'gross_amount', round(v_b * v_rate, 2));
            v_lines := v_lines || v_line;
            v_gross := v_gross + (v_line->>'gross_amount')::numeric;
          end if;
        end if;
        -- qualified segment
        if v_q > 0 then
          v_rate := public.trade_rate_on(v_trade_id, v_role, 'qualified', r.date);
          if v_rate is null then
            v_unrated := v_unrated + v_q;
            v_key := coalesce(r.site_id::text, '__none__');
            v_unrated_sites := jsonb_set(v_unrated_sites, array[v_key],
              to_jsonb(round(coalesce((v_unrated_sites->>v_key)::numeric, 0) + v_q, 2)));
          else
            v_line := jsonb_build_object(
              'site_id', r.site_id, 'site_name', v_site_name, 'date', r.date,
              'trade_id', v_trade_id, 'trade_name', v_trade_name,
              'salary_role', v_role, 'experience_tier', 'qualified',
              'hours', round(v_q, 2), 'hourly_rate', v_rate,
              'gross_amount', round(v_q * v_rate, 2));
            v_lines := v_lines || v_line;
            v_gross := v_gross + (v_line->>'gross_amount')::numeric;
          end if;
        end if;
      end if;
    end if;
  end loop;

  if v_opening_lifetime = 0 then v_opening_lifetime := v_opening; end if;
  if v_closing_lifetime = 0 then v_closing_lifetime := v_opening_lifetime; end if;

  return jsonb_build_object(
    'employee_id',              p_employee_id,
    'total_hours',              round(v_total_hours, 2),
    'opening_lifetime_hours',   round(v_opening_lifetime, 2),
    'closing_lifetime_hours',   round(v_closing_lifetime, 2),
    'below_threshold_hours',    0,  -- filled by the aggregates below
    'qualified_hours',          0,
    'unrated_hours',            round(v_unrated, 2),
    'unassigned_hours',         round(v_unassigned, 2),
    'unassigned_sites',         v_unassigned_sites,
    'unrated_sites',            v_unrated_sites,
    'gross_salary',             round(v_gross, 2),
    'lines',                    v_lines
  );
end; $$;

-- ---------------------------------------------------------------------------
-- 4. PAYROLL REFRESH — manual sheet edits win; unpriced hours per site
-- ---------------------------------------------------------------------------
create or replace function public.payroll_upsert_employee(
  p_period public.payroll_period, p_employee_id uuid
) returns void language plpgsql
security definer set search_path = public
as $$
declare
  emp record;
  calc jsonb;
  v_pe public.payroll_employee;
  v_pe_id uuid;
  v_site jsonb;
  v_line jsonb;
  v_role_hours numeric;
  v_tier_hours numeric;
  v_site_row jsonb;
  v_key text;
  v_unpriced numeric;
  v_site_name text;
  v_sites jsonb := '{}'::jsonb;   -- coalesced site key → aggregate object
  v_agg jsonb;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;

  -- THE SHEET RECORD HAS PRIORITY: a settlement edited by hand in the Salary
  -- Sheet is never recalculated until reset_payroll_employee_auto is used.
  if exists (select 1 from public.payroll_employee pe
             where pe.payroll_period_id = p_period.id
               and pe.employee_id = p_employee_id
               and pe.manually_edited) then
    return;
  end if;

  select e.*, t.name as trade_name into emp
  from public.employee e left join public.trades t on t.id = e.trade_id
  where e.id = p_employee_id and e.status <> 'deleted';
  if emp.id is null then return; end if;

  calc := public.calculate_employee_payroll(p_employee_id, p_period.year, p_period.month);

  -- aggregate lines into site buckets
  for v_line in select * from jsonb_array_elements(calc->'lines') loop
    v_key := coalesce(v_line->>'site_id', '__none__');
    v_agg := v_sites->v_key;
    if v_agg is null then
      v_agg := jsonb_build_object(
        'site_id', (v_line->'site_id'),
        'site_name', v_line->>'site_name',
        'total_hours', 0, 'below_threshold_hours', 0, 'qualified_hours', 0,
        'standard_hours', 0, 'team_leader_hours', 0, 'supervisor_hours', 0,
        'gross_salary', 0, 'has_missing_rate', false);
    end if;
    v_agg := jsonb_set(v_agg, '{total_hours}',
      to_jsonb(round(((v_agg->>'total_hours')::numeric + (v_line->>'hours')::numeric), 2)));
    v_tier_hours := (v_line->>'hours')::numeric;
    v_agg := jsonb_set(v_agg, array[(v_line->>'experience_tier') || '_hours'],
      to_jsonb(round(((v_agg->((v_line->>'experience_tier') || '_hours'))::numeric + v_tier_hours), 2)));
    v_role_hours := (v_agg->((v_line->>'salary_role') || '_hours'))::numeric + v_tier_hours;
    v_agg := jsonb_set(v_agg, array[(v_line->>'salary_role') || '_hours'], to_jsonb(round(v_role_hours, 2)));
    v_agg := jsonb_set(v_agg, '{gross_salary}',
      to_jsonb(round(((v_agg->>'gross_salary')::numeric + (v_line->>'gross_amount')::numeric), 2)));
    v_sites := jsonb_set(v_sites, array[v_key], v_agg);
  end loop;

  -- unpriced hours (no trade / no effective rate) belong to the site where
  -- they were WORKED; only hours with no site at all land in "No site".
  -- An employee who moved mid-month therefore appears at every site they
  -- worked at, with the hours of that site.
  for v_key in select jsonb_object_keys(calc->'unassigned_sites') loop
    v_unpriced := (calc->'unassigned_sites'->>v_key)::numeric;
    v_agg := v_sites->v_key;
    if v_agg is null then
      if v_key = '__none__' then
        v_agg := jsonb_build_object('site_id', null, 'site_name', 'No site',
          'total_hours', 0, 'below_threshold_hours', 0, 'qualified_hours', 0,
          'standard_hours', 0, 'team_leader_hours', 0, 'supervisor_hours', 0,
          'gross_salary', 0, 'has_missing_rate', false);
      else
        select coalesce(s.name, 'No site') into v_site_name
        from public.site s where s.id = v_key::uuid;
        v_agg := jsonb_build_object('site_id', to_jsonb(v_key::uuid),
          'site_name', coalesce(v_site_name, 'No site'),
          'total_hours', 0, 'below_threshold_hours', 0, 'qualified_hours', 0,
          'standard_hours', 0, 'team_leader_hours', 0, 'supervisor_hours', 0,
          'gross_salary', 0, 'has_missing_rate', false);
      end if;
    end if;
    v_agg := jsonb_set(v_agg, '{total_hours}',
      to_jsonb(round(((v_agg->>'total_hours')::numeric + v_unpriced), 2)));
    v_sites := jsonb_set(v_sites, array[v_key], v_agg);
  end loop;

  for v_key in select jsonb_object_keys(calc->'unrated_sites') loop
    v_unpriced := (calc->'unrated_sites'->>v_key)::numeric;
    v_agg := v_sites->v_key;
    if v_agg is null then
      if v_key = '__none__' then
        v_agg := jsonb_build_object('site_id', null, 'site_name', 'No site',
          'total_hours', 0, 'below_threshold_hours', 0, 'qualified_hours', 0,
          'standard_hours', 0, 'team_leader_hours', 0, 'supervisor_hours', 0,
          'gross_salary', 0, 'has_missing_rate', false);
      else
        select coalesce(s.name, 'No site') into v_site_name
        from public.site s where s.id = v_key::uuid;
        v_agg := jsonb_build_object('site_id', to_jsonb(v_key::uuid),
          'site_name', coalesce(v_site_name, 'No site'),
          'total_hours', 0, 'below_threshold_hours', 0, 'qualified_hours', 0,
          'standard_hours', 0, 'team_leader_hours', 0, 'supervisor_hours', 0,
          'gross_salary', 0, 'has_missing_rate', false);
      end if;
    end if;
    v_agg := jsonb_set(v_agg, '{total_hours}',
      to_jsonb(round(((v_agg->>'total_hours')::numeric + v_unpriced), 2)));
    v_agg := jsonb_set(v_agg, '{has_missing_rate}', 'true');
    v_sites := jsonb_set(v_sites, array[v_key], v_agg);
  end loop;

  -- upsert the employee settlement row (adjustments preserved)
  insert into public.payroll_employee (
    payroll_period_id, employee_id,
    opening_lifetime_hours, closing_lifetime_hours,
    total_hours, unrated_hours, unassigned_hours, gross_salary,
    trade_id_snapshot, salary_role_snapshot, net_salary
  ) values (
    p_period.id, p_employee_id,
    (calc->>'opening_lifetime_hours')::numeric, (calc->>'closing_lifetime_hours')::numeric,
    (calc->>'total_hours')::numeric,
    (calc->>'unrated_hours')::numeric, (calc->>'unassigned_hours')::numeric,
    (calc->>'gross_salary')::numeric,
    emp.trade_id, emp.salary_role,
    (calc->>'gross_salary')::numeric
  )
  on conflict (payroll_period_id, employee_id) do update set
    opening_lifetime_hours = excluded.opening_lifetime_hours,
    closing_lifetime_hours = excluded.closing_lifetime_hours,
    total_hours            = excluded.total_hours,
    unrated_hours          = excluded.unrated_hours,
    unassigned_hours       = excluded.unassigned_hours,
    gross_salary           = excluded.gross_salary,
    trade_id_snapshot      = excluded.trade_id_snapshot,
    salary_role_snapshot   = excluded.salary_role_snapshot,
    net_salary             = excluded.gross_salary
                              - public.payroll_employee.advance
                              - public.payroll_employee.deduction,
    updated_at             = now()
  returning * into v_pe;
  v_pe_id := v_pe.id;

  -- refresh the pure-calculation children (site rows + lines)
  delete from public.payroll_employee_site where payroll_employee_id = v_pe_id;
  delete from public.payroll_salary_line  where payroll_employee_id = v_pe_id;

  for v_key in select jsonb_object_keys(v_sites) loop
    v_site_row := v_sites->v_key;
    insert into public.payroll_employee_site (
      payroll_employee_id, site_id, site_name_snapshot,
      total_hours, below_threshold_hours, qualified_hours,
      standard_hours, team_leader_hours, supervisor_hours,
      gross_salary, has_missing_rate, calculation_details
    ) values (
      v_pe_id,
      nullif(v_key, '__none__')::uuid,
      v_site_row->>'site_name',
      (v_site_row->>'total_hours')::numeric,
      (v_site_row->>'below_threshold_hours')::numeric,
      (v_site_row->>'qualified_hours')::numeric,
      (v_site_row->>'standard_hours')::numeric,
      (v_site_row->>'team_leader_hours')::numeric,
      (v_site_row->>'supervisor_hours')::numeric,
      (v_site_row->>'gross_salary')::numeric,
      coalesce((v_site_row->>'has_missing_rate')::boolean, false),
      v_site_row
    );
  end loop;

  for v_line in select * from jsonb_array_elements(calc->'lines') loop
    insert into public.payroll_salary_line (
      payroll_employee_id, site_id, site_name_snapshot, attendance_date,
      trade_id, trade_name_snapshot, salary_role_snapshot, experience_tier,
      hours, hourly_rate, gross_amount
    ) values (
      v_pe_id,
      (v_line->>'site_id')::uuid,
      v_line->>'site_name',
      (v_line->>'date')::date,
      (v_line->>'trade_id')::uuid,
      v_line->>'trade_name',
      v_line->>'salary_role',
      v_line->>'experience_tier',
      (v_line->>'hours')::numeric,
      (v_line->>'hourly_rate')::numeric,
      (v_line->>'gross_amount')::numeric
    );
  end loop;
end; $$;

-- ---------------------------------------------------------------------------
-- 5. SALARY SHEET READ — expose the manual-edit flags
-- ---------------------------------------------------------------------------
create or replace function public.get_salary_sheet(p_year int, p_month int)
returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_period public.payroll_period;
  v_totals jsonb;
  v_sites jsonb := '[]'::jsonb;
  v_employees jsonb;
  v_audit jsonb;
  v_rows jsonb;
  v_group record;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;

  select * into v_period from public.payroll_period
  where year = p_year and month = p_month;
  if v_period.id is null then
    return jsonb_build_object('exists', false, 'period', null, 'totals', null,
                              'sites', '[]'::jsonb, 'employees', '[]'::jsonb, 'audit', '[]'::jsonb);
  end if;

  -- drafts stay live: attendance edits recalculate on every view
  -- (manually edited settlements are skipped inside payroll_upsert_employee)
  if v_period.status = 'draft' then
    perform public.generate_payroll_period(p_year, p_month);
    select * into v_period from public.payroll_period where id = v_period.id;
  end if;

  select jsonb_build_object(
    'employees', count(*),
    'total_hours', round(coalesce(sum(total_hours), 0), 2),
    'gross_salary', round(coalesce(sum(gross_salary), 0), 2),
    'advances', round(coalesce(sum(advance), 0), 2),
    'deductions', round(coalesce(sum(deduction), 0), 2),
    'net_payable', round(coalesce(sum(net_salary), 0), 2),
    'paid_count', count(*) filter (where payment_status = 'paid'),
    'unpaid_count', count(*) filter (where payment_status <> 'paid')
  ) into v_totals
  from public.payroll_employee where payroll_period_id = v_period.id;

  -- site groups (employee × site rows, gross at that site) — keyed by site id,
  -- never by name (two sites may share a name)
  for v_group in
    select s.site_id, s.site_name_snapshot as site_name,
           count(*)::int as employees,
           round(sum(s.total_hours), 2) as total_hours,
           round(sum(s.gross_salary), 2) as gross_salary
    from public.payroll_employee_site s
    join public.payroll_employee pe on pe.id = s.payroll_employee_id
    where pe.payroll_period_id = v_period.id
    group by s.site_id, s.site_name_snapshot
    order by sum(s.gross_salary) desc nulls last
  loop
    select coalesce(jsonb_agg(jsonb_build_object(
      'site_id', r.site_id,
      'site_name', r.site_name_snapshot,
      'total_hours', r.total_hours,
      'below_threshold_hours', r.below_threshold_hours,
      'qualified_hours', r.qualified_hours,
      'standard_hours', r.standard_hours,
      'team_leader_hours', r.team_leader_hours,
      'supervisor_hours', r.supervisor_hours,
      'gross_salary', r.gross_salary,
      'has_missing_rate', r.has_missing_rate,
      'manually_edited', r.manually_edited,
      'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                  'site_id', l.site_id, 'site_name', l.site_name_snapshot,
                  'date', l.attendance_date, 'trade_id', l.trade_id,
                  'trade_name', l.trade_name_snapshot,
                  'salary_role', l.salary_role_snapshot,
                  'experience_tier', l.experience_tier,
                  'hours', l.hours, 'hourly_rate', l.hourly_rate,
                  'gross_amount', l.gross_amount) order by l.attendance_date), '[]'::jsonb)
                from public.payroll_salary_line l
                where l.payroll_employee_id = pe.id
                  and (l.site_id is not distinct from r.site_id)),
      'employee_id', pe.employee_id,
      'full_name', e.full_name,
      'employee_code', e.employee_code,
      'nationality', e.nationality,
      'photo', e.photo,
      'trade_name', t.name,
      'salary_role', pe.salary_role_snapshot
    ) order by e.full_name), '[]'::jsonb) into v_rows
    from public.payroll_employee_site r
    join public.payroll_employee pe on pe.id = r.payroll_employee_id
    join public.employee e on e.id = pe.employee_id
    left join public.trades t on t.id = pe.trade_id_snapshot
    where pe.payroll_period_id = v_period.id
      and (r.site_id is not distinct from v_group.site_id);

    v_sites := v_sites || jsonb_build_object(
      'site_id', v_group.site_id,
      'site_name', v_group.site_name,
      'employees', v_group.employees,
      'total_hours', v_group.total_hours,
      'gross_salary', v_group.gross_salary,
      'rows', v_rows
    );
  end loop;

  -- consolidated per-employee settlements (advance/deduction/net exactly once)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', pe.id,
    'payroll_period_id', pe.payroll_period_id,
    'employee_id', pe.employee_id,
    'full_name', e.full_name,
    'employee_code', e.employee_code,
    'nationality', e.nationality,
    'photo', e.photo,
    'status', e.status,
    'trade_id', pe.trade_id_snapshot,
    'trade_name', t.name,
    'salary_role', pe.salary_role_snapshot,
    'manually_edited', pe.manually_edited,
    'total_hours', pe.total_hours,
    'opening_lifetime_hours', pe.opening_lifetime_hours,
    'closing_lifetime_hours', pe.closing_lifetime_hours,
    'below_threshold_hours', (select coalesce(sum(s.below_threshold_hours), 0)
                              from public.payroll_employee_site s
                              where s.payroll_employee_id = pe.id),
    'qualified_hours', (select coalesce(sum(s.qualified_hours), 0)
                        from public.payroll_employee_site s
                        where s.payroll_employee_id = pe.id),
    'unrated_hours', pe.unrated_hours,
    'unassigned_hours', pe.unassigned_hours,
    'gross_salary', pe.gross_salary,
    'advance', pe.advance,
    'deduction', pe.deduction,
    'net_salary', pe.net_salary,
    'payment_status', pe.payment_status,
    'paid_at', pe.paid_at,
    'paid_by', pe.paid_by,
    'paid_by_name', (select coalesce(name, email) from public.profiles where id = pe.paid_by),
    'notes', pe.notes,
    'sites', (select coalesce(jsonb_agg(jsonb_build_object(
                'site_id', s.site_id, 'site_name', s.site_name_snapshot,
                'total_hours', s.total_hours,
                'below_threshold_hours', s.below_threshold_hours,
                'qualified_hours', s.qualified_hours,
                'standard_hours', s.standard_hours,
                'team_leader_hours', s.team_leader_hours,
                'supervisor_hours', s.supervisor_hours,
                'gross_salary', s.gross_salary,
                'has_missing_rate', s.has_missing_rate,
                'manually_edited', s.manually_edited,
                'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                            'site_id', l.site_id, 'site_name', l.site_name_snapshot,
                            'date', l.attendance_date, 'trade_id', l.trade_id,
                            'trade_name', l.trade_name_snapshot,
                            'salary_role', l.salary_role_snapshot,
                            'experience_tier', l.experience_tier,
                            'hours', l.hours, 'hourly_rate', l.hourly_rate,
                            'gross_amount', l.gross_amount) order by l.attendance_date), '[]'::jsonb)
                          from public.payroll_salary_line l
                          where l.payroll_employee_id = pe.id
                            and (l.site_id is not distinct from s.site_id))
              ) order by s.gross_salary desc), '[]'::jsonb)
              from public.payroll_employee_site s where s.payroll_employee_id = pe.id)
  ) order by e.full_name), '[]'::jsonb) into v_employees
  from public.payroll_employee pe
  join public.employee e on e.id = pe.employee_id
  left join public.trades t on t.id = pe.trade_id_snapshot
  where pe.payroll_period_id = v_period.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'action', a.action, 'actor_name', a.actor_name,
    'details', a.details, 'created_at', a.created_at
  ) order by a.created_at desc), '[]'::jsonb) into v_audit
  from public.payroll_audit_log a where a.period_id = v_period.id;

  return jsonb_build_object(
    'exists', true,
    'period', jsonb_build_object(
      'id', v_period.id, 'year', v_period.year, 'month', v_period.month,
      'status', v_period.status, 'created_by', v_period.created_by,
      'finalized_by', v_period.finalized_by, 'finalized_at', v_period.finalized_at,
      'created_at', v_period.created_at),
    'totals', v_totals,
    'sites', v_sites,
    'employees', v_employees,
    'audit', v_audit
  );
end; $$;

-- ---------------------------------------------------------------------------
-- 6. SALARY SHEET EDITING
--     THE SHEET RECORD HAS PRIORITY over other stored data: values edited
--     here overwrite the stored data and are never touched by the automatic
--     recalculation (until reset_payroll_employee_auto).
-- ---------------------------------------------------------------------------

-- the assignment helper is also used from the Salary Sheet (salary_sheet
-- permission), not only from the employee form (employees permission)
create or replace function public.apply_employee_assignment(
  p_employee_id uuid, p_trade_id uuid, p_salary_role text, p_eff date
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_cap date;
begin
  if not public.has_menu_permission('employees')
     and not public.has_menu_permission('salary_sheet') then
    raise exception 'Access denied';
  end if;

  delete from public.employee_salary_assignment
    where employee_id = p_employee_id and effective_from = p_eff;

  select min(effective_from) - 1 into v_cap
  from public.employee_salary_assignment
  where employee_id = p_employee_id and effective_from > p_eff;

  update public.employee_salary_assignment
    set effective_to = p_eff - 1
    where employee_id = p_employee_id
      and effective_from < p_eff
      and (effective_to is null or effective_to >= p_eff);

  if p_trade_id is not null then
    if not exists (select 1 from public.trades where id = p_trade_id) then
      raise exception 'Trade not found';
    end if;
    insert into public.employee_salary_assignment (
      employee_id, trade_id, salary_role, effective_from, effective_to, created_by
    ) values (
      p_employee_id, p_trade_id, p_salary_role, p_eff, v_cap, auth.uid()
    );
  end if;
end; $$;

-- Update one employee's Salary Sheet row.
--   p_payload:
--   {
--     "payroll_employee_id": "<uuid>",          (required)
--     "trade_id": "<uuid>" | null,              (present → overwrite the stored trade)
--     "advance": 500, "deduction": 100,         (optional, >= 0)
--     "notes": "text" | null,                   (optional)
--     "sites": [                                (optional — manual overrides)
--       {"site_id": "<uuid>"|null, "total_hours": 176,
--        "hourly_rate": 8.5, "gross_salary": 1496}
--     ]
--   }
-- Rules:
--   • paid employees are protected (reopen the payroll first);
--   • a trade change overwrites employee.trade_id and the assignment history
--     from the 1st of the payroll month (the whole month prices at the new
--     trade) and re-prices the employee automatically when no manual site
--     values exist;
--   • any manual site override marks the settlement manually_edited — the
--     sheet record then wins over every recalculation.
create or replace function public.update_salary_sheet_row(p_payload jsonb)
returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_payload jsonb := case when jsonb_typeof(p_payload) = 'string'
                          then (p_payload #>> '{}')::jsonb else p_payload end;
  v_pe_id uuid;
  v_pe public.payroll_employee;
  v_period public.payroll_period;
  v_emp public.employee;
  v_emp_name text;
  v_trade_id uuid;
  v_trade_name text;
  v_has_trade_change boolean := false;
  v_was_manual boolean;
  v_month_start date;
  v_sites jsonb;
  v_site jsonb;
  v_site_key text;
  v_row public.payroll_employee_site;
  v_hours numeric;
  v_gross numeric;
  v_rate numeric;
  v_total numeric;
  v_gross_total numeric;
  v_advance numeric;
  v_deduction numeric;
  v_notes text;
  v_actor text;
  v_details text := '';
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;
  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'Invalid payload — expected a JSON object';
  end if;

  v_pe_id := nullif(v_payload->>'payroll_employee_id', '')::uuid;
  if v_pe_id is null then raise exception 'payroll_employee_id is required'; end if;

  select * into v_pe from public.payroll_employee where id = v_pe_id;
  if v_pe.id is null then raise exception 'Payroll employee not found'; end if;
  if v_pe.payment_status = 'paid' then
    raise exception 'This employee is already marked paid — reopen the payroll to correct it';
  end if;

  select * into v_period from public.payroll_period where id = v_pe.payroll_period_id;
  select * into v_emp from public.employee where id = v_pe.employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;
  v_emp_name := v_emp.full_name;
  v_month_start := make_date(v_period.year, v_period.month, 1);
  v_was_manual := v_pe.manually_edited;

  -- 1. trade picked in the sheet → OVERWRITE the stored trade + assignment
  if v_payload ? 'trade_id' then
    v_trade_id := nullif(v_payload->>'trade_id', '')::uuid;
    if v_trade_id is not null then
      select name into v_trade_name from public.trades where id = v_trade_id;
      if v_trade_name is null then raise exception 'Trade not found'; end if;
    end if;
    if v_trade_id is distinct from v_emp.trade_id then
      v_has_trade_change := true;
      -- the new trade applies from the 1st of this payroll month
      perform public.apply_employee_assignment(
        v_emp.id, v_trade_id, coalesce(v_emp.salary_role, 'standard'), v_month_start);
      update public.employee
        set trade_id = v_trade_id, updated_at = now()
        where id = v_emp.id;
      update public.payroll_employee
        set trade_id_snapshot = v_trade_id, updated_at = now()
        where id = v_pe_id;
      -- refresh the employee row so later steps see the NEW trade
      select * into v_emp from public.employee where id = v_pe.employee_id;
      v_details := v_details || 'trade → ' || coalesce(v_trade_name, 'no trade') || '; ';
    end if;
  end if;

  -- 2. manual site overrides — the sheet record wins
  if v_payload ? 'sites' then
    v_sites := v_payload->'sites';
    if jsonb_typeof(v_sites) = 'string' then v_sites := (v_sites #>> '{}')::jsonb; end if;
    if v_sites is null or jsonb_typeof(v_sites) <> 'array' then
      raise exception 'sites must be a JSON array';
    end if;

    for v_site in select * from jsonb_array_elements(v_sites) loop
      v_site_key := coalesce(v_site->>'site_id', '');
      if v_site_key = '' then
        select * into v_row from public.payroll_employee_site
          where payroll_employee_id = v_pe_id and site_id is null;
      else
        select * into v_row from public.payroll_employee_site
          where payroll_employee_id = v_pe_id and site_id = v_site_key::uuid;
      end if;
      -- `not found` (not v_row.id) — a failed select into a row variable keeps
      -- the PREVIOUS loop iteration's value, which would update the wrong site
      if not found then
        raise exception 'Site row "%" not found for this employee', coalesce(nullif(v_site_key, ''), 'No site');
      end if;

      v_hours := round(coalesce(nullif(v_site->>'total_hours', '')::numeric, v_row.total_hours), 2);
      v_gross := round(coalesce(nullif(v_site->>'gross_salary', '')::numeric, v_row.gross_salary), 2);
      v_rate  := nullif(v_site->>'hourly_rate', '')::numeric;
      if v_hours < 0 or v_gross < 0 then
        raise exception 'Hours and gross must be 0 or more';
      end if;

      update public.payroll_employee_site set
        total_hours      = v_hours,
        gross_salary     = v_gross,
        has_missing_rate = false,
        manually_edited = true,
        calculation_details = coalesce(calculation_details, '{}'::jsonb)
                              || jsonb_build_object('manual', true, 'manual_rate', v_rate)
      where id = v_row.id;

      -- the site's rate lines collapse into ONE manual line
      delete from public.payroll_salary_line
        where payroll_employee_id = v_pe_id
          and site_id is not distinct from v_row.site_id;

      if v_hours > 0 then
        if v_rate is null then
          v_rate := round(v_gross / v_hours, 2);
        end if;
        insert into public.payroll_salary_line (
          payroll_employee_id, site_id, site_name_snapshot, attendance_date,
          trade_id, trade_name_snapshot, salary_role_snapshot, experience_tier,
          hours, hourly_rate, gross_amount
        ) values (
          v_pe_id, v_row.site_id, v_row.site_name_snapshot, v_month_start,
          v_emp.trade_id,
          coalesce((select name from public.trades where id = v_emp.trade_id), 'No trade'),
          coalesce(v_emp.salary_role, 'standard'), 'manual',
          v_hours, round(v_rate, 2), v_gross
        );
      end if;
    end loop;

    -- settlement totals = sum over ALL site rows (manual + automatic)
    select coalesce(sum(total_hours), 0), coalesce(sum(gross_salary), 0)
      into v_total, v_gross_total
    from public.payroll_employee_site where payroll_employee_id = v_pe_id;

    update public.payroll_employee set
      total_hours      = round(v_total, 2),
      gross_salary     = round(v_gross_total, 2),
      unrated_hours    = 0,
      unassigned_hours = 0,
      manually_edited  = true,
      updated_at       = now()
    where id = v_pe_id;
    v_details := v_details || 'manual site values; ';
  end if;

  -- 3. trade change without manual values → re-price the month automatically
  if v_has_trade_change and not (v_payload ? 'sites') then
    if not v_was_manual then
      perform public.payroll_upsert_employee(v_period, v_pe.employee_id);
      v_details := v_details || 'recalculated; ';
    else
      -- manual values exist: keep them, only refresh the trade snapshot
      update public.payroll_employee set
        trade_id_snapshot    = v_emp.trade_id,
        salary_role_snapshot = coalesce(v_emp.salary_role, 'standard'),
        updated_at           = now()
      where id = v_pe_id;
    end if;
  end if;

  -- 4. settlement adjustments (advance / deduction / notes)
  if v_payload ? 'advance' or v_payload ? 'deduction' or v_payload ? 'notes' then
    select * into v_pe from public.payroll_employee where id = v_pe_id;
    v_advance   := coalesce(nullif(v_payload->>'advance', '')::numeric, v_pe.advance);
    v_deduction := coalesce(nullif(v_payload->>'deduction', '')::numeric, v_pe.deduction);
    if v_payload ? 'notes' then
      v_notes := nullif(btrim(coalesce(v_payload->>'notes', '')), '');
    else
      v_notes := v_pe.notes;
    end if;
    if v_advance < 0 or v_deduction < 0 then
      raise exception 'Advance and deduction must be 0 or more';
    end if;
    update public.payroll_employee set
      advance    = round(v_advance, 2),
      deduction  = round(v_deduction, 2),
      notes      = v_notes,
      updated_at = now()
    where id = v_pe_id;
    v_details := v_details || 'settlement; ';
  end if;

  -- net is always gross − advance − deduction
  update public.payroll_employee set
    net_salary = round(gross_salary - advance - deduction, 2),
    updated_at = now()
  where id = v_pe_id;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  if v_details = '' then v_details := 'no changes'; end if;
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (v_period.id, 'manual_edit', auth.uid(), v_actor,
          'Salary sheet row of ' || v_emp_name || ' edited: ' || rtrim(v_details, '; '));

  return jsonb_build_object('ok', true);
end; $$;

-- Return an employee's settlement to automatic calculation (draft periods).
create or replace function public.reset_payroll_employee_auto(p_payroll_employee_id uuid)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_pe public.payroll_employee;
  v_period public.payroll_period;
  v_actor text;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;
  select * into v_pe from public.payroll_employee where id = p_payroll_employee_id;
  if v_pe.id is null then raise exception 'Payroll employee not found'; end if;

  select * into v_period from public.payroll_period where id = v_pe.payroll_period_id;
  if v_period.status = 'finalized' then
    raise exception 'Reopen the finalized payroll before resetting to automatic calculation';
  end if;

  update public.payroll_employee set manually_edited = false, updated_at = now()
    where id = p_payroll_employee_id;
  perform public.payroll_upsert_employee(v_period, v_pe.employee_id);

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (v_period.id, 'reset_auto', auth.uid(), v_actor,
          'Salary sheet row of employee ' || v_pe.employee_id || ' returned to automatic calculation');
end; $$;

-- ---------------------------------------------------------------------------
-- 7. REALTIME — publish the sheet detail tables
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.payroll_employee_site;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.payroll_salary_line;
exception when duplicate_object then null; end $$;
