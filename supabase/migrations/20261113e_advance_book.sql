-- ============================================================================
-- 20261113e — ADVANCE BOOK (advance ledger: due / cleared + cut-month scheduling)
-- ============================================================================
-- The advance was only a number typed into one month's Payroll row. This
-- migration adds a proper LEDGER:
--
--   advance_record     one row per advance handed to an employee:
--                      amount, given date, CUT month (the salary month that
--                      will recover it), note.
--
--   status is DERIVED, never stored:
--     cleared  → the employee's payroll row of the CUT month is PAID
--                (marked cleared the moment that salary is paid; unmarking
--                the payment flips it back to due — always in sync)
--     due      → everything else
--     overdue  → due AND the cut month has already passed (chip in the UI)
--
--   advance_book_sync_period(y, m)
--                      folds the DUE records scheduled for month (y, m) into
--                      that month's payroll rows:
--                        advance = (advance − advance_book_applied) + Σ records
--                      advance_book_applied tracks how much of the stored
--                      advance came from the book, so manual edits and the
--                      time-card carryover (which touch `advance` directly)
--                      are never double-counted. PAID rows are skipped — a
--                      record scheduled for an already-paid month stays due
--                      (overdue) until it is rescheduled.
--
--   get_advance_book()              the whole ledger + totals (permission:
--                                   salary_sheet OR payroll OR advance_book)
--   save_advance_record(payload)    add / edit (reschedule) a DUE record
--   delete_advance_record(id)       remove a DUE record
--
--   generate_payroll_period         now ends with advance_book_sync_period, so
--                                   records scheduled for a month that did not
--                                   exist yet are folded in when it is created
--
--   get_salary_sheet v5             employees[] gains advance_book_applied +
--                                   advance_book_due[] (the Payroll Advance
--                                   popover lists & manages them inline)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The ledger table
-- ---------------------------------------------------------------------------
create table if not exists public.advance_record (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employee(id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  given_date  date not null default current_date,
  cut_year    int  not null check (cut_year between 2000 and 2100),
  cut_month   int  not null check (cut_month between 1 and 12),
  note        text,
  -- how much of THIS record is currently inside the cut month's Advance
  -- column (0 → not folded in: no payroll row yet, or the salary was already
  -- paid when the record was added). Powers the honest cleared status:
  --   cleared = the cut month's salary is PAID *and* this record was part of
  --   it (applied_amount > 0) — a record added after the payment stays DUE.
  applied_amount numeric(12,2) not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_advance_record_employee on public.advance_record(employee_id);
create index if not exists idx_advance_record_cut on public.advance_record(cut_year, cut_month);

alter table public.advance_record enable row level security;
do $$ begin
  alter publication supabase_realtime add table public.advance_record;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. payroll_employee.advance_book_applied — how much of the stored advance
--    was contributed by due advance records scheduled for THIS period
-- ---------------------------------------------------------------------------
alter table public.payroll_employee
  add column if not exists advance_book_applied numeric(12,2) not null default 0;

-- ---------------------------------------------------------------------------
-- 3. advance_book_sync_period — recompute the book part of one month's rows
-- ---------------------------------------------------------------------------
create or replace function public.advance_book_sync_period(p_year int, p_month int)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_period public.payroll_period;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll')
     and not public.has_menu_permission('advance_book') then
    raise exception 'Access denied';
  end if;

  select * into v_period from public.payroll_period
  where year = p_year and month = p_month;
  if v_period.id is null then return; end if;

  -- (a) rows whose records were deleted / rescheduled AWAY: drop the old book
  --     part (clamped at 0 so the advance >= 0 constraint can never fire)
  update public.payroll_employee pe set
    advance = greatest(0, round(pe.advance - pe.advance_book_applied, 2)),
    advance_book_applied = 0,
    net_salary = pe.gross_salary
                   - greatest(0, round(pe.advance - pe.advance_book_applied, 2))
                   - pe.deduction - pe.absent_deduction,
    updated_at = now()
  where pe.payroll_period_id = v_period.id
    and pe.payment_status <> 'paid'
    and pe.advance_book_applied <> 0
    and not exists (
      select 1 from public.advance_record r
      where r.employee_id = pe.employee_id
        and r.cut_year = p_year and r.cut_month = p_month);

  -- (b) rows with scheduled records: set / refresh the book part (idempotent)
  update public.payroll_employee pe set
    advance = greatest(0, round(pe.advance - pe.advance_book_applied + v_book.book_sum, 2)),
    advance_book_applied = v_book.book_sum,
    net_salary = pe.gross_salary
                   - greatest(0, round(pe.advance - pe.advance_book_applied + v_book.book_sum, 2))
                   - pe.deduction - pe.absent_deduction,
    updated_at = now()
  from (
    select r.employee_id, round(sum(r.amount), 2) as book_sum
    from public.advance_record r
    where r.cut_year = p_year and r.cut_month = p_month
    group by r.employee_id
  ) v_book
  where pe.payroll_period_id = v_period.id
    and pe.employee_id = v_book.employee_id
    and pe.payment_status <> 'paid'
    and pe.advance_book_applied is distinct from v_book.book_sum;

  -- (b2) per-record markers: every record scheduled for this month whose row
  --      exists and is UNPAID counts as folded in (full amount inside the
  --      Advance column). Records of PAID rows keep their frozen marker —
  --      that is exactly what distinguishes "recovered by the paid salary"
  --      from "added after the payment" (the latter stays 0 → stays DUE).
  update public.advance_record r set
    applied_amount = round(r.amount, 2),
    updated_at = now()
  where r.cut_year = p_year and r.cut_month = p_month
    and exists (
      select 1 from public.payroll_employee pe
      where pe.payroll_period_id = v_period.id
        and pe.employee_id = r.employee_id
        and pe.payment_status <> 'paid')
    and r.applied_amount is distinct from round(r.amount, 2);

  -- (b3) markers of records whose payroll row DISAPPEARED (regeneration
  --      dropped the employee) drop back to 0 → the record is due again.
  --      PAID rows never land here — their markers stay frozen as the
  --      "recovered by that salary" evidence (the cleared status).
  update public.advance_record r set
    applied_amount = 0,
    updated_at = now()
  where r.applied_amount <> 0
    and r.cut_year = p_year and r.cut_month = p_month
    and not exists (
      select 1 from public.payroll_employee pe
      where pe.payroll_period_id = v_period.id
        and pe.employee_id = r.employee_id);
end; $$;

-- ---------------------------------------------------------------------------
-- 4. generate_payroll_period — same body, plus the advance-book sync at the
--    end (records scheduled for a month that had no payroll yet fold in here)
-- ---------------------------------------------------------------------------
create or replace function public.generate_payroll_period(p_year int, p_month int)
returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_period public.payroll_period;
  v_month_end date := (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day')::date;
  v_emp record;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;

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

  -- fold due advance records scheduled for this month into the Advance column
  perform public.advance_book_sync_period(p_year, p_month);

  return jsonb_build_object('id', v_period.id, 'year', v_period.year,
    'month', v_period.month, 'status', v_period.status);
end; $$;

-- ---------------------------------------------------------------------------
-- 5. get_advance_book — the whole ledger with DERIVED status + totals
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
-- 6. save_advance_record — add a record, or edit / reschedule a DUE one
--    payload: { id?, employee_id, amount, given_date?, cut_year, cut_month, note? }
-- ---------------------------------------------------------------------------
create or replace function public.save_advance_record(p_payload jsonb)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_id uuid := nullif(p_payload->>'id', '')::uuid;
  v_employee_id uuid := (p_payload->>'employee_id')::uuid;
  v_amount numeric := (p_payload->>'amount')::numeric;
  v_given_date date := coalesce(nullif(p_payload->>'given_date', '')::date, current_date);
  v_cut_year int := (p_payload->>'cut_year')::int;
  v_cut_month int := (p_payload->>'cut_month')::int;
  v_note text := nullif(btrim(coalesce(p_payload->>'note', '')), '');
  v_old public.advance_record;
  v_emp public.employee;
  v_actor text;
  v_period_id uuid;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll')
     and not public.has_menu_permission('advance_book') then
    raise exception 'Access denied';
  end if;

  select * into v_emp from public.employee
  where id = v_employee_id and status <> 'deleted';
  if v_emp.id is null then raise exception 'Employee not found'; end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'Advance amount must be greater than 0';
  end if;
  if v_cut_year is null or v_cut_month is null
     or v_cut_year not between 2000 and 2100
     or v_cut_month not between 1 and 12 then
    raise exception 'A valid cut month is required';
  end if;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  select id into v_period_id from public.payroll_period
  where year = v_cut_year and month = v_cut_month;

  if v_id is not null then
    select * into v_old from public.advance_record where id = v_id;
    if v_old.id is null then raise exception 'Advance record not found'; end if;
    if v_old.employee_id <> v_employee_id then
      raise exception 'An advance record cannot move to another employee — delete it and add a new one';
    end if;
    -- only DUE records can be edited: cleared = the record was folded into
    -- the cut month's advance AND that salary was paid
    if exists (
      select 1 from public.payroll_period p
      join public.payroll_employee pe
        on pe.payroll_period_id = p.id and pe.employee_id = v_old.employee_id
      where p.year = v_old.cut_year and p.month = v_old.cut_month
        and pe.payment_status = 'paid'
        and v_old.applied_amount > 0) then
      raise exception 'This advance is already cleared — the % salary was paid. Add a new record instead.',
        to_char(make_date(v_old.cut_year, v_old.cut_month, 1), 'TMMonth YYYY');
    end if;

    update public.advance_record set
      amount = round(v_amount, 2),
      given_date = v_given_date,
      cut_year = v_cut_year,
      cut_month = v_cut_month,
      note = v_note,
      -- the record moves: the new cut month's sync re-marks it if it folds in
      applied_amount = 0,
      updated_at = now()
    where id = v_id;

    -- refresh BOTH the old and the new cut month (the record may have moved)
    perform public.advance_book_sync_period(v_old.cut_year, v_old.cut_month);
    perform public.advance_book_sync_period(v_cut_year, v_cut_month);

    insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
    values (v_period_id, 'advance_edit', auth.uid(), v_actor,
            'Advance book: record of ' || coalesce(v_emp.full_name, 'Unknown employee')
            || ' (' || coalesce(v_emp.employee_code, '—') || ') updated — '
            || round(v_old.amount, 2) || ' (' || to_char(make_date(v_old.cut_year, v_old.cut_month, 1), 'TMMon YYYY')
            || ') → ' || round(v_amount, 2) || ' (' || to_char(make_date(v_cut_year, v_cut_month, 1), 'TMMon YYYY') || ')');
  else
    insert into public.advance_record
      (employee_id, amount, given_date, cut_year, cut_month, note, created_by)
    values
      (v_employee_id, round(v_amount, 2), v_given_date, v_cut_year, v_cut_month, v_note, auth.uid());

    perform public.advance_book_sync_period(v_cut_year, v_cut_month);

    insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
    values (v_period_id, 'advance_add', auth.uid(), v_actor,
            'Advance book: ' || round(v_amount, 2) || ' given to '
            || coalesce(v_emp.full_name, 'Unknown employee')
            || ' (' || coalesce(v_emp.employee_code, '—') || ') — cutting from '
            || to_char(make_date(v_cut_year, v_cut_month, 1), 'TMMonth YYYY'));
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- 7. delete_advance_record — remove a DUE record (cleared ones are history)
-- ---------------------------------------------------------------------------
create or replace function public.delete_advance_record(p_id uuid)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_old public.advance_record;
  v_emp public.employee;
  v_actor text;
  v_period_id uuid;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll')
     and not public.has_menu_permission('advance_book') then
    raise exception 'Access denied';
  end if;

  select * into v_old from public.advance_record where id = p_id;
  if v_old.id is null then raise exception 'Advance record not found'; end if;

  if exists (
    select 1 from public.payroll_period p
    join public.payroll_employee pe
      on pe.payroll_period_id = p.id and pe.employee_id = v_old.employee_id
    where p.year = v_old.cut_year and p.month = v_old.cut_month
      and pe.payment_status = 'paid'
      and v_old.applied_amount > 0) then
    raise exception 'This advance is already cleared — the % salary was paid. Cleared records are kept as history.',
      to_char(make_date(v_old.cut_year, v_old.cut_month, 1), 'TMMonth YYYY');
  end if;

  select * into v_emp from public.employee where id = v_old.employee_id;
  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  select id into v_period_id from public.payroll_period
  where year = v_old.cut_year and month = v_old.cut_month;

  delete from public.advance_record where id = p_id;
  perform public.advance_book_sync_period(v_old.cut_year, v_old.cut_month);

  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (v_period_id, 'advance_delete', auth.uid(), v_actor,
          'Advance book: record of ' || coalesce(v_emp.full_name, 'Unknown employee')
          || ' (' || coalesce(v_emp.employee_code, '—') || ') deleted — '
          || round(v_old.amount, 2) || ' (' || to_char(make_date(v_old.cut_year, v_old.cut_month, 1), 'TMMon YYYY') || ')');
end; $$;

-- ---------------------------------------------------------------------------
-- 8. get_salary_sheet v5 — employees[] gains the advance-book fields
--    (advance_book_applied = the book part inside the stored advance;
--     advance_book_due = the employee's DUE records, any cut month — the
--     Payroll Advance popover lists them and can reschedule them to this month)
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
           round(sum(s.gross_salary), 2) as gross_salary
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
      'rows', v_rows,
      'idle', false
    );
  end loop;

  -- IDLE EMPLOYEES (always the LAST group):
  --   (a) employees with unassigned / unrated (no-site) hours — the hours are
  --       shown as idle hours, never attributed to an invented site;
  --   (b) employees whose CURRENT site is empty and who have no no-site row
  --       (synthetic zero rows — includes site-less employees with no
  --       attendance at all)
  select coalesce(jsonb_agg(payload order by full_name), '[]'::jsonb) into v_idle_rows
  from (
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
-- 9. grants (same blanket pattern as the base schema)
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
