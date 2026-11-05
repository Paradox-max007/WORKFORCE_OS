-- ============================================================================
-- PULSE Workforce OS — 20261105: Payroll inline editing
-- ----------------------------------------------------------------------------
-- The Payroll page becomes a full payment workspace (like the Salary Sheet):
--
--   1. mark_employee_salary_paid — NO LONGER requires a finalized period.
--      "Mark Paid" is active whenever the employee HAS a salary this month
--      (gross_salary > 0). Paid records keep their protection + audit trail.
--   2. update_salary_sheet_row — permission leniency: salary_sheet OR payroll,
--      so a trade picked on the Payroll page (edit mode dropdown) can be saved
--      exactly like on the Salary Sheet. The trade change overwrites the
--      stored trade + assignment history from the 1st of the payroll month
--      and re-prices the month — Employee Details, Attendance page, the
--      Attendance PDF and every trade-linked page read the same rows, so they
--      all update together.
--
-- Both functions are idempotent (create or replace) and safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. mark_employee_salary_paid — pay whenever the employee has a salary
--    (was: "Finalize the payroll before marking salaries paid")
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

  -- the ONLY requirement: the employee must actually have a salary this month
  if coalesce(v_pe.gross_salary, 0) <= 0 then
    raise exception 'No salary calculated for this employee this month';
  end if;

  select * into v_period from public.payroll_period where id = v_pe.payroll_period_id;

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
-- 2. update_salary_sheet_row — permission: salary_sheet OR payroll
--    (trade dropdown on the Payroll page reuses this exact RPC; paid
--    employees remain protected, everything else is unchanged)
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

  -- net is always gross − advance − deduction
  update public.payroll_employee set
    net_salary = round(gross_salary - advance - deduction, 2),
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
-- 3. apply_employee_assignment — permission: employees OR salary_sheet OR
--    payroll. The trade change flows through update_salary_sheet_row →
--    apply_employee_assignment, so a payroll-only admin needs this too
--    (body otherwise identical to 20261103b).
-- ---------------------------------------------------------------------------
create or replace function public.apply_employee_assignment(
  p_employee_id uuid, p_trade_id uuid, p_salary_role text, p_eff date
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_cap date;
begin
  if not public.has_menu_permission('employees')
     and not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;

  delete from public.employee_salary_assignment
   where employee_id = p_employee_id and effective_from = p_eff;

  -- a strictly future-scheduled assignment caps the new one (it wins from its date)
  select min(effective_from) - 1 into v_cap
    from public.employee_salary_assignment
   where employee_id = p_employee_id and effective_from > p_eff;

  -- close the currently open assignment the day before
  update public.employee_salary_assignment
     set effective_to = p_eff - 1
   where employee_id = p_employee_id
     and effective_from < p_eff
     and (effective_to is null or effective_to >= p_eff);

  if p_trade_id is not null then
    if not exists (select 1 from public.trades where id = p_trade_id) then
      raise exception 'Trade not found';
    end if;
    insert into public.employee_salary_assignment (
      employee_id, trade_id, salary_role, effective_from, effective_to, created_by
    ) values (
      p_employee_id, p_trade_id, p_salary_role, p_eff, v_cap, auth.uid()
    );
  end if;
end; $$;
