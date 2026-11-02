-- ============================================================================
-- 20261102c — Automated menu permissions
-- ----------------------------------------------------------------------------
-- The sidebar menu list now lives in ONE place (src/lib/menus.ts). Adding a
-- menu there automatically adds it to the Admin Management permission toggles.
-- This migration makes the DATABASE keep up:
--
--  1. menu_permission.menu_key accepts ANY key (the old CHECK hardcoded the
--     seven original menus, so toggling a newly added menu would violate it).
--  2. has_menu_permission: a missing row now falls back to a default-allow set
--     — the menus that ship visible to every admin (mirrors defaultOn:true in
--     lib/menus.ts). Explicit permission rows keep winning either way.
--  3. Working Hours / Uniform Registry data RPCs gate on their own menu keys,
--     leniently ("own key OR employees", the same pattern attendance uses),
--     so the new super-admin toggles revoke data access without breaking any
--     admin who already had Employees granted.
--  4. Access preservation: admins who already had Employees granted get a
--     working_hours=true row, because Working Hours used to piggyback on the
--     Employees permission in the sidebar.
--
-- Idempotent: safe to run any number of times.
-- ============================================================================

-- 1. Allow any menu key (the client config is the source of truth) ----------
alter table public.menu_permission
  drop constraint if exists menu_permission_menu_key_check;

-- 2. Default-allow fallback for menus that ship visible to every admin ------
--    (keep in sync with defaultOn:true in src/lib/menus.ts)
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

-- 3a. Working Hours report — gate on its own menu (lenient: OR employees) ---
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

-- 3b. Uniform Registry — gate on its own menu (lenient: OR employees) -------
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

-- 4. Preserve current access: admins with Employees keep Working Hours -----
insert into public.menu_permission (profile_id, menu_key, allowed)
select mp.profile_id, 'working_hours', true
from public.menu_permission mp
join public.profiles p on p.id = mp.profile_id
where mp.menu_key = 'employees' and mp.allowed and p.role = 'admin'
on conflict (profile_id, menu_key) do nothing;
