-- ============================================================================
-- PULSE Workforce OS — 20261104: Payroll page + Idle Employees restructure
-- ----------------------------------------------------------------------------
-- The Salary Sheet stays the single source of truth for salary CALCULATION.
-- A new consolidated Payroll page (menu key: payroll) renders one row per
-- employee from the SAME get_salary_sheet data — no second salary engine.
--
-- This migration:
--   1. get_salary_sheet
--        • permission: salary_sheet OR payroll (the Payroll page reuses it)
--        • normal site groups exclude the "no site" bucket
--        • new "Idle Employees" group, ALWAYS LAST: employees whose current
--          site is empty (synthetic 0/0 rows when they have no unassigned
--          hours) + every employee with unassigned/unrated (no-site) hours.
--          Historical attendance keeps its original site attribution.
--        • per-employee qualification fields for the Payroll hours tooltip:
--          join_date, six_month_date, threshold_date (1,000-hour crossing).
--   2. Permission leniency (salary_sheet OR payroll) for the shared engine:
--        calculate_employee_payroll, payroll_upsert_employee,
--        generate_payroll_period, update_payroll_adjustment,
--        mark_employee_salary_paid.
--   3. NEW unmark_employee_salary_paid — revert a payment. Super admin only,
--      reason mandatory, audited.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. calculate_employee_payroll — permission: salary_sheet OR payroll
--    (body otherwise identical to 20261103)
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
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;

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
-- 2. payroll_upsert_employee — permission: salary_sheet OR payroll
--    (body otherwise identical to 20261103)
-- ---------------------------------------------------------------------------
create or replace function public.payroll_upsert_employee(
  p_period public.payroll_period, p_employee_id uuid
) returns void language plpgsql volatile
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
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
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

-- ---------------------------------------------------------------------------
-- 3. generate_payroll_period — permission: salary_sheet OR payroll
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

  return jsonb_build_object('id', v_period.id, 'year', v_period.year,
    'month', v_period.month, 'status', v_period.status);
end; $$;

-- ---------------------------------------------------------------------------
-- 4. update_payroll_adjustment — permission: salary_sheet OR payroll
--    (advances/deductions are now administered on the Payroll page)
-- ---------------------------------------------------------------------------
create or replace function public.update_payroll_adjustment(
  p_payroll_employee_id uuid, p_advance numeric, p_deduction numeric, p_notes text
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_pe public.payroll_employee;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;
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

-- ---------------------------------------------------------------------------
-- 5. mark_employee_salary_paid — permission: salary_sheet OR payroll
--    (payment administration moves to the Payroll page)
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
  v_actor text;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;
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
-- 6. NEW unmark_employee_salary_paid — revert a payment (super admin only,
--    reason mandatory, audited). The Paid toggle in Payroll uses this.
-- ---------------------------------------------------------------------------
create or replace function public.unmark_employee_salary_paid(
  p_payroll_employee_id uuid, p_reason text
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_pe public.payroll_employee;
  v_period public.payroll_period;
  v_actor text;
begin
  if not public.is_super_admin() then
    raise exception 'Only a super admin can revert a paid salary';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to revert a paid salary';
  end if;

  select * into v_pe from public.payroll_employee where id = p_payroll_employee_id;
  if v_pe.id is null then raise exception 'Payroll employee not found'; end if;
  if v_pe.payment_status <> 'paid' then
    raise exception 'This salary is not marked paid';
  end if;
  select * into v_period from public.payroll_period where id = v_pe.payroll_period_id;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  update public.payroll_employee set
    payment_status = 'unpaid',
    paid_at = null,
    paid_by = null,
    updated_at = now()
  where id = p_payroll_employee_id;
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (v_period.id, 'unpayment', auth.uid(), v_actor,
          'Employee ' || v_pe.employee_id || ' reverted to unpaid — reason: ' || btrim(p_reason));
end; $$;

-- ---------------------------------------------------------------------------
-- 7. get_salary_sheet — THE shared read model for Salary Sheet AND Payroll
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
    'deductions', round(coalesce(sum(deduction), 0), 2),
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
  -- page; includes the qualification fields used by the hours tooltip.
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
