-- ============================================================================
-- 20261108 — ATTENDANCE SHARE LINKS (digital per-site sheet over WhatsApp)
-- ----------------------------------------------------------------------------
-- User request:
--   • a "Send Link" button on every site in the Attendance sheet generates a
--     shareable link (carrying the site name) for that site + viewed month
--   • a WhatsApp send option shares the link with the site supervisor
--   • opening the link shows a DIGITAL attendance sheet — hours, A (the ONLY
--     absent marker) or any short free text — with NO login required
--   • ONE-TIME USE: once the sheet is submitted the link locks (re-opening
--     shows the SAVED sheet + the date/time it was saved); any admin can
--     re-grant edit access to the same link when changes are needed
--   • all links are stored date-wise in a right sidebar on the attendance page
--
-- What changes:
--   1. attendance_share_link — new table (token-gated capability rows). RLS:
--      staff only (normal admins see/act on their assigned sites' links).
--   2. mark_attendance_core — the marking engine (parse → upsert → rating →
--      3-consecutive-absences warning) extracted out of mark_attendance so the
--      public submit path can reuse the EXACT same behaviour without a user
--      session. mark_attendance keeps its permission + date-effective
--      site-assignment checks and simply delegates. Execute on the core is
--      revoked from PUBLIC/anon — only the definer-owned wrappers reach it.
--   3. create_attendance_share_link / list_attendance_share_links /
--      grant_attendance_share_edit — admin-side lifecycle (permission checks
--      mirror mark_attendance: super admin = all sites, admin = assigned).
--   4. get_shared_attendance_sheet — PUBLIC (anon) read by token: live crew +
--      current marks while the link is editable, the saved snapshot once
--      submitted. Markable days follow the SAME date-effective engine
--      (emp_site_on_date) as the marking sheet.
--   5. submit_shared_attendance_sheet — PUBLIC (anon) one-time submit by
--      token: applies every changed cell through mark_attendance_core, stores
--      a full snapshot + submitted_at, then flips the link to read-only.
-- ============================================================================

-- 1. table -------------------------------------------------------------------
create table if not exists public.attendance_share_link (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  site_id uuid references public.site(id) on delete set null,
  site_name text not null default '',
  month_key text not null,                       -- 'YYYY-MM'
  created_by uuid,
  created_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'submitted')),
  submitted_at timestamptz,                      -- date + time the sheet got saved
  submitted_by text,
  submit_count int not null default 0,
  edit_granted_at timestamptz,                   -- last time an admin re-opened editing
  edit_granted_by uuid,
  sheet_data jsonb                               -- saved snapshot (what the link shows once locked)
);

create index if not exists idx_share_link_created on public.attendance_share_link(created_at desc);
create index if not exists idx_share_link_site on public.attendance_share_link(site_id);

comment on table public.attendance_share_link is
  'One-time shareable digital attendance sheet per site + month — token in the URL is the capability; once submitted the link is read-only until an admin grants edit access again';

alter table public.attendance_share_link enable row level security;

drop policy if exists share_link_select on public.attendance_share_link;
create policy share_link_select on public.attendance_share_link
  for select using (
    public.is_staff() and (
      public.is_super_admin()
      or site_id is null
      or exists (
        select 1 from public.admin_site a
        where a.profile_id = auth.uid() and a.site_id = attendance_share_link.site_id
      )
    )
  );

drop policy if exists share_link_insert on public.attendance_share_link;
create policy share_link_insert on public.attendance_share_link
  for insert with check (public.is_staff());

drop policy if exists share_link_update on public.attendance_share_link;
create policy share_link_update on public.attendance_share_link
  for update using (public.is_staff());

-- 2. marking engine extracted (no permission checks inside) -------------------
create or replace function public.mark_attendance_core(
  p_employee_id uuid, p_date date, p_value text default null, p_by uuid default null
)
returns public.attendance language plpgsql
security definer set search_path = public
as $$
declare
  result public.attendance;
  prev public.attendance;
  v_hours numeric := null;
  v_status text;
  v_note text := null;
  ot_delta numeric := 0;
  walk date;
  absent_dates date[] := array[p_date];
  v_trimmed text;
begin
  -- parse the cell value
  v_trimmed := btrim(coalesce(p_value, ''));
  if v_trimmed = '' then
    -- cleared cell: remove the record entirely
    delete from public.attendance where employee_id = p_employee_id and date = p_date;
    return prev;
  elsif lower(v_trimmed) = 'a' then
    -- ONLY "A" marks a day absent — any other free text never does
    v_status := 'absent';
  else
    -- numeric → hours; anything else → free-text marker (present, no hours)
    begin
      v_hours := v_trimmed::numeric;
    exception when others then
      v_hours := null;
    end;
    if v_hours is not null then
      if v_hours < 0 or v_hours > 24 then
        raise exception 'Hours must be between 0 and 24';
      end if;
      v_status := 'present';
    else
      if length(v_trimmed) > 40 then
        raise exception 'Free-text markers are limited to 40 characters — only A counts as absent';
      end if;
      v_status := 'present';
      v_note := v_trimmed;
    end if;
  end if;

  select * into prev from public.attendance
    where employee_id = p_employee_id and date = p_date;
  if prev.id is not null then
    ot_delta := greatest(0, coalesce(v_hours,0) - 8) - greatest(0, coalesce(prev.hours,0) - 8);
  else
    ot_delta := greatest(0, coalesce(v_hours,0) - 8);
  end if;

  insert into public.attendance (employee_id, date, status, hours, note)
  values (p_employee_id, p_date, v_status,
          case when v_status = 'present' then v_hours else null end,
          v_note)
  on conflict (employee_id, date) do update set
    status = excluded.status,
    hours = excluded.hours,
    note = excluded.note
  returning * into result;

  -- rating: +/- 0.2 stars per overtime-hour delta (hours above 8/day)
  if ot_delta <> 0 then
    update public.employee set rating = public.clamp_rating(rating + 0.2 * ot_delta) where id = p_employee_id;
  end if;

  -- auto-warning: 3 consecutive absences (walking back, skipping Fridays).
  -- Only status = 'absent' counts — free-text markers never trigger it.
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
              true, to_jsonb(absent_dates), p_by);
      update public.employee set rating = public.clamp_rating(rating - 0.5) where id = p_employee_id;
      -- fan out to super admins inline (notify_super_admins checks is_staff(),
      -- which a token-driven submit has no session for)
      insert into public.notification (profile_id, title, message, type, read, is_hidden)
      select p.id, 'Auto-Generated Warning',
             (select full_name || ' (' || employee_code || ') was absent 3+ consecutive days'
              from public.employee where id = p_employee_id),
             'warning', false, false
      from public.profiles p where p.role = 'super_admin';
    end if;
  end if;

  return result;
end; $$;

comment on function public.mark_attendance_core(uuid, date, text, uuid) is
  'Marking engine shared by mark_attendance (admin, permission-checked) and submit_shared_attendance_sheet (public, token-gated). NOT executable directly — execute revoked from PUBLIC/anon.';

-- only the definer-owned wrappers may reach the core
revoke execute on function public.mark_attendance_core(uuid, date, text, uuid) from public;
revoke execute on function public.mark_attendance_core(uuid, date, text, uuid) from anon;

-- mark_attendance = permission + date-effective site checks + the shared core
create or replace function public.mark_attendance(
  p_employee_id uuid, p_date date, p_value text default null
)
returns public.attendance language plpgsql
security definer set search_path = public
as $$
declare
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

  return public.mark_attendance_core(p_employee_id, p_date, p_value, auth.uid());
end; $$;

-- 3. admin-side lifecycle ------------------------------------------------------
-- create a fresh link for a site + month (the "Send Link" button)
create or replace function public.create_attendance_share_link(
  p_site_id uuid, p_month text
)
returns jsonb language plpgsql
security definer set search_path = public
as $$
declare
  v_site public.site%rowtype;
  v_link public.attendance_share_link%rowtype;
begin
  if not public.has_menu_permission('attendance') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;

  select * into v_site from public.site where id = p_site_id and is_active;
  if v_site.id is null then
    raise exception 'Site not found';
  end if;

  -- normal admins may only share links for their assigned sites
  if not public.is_super_admin() then
    if not exists (
      select 1 from public.admin_site where profile_id = auth.uid() and site_id = p_site_id
    ) then
      raise exception 'Access denied — you can only share links for your assigned sites';
    end if;
  end if;

  if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Invalid month — expected YYYY-MM';
  end if;

  insert into public.attendance_share_link
    (token, site_id, site_name, month_key, created_by)
  values (
    substr(md5(gen_random_uuid()::text || clock_timestamp()::text || random()::text), 1, 20),
    v_site.id, v_site.name, p_month, auth.uid()
  )
  returning * into v_link;

  return jsonb_build_object(
    'id', v_link.id, 'token', v_link.token,
    'site_id', v_link.site_id, 'site_name', v_link.site_name,
    'month_key', v_link.month_key,
    'created_by', v_link.created_by,
    'created_by_name', (select name from public.profiles where id = v_link.created_by),
    'created_at', v_link.created_at,
    'status', v_link.status, 'submitted_at', v_link.submitted_at,
    'submitted_by', v_link.submitted_by, 'submit_count', v_link.submit_count,
    'edit_granted_at', v_link.edit_granted_at, 'edit_granted_by', v_link.edit_granted_by);
end; $$;

-- every link the caller may see, newest first (the right sidebar)
create or replace function public.list_attendance_share_links()
returns jsonb language plpgsql
security definer set search_path = public
as $$
declare
  v_rows jsonb;
begin
  if not public.is_staff() then
    raise exception 'Access denied';
  end if;

  select coalesce(jsonb_agg(row order by (row->>'created_at') desc), '[]'::jsonb)
  into v_rows
  from (
    select jsonb_build_object(
      'id', l.id, 'token', l.token, 'site_id', l.site_id, 'site_name', l.site_name,
      'month_key', l.month_key, 'created_by', l.created_by,
      'created_by_name', (select name from public.profiles where id = l.created_by),
      'created_at', l.created_at, 'status', l.status, 'submitted_at', l.submitted_at,
      'submitted_by', l.submitted_by, 'submit_count', l.submit_count,
      'edit_granted_at', l.edit_granted_at, 'edit_granted_by', l.edit_granted_by) as row
    from public.attendance_share_link l
    where public.is_super_admin()
       or l.site_id is null
       or exists (
         select 1 from public.admin_site a
         where a.profile_id = auth.uid() and a.site_id = l.site_id
       )
  ) t;

  return v_rows;
end; $$;

-- re-open editing on a submitted link (any admin responsible for the site)
create or replace function public.grant_attendance_share_edit(
  p_token text
)
returns void language plpgsql
security definer set search_path = public
as $$
declare
  v_link public.attendance_share_link%rowtype;
begin
  if not public.has_menu_permission('attendance') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;

  select * into v_link from public.attendance_share_link where token = p_token;
  if v_link.id is null then
    raise exception 'Link not found';
  end if;

  if not public.is_super_admin() then
    if v_link.site_id is null or not exists (
      select 1 from public.admin_site where profile_id = auth.uid() and site_id = v_link.site_id
    ) then
      raise exception 'Access denied — you can only manage links for your assigned sites';
    end if;
  end if;

  update public.attendance_share_link
    set status = 'active',
        edit_granted_at = now(),
        edit_granted_by = auth.uid()
    where id = v_link.id;
end; $$;

revoke execute on function public.create_attendance_share_link(uuid, text) from anon;
revoke execute on function public.list_attendance_share_links() from anon;
revoke execute on function public.grant_attendance_share_edit(text) from anon;

-- 4. snapshot builder (shared by submit + the locked read view) ---------------
-- One row per employee who spent at least one day of the link's month at the
-- site (date-effective), with their CURRENT cell texts, row totals and the
-- crew grand totals. This is what gets frozen into sheet_data on submit.
create or replace function public.build_shared_sheet_snapshot(
  p_link_id uuid
)
returns jsonb language plpgsql
security definer set search_path = public
as $$
declare
  p_link public.attendance_share_link%rowtype;
  v_year int;
  v_month int;
  v_days int;
  v_first date;
  v_last date;
  v_employees jsonb := '[]'::jsonb;
  v_total_hours numeric := 0;
  v_total_absents int := 0;
begin
  select * into p_link from public.attendance_share_link where id = p_link_id;
  if p_link.id is null then
    raise exception 'Link not found';
  end if;

  v_year := (split_part(p_link.month_key, '-', 1))::int;
  v_month := (split_part(p_link.month_key, '-', 2))::int;
  v_days := extract(day from (make_date(v_year, v_month, 1) + interval '1 month - 1 day'))::int;
  v_first := make_date(v_year, v_month, 1);
  v_last := make_date(v_year, v_month, v_days);

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'name', e.full_name, 'code', e.employee_code, 'trade', e.trade,
      'cells', e.cells, 'markable', e.markable,
      'total_hours', e.total_hours, 'absents', e.absents)
    order by e.full_name), '[]'::jsonb)
  into v_employees
  from (
    select emp.id, emp.full_name,
      coalesce((select t.name from public.trades t where t.id = emp.trade_id), emp.position) as trade,
      emp.employee_code,
      (select coalesce(jsonb_object_agg(to_char(a.date, 'YYYY-MM-DD'),
          case
            when a.status = 'absent' then 'A'
            when a.status = 'present' and a.hours is not null then a.hours::text
            when a.note is not null then a.note
            else ''
          end), '{}'::jsonb)
       from public.attendance a
       where a.employee_id = emp.id
         and a.date >= v_first and a.date <= v_last
         and not a.is_hidden) as cells,
      (select coalesce(jsonb_agg(to_char(d, 'YYYY-MM-DD') order by d), '[]'::jsonb)
       from generate_series(v_first, v_last, interval '1 day') d
       where public.emp_site_on_date(emp.id, d::date) = p_link.site_id) as markable,
      (select coalesce(sum(a.hours), 0) from public.attendance a
       where a.employee_id = emp.id and a.date >= v_first and a.date <= v_last
         and not a.is_hidden and a.hours is not null) as total_hours,
      (select count(*) from public.attendance a
       where a.employee_id = emp.id and a.date >= v_first and a.date <= v_last
         and not a.is_hidden and a.status = 'absent') as absents
    from public.employee emp
    where emp.status <> 'deleted'
      and exists (
        select 1 from generate_series(v_first, v_last, interval '1 day') d
        where public.emp_site_on_date(emp.id, d::date) = p_link.site_id
      )
  ) e;

  select coalesce(sum((emp->>'total_hours')::numeric), 0),
         coalesce(sum((emp->>'absents')::int), 0)
  into v_total_hours, v_total_absents
  from jsonb_array_elements(v_employees) emp;

  return jsonb_build_object(
    'saved_at', now(),
    'site_name', p_link.site_name,
    'month_key', p_link.month_key,
    'year', v_year, 'month', v_month, 'days', v_days,
    'employees', v_employees,
    'totals', jsonb_build_object('hours', round(v_total_hours, 2), 'absents', v_total_absents));
end; $$;

revoke execute on function public.build_shared_sheet_snapshot(uuid) from public;
revoke execute on function public.build_shared_sheet_snapshot(uuid) from anon;
revoke execute on function public.build_shared_sheet_snapshot(uuid) from authenticated;

-- 5. PUBLIC read by token (no login — the token IS the capability) ------------
create or replace function public.get_shared_attendance_sheet(
  p_token text
)
returns jsonb language plpgsql
security definer set search_path = public
as $$
declare
  v_link public.attendance_share_link%rowtype;
  v_snap jsonb;
begin
  select * into v_link from public.attendance_share_link where token = p_token;
  if v_link.id is null then
    return jsonb_build_object('exists', false);
  end if;

  -- submitted link → the SAVED sheet (read-only view) + save date/time
  if v_link.status = 'submitted' and v_link.sheet_data is not null then
    return jsonb_build_object(
      'exists', true, 'token', v_link.token,
      'site_id', v_link.site_id, 'site_name', v_link.site_name,
      'month_key', v_link.month_key,
      'status', v_link.status,
      'submitted_at', v_link.submitted_at,
      'submitted_by', v_link.submitted_by,
      'submit_count', v_link.submit_count,
      'edit_granted_at', v_link.edit_granted_at,
      'created_at', v_link.created_at,
      'today', to_char(current_date, 'YYYY-MM-DD'),
      'employees', '[]'::jsonb,
      'snapshot', v_link.sheet_data);
  end if;

  -- active link → live crew + current marks, editable until submitted
  v_snap := public.build_shared_sheet_snapshot(v_link.id);
  return jsonb_build_object(
    'exists', true, 'token', v_link.token,
    'site_id', v_link.site_id, 'site_name', v_link.site_name,
    'month_key', v_link.month_key,
    'year', (v_snap->>'year')::int, 'month', (v_snap->>'month')::int, 'days', (v_snap->>'days')::int,
    'status', v_link.status,
    'submitted_at', v_link.submitted_at,
    'submitted_by', v_link.submitted_by,
    'submit_count', v_link.submit_count,
    'edit_granted_at', v_link.edit_granted_at,
    'created_at', v_link.created_at,
    'today', to_char(current_date, 'YYYY-MM-DD'),
    'employees', v_snap->'employees',
    'snapshot', null);
end; $$;

grant execute on function public.get_shared_attendance_sheet(text) to anon, authenticated;

-- 6. PUBLIC one-time submit by token ------------------------------------------
-- p_entries: [{"employee_id":"…","date":"YYYY-MM-DD","value":"8|A|OT|"}] —
-- only CHANGED cells. Applies them through the shared marking engine, freezes
-- the snapshot, stamps submitted_at and locks the link.
create or replace function public.submit_shared_attendance_sheet(
  p_token text, p_entries jsonb default '[]'::jsonb, p_submitted_by text default null
)
returns jsonb language plpgsql
security definer set search_path = public
as $$
declare
  v_link public.attendance_share_link%rowtype;
  v_entry jsonb;
  v_emp public.employee%rowtype;
  v_date date;
  v_bad boolean;
  v_first date;
  v_last date;
  v_applied int := 0;
  v_skipped int := 0;
  v_snap jsonb;
begin
  select * into v_link from public.attendance_share_link where token = p_token;
  if v_link.id is null then
    raise exception 'Link not found';
  end if;

  -- ONE-TIME USE: once submitted the same link can never edit again until an
  -- admin grants edit access back
  if v_link.status <> 'active' then
    raise exception 'This sheet was already submitted and is locked — ask an admin to grant edit access to the link';
  end if;

  v_first := make_date((split_part(v_link.month_key, '-', 1))::int,
                       (split_part(v_link.month_key, '-', 2))::int, 1);
  v_last := (v_first + interval '1 month - 1 day')::date;

  for v_entry in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb))
  loop
    select * into v_emp from public.employee
      where id = coalesce((v_entry->>'employee_id')::uuid, '00000000-0000-0000-0000-000000000000'::uuid);
    if v_emp.id is null or v_emp.status = 'deleted' then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    begin
      v_date := (v_entry->>'date')::date;
      v_bad := false;
    exception when others then
      v_bad := true;
    end;
    if v_bad then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- only PAST days of the link's month, marked at THIS site (the same
    -- date-effective rule the marking sheet enforces)
    if v_date < v_first or v_date > v_last or v_date > current_date
       or public.emp_site_on_date(v_emp.id, v_date) is distinct from v_link.site_id then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    begin
      perform public.mark_attendance_core(v_emp.id, v_date, coalesce(v_entry->>'value', ''), v_link.created_by);
    exception when others then
      raise exception '% — %', v_emp.full_name, sqlerrm;
    end;
    v_applied := v_applied + 1;
  end loop;

  -- freeze the saved sheet + stamp the date/time it got saved
  v_snap := public.build_shared_sheet_snapshot(v_link.id);
  update public.attendance_share_link
    set status = 'submitted',
        submitted_at = now(),
        submitted_by = nullif(btrim(coalesce(p_submitted_by, '')), ''),
        submit_count = submit_count + 1,
        sheet_data = v_snap
    where id = v_link.id
    returning submitted_at into v_link.submitted_at;

  return jsonb_build_object(
    'ok', true, 'applied', v_applied, 'skipped', v_skipped,
    'saved_at', v_link.submitted_at);
end; $$;

grant execute on function public.submit_shared_attendance_sheet(text, jsonb, text) to anon, authenticated;

-- 7. realtime — the admin sidebar refreshes when a sheet is submitted ---------
do $$ begin
  alter publication supabase_realtime add table public.attendance_share_link;
exception when duplicate_object then null; end $$;
