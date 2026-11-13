-- ============================================================================
-- 20261113c — PAYROLL TIME CARD HOURS + instant mark/unmark + RPC fix
-- ----------------------------------------------------------------------------
-- User request:
--   1. Payroll gets a NATIONALITY column (Asian / African / …) — client side.
--   2. Next to Total Hours a FINAL HOURS column — the time card hours from the
--      APPROVED timesheets of a site's employees, entered per site via the new
--      "Time Card" dialog on the Payroll page. Once entered, a BALANCE column
--      shows (time card hours − total hours) × rate − net payable.
--      The extra columns render ONLY after time card hours were added for a
--      site (no data → compact layout, exactly as before).
--   3. Mark as paid / Unmark become INSTANT toggles (no confirmation dialog).
--      Unmarking is therefore no longer super-admin-only — anyone allowed to
--      mark (salary_sheet / payroll menu) can revert; still audited.
--
-- BUG FIX (user-reported):
--   "function public.update_payroll_adjustment(uuid, numeric, numeric, text)
--    is not unique" when marking an employee paid.
--   Root cause: TWO overloads coexist in the DB — the 4-arg version
--   (≤ 20261111b) and the 6-arg version with two defaulted params
--   (20261111d). mark_employee_salary_paid calls it with 4 positional args,
--   which matches BOTH (the 6-arg fills its defaults) → PostgreSQL 42725.
--   Fix: drop the 4-arg overload so exactly ONE canonical function remains,
--   and re-create it (self-contained for DBs that ran only part of the chain).
--
-- What changes:
--   1. payroll_time_card — new table: one row per (period, site, employee)
--      with the approved time card hours. SEPARATE from
--      payroll_employee_site on purpose: draft periods regenerate the
--      calculation rows on every view (payroll_upsert_employee deletes +
--      re-inserts them), which would wipe hours stored there. This table is
--      never touched by the recalculation.
--   2. save_site_time_card_hours — RPC: bulk-save the entries of one site
--      (audited). Empty hours → the entry is removed.
--   3. update_payroll_adjustment — de-duplicated (see above).
--   4. mark_employee_salary_paid — unchanged rules; internal call now uses
--      explicit named arguments so it can never be ambiguous again.
--   5. unmark_employee_salary_paid — instant revert: reason OPTIONAL
--      (defaults to an audit note), permission = salary_sheet / payroll
--      (same as marking paid) instead of super-admin-only.
--   6. get_salary_sheet — every employee row gains time_card_hours
--      (null → no time card entered); site-group rows gain time_card_hours
--      per employee and the group gains time_card_total.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. payroll_time_card table
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_time_card (
  id                uuid primary key default gen_random_uuid(),
  payroll_period_id uuid not null references public.payroll_period(id) on delete cascade,
  site_id           uuid not null references public.site(id) on delete cascade,
  employee_id       uuid not null references public.employee(id) on delete cascade,
  time_card_hours   numeric(12,2) not null check (time_card_hours >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by        uuid,
  unique (payroll_period_id, site_id, employee_id)
);
create index if not exists idx_payroll_time_card_period
  on public.payroll_time_card(payroll_period_id);

alter table public.payroll_time_card enable row level security;
-- no SELECT/INSERT policies → clients can only reach it through the
-- SECURITY DEFINER RPCs below (same pattern as payroll_employee & co.)

do $$ begin
  alter publication supabase_realtime add table public.payroll_time_card;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. save_site_time_card_hours — bulk-save ONE site's approved time card
--    entries. p_entries = [{"employee_id": uuid, "hours": 208 | null}, …]
--    (hours null/absent → the employee's entry is REMOVED)
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
  v_emp public.employee;
  v_site_name text;
  v_actor text;
  v_saved int := 0;
  v_cleared int := 0;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;

  select name into v_site_name from public.site where id = p_site_id;
  if v_site_name is null then
    raise exception 'Site not found';
  end if;
  if not exists (select 1 from public.payroll_period where id = p_period_id) then
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
end; $$;

-- ---------------------------------------------------------------------------
-- 3. update_payroll_adjustment — DE-DUPLICATED
--    The 4-arg overload (≤ 20261111b) made every 4-arg call ambiguous with
--    the 6-arg canonical version (20261111d) → error 42725 on mark-paid.
--    Drop the stale overload(s), keep exactly ONE function.
-- ---------------------------------------------------------------------------
drop function if exists public.update_payroll_adjustment(uuid, numeric, numeric, text);
drop function if exists public.update_payroll_adjustment(uuid, numeric, numeric, text, numeric);

create or replace function public.update_payroll_adjustment(
  p_payroll_employee_id uuid, p_advance numeric, p_deduction numeric, p_notes text,
  p_absent_deduction numeric default null, p_absent_auto boolean default false
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_pe public.payroll_employee;
  v_period public.payroll_period;
  v_absent numeric;
  v_absent_edited boolean;
  v_emp public.employee;
  v_actor text;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;
  if p_advance is null or p_advance < 0 then raise exception 'Advance must be 0 or more'; end if;
  if p_deduction is null or p_deduction < 0 then raise exception 'Deduction must be 0 or more'; end if;
  if p_absent_deduction is not null and p_absent_deduction < 0 then
    raise exception 'Absent deduction must be 0 or more';
  end if;

  select * into v_pe from public.payroll_employee where id = p_payroll_employee_id;
  if v_pe.id is null then raise exception 'Payroll employee not found'; end if;
  if v_pe.payment_status = 'paid' then
    raise exception 'This employee is already marked paid — reopen the payroll to correct it';
  end if;

  -- THE PAYROLL PAGE VALUE HAS PRIORITY: a hand-entered absent deduction is
  -- stored as the ACTUAL amount and flagged; p_absent_auto returns it to the
  -- configured rule (recomputed from this month's attendance).
  if p_absent_auto then
    select * into v_period from public.payroll_period where id = v_pe.payroll_period_id;
    v_absent := public.absent_deduction_for(v_pe.employee_id, v_period.year, v_period.month);
    v_absent_edited := false;
  elsif p_absent_deduction is not null then
    v_absent := round(p_absent_deduction, 2);
    v_absent_edited := true;
  else
    v_absent := v_pe.absent_deduction;
    v_absent_edited := v_pe.absent_deduction_edited;
  end if;

  select * into v_emp from public.employee where id = v_pe.employee_id;
  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();

  update public.payroll_employee set
    advance = round(p_advance, 2),
    deduction = round(p_deduction, 2),
    notes = nullif(btrim(coalesce(p_notes, '')), ''),
    absent_deduction = v_absent,
    absent_deduction_edited = v_absent_edited,
    net_salary = round(gross_salary - round(p_advance, 2) - round(p_deduction, 2) - v_absent, 2),
    updated_at = now()
  where id = p_payroll_employee_id;

  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (v_pe.payroll_period_id, 'adjustment', auth.uid(), v_actor,
          coalesce(v_emp.full_name, 'Unknown employee') || ' (' ||
          coalesce(v_emp.employee_code, '—') || ') — advance ' ||
          round(p_advance, 2)::text || ', deduction ' || round(p_deduction, 2)::text ||
          case when p_absent_auto then ', absent deduction reset to the rule'
               when p_absent_deduction is not null
                 then ', absent deduction set to ' || round(p_absent_deduction, 2)::text
               else '' end);
end; $$;

-- ---------------------------------------------------------------------------
-- 4. mark_employee_salary_paid — rules unchanged from 20261105b; the internal
--    update call now passes ALL parameters by name (never ambiguous)
-- ---------------------------------------------------------------------------
create or replace function public.mark_employee_salary_paid(
  p_payroll_employee_id uuid, p_advance numeric default null,
  p_deduction numeric default null, p_notes text default null
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_pe public.payroll_employee;
  v_period public.payroll_period;
  v_emp public.employee;
  v_actor text;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;
  select * into v_pe from public.payroll_employee where id = p_payroll_employee_id;
  if v_pe.id is null then raise exception 'Payroll employee not found'; end if;
  if v_pe.payment_status = 'paid' then raise exception 'Already marked paid'; end if;

  -- the ONLY requirement: the employee must actually have a salary this month
  if coalesce(v_pe.gross_salary, 0) <= 0 then
    raise exception 'No salary calculated for this employee this month';
  end if;

  select * into v_period from public.payroll_period where id = v_pe.payroll_period_id;
  select * into v_emp from public.employee where id = v_pe.employee_id;

  -- optional last-second adjustment values (instant mark passes the current
  -- stored values — a no-op that keeps one code path)
  if p_advance is not null or p_deduction is not null or p_notes is not null then
    perform public.update_payroll_adjustment(
      p_payroll_employee_id       := p_payroll_employee_id,
      p_advance                   := coalesce(round(p_advance, 2), v_pe.advance),
      p_deduction                 := coalesce(round(p_deduction, 2), v_pe.deduction),
      p_notes                     := coalesce(nullif(btrim(coalesce(p_notes, '')), ''), v_pe.notes),
      p_absent_deduction          := null,
      p_absent_auto               := false
    );
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
          coalesce(v_emp.full_name, 'Unknown employee') || ' (' ||
          coalesce(v_emp.employee_code, '—') || ') marked paid');
end; $$;

-- ---------------------------------------------------------------------------
-- 5. unmark_employee_salary_paid — INSTANT REVERT
--    • permission: salary_sheet / payroll (same as marking paid — the toggle
--      is symmetric now); super admins keep their access implicitly
--    • reason OPTIONAL (defaults to an audit note) — the Payroll page unmarks
--      without a confirmation dialog
--    • still fully audited (actor + timestamp + reason)
-- ---------------------------------------------------------------------------
create or replace function public.unmark_employee_salary_paid(
  p_payroll_employee_id uuid, p_reason text default null
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_pe public.payroll_employee;
  v_period public.payroll_period;
  v_emp public.employee;
  v_actor text;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;

  select * into v_pe from public.payroll_employee where id = p_payroll_employee_id;
  if v_pe.id is null then raise exception 'Payroll employee not found'; end if;
  if v_pe.payment_status <> 'paid' then
    raise exception 'This salary is not marked paid';
  end if;
  select * into v_period from public.payroll_period where id = v_pe.payroll_period_id;
  select * into v_emp from public.employee where id = v_pe.employee_id;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  update public.payroll_employee set
    payment_status = 'unpaid',
    paid_at = null,
    paid_by = null,
    updated_at = now()
  where id = p_payroll_employee_id;
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (v_period.id, 'unpayment', auth.uid(), v_actor,
          coalesce(v_emp.full_name, 'Unknown employee') || ' (' ||
          coalesce(v_emp.employee_code, '—') || ') reverted to unpaid — reason: ' ||
          coalesce(nullif(btrim(coalesce(p_reason, '')), ''),
                   'Unmarked from the Payroll page'));
end; $$;

-- ---------------------------------------------------------------------------
-- 6. get_salary_sheet — time card data in the report
--    • employees[].time_card_hours — Σ approved time card hours of the month
--      (null → nothing entered → the Payroll page keeps its compact layout)
--    • sites[].rows[].time_card_hours — per employee × site (dialog prefill)
--    • sites[].time_card_total — Σ time card hours of that site's employees
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
              and tc.site_id = s.site_id) as time_card_total
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
  -- entered; drives the conditional Final Hours / Balance columns).
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
-- 7. grants — business RPCs are authenticated-only (guards live inside)
-- ---------------------------------------------------------------------------
revoke all on function public.save_site_time_card_hours(uuid, uuid, jsonb) from public, anon;
grant execute on function public.save_site_time_card_hours(uuid, uuid, jsonb) to authenticated;
