-- ============================================================================
-- 20261113f — TIME-CARD CARRYOVER → ADVANCE BOOK RECORD
-- ============================================================================
-- The time-card carryover (a NEGATIVE difference: the attendance salary
-- exceeded the approved time card) used to write directly into the NEXT
-- month's payroll advance with a note. Now it is stored as a NORMAL ADVANCE
-- RECORD in the Advance Book:
--
--   • one advance_record per (source period, employee) — tracked by the new
--     advance_record.source_period_id column (unique where not null), so
--     re-saving the time card UPDATES the record instead of duplicating it
--   • the record carries the note (time card vs attendance hours) and the
--     DEFAULT CUT MONTH = the very next month after the source period
--   • advance_book_sync_period folds it into that month's Advance column
--     (advance = manual part + Σ book records) — a manual reschedule of the
--     record to a later month is PRESERVED on re-save; only the amount and
--     the note follow the time card
--   • v_needed = 0 (the time card now matches) deletes the record again
--   • cleared records (the cut month's salary was already paid) are history:
--     re-saving raises instead of rewriting paid salaries
--
--   get_advance_book           gains from_time_card (UI badge)
--   get_salary_sheet v6        REPAIR of a 20261113e regression — its v5 was
--                              built from a pre-20261113d body and dropped the
--                              time card fields (per employee + per site) and
--                              the Idle Employees no-site hours rows; v6
--                              restores them and keeps the advance-book fields
--
--   DATA MIGRATION             legacy carryovers (payroll_time_card.
--                              carryover_applied > 0, written directly into
--                              the next month's advance) become book records
--                              too, and advance_book_applied is raised so the
--                              sync never double-counts them
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. advance_record.source_period_id — links a record to the payroll period
--    whose time card produced it (null → a normal, manually added record)
-- ---------------------------------------------------------------------------
alter table public.advance_record
  add column if not exists source_period_id uuid
  references public.payroll_period(id) on delete cascade;

create unique index if not exists uq_advance_record_source
  on public.advance_record(source_period_id, employee_id)
  where source_period_id is not null;

-- ---------------------------------------------------------------------------
-- 2. save_site_time_card_hours v3 — the carryover becomes a normal advance
--    book record (cut = the very next month) folded in by the book sync
-- ---------------------------------------------------------------------------
create or replace function public.save_site_time_card_hours(
  p_period_id uuid, p_site_id uuid, p_entries jsonb
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_entry jsonb;
  v_employee_id uuid;
  v_hours numeric;
  v_pe public.payroll_employee;
  v_emp record;
  v_site_name text;
  v_actor text;
  v_saved int := 0;
  v_cleared int := 0;
  -- carryover
  v_src public.payroll_period;
  v_next_year int;
  v_next_month int;
  v_next_period public.payroll_period;
  v_extra numeric;
  v_tc_hours numeric;
  v_att_hours numeric;
  v_needed numeric;
  v_rec public.advance_record;
  v_note text;
  v_month_name text;
  v_next_month_name text;
  v_cut_year int;
  v_cut_month int;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;

  select name into v_site_name from public.site where id = p_site_id;
  if v_site_name is null then
    raise exception 'Site not found';
  end if;
  select * into v_src from public.payroll_period where id = p_period_id;
  if v_src.id is null then
    raise exception 'Payroll period not found';
  end if;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();

  for v_entry in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    v_employee_id := nullif(btrim(coalesce(v_entry->>'employee_id', '')), '')::uuid;
    if v_employee_id is null then
      raise exception 'An entry is missing its employee id';
    end if;

    -- hours: null / '' / absent → remove the entry; otherwise validate
    v_hours := nullif(btrim(coalesce(v_entry->>'hours', '')), '');
    if v_hours is not null then
      v_hours := round(v_hours::numeric, 2);
      if v_hours < 0 then
        raise exception 'Time card hours must be 0 or more';
      end if;
    end if;

    -- the employee must be part of this payroll period
    select * into v_pe from public.payroll_employee
    where payroll_period_id = p_period_id and employee_id = v_employee_id;
    if v_pe.id is null then
      raise exception 'Employee % is not part of this payroll period', v_employee_id::text;
    end if;

    if v_hours is null then
      delete from public.payroll_time_card
      where payroll_period_id = p_period_id
        and site_id = p_site_id
        and employee_id = v_employee_id;
      v_cleared := v_cleared + 1;
    else
      insert into public.payroll_time_card (
        payroll_period_id, site_id, employee_id, time_card_hours, updated_by
      ) values (p_period_id, p_site_id, v_employee_id, v_hours, auth.uid())
      on conflict (payroll_period_id, site_id, employee_id) do update set
        time_card_hours = excluded.time_card_hours,
        updated_at = now(),
        updated_by = excluded.updated_by;
      v_saved := v_saved + 1;
    end if;
  end loop;

  if v_saved > 0 or v_cleared > 0 then
    insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
    values (p_period_id, 'time_card', auth.uid(), v_actor,
            'Time card hours for ' || v_site_name || ' — '
            || v_saved || ' saved, ' || v_cleared || ' cleared');
  end if;

  -- -------------------------------------------------------------------------
  -- CARRYOVER — a NEGATIVE total difference is recovered from the NEXT
  -- month's salary. It is stored as a NORMAL ADVANCE BOOK RECORD (source =
  -- this period, cut = the very next month, note = the calculation) and
  -- advance_book_sync_period folds it into that month's Advance column.
  -- Idempotent: the record is matched by (source period, employee), so
  -- re-saving the time card only updates amount + note.
  -- -------------------------------------------------------------------------
  v_next_year := v_src.year + case when v_src.month = 12 then 1 else 0 end;
  v_next_month := case when v_src.month = 12 then 1 else v_src.month + 1 end;
  v_month_name := (array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])[v_src.month]
                  || ' ' || v_src.year::text;
  v_next_month_name := (array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])[v_next_month]
                       || ' ' || v_next_year::text;

  for v_emp in
    select distinct e.id as employee_id, e.full_name, e.employee_code
    from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) en
    join public.employee e
      on e.id = nullif(btrim(coalesce(en->>'employee_id', '')), '')::uuid
  loop
    -- total time-card difference across ALL of the employee's entries this
    -- period (Σ per-site (time card − attendance hours) × rate)
    select coalesce(sum(
             (tc.time_card_hours - coalesce(s.total_hours, 0)) *
             (case when coalesce(s.total_hours, 0) > 0 then s.gross_salary / s.total_hours
                   when pe.total_hours > 0 then pe.gross_salary / pe.total_hours
                   else 0 end)
           ), 0),
           coalesce(sum(tc.time_card_hours), 0)
    into v_extra, v_tc_hours
    from public.payroll_time_card tc
    join public.payroll_employee pe
      on pe.payroll_period_id = tc.payroll_period_id and pe.employee_id = tc.employee_id
    left join public.payroll_employee_site s
      on s.payroll_employee_id = pe.id and s.site_id = tc.site_id
    where tc.payroll_period_id = p_period_id
      and tc.employee_id = v_emp.employee_id;

    v_extra := round(coalesce(v_extra, 0), 2);
    v_needed := case when v_extra < 0 then -v_extra else 0 end;

    -- attendance hours of this employee in the SOURCE period (note details)
    select coalesce(pe.total_hours, 0) into v_att_hours
    from public.payroll_employee pe
    where pe.payroll_period_id = p_period_id
      and pe.employee_id = v_emp.employee_id;

    -- the carryover record of THIS source period + employee (if any)
    select * into v_rec from public.advance_record
    where source_period_id = p_period_id and employee_id = v_emp.employee_id;

    -- nothing to carry over and no record → done
    if v_needed = 0 and v_rec.id is null then
      continue;
    end if;

    -- idempotent no-op: the record already says exactly this
    if v_rec.id is not null
       and v_rec.amount = v_needed
       and v_rec.cut_year = v_next_year and v_rec.cut_month = v_next_month then
      continue;
    end if;

    -- a CLEARED record (its cut month's salary was paid with it folded in)
    -- is history — the time card cannot rewrite a paid salary
    if v_rec.id is not null and v_rec.applied_amount > 0 and exists (
      select 1 from public.payroll_period p
      join public.payroll_employee pe
        on pe.payroll_period_id = p.id and pe.employee_id = v_rec.employee_id
      where p.year = v_rec.cut_year and p.month = v_rec.cut_month
        and pe.payment_status = 'paid') then
      raise exception 'The % carryover advance was already cleared — the % salary was paid. Add a new advance record instead.',
        v_emp.full_name, to_char(make_date(v_rec.cut_year, v_rec.cut_month, 1), 'TMMonth YYYY');
    end if;

    if v_needed = 0 then
      -- the time card now matches the attendance → remove the record
      delete from public.advance_record where id = v_rec.id;

      perform public.advance_book_sync_period(v_rec.cut_year, v_rec.cut_month);

      insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
      values (p_period_id, 'time_card_carryover', auth.uid(), v_actor,
              coalesce(v_emp.full_name, 'Unknown employee') || ' (' ||
              coalesce(v_emp.employee_code, '—') || ') — time card ' ||
              v_tc_hours::text || ' h vs attendance ' ||
              coalesce(v_att_hours, 0)::text || ' h → matches, carryover record of ' ||
              round(v_rec.amount, 2) || ' removed from the advance book');
    else
      -- the FINAL cut month: the DEFAULT is the very next month; a record
      -- the user RESCHEDULED to a later month keeps its cut (only the
      -- amount + the note follow the time card)
      if v_rec.id is not null
         and (v_rec.cut_year <> v_next_year or v_rec.cut_month <> v_next_month) then
        v_cut_year := v_rec.cut_year;
        v_cut_month := v_rec.cut_month;
      else
        v_cut_year := v_next_year;
        v_cut_month := v_next_month;

        -- ensure NEXT month's payroll period exists (draft) so the record
        -- and the advance become visible the moment that month is opened
        insert into public.payroll_period (year, month, created_by)
        values (v_next_year, v_next_month, auth.uid())
        on conflict (year, month) do update set year = public.payroll_period.year
        returning * into v_next_period;

        if v_next_period.status = 'finalized' then
          raise exception 'The % payroll is already finalized — reopen it before changing time card carryovers',
            v_next_month_name;
        end if;
      end if;

      v_note := '[Time card ' || v_month_name || '] time card ' || v_tc_hours::text
              || ' h vs attendance ' || coalesce(v_att_hours, 0)::text
              || ' h → ' || v_needed::text || ' cutting from '
              || to_char(make_date(v_cut_year, v_cut_month, 1), 'TMMon YYYY');

      if v_rec.id is null then
        insert into public.advance_record
          (employee_id, amount, given_date, cut_year, cut_month, note,
           created_by, source_period_id)
        values
          (v_emp.employee_id, v_needed, current_date, v_cut_year, v_cut_month,
           v_note, auth.uid(), p_period_id);
      else
        update public.advance_record set
          amount = v_needed,
          note = v_note,
          applied_amount = 0,
          updated_at = now()
        where id = v_rec.id;
      end if;

      -- fold the (updated) record into its cut month's Advance column
      perform public.advance_book_sync_period(v_cut_year, v_cut_month);

      insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
      values (p_period_id, 'time_card_carryover', auth.uid(), v_actor,
              coalesce(v_emp.full_name, 'Unknown employee') || ' (' ||
              coalesce(v_emp.employee_code, '—') || ') — time card ' ||
              v_tc_hours::text || ' h vs attendance ' ||
              coalesce(v_att_hours, 0)::text || ' h → ' || v_needed::text ||
              ' advance book record cutting from ' ||
              to_char(make_date(v_cut_year, v_cut_month, 1), 'TMMon YYYY'));
    end if;

    -- rebalance the internal tracking so Σ carryover_applied = the scheduled
    -- carryover (kept for the entries table only — the record is the truth)
    update public.payroll_time_card set carryover_applied = 0
    where payroll_period_id = p_period_id and employee_id = v_emp.employee_id;
    if v_needed <> 0 then
      update public.payroll_time_card set carryover_applied = v_needed
      where id = (
        select id from public.payroll_time_card
        where payroll_period_id = p_period_id and employee_id = v_emp.employee_id
        order by created_at, id
        limit 1
      );
    end if;
  end loop;
end; $$;

-- ---------------------------------------------------------------------------
-- 3. get_advance_book — adds from_time_card (records born from a time-card
--    carryover; the UI badges them)
-- ---------------------------------------------------------------------------
create or replace function public.get_advance_book()
returns jsonb language plpgsql stable
security definer set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll')
     and not public.has_menu_permission('advance_book') then
    raise exception 'Access denied';
  end if;

  with recs as (
    select r.id, r.employee_id, r.amount, r.given_date,
           r.cut_year, r.cut_month, r.note, r.created_by, r.created_at,
           (r.source_period_id is not null) as from_time_card,
           e.full_name, e.employee_code, e.photo,
           -- DERIVED status — can never drift from the payroll data:
           -- cleared = the cut month's salary is PAID *and* this record was
           -- folded into it (applied_amount > 0). A record added AFTER the
           -- salary was paid never folded in → stays DUE for rescheduling.
           (coalesce(pe.payment_status, '') = 'paid' and r.applied_amount > 0) as cleared,
           pe.paid_at as cleared_at,
           (r.applied_amount > 0) as applied,
           (not (coalesce(pe.payment_status, '') = 'paid' and r.applied_amount > 0)
             and (r.cut_year, r.cut_month)
                 < (extract(year from now())::int, extract(month from now())::int)) as overdue
    from public.advance_record r
    join public.employee e on e.id = r.employee_id
    left join public.payroll_period p on p.year = r.cut_year and p.month = r.cut_month
    left join public.payroll_employee pe
      on pe.payroll_period_id = p.id and pe.employee_id = r.employee_id
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rec.id, 'employee_id', rec.employee_id,
        'full_name', rec.full_name, 'employee_code', rec.employee_code,
        'photo', rec.photo,
        'amount', rec.amount, 'given_date', rec.given_date,
        'cut_year', rec.cut_year, 'cut_month', rec.cut_month, 'note', rec.note,
        'from_time_card', rec.from_time_card,
        'cleared', rec.cleared,
        'cleared_at', rec.cleared_at,
        'applied', rec.applied,
        'overdue', rec.overdue,
        'created_by_name', (select coalesce(name, email) from public.profiles where id = rec.created_by),
        'created_at', rec.created_at
      ) order by rec.given_date desc, rec.created_at desc)
      from recs rec
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'due_count', count(*) filter (where not cleared),
      'due_amount', round(coalesce(sum(amount) filter (where not cleared), 0), 2),
      'overdue_count', count(*) filter (where not cleared and overdue),
      'overdue_amount', round(coalesce(sum(amount) filter (where not cleared and overdue), 0), 2),
      'cleared_count', count(*) filter (where cleared),
      'cleared_amount', round(coalesce(sum(amount) filter (where cleared), 0), 2)
    )
  )
  into v_result
  from recs;

  return v_result;
end; $$;

-- ---------------------------------------------------------------------------
-- 3b. get_salary_sheet v6 — REPAIRS a regression of 20261113e: its v5 was
--     built from a pre-20261113d body and silently DROPPED
--       • the per-employee time_card_hours / time_card_amount fields and the
--         per-site time_card_total / time_card_amount_total (20261113d)
--       • the Idle Employees no-site HOURS rows (the (a) part of the group)
--     v6 restores them and KEEPS the advance-book fields of v5
--     (advance_book_applied / advance_book_due). Body = v4 + book fields.
-- ---------------------------------------------------------------------------
create or replace function public.get_salary_sheet(p_year int, p_month int)
returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_period public.payroll_period;
  v_totals jsonb;
  v_sites jsonb := '[]'::jsonb;
  v_idle_rows jsonb := '[]'::jsonb;
  v_employees jsonb;
  v_audit jsonb;
  v_rows jsonb;
  v_group record;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;

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
    'deductions', round(coalesce(sum(deduction + absent_deduction), 0), 2),
    'net_payable', round(coalesce(sum(net_salary), 0), 2),
    'paid_count', count(*) filter (where payment_status = 'paid'),
    'unpaid_count', count(*) filter (where payment_status <> 'paid')
  ) into v_totals
  from public.payroll_employee where payroll_period_id = v_period.id;

  -- normal site groups (employee × site rows, gross at that site) — keyed by
  -- site id, never by name. The "no site" bucket is NOT a site group: it is
  -- part of Idle Employees below.
  for v_group in
    select s.site_id, s.site_name_snapshot as site_name,
           count(*)::int as employees,
           round(sum(s.total_hours), 2) as total_hours,
           round(sum(s.gross_salary), 2) as gross_salary,
           (select round(coalesce(sum(tc.time_card_hours), 0), 2)
            from public.payroll_time_card tc
            where tc.payroll_period_id = v_period.id
              and tc.site_id = s.site_id) as time_card_total,
           (select round(coalesce(sum(
                     (tc.time_card_hours - coalesce(ps.total_hours, 0)) *
                     (case when coalesce(ps.total_hours, 0) > 0 then ps.gross_salary / ps.total_hours
                           when pe.total_hours > 0 then pe.gross_salary / pe.total_hours
                           else 0 end)), 0), 2)
            from public.payroll_time_card tc
            join public.payroll_employee pe
              on pe.payroll_period_id = v_period.id and pe.employee_id = tc.employee_id
            left join public.payroll_employee_site ps
              on ps.payroll_employee_id = pe.id and ps.site_id = s.site_id
            where tc.payroll_period_id = v_period.id
              and tc.site_id = s.site_id) as time_card_amount_total
    from public.payroll_employee_site s
    join public.payroll_employee pe on pe.id = s.payroll_employee_id
    where pe.payroll_period_id = v_period.id
      and s.site_id is not null
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
      'time_card_hours', (select tc.time_card_hours
                          from public.payroll_time_card tc
                          where tc.payroll_period_id = v_period.id
                            and tc.site_id = r.site_id
                            and tc.employee_id = pe.employee_id),
      'time_card_amount', (select round((tc.time_card_hours - coalesce(r.total_hours, 0)) *
                          (case when r.total_hours > 0 then r.gross_salary / r.total_hours
                                when pe.total_hours > 0 then pe.gross_salary / pe.total_hours
                                else 0 end), 2)
                          from public.payroll_time_card tc
                          where tc.payroll_period_id = v_period.id
                            and tc.site_id = r.site_id
                            and tc.employee_id = pe.employee_id),
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
      'salary_role', pe.salary_role_snapshot,
      'synthetic', false
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
      'time_card_total', v_group.time_card_total,
      'time_card_amount_total', v_group.time_card_amount_total,
      'rows', v_rows,
      'idle', false
    );
  end loop;

  -- IDLE EMPLOYEES (always the LAST group):
  --   (a) employees with unassigned / unrated (no-site) hours — the hours are
  --       shown as idle hours, never attributed to an invented site;
  --   (b) employees whose CURRENT site is empty and who have no no-site row
  --       (synthetic zero rows — includes site-less employees with no
  --       attendance at all). Historical attendance of these employees keeps
  --       its original site attribution and stays in the site groups above.
  select coalesce(jsonb_agg(payload order by full_name), '[]'::jsonb) into v_idle_rows
  from (
    select jsonb_build_object(
        'site_id', null,
        'site_name', 'Idle Employees',
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
                    and l.site_id is null),
        'employee_id', pe.employee_id,
        'full_name', e.full_name,
        'employee_code', e.employee_code,
        'nationality', e.nationality,
        'photo', e.photo,
        'trade_name', t.name,
        'salary_role', pe.salary_role_snapshot,
        'synthetic', false
      ) as payload, e.full_name
    from public.payroll_employee_site r
    join public.payroll_employee pe on pe.id = r.payroll_employee_id
    join public.employee e on e.id = pe.employee_id
    left join public.trades t on t.id = pe.trade_id_snapshot
    where pe.payroll_period_id = v_period.id
      and r.site_id is null

    union all

    select jsonb_build_object(
        'site_id', null,
        'site_name', 'Idle Employees',
        'total_hours', 0,
        'below_threshold_hours', 0,
        'qualified_hours', 0,
        'standard_hours', 0,
        'team_leader_hours', 0,
        'supervisor_hours', 0,
        'gross_salary', 0,
        'has_missing_rate', false,
        'manually_edited', false,
        'lines', '[]'::jsonb,
        'employee_id', pe.employee_id,
        'full_name', e.full_name,
        'employee_code', e.employee_code,
        'nationality', e.nationality,
        'photo', e.photo,
        'trade_name', t.name,
        'salary_role', pe.salary_role_snapshot,
        'synthetic', true
      ) as payload, e.full_name
    from public.payroll_employee pe
    join public.employee e on e.id = pe.employee_id
    left join public.trades t on t.id = pe.trade_id_snapshot
    where pe.payroll_period_id = v_period.id
      and e.current_site_id is null
      and not exists (
        select 1 from public.payroll_employee_site s
        where s.payroll_employee_id = pe.id and s.site_id is null)
  ) idle;

  if v_idle_rows is not null and jsonb_array_length(v_idle_rows) > 0 then
    v_sites := v_sites || jsonb_build_object(
      'site_id', null,
      'site_name', 'Idle Employees',
      'employees', jsonb_array_length(v_idle_rows),
      'total_hours', (select coalesce(round(sum((x->>'total_hours')::numeric), 2), 0)
                      from jsonb_array_elements(v_idle_rows) x),
      'gross_salary', (select coalesce(round(sum((x->>'gross_salary')::numeric), 2), 0)
                       from jsonb_array_elements(v_idle_rows) x),
      'rows', v_idle_rows,
      'idle', true
    );
  end if;

  -- consolidated per-employee rows — ONE row per employee for the Payroll
  -- page; includes the qualification fields used by the hours tooltip and the
  -- payment method (payment_type + card_type) for the new column / filter.
  -- threshold_date = first date the lifetime cumulative (opening + all
  -- tracked attendance) reaches 1,000 h — computed chronologically.
  -- time_card_hours = Σ approved time card hours of the month (null → none
  -- entered); time_card_amount = Σ per-site (time card − attendance hours) ×
  -- rate — the difference added to the Payroll's net payable (positive) or
  -- carried to next month's advance (negative).
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', pe.id,
    'payroll_period_id', pe.payroll_period_id,
    'employee_id', pe.employee_id,
    'full_name', e.full_name,
    'employee_code', e.employee_code,
    'nationality', e.nationality,
    'photo', e.photo,
    'status', e.status,
    'camp_id', e.camp_id,
    'camp_name', c.name,
    'trade_id', pe.trade_id_snapshot,
    'trade_name', t.name,
    'payment_type', e.payment_type,
    'card_type', ct.name,
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
    'advance_book_applied', pe.advance_book_applied,
    'advance_book_due', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'amount', r.amount, 'given_date', r.given_date,
        'cut_year', r.cut_year, 'cut_month', r.cut_month, 'note', r.note)
        order by r.cut_year, r.cut_month, r.created_at), '[]'::jsonb)
      from public.advance_record r
      where r.employee_id = pe.employee_id
        and not exists (
          select 1 from public.payroll_period p2
          join public.payroll_employee pe2
            on pe2.payroll_period_id = p2.id and pe2.employee_id = r.employee_id
          where p2.year = r.cut_year and p2.month = r.cut_month
            and pe2.payment_status = 'paid'
            and r.applied_amount > 0)),
    'deduction', pe.deduction,
    'absent_deduction', pe.absent_deduction,
    'absent_deduction_edited', pe.absent_deduction_edited,
    'net_salary', pe.net_salary,
    'payment_status', pe.payment_status,
    'paid_at', pe.paid_at,
    'paid_by', pe.paid_by,
    'paid_by_name', (select coalesce(name, email) from public.profiles where id = pe.paid_by),
    'notes', pe.notes,
    'join_date', e.join_date,
    'six_month_date', (coalesce(e.join_date, e.created_at::date) + interval '6 months')::date,
    'time_card_hours', (select round(sum(tc.time_card_hours), 2)
                        from public.payroll_time_card tc
                        where tc.payroll_period_id = v_period.id
                          and tc.employee_id = pe.employee_id),
    'time_card_amount', (select round(sum(
                          (tc.time_card_hours - coalesce(s.total_hours, 0)) *
                          (case when coalesce(s.total_hours, 0) > 0 then s.gross_salary / s.total_hours
                                when pe.total_hours > 0 then pe.gross_salary / pe.total_hours
                                else 0 end)), 2)
                        from public.payroll_time_card tc
                        left join public.payroll_employee_site s
                          on s.payroll_employee_id = pe.id and s.site_id = tc.site_id
                        where tc.payroll_period_id = v_period.id
                          and tc.employee_id = pe.employee_id),
    'threshold_date', (select min(t.d) from (
        select a.date as d,
               coalesce(e.opening_hours, 0)
                 + sum(a.hours) over (order by a.date
                                      rows between unbounded preceding and current row) as cum
        from public.attendance a
        where a.employee_id = pe.employee_id
          and not a.is_hidden
          and a.hours is not null and a.hours > 0
      ) t where t.cum >= 1000),
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
                'time_card_hours', (select tc.time_card_hours
                                    from public.payroll_time_card tc
                                    where tc.payroll_period_id = v_period.id
                                      and tc.site_id = s.site_id
                                      and tc.employee_id = pe.employee_id),
                'time_card_amount', (select round((tc.time_card_hours - coalesce(s.total_hours, 0)) *
                                    (case when s.total_hours > 0 then s.gross_salary / s.total_hours
                                          when pe.total_hours > 0 then pe.gross_salary / pe.total_hours
                                          else 0 end), 2)
                                    from public.payroll_time_card tc
                                    where tc.payroll_period_id = v_period.id
                                      and tc.site_id = s.site_id
                                      and tc.employee_id = pe.employee_id),
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
  left join public.camp c on c.id = e.camp_id
  left join public.card_type ct on ct.id = e.card_type_id
  where pe.payroll_period_id = v_period.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'action', a.action, 'actor_name', a.actor_name,
    'details', a.details, 'created_at', a.created_at
  ) order by a.created_at desc), '[]'::jsonb) into v_audit
  from public.payroll_audit_log a where a.period_id = v_period.id;

  return jsonb_build_object(
    'exists', true,
    'period', to_jsonb(v_period),
    'totals', v_totals,
    'sites', v_sites,
    'employees', v_employees,
    'audit', v_audit
  );
end; $$;

-- ---------------------------------------------------------------------------
-- 4. DATA MIGRATION — legacy carryovers become advance book records.
--    Before this migration the carryover wrote STRAIGHT into the next
--    month's payroll_employee.advance (+ note). Those amounts are converted
--    into book records with the same cut month, and advance_book_applied is
--    raised by the same amount so advance_book_sync_period never
--    double-counts them (the advance VALUE is untouched).
--    Records whose cut month's salary was already paid are inserted as
--    cleared (applied_amount = amount) — honest history.
--    (No sync call here: the markers are set directly, and the sync's
--    permission check does not apply in a migration context.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_rec record;
  v_period public.payroll_period;
  v_pe public.payroll_employee;
  v_note text;
  v_month_name text;
  v_next_month_name text;
  v_tc_hours numeric;
  v_att_hours numeric;
  v_next_year int;
  v_next_month int;
  v_next_paid boolean;
begin
  -- nothing to convert when the time-card feature is not installed yet
  -- (fresh base-schema load — the migration chain applies this file again
  -- after 20261113c/d, with the table present)
  if to_regclass('public.payroll_time_card') is null then
    return;
  end if;

  for v_rec in
    select tc.payroll_period_id, tc.employee_id,
           round(sum(tc.carryover_applied), 2) as amount
    from public.payroll_time_card tc
    group by tc.payroll_period_id, tc.employee_id
    having sum(tc.carryover_applied) > 0
  loop
    -- already converted (a book record exists for this source period)?
    if exists (select 1 from public.advance_record r
               where r.source_period_id = v_rec.payroll_period_id
                 and r.employee_id = v_rec.employee_id) then
      continue;
    end if;

    select * into v_period from public.payroll_period
    where id = v_rec.payroll_period_id;
    if v_period.id is null then continue; end if;

    v_next_year := v_period.year + case when v_period.month = 12 then 1 else 0 end;
    v_next_month := case when v_period.month = 12 then 1 else v_period.month + 1 end;
    v_month_name := (array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])[v_period.month]
                    || ' ' || v_period.year::text;
    v_next_month_name := (array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])[v_next_month]
                         || ' ' || v_next_year::text;

    select coalesce(sum(time_card_hours), 0) into v_tc_hours
    from public.payroll_time_card
    where payroll_period_id = v_rec.payroll_period_id
      and employee_id = v_rec.employee_id;

    -- attendance hours of the SOURCE period (note details)
    select coalesce(pe.total_hours, 0) into v_att_hours
    from public.payroll_employee pe
    where pe.payroll_period_id = v_rec.payroll_period_id
      and pe.employee_id = v_rec.employee_id;

    -- was the NEXT month's salary already paid with the carryover inside?
    -- (then the record is inserted as CLEARED history)
    select coalesce(pe.payment_status, '') = 'paid' into v_next_paid
    from public.payroll_period p
    join public.payroll_employee pe
      on pe.payroll_period_id = p.id and pe.employee_id = v_rec.employee_id
    where p.year = v_next_year and p.month = v_next_month;

    v_note := '[Time card ' || v_month_name || '] time card ' || v_tc_hours::text
            || ' h vs attendance ' || coalesce(v_att_hours, 0)::text
            || ' h → ' || v_rec.amount::text || ' cutting from ' || v_next_month_name;

    insert into public.advance_record
      (employee_id, amount, given_date, cut_year, cut_month, note,
       created_by, source_period_id, applied_amount)
    values
      (v_rec.employee_id, v_rec.amount, current_date,
       v_next_year, v_next_month, v_note, null, v_rec.payroll_period_id,
       case when coalesce(v_next_paid, false) then v_rec.amount else 0 end);

    -- UNPAID cut-month row: register the book part so the sync keeps the
    -- advance value as-is (it already contains the carryover)
    update public.payroll_employee pe set
      advance_book_applied = round(pe.advance_book_applied + v_rec.amount, 2),
      updated_at = now()
    where pe.payroll_period_id = (
        select id from public.payroll_period
        where year = v_next_year and month = v_next_month)
      and pe.employee_id = v_rec.employee_id
      and pe.payment_status <> 'paid';
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. grants (same blanket pattern as the base schema)
-- ---------------------------------------------------------------------------
revoke all on function public.save_site_time_card_hours(uuid, uuid, jsonb) from public, anon;
revoke all on function public.get_advance_book() from public, anon;
grant execute on function public.save_site_time_card_hours(uuid, uuid, jsonb) to authenticated;
grant execute on function public.get_advance_book() to authenticated;
