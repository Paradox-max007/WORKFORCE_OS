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
  menu_key    text not null check (menu_key in ('employees','sites','camps','attendance','leave_requests','cancellation_requests','notifications')),
  allowed     boolean not null default false,
  unique (profile_id, menu_key)
);

-- Work sites
create table if not exists public.site (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  client_name  text,
  project_name text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
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
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Accommodation camps (where employees stay; one employee → at most one camp)
create table if not exists public.camp (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  location    text,
  capacity    int check (capacity is null or capacity >= 0),
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
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
-- older installs created menu_permission without the 'camps' menu key
alter table public.menu_permission drop constraint if exists menu_permission_menu_key_check;
alter table public.menu_permission add constraint menu_permission_menu_key_check
  check (menu_key in ('employees','sites','camps','attendance','leave_requests','cancellation_requests','notifications'));
-- camp block / room columns for older installs
alter table public.employee add column if not exists camp_block text;
alter table public.employee add column if not exists camp_room text;

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
create or replace function public.has_menu_permission(p_menu_key text)
returns boolean language sql stable
security definer set search_path = public
as $$
  select
    exists(select 1 from public.profiles where id = auth.uid() and role = 'super_admin')
    or exists(
      select 1 from public.menu_permission mp
      join public.profiles p on p.id = mp.profile_id
      where mp.profile_id = auth.uid() and mp.menu_key = p_menu_key and mp.allowed and p.role = 'admin'
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

create or replace function public.create_site(p_name text, p_client_name text default null, p_project_name text default null)
returns public.site language plpgsql
security definer set search_path = public
as $$
declare result public.site;
begin
  if not public.has_menu_permission('sites') then raise exception 'Access denied'; end if;
  if exists (select 1 from public.site where lower(name) = lower(p_name)) then
    raise exception 'A site with this name already exists';
  end if;
  insert into public.site (name, client_name, project_name) values (p_name, p_client_name, p_project_name)
  returning * into result;
  return result;
end; $$;

-- Returns the site + how many employees got unassigned when deactivating.
create or replace function public.update_site(
  p_id uuid, p_name text, p_client_name text, p_project_name text, p_is_active boolean
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
  update public.site set name = p_name, client_name = p_client_name, project_name = p_project_name, is_active = p_is_active
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
declare v_site uuid := nullif(p_employee->>'current_site_id','');
declare v_camp uuid := nullif(p_employee->>'camp_id','');
declare v_block text := nullif(btrim(coalesce(p_employee->>'camp_block','')), '');
declare v_room  text := nullif(btrim(coalesce(p_employee->>'camp_room','')), '');
declare v_leader_site uuid := nullif(p_employee->>'team_leader_site_id','');
declare v_is_leader boolean := coalesce((p_employee->>'is_team_leader')::boolean, false);
-- manual employee ID: use it as-is; blank → auto-generate (PUL-YYYY-NNN)
declare v_code text := nullif(btrim(coalesce(p_employee->>'employee_code','')), '');
declare conflicting public.employee;
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;

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
    camp_id, camp_block, camp_room
  ) values (
    p_employee->>'full_name', coalesce(v_code, public.next_employee_code()),
    nullif(p_employee->>'nationality',''), (p_employee->>'date_of_birth')::date,
    nullif(p_employee->>'phone',''), nullif(p_employee->>'email',''), nullif(p_employee->>'address',''),
    nullif(p_employee->>'emergency_contact',''), nullif(p_employee->>'position',''),
    (p_employee->>'join_date')::date, nullif(p_employee->>'company_name',''),
    nullif(p_employee->>'passport_number',''), nullif(p_employee->>'passport_status',''),
    nullif(p_employee->>'id_number',''), nullif(p_employee->>'id_status',''),
    v_site, 5.0, 'active', nullif(p_employee->>'photo',''), v_is_leader, v_leader_site, v_camp,
    v_block, v_room
  ) returning * into result;
  return result;
end; $$;

create or replace function public.update_employee(p_id uuid, p_employee jsonb, p_effective_date date default null)
returns public.employee language plpgsql
security definer set search_path = public
as $$
declare result public.employee;
declare v_site uuid := nullif(p_employee->>'current_site_id','');
declare v_camp uuid := nullif(p_employee->>'camp_id','');
declare v_block text := nullif(btrim(coalesce(p_employee->>'camp_block','')), '');
declare v_room  text := nullif(btrim(coalesce(p_employee->>'camp_room','')), '');
declare v_leader_site uuid := nullif(p_employee->>'team_leader_site_id','');
declare v_is_leader boolean := coalesce((p_employee->>'is_team_leader')::boolean, false);
declare v_prev_site uuid;
declare conflicting public.employee;
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;

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
  select current_site_id into v_prev_site from public.employee where id = p_id;

  update public.employee set
    full_name         = p_employee->>'full_name',
    nationality       = nullif(p_employee->>'nationality',''),
    date_of_birth     = (p_employee->>'date_of_birth')::date,
    phone             = nullif(p_employee->>'phone',''),
    email             = nullif(p_employee->>'email',''),
    address           = nullif(p_employee->>'address',''),
    emergency_contact = nullif(p_employee->>'emergency_contact',''),
    position          = nullif(p_employee->>'position',''),
    join_date         = (p_employee->>'join_date')::date,
    company_name      = nullif(p_employee->>'company_name',''),
    passport_number   = nullif(p_employee->>'passport_number',''),
    passport_status   = nullif(p_employee->>'passport_status',''),
    id_number         = nullif(p_employee->>'id_number',''),
    id_status         = nullif(p_employee->>'id_status',''),
    current_site_id   = v_site,
    camp_id           = v_camp,
    camp_block        = v_block,
    camp_room         = v_room,
    photo             = nullif(p_employee->>'photo',''),
    is_team_leader    = v_is_leader,
    team_leader_site_id = case when v_is_leader then v_leader_site else null end,
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
          where s.profile_id = auth.uid() and s.site_id = e.current_site_id
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

  -- site-scoped marking: normal admins may only mark attendance for their
  -- assigned sites (and never for idle employees — super admins can).
  select current_site_id into v_emp_site from public.employee where id = p_employee_id;
  if not public.is_super_admin() then
    if v_emp_site is null then
      raise exception 'This employee has no site — only super admins can mark idle employees';
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
-- mark_attendance engine (permissions, rating, auto-warnings).
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
-- 10. LEAVE REQUEST RPCs
-- ============================================================================

create or replace function public.create_leave_request(
  p_employee_id uuid, p_leave_type text, p_other_type_text text default null,
  p_start_date date, p_end_date date, p_total_days int, p_reason text
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
begin
  if not public.is_staff() then raise exception 'Access denied'; end if;
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
     p_items, nullif(p_site_name,''), nullif(p_team_leader_name,''), p_is_renewal, p_previous_token_id,
     p_created_at, p_created_at + interval '6 months')
  returning * into result;
  return result;
end; $$;

create or replace function public.update_uniform_entry(
  p_id uuid, p_token_number int, p_document_type text, p_document_number text,
  p_items jsonb, p_site_name text default null, p_team_leader_name text default null,
  p_created_at timestamptz
)
returns public.uniform_registry language plpgsql
security definer set search_path = public
as $$
declare result public.uniform_registry;
begin
  if not public.is_staff() then raise exception 'Access denied'; end if;
  if p_document_type not in ('id','passport') then raise exception 'Invalid document type'; end if;
  update public.uniform_registry set
    token_number = p_token_number,
    document_type = p_document_type,
    document_number = p_document_number,
    items = p_items,
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
  if not public.is_staff() then raise exception 'Access denied'; end if;
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
