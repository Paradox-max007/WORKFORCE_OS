-- ============================================================================
-- 20261108b — PAPER-STYLED shared sheet (the site DAILY ATTENDANCE form)
-- ----------------------------------------------------------------------------
-- User request:
--   • the shared link must open the site attendance PDF-STYLED PAPER (the A4
--     "DAILY ATTENDANCE" form used on the Sites page) — NOT the Excel-style
--     month marking grid
--   • the SIGNATURE column carries the clickable / editable options: each
--     employee row is marked Present (hours, default 10), Absent ("A") or a
--     short custom marker — exactly the marking-sheet cell grammar
--   • submitting writes through the SAME marking engine into the SAME
--     public.attendance table, so the in-app Excel marking sheet updates too
--
-- What changes:
--   1. build_shared_sheet_snapshot — per-employee is_team_leader / is_supervisor
--      flags (the paper's TL / SUPERVISOR row tints + trade suffixes) and the
--      paper header names: client_name + project_name from the site row.
--   2. submit_shared_attendance_sheet — new optional p_paper_date + p_extras
--      params: the date shown on the submitted paper and its EXTRA EMPLOYEES
--      rows are frozen into the snapshot. The TOTAL PRESENT / TOTAL ABSENT
--      boxes are computed SERVER-SIDE from the final marks of that date
--      (crew records + extra rows) — never trusted from the client. Signature
--      marks still flow through mark_attendance_core → public.attendance
--      (same table as the admin marking sheet → the Excel updates too).
--      The old 3-arg signature is dropped (no callers besides the updated
--      share page) so Postgres does not keep a stale overload.
--   3. get_shared_attendance_sheet — the live (active) view now carries
--      client_name / project_name; the submitted view back-fills paper_date
--      for LEGACY snapshots (saved by the previous month-grid version) with
--      the date the sheet was saved, so the paper always renders.
-- ============================================================================

-- 1. enriched snapshot builder -----------------------------------------------
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
      'is_team_leader', e.is_team_leader, 'is_supervisor', e.is_supervisor,
      'cells', e.cells, 'markable', e.markable,
      'total_hours', e.total_hours, 'absents', e.absents)
    order by e.full_name), '[]'::jsonb)
  into v_employees
  from (
    select emp.id, emp.full_name,
      coalesce((select t.name from public.trades t where t.id = emp.trade_id), emp.position) as trade,
      emp.employee_code,
      (emp.is_team_leader and emp.team_leader_site_id = p_link.site_id) as is_team_leader,
      coalesce(coalesce((select t.name from public.trades t where t.id = emp.trade_id), emp.position), '') ilike '%supervisor%'
        as is_supervisor,
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
    'client_name', (select s.client_name from public.site s where s.id = p_link.site_id),
    'project_name', coalesce(nullif((select s.project_name from public.site s where s.id = p_link.site_id), ''), p_link.site_name),
    'month_key', p_link.month_key,
    'year', v_year, 'month', v_month, 'days', v_days,
    'employees', v_employees,
    'totals', jsonb_build_object('hours', round(v_total_hours, 2), 'absents', v_total_absents));
end; $$;

revoke execute on function public.build_shared_sheet_snapshot(uuid) from public;
revoke execute on function public.build_shared_sheet_snapshot(uuid) from anon;
revoke execute on function public.build_shared_sheet_snapshot(uuid) from authenticated;

-- 2. one-time submit with the paper form's date + extra employees -------------
drop function if exists public.submit_shared_attendance_sheet(text, jsonb, text);

create or replace function public.submit_shared_attendance_sheet(
  p_token text, p_entries jsonb default '[]'::jsonb, p_submitted_by text default null,
  p_paper_date date default null, p_extras jsonb default '[]'::jsonb
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
  v_paper_date date;
  v_paper_extras jsonb := '[]'::jsonb;
  v_total_present int := 0;
  v_total_absent int := 0;
  v_extra jsonb;
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

  -- the date the paper was showing (clamped into the month, never the future)
  v_paper_date := least(greatest(coalesce(p_paper_date, current_date), v_first), least(v_last, current_date));

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

  -- sanitised EXTRA EMPLOYEES rows (max 10, trimmed, length-capped)
  if jsonb_typeof(p_extras) = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'name', left(btrim(coalesce(x->>'name', '')), 80),
        'code', left(btrim(coalesce(x->>'code', '')), 40),
        'trade', left(btrim(coalesce(x->>'trade', '')), 60),
        'mark', left(btrim(coalesce(x->>'mark', '')), 40))
      order by ord), '[]'::jsonb)
    into v_paper_extras
    from (
      select x, ord
      from jsonb_array_elements(p_extras) with ordinality as t(x, ord)
      limit 10
    ) s;
  end if;

  -- TOTAL PRESENT / TOTAL ABSENT boxes — computed from the FINAL marks of the
  -- paper's date: crew attendance rows (present = any mark that is not "A") +
  -- extra rows (mark not empty; "A" counts absent, anything else present)
  select
    count(*) filter (where a.status = 'present')
    + (select count(*) from jsonb_array_elements(v_paper_extras) e
       where btrim(coalesce(e->>'mark', '')) <> '' and upper(btrim(e->>'mark')) <> 'A'),
    count(*) filter (where a.status = 'absent')
    + (select count(*) from jsonb_array_elements(v_paper_extras) e
       where upper(btrim(e->>'mark')) = 'A')
  into v_total_present, v_total_absent
  from public.attendance a
  where a.date = v_paper_date
    and not a.is_hidden
    and public.emp_site_on_date(a.employee_id, a.date) = v_link.site_id;

  -- freeze the saved paper + stamp the date/time it got saved
  v_snap := public.build_shared_sheet_snapshot(v_link.id)
    || jsonb_build_object(
      'paper_date', to_char(v_paper_date, 'YYYY-MM-DD'),
      'extras', v_paper_extras,
      'total_present', v_total_present,
      'total_absent', v_total_absent);

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
    'saved_at', v_link.submitted_at,
    'paper_date', to_char(v_paper_date, 'YYYY-MM-DD'),
    'total_present', v_total_present, 'total_absent', v_total_absent);
end; $$;

grant execute on function public.submit_shared_attendance_sheet(text, jsonb, text, date, jsonb) to anon, authenticated;

-- 3. public read by token -----------------------------------------------------
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

  -- submitted link → the SAVED paper (read-only view) + save date/time;
  -- legacy snapshots (saved by the month-grid version) get their paper_date
  -- back-filled with the date the sheet was saved
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
      'snapshot',
        case when v_link.sheet_data ? 'paper_date' then v_link.sheet_data
             else v_link.sheet_data
                  || jsonb_build_object('paper_date', to_char(v_link.submitted_at, 'YYYY-MM-DD'))
        end);
  end if;

  -- active link → live crew + current marks, editable until submitted
  v_snap := public.build_shared_sheet_snapshot(v_link.id);
  return jsonb_build_object(
    'exists', true, 'token', v_link.token,
    'site_id', v_link.site_id, 'site_name', v_link.site_name,
    'month_key', v_link.month_key,
    'year', (v_snap->>'year')::int, 'month', (v_snap->>'month')::int, 'days', (v_snap->>'days')::int,
    'client_name', v_snap->'client_name',
    'project_name', v_snap->'project_name',
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
