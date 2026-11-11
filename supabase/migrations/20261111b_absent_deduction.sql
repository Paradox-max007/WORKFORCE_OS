-- ============================================================================
-- 20261111b — ABSENT DEDUCTION (attendance-driven, computed at generation)
-- ----------------------------------------------------------------------------
-- User request:
--   If an employee has MORE THAN 2 absent days in a payroll month, an amount
--   of AED 25 is imposed as a deduction for EACH absent day from the 3rd
--   onwards. The payroll includes it as "ABSENT DEDUCTION" (separate from the
--   manually administered deduction), and the Payroll page opens a per-site
--   attendance calendar for the employee when the deduction amount is clicked.
--
-- Rule (mirrored exactly by the demo engine — src/lib/data/demo-salary.ts):
--   absent_count   = # attendance rows of the month with status 'absent'
--                    (not hidden) — 'A' is the ONLY absent marker
--   absent_deduct. = greatest(absent_count - 2, 0) * 25
--   net_salary     = gross_salary - advance - deduction - absent_deduction
--
-- What changes:
--   1. payroll_employee.absent_deduction — new column (default 0).
--   2. payroll_upsert_employee — counts the month's absences, stores the
--      deduction and includes it in net_salary (insert + conflict update).
--      Also RESTORES the manually_edited guard documented since 20261103b
--      ("a hand-edited settlement is never recalculated") which the
--      20261104/20261111 bodies accidentally dropped — the demo engine and
--      update_salary_sheet_row always kept it.
--   3. update_payroll_adjustment / update_salary_sheet_row — net_salary now
--      subtracts absent_deduction too (the automatic part is never edited).
--   4. get_salary_sheet — exposes absent_deduction per employee and includes
--      it in the totals' deductions sum.
--
-- Data: no backfill needed. DRAFT periods recalculate on their next view
-- (get_salary_sheet regenerates drafts) and pick the rule up automatically;
-- FINALIZED periods stay locked exactly as they were paid.
-- ============================================================================

alter table public.payroll_employee
  add column if not exists absent_deduction numeric(12,2) not null default 0;

-- ---------------------------------------------------------------------------
-- 1. payroll_upsert_employee — 20261111 body + manually_edited guard restored
--    + absent deduction computed from the month's attendance
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
  v_month_start date;
  v_month_end date;
  v_absent_count int := 0;
  v_absent_deduction numeric := 0;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;

  -- THE SHEET RECORD HAS PRIORITY: a settlement edited by hand in the Salary
  -- Sheet is never recalculated until reset_payroll_employee_auto is used.
  if exists (select 1 from public.payroll_employee pe
             where pe.payroll_period_id = p_period.id
               and pe.employee_id = p_employee_id
               and pe.manually_edited) then
    return;
  end if;

  select e.*, t.name as trade_name into emp
  from public.employee e left join public.trades t on t.id = e.trade_id
  where e.id = p_employee_id and e.status <> 'deleted';
  if emp.id is null then return; end if;

  -- ABSENT DEDUCTION — 'A' attendance rows of this payroll month; the first
  -- 2 absences are free, every absence from the 3rd onwards costs AED 25.
  v_month_start := make_date(p_period.year, p_period.month, 1);
  v_month_end   := (v_month_start + interval '1 month' - interval '1 day')::date;
  select count(*) into v_absent_count
  from public.attendance a
  where a.employee_id = p_employee_id
    and not a.is_hidden
    and a.status = 'absent'
    and a.date >= v_month_start and a.date <= v_month_end;
  v_absent_deduction := greatest(v_absent_count - 2, 0) * 25;

  calc := public.calculate_employee_payroll(p_employee_id, p_period.year, p_period.month);

  -- aggregate lines into site buckets
  for v_line in select * from jsonb_array_elements(calc->'lines') loop
    v_key := coalesce(v_line->>'site_id', '__none__');
    v_agg := v_sites->v_key;
    if v_agg is null then
      v_agg := jsonb_build_object(
        'site_id', (v_line->'site_id'),
        'site_name', coalesce(v_line->>'site_name', 'No site'),
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
    trade_id_snapshot, salary_role_snapshot, absent_deduction, net_salary
  ) values (
    p_period.id, p_employee_id,
    (calc->>'opening_lifetime_hours')::numeric, (calc->>'closing_lifetime_hours')::numeric,
    (calc->>'total_hours')::numeric,
    (calc->>'unrated_hours')::numeric, (calc->>'unassigned_hours')::numeric,
    (calc->>'gross_salary')::numeric,
    emp.trade_id, emp.salary_role,
    v_absent_deduction,
    round((calc->>'gross_salary')::numeric - v_absent_deduction, 2)
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
    absent_deduction       = excluded.absent_deduction,
    net_salary             = excluded.gross_salary
                              - public.payroll_employee.advance
                              - public.payroll_employee.deduction
                              - excluded.absent_deduction,
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
      coalesce(v_site_row->>'site_name', 'No site'),
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
      coalesce(v_line->>'site_name', 'No site'),
      (v_line->>'date')::date,
      (v_line->>'trade_id')::uuid,
      coalesce(v_line->>'trade_name', 'No trade'),
      coalesce(v_line->>'salary_role', 'standard'),
      v_line->>'experience_tier',
      (v_line->>'hours')::numeric,
      (v_line->>'hourly_rate')::numeric,
      (v_line->>'gross_amount')::numeric
    );
  end loop;
end; $$;

-- ---------------------------------------------------------------------------
-- 2. update_payroll_adjustment — net now includes the automatic absent
--    deduction (only advance / deduction / notes are editable by hand)
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
    net_salary = gross_salary - round(p_advance, 2) - round(p_deduction, 2) - absent_deduction,
    updated_at = now()
  where id = p_payroll_employee_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 3. update_salary_sheet_row — identical to the 20261105b body except the
--    final net recomputation subtracts absent_deduction as well
-- ---------------------------------------------------------------------------
create or replace function public.update_salary_sheet_row(p_payload jsonb)
returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_payload jsonb := case when jsonb_typeof(p_payload) = 'string'
                          then (p_payload #>> '{}')::jsonb else p_payload end;
  v_pe_id uuid;
  v_pe public.payroll_employee;
  v_period public.payroll_period;
  v_emp public.employee;
  v_emp_name text;
  v_trade_id uuid;
  v_trade_name text;
  v_has_trade_change boolean := false;
  v_was_manual boolean;
  v_month_start date;
  v_sites jsonb;
  v_site jsonb;
  v_site_key text;
  v_row public.payroll_employee_site;
  v_hours numeric;
  v_gross numeric;
  v_rate numeric;
  v_total numeric;
  v_gross_total numeric;
  v_advance numeric;
  v_deduction numeric;
  v_notes text;
  v_actor text;
  v_details text := '';
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;
  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'Invalid payload — expected a JSON object';
  end if;

  v_pe_id := nullif(v_payload->>'payroll_employee_id', '')::uuid;
  if v_pe_id is null then raise exception 'payroll_employee_id is required'; end if;

  select * into v_pe from public.payroll_employee where id = v_pe_id;
  if v_pe.id is null then raise exception 'Payroll employee not found'; end if;
  if v_pe.payment_status = 'paid' then
    raise exception 'This employee is already marked paid — reopen the payroll to correct it';
  end if;

  select * into v_period from public.payroll_period where id = v_pe.payroll_period_id;
  select * into v_emp from public.employee where id = v_pe.employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;
  v_emp_name := v_emp.full_name;
  v_month_start := make_date(v_period.year, v_period.month, 1);
  v_was_manual := v_pe.manually_edited;

  -- 1. trade picked in the sheet / payroll → OVERWRITE the stored trade + assignment
  if v_payload ? 'trade_id' then
    v_trade_id := nullif(v_payload->>'trade_id', '')::uuid;
    if v_trade_id is not null then
      select name into v_trade_name from public.trades where id = v_trade_id;
      if v_trade_name is null then raise exception 'Trade not found'; end if;
    end if;
    if v_trade_id is distinct from v_emp.trade_id then
      v_has_trade_change := true;
      -- the new trade applies from the 1st of this payroll month
      perform public.apply_employee_assignment(
        v_emp.id, v_trade_id, coalesce(v_emp.salary_role, 'standard'), v_month_start);
      update public.employee
        set trade_id = v_trade_id, updated_at = now()
        where id = v_emp.id;
      update public.payroll_employee
        set trade_id_snapshot = v_trade_id, updated_at = now()
        where id = v_pe_id;
      -- refresh the employee row so later steps see the NEW trade
      select * into v_emp from public.employee where id = v_pe.employee_id;
      v_details := v_details || 'trade → ' || coalesce(v_trade_name, 'no trade') || '; ';
    end if;
  end if;

  -- 2. manual site overrides — the sheet record wins
  if v_payload ? 'sites' then
    v_sites := v_payload->'sites';
    if jsonb_typeof(v_sites) = 'string' then v_sites := (v_sites #>> '{}')::jsonb; end if;
    if v_sites is null or jsonb_typeof(v_sites) <> 'array' then
      raise exception 'sites must be a JSON array';
    end if;

    for v_site in select * from jsonb_array_elements(v_sites) loop
      v_site_key := coalesce(v_site->>'site_id', '');
      if v_site_key = '' then
        select * into v_row from public.payroll_employee_site
          where payroll_employee_id = v_pe_id and site_id is null;
      else
        select * into v_row from public.payroll_employee_site
          where payroll_employee_id = v_pe_id and site_id = v_site_key::uuid;
      end if;
      -- `not found` (not v_row.id) — a failed select into a row variable keeps
      -- the PREVIOUS loop iteration's value, which would update the wrong site
      if not found then
        raise exception 'Site row "%" not found for this employee', coalesce(nullif(v_site_key, ''), 'No site');
      end if;

      v_hours := round(coalesce(nullif(v_site->>'total_hours', '')::numeric, v_row.total_hours), 2);
      v_gross := round(coalesce(nullif(v_site->>'gross_salary', '')::numeric, v_row.gross_salary), 2);
      v_rate  := nullif(v_site->>'hourly_rate', '')::numeric;
      if v_hours < 0 or v_gross < 0 then
        raise exception 'Hours and gross must be 0 or more';
      end if;

      update public.payroll_employee_site set
        total_hours      = v_hours,
        gross_salary     = v_gross,
        has_missing_rate = false,
        manually_edited = true,
        calculation_details = coalesce(calculation_details, '{}'::jsonb)
                              || jsonb_build_object('manual', true, 'manual_rate', v_rate)
      where id = v_row.id;

      -- the site's rate lines collapse into ONE manual line
      delete from public.payroll_salary_line
        where payroll_employee_id = v_pe_id
          and site_id is not distinct from v_row.site_id;

      if v_hours > 0 then
        if v_rate is null then
          v_rate := round(v_gross / v_hours, 2);
        end if;
        insert into public.payroll_salary_line (
          payroll_employee_id, site_id, site_name_snapshot, attendance_date,
          trade_id, trade_name_snapshot, salary_role_snapshot, experience_tier,
          hours, hourly_rate, gross_amount
        ) values (
          v_pe_id, v_row.site_id, v_row.site_name_snapshot, v_month_start,
          v_emp.trade_id,
          coalesce((select name from public.trades where id = v_emp.trade_id), 'No trade'),
          coalesce(v_emp.salary_role, 'standard'), 'manual',
          v_hours, round(v_rate, 2), v_gross
        );
      end if;
    end loop;

    -- settlement totals = sum over ALL site rows (manual + automatic)
    select coalesce(sum(total_hours), 0), coalesce(sum(gross_salary), 0)
      into v_total, v_gross_total
    from public.payroll_employee_site where payroll_employee_id = v_pe_id;

    update public.payroll_employee set
      total_hours      = round(v_total, 2),
      gross_salary     = round(v_gross_total, 2),
      unrated_hours    = 0,
      unassigned_hours = 0,
      manually_edited  = true,
      updated_at       = now()
    where id = v_pe_id;
    v_details := v_details || 'manual site values; ';
  end if;

  -- 3. trade change without manual values → re-price the month automatically
  if v_has_trade_change and not (v_payload ? 'sites') then
    if not v_was_manual then
      perform public.payroll_upsert_employee(v_period, v_pe.employee_id);
      v_details := v_details || 'recalculated; ';
    else
      -- manual values exist: keep them, only refresh the trade snapshot
      update public.payroll_employee set
        trade_id_snapshot    = v_emp.trade_id,
        salary_role_snapshot = coalesce(v_emp.salary_role, 'standard'),
        updated_at           = now()
      where id = v_pe_id;
    end if;
  end if;

  -- 4. settlement adjustments (advance / deduction / notes)
  if v_payload ? 'advance' or v_payload ? 'deduction' or v_payload ? 'notes' then
    select * into v_pe from public.payroll_employee where id = v_pe_id;
    v_advance   := coalesce(nullif(v_payload->>'advance', '')::numeric, v_pe.advance);
    v_deduction := coalesce(nullif(v_payload->>'deduction', '')::numeric, v_pe.deduction);
    if v_payload ? 'notes' then
      v_notes := nullif(btrim(coalesce(v_payload->>'notes', '')), '');
    else
      v_notes := v_pe.notes;
    end if;
    if v_advance < 0 or v_deduction < 0 then
      raise exception 'Advance and deduction must be 0 or more';
    end if;
    update public.payroll_employee set
      advance    = round(v_advance, 2),
      deduction  = round(v_deduction, 2),
      notes      = v_notes,
      updated_at = now()
    where id = v_pe_id;
    v_details := v_details || 'settlement; ';
  end if;

  -- net is always gross − advance − deduction − absent deduction (the absent
  -- part is automatic and never touched by hand edits)
  update public.payroll_employee set
    net_salary = round(gross_salary - advance - deduction - absent_deduction, 2),
    updated_at = now()
  where id = v_pe_id;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  if v_details = '' then v_details := 'no changes'; end if;
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (v_period.id, 'manual_edit', auth.uid(), v_actor,
          'Salary sheet row of ' || v_emp_name || ' edited: ' || rtrim(v_details, '; '));

  return jsonb_build_object('ok', true);
end; $$;

-- ---------------------------------------------------------------------------
-- 4. get_salary_sheet — exposes absent_deduction per employee; the totals'
--    deductions sum now includes it (net = gross − adv − ded − absent)
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
