-- ============================================================================
-- PULSE Workforce OS — Migration 2026-11-02: Employee Working Hours
-- ----------------------------------------------------------------------------
-- Adds the "Employee Working Hours" module foundation to databases created
-- before it existed:
--   1. employee.opening_hours — historical hours accumulated before PULSE
--      started tracking attendance (0 by default, never negative)
--   2. create_employee / update_employee accept opening_hours in the jsonb
--      payload (create: blank → 0; update: blank → keep, changes are
--      super-admin-only)
--   3. get_employee_working_hours(p_employee_id) — database-side lifetime /
--      monthly / per-site aggregation that resolves each attendance date's
--      site through emp_site_on_date() (the same date-effective transfer rule
--      the attendance sheet uses)
--   4. partial index backing the aggregation
--
-- Fully idempotent — safe to run any number of times (matches schema.sql).
-- Run in the Supabase SQL editor (or psql) against the project database.
-- ============================================================================

-- 1. the column (fresh databases already have it via create table)
alter table public.employee add column if not exists opening_hours numeric(12,2) not null default 0;
alter table public.employee drop constraint if exists employee_opening_hours_check;
alter table public.employee add constraint employee_opening_hours_check check (opening_hours >= 0);

-- 2a. create_employee with the opening balance (same signature — jsonb payload)
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
-- historical opening balance: blank / missing / null → 0 (new employees)
declare v_opening numeric := coalesce(nullif(p_employee->>'opening_hours','')::numeric, 0);
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
    p_employee->>'full_name', coalesce(v_code, public.next_employee_code()),
    nullif(p_employee->>'nationality',''), (p_employee->>'date_of_birth')::date,
    nullif(p_employee->>'phone',''), nullif(p_employee->>'email',''), nullif(p_employee->>'address',''),
    nullif(p_employee->>'emergency_contact',''), nullif(p_employee->>'position',''),
    (p_employee->>'join_date')::date, nullif(p_employee->>'company_name',''),
    nullif(p_employee->>'passport_number',''), nullif(p_employee->>'passport_status',''),
    nullif(p_employee->>'id_number',''), nullif(p_employee->>'id_status',''),
    v_site, 5.0, 'active', nullif(p_employee->>'photo',''), v_is_leader, v_leader_site, v_camp,
    v_block, v_room, round(v_opening, 2)
  ) returning * into result;
  return result;
end; $$;

-- 2b. update_employee: blank opening_hours → keep the stored value; changing
--     it is a super-admin-only adjustment (the form always sends the current
--     value back, so normal edits pass through untouched)
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
declare v_opening numeric := nullif(p_employee->>'opening_hours','')::numeric;
declare v_prev_site uuid;
declare v_prev_opening numeric;
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

-- 3. the working-hours report RPC (monthly + per-site aggregation)
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
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;

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

-- 4. index backing the aggregation
create index if not exists idx_attendance_emp_hours
  on public.attendance(employee_id, date) where is_hidden = false;

-- 5. keep the function grants from the schema's final pass
revoke execute on function public.get_employee_working_hours(uuid) from public;
revoke execute on function public.get_employee_working_hours(uuid) from anon;
grant execute on function public.get_employee_working_hours(uuid) to authenticated, service_role;
