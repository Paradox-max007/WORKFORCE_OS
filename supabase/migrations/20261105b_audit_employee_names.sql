-- ============================================================================
-- PULSE Workforce OS — 20261105b: Audit trail readability (employee identity)
-- ----------------------------------------------------------------------------
-- The payroll audit trail used the raw employee database UUID in its details
-- text ("Employee 3f2b6c1e-… marked paid"). Audits must be human-readable:
-- they now use the employee NAME and CODE ("Rajesh Kumar (PUL-2026-001)
-- marked paid").
--
--   1. BACKFILL — existing payroll_audit_log rows: every bare employee UUID
--      inside `details` is replaced with "Full Name (EMPLOYEE_CODE)".
--   2. mark_employee_salary_paid / unmark_employee_salary_paid /
--      reset_payroll_employee_auto — recreated so NEW audit rows are written
--      with the employee name + code instead of the database id.
--
-- All statements are idempotent and safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. BACKFILL — rewrite the raw employee UUIDs inside existing audit details
--    (covers "Employee <uuid> marked paid", "Employee <uuid> reverted to
--    unpaid — …" and "Salary sheet row of employee <uuid> returned to
--    automatic calculation" — every variant embeds the bare uuid)
-- ---------------------------------------------------------------------------
update public.payroll_audit_log a
set details = replace(a.details, e.id::text, e.full_name || ' (' || e.employee_code || ')')
from public.employee e
where a.details like '%' || e.id::text || '%';

-- ---------------------------------------------------------------------------
-- 2. mark_employee_salary_paid — audit with employee name + code
--    (payment rules unchanged from 20261105: no finalized-period requirement)
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
          coalesce(v_emp.full_name, 'Unknown employee') || ' (' ||
          coalesce(v_emp.employee_code, '—') || ') marked paid');
end; $$;

-- ---------------------------------------------------------------------------
-- 3. unmark_employee_salary_paid — audit with employee name + code
--    (super admin only, reason mandatory — rules unchanged from 20261104)
-- ---------------------------------------------------------------------------
create or replace function public.unmark_employee_salary_paid(
  p_payroll_employee_id uuid, p_reason text
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_pe public.payroll_employee;
  v_period public.payroll_period;
  v_emp public.employee;
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
          coalesce(v_emp.employee_code, '—') || ') reverted to unpaid — reason: ' || btrim(p_reason));
end; $$;

-- ---------------------------------------------------------------------------
-- 4. reset_payroll_employee_auto — audit with employee name + code
--    (rules unchanged from 20261103b)
-- ---------------------------------------------------------------------------
create or replace function public.reset_payroll_employee_auto(p_payroll_employee_id uuid)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_pe public.payroll_employee;
  v_period public.payroll_period;
  v_emp public.employee;
  v_actor text;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;
  select * into v_pe from public.payroll_employee where id = p_payroll_employee_id;
  if v_pe.id is null then raise exception 'Payroll employee not found'; end if;

  select * into v_period from public.payroll_period where id = v_pe.payroll_period_id;
  if v_period.status = 'finalized' then
    raise exception 'Reopen the finalized payroll before resetting to automatic calculation';
  end if;

  update public.payroll_employee set manually_edited = false, updated_at = now()
    where id = p_payroll_employee_id;
  perform public.payroll_upsert_employee(v_period, v_pe.employee_id);

  select * into v_emp from public.employee where id = v_pe.employee_id;
  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (v_period.id, 'reset_auto', auth.uid(), v_actor,
          'Salary sheet row of ' || coalesce(v_emp.full_name, 'Unknown employee') || ' (' ||
          coalesce(v_emp.employee_code, '—') || ') returned to automatic calculation');
end; $$;
