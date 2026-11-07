-- ============================================================================
-- 20261107 — ATTENDANCE FREE-TEXT MARKERS
-- ----------------------------------------------------------------------------
-- User request: in the attendance sheet we should be able to mark FREE TEXT,
-- and ANY free text other than "A" must NOT be considered absent.
--
-- What changes:
--   1. attendance.note — new column that stores the free-text marker typed
--      into a cell (e.g. "OT", "H", "travel", "5+4"). The text is saved,
--      shown in the cell (sheet + calendar + employee details) and counts as
--      a PRESENT day with NO tracked hours.
--   2. mark_attendance — new parsing rules:
--        '' / null            → clear the cell (record removed)
--        'a' / 'A'            → ABSENT (the ONLY text that ever counts as
--                               absent — the old 'absent' word alias is gone)
--        numeric 0–24         → present + hours
--        ANY other text       → present, no hours, text stored in `note`
--                               (max 40 characters)
--      Free-text days add no hours to payroll (the salary engine already
--      ignores rows with hours is null) and never trigger the 3-consecutive-
--      absences auto-warning. bulk_mark_attendance delegates to this
--      function, so bulk entries get the identical behaviour.
--   3. get_month_attendance already returns `select a.*` — the new column
--      flows to the UI automatically. No RLS/policy change needed (column
--      inherits the table's policies).
-- ============================================================================

-- 1. the marker column -------------------------------------------------------
alter table public.attendance
  add column if not exists note text;

comment on column public.attendance.note is
  'Free-text marker typed into the sheet (e.g. OT, H, travel) — stored and displayed; anything other than A is never counted as absent (present day, no tracked hours)';

-- 2. mark_attendance with free-text support ---------------------------------
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
  v_note text := null;
  ot_delta numeric := 0;
  walk date;
  absent_dates date[] := array[p_date];
  v_emp_site uuid;
  v_trimmed text;
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

-- 3. bulk doc update (behaviour comes from mark_attendance automatically) ----
comment on function public.bulk_mark_attendance(p_entries jsonb) is
  'Bulk day entry: value is hours ("10"), "A" (the ONLY absent marker), any other free text (max 40 chars — present day with no hours, text kept as a marker) or "" to clear.';
