-- ============================================================================
-- 20261111c — CONFIGURABLE ABSENT DEDUCTION (Deduction Management)
-- ----------------------------------------------------------------------------
-- The absent-deduction rule introduced in 20261111b (first 2 absences free,
-- AED 25 per absence from the 3rd onwards) becomes CONFIGURABLE from the UI:
--
--   Trade Management → Deductions tab   (sidebar label: Trade/Ded Management)
--     • Free absent days per month    (absent_free_days,        default 2)
--     • Deduction per absent day AED  (absent_deduction_amount, default 25)
--
--   absent_deduction = greatest(absent_count - absent_free_days, 0)
--                        * absent_deduction_amount
--
-- Storage: public.deduction_settings — a SINGLETON table (id fixed to 1).
--
--   1. get_deduction_settings — any signed-in staff member can read it (the
--      Payroll page and the attendance calendar render the live rule).
--   2. update_deduction_settings — requires the trade_management menu
--      permission (the same gate as trade edits); every change is audited
--      into payroll_audit_log.
--   3. payroll_upsert_employee — the 20261111b body, now reading the rule
--      from the settings row (fallback 2 / 25 when the row is missing)
--      instead of the hardcoded constants.
--
-- Data: the default row is inserted below, so behaviour is UNCHANGED until
-- an admin edits the rule. DRAFT periods pick the new rule up on their next
-- view (get_salary_sheet regenerates drafts); FINALIZED periods stay locked
-- exactly as they were paid.
-- ============================================================================

create table if not exists public.deduction_settings (
  id                      int primary key default 1 check (id = 1),
  -- how many absences per payroll month are free of charge
  absent_free_days        int not null default 2 check (absent_free_days between 0 and 31),
  -- AED charged per absence beyond the free days
  absent_deduction_amount numeric(12,2) not null default 25 check (absent_deduction_amount >= 0),
  updated_at              timestamptz,
  updated_by              uuid
);

insert into public.deduction_settings (id, absent_free_days, absent_deduction_amount)
values (1, 2, 25)
on conflict (id) do nothing;

-- lock the singleton down; all access flows through the RPCs below
alter table public.deduction_settings enable row level security;

-- ---------------------------------------------------------------------------
-- 1. get_deduction_settings — the effective rule (any signed-in staff)
-- ---------------------------------------------------------------------------
create or replace function public.get_deduction_settings()
returns jsonb language plpgsql stable
security definer set search_path = public
as $$
declare
  s public.deduction_settings;
  v_actor text;
begin
  if not public.is_staff() then raise exception 'Access denied'; end if;

  select * into s from public.deduction_settings where id = 1;
  if s.id is null then
    -- no row yet (should not happen — inserted above): ship the defaults
    return jsonb_build_object(
      'absent_free_days', 2,
      'absent_deduction_amount', 25,
      'updated_at', null,
      'updated_by_name', null);
  end if;

  select coalesce(name, email) into v_actor from public.profiles where id = s.updated_by;
  return jsonb_build_object(
    'absent_free_days', s.absent_free_days,
    'absent_deduction_amount', s.absent_deduction_amount,
    'updated_at', s.updated_at,
    'updated_by_name', v_actor);
end; $$;

-- ---------------------------------------------------------------------------
-- 2. update_deduction_settings — trade_management permission, audited
-- ---------------------------------------------------------------------------
create or replace function public.update_deduction_settings(
  p_free_days int, p_amount numeric
) returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_before public.deduction_settings;
  v_actor text;
begin
  if not public.has_menu_permission('trade_management') then
    raise exception 'Access denied';
  end if;
  if p_free_days is null or p_free_days < 0 or p_free_days > 31 then
    raise exception 'Free absent days must be a whole number between 0 and 31';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'Deduction per absent day must be 0 or more';
  end if;

  select * into v_before from public.deduction_settings where id = 1;
  -- the on-conflict insert below guarantees the row exists even on a DB
  -- where the default insert was skipped

  insert into public.deduction_settings (id, absent_free_days, absent_deduction_amount,
                                         updated_at, updated_by)
  values (1, p_free_days, round(p_amount, 2), now(), auth.uid())
  on conflict (id) do update set
    absent_free_days        = excluded.absent_free_days,
    absent_deduction_amount = excluded.absent_deduction_amount,
    updated_at              = excluded.updated_at,
    updated_by              = excluded.updated_by;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (null, 'deduction_settings', auth.uid(), v_actor,
          'Absent deduction rule: first ' || p_free_days
          || ' absence' || case when p_free_days = 1 then '' else 's' end
          || ' free, AED ' || round(p_amount, 2) || ' per absence after that (was '
          || coalesce(v_before.absent_free_days, 2) || ' free / AED '
          || coalesce(v_before.absent_deduction_amount, 25) || ')');

  return jsonb_build_object(
    'absent_free_days', p_free_days,
    'absent_deduction_amount', round(p_amount, 2),
    'updated_at', now(),
    'updated_by_name', v_actor);
end; $$;

-- ---------------------------------------------------------------------------
-- 3. payroll_upsert_employee — 20261111b body, deduction rule now read from
--    deduction_settings (fallback 2 / 25 when the row is missing)
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
  v_free_days int := 2;
  v_ded_amount numeric := 25;
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
  -- absent_free_days absences are free (Deduction Management), every absence
  -- after those costs absent_deduction_amount. No settings row → 2 / AED 25.
  select s.absent_free_days, s.absent_deduction_amount
  into v_free_days, v_ded_amount
  from public.deduction_settings s where s.id = 1;
  if v_free_days is null then
    v_free_days := 2; v_ded_amount := 25;
  end if;
  v_month_start := make_date(p_period.year, p_period.month, 1);
  v_month_end   := (v_month_start + interval '1 month' - interval '1 day')::date;
  select count(*) into v_absent_count
  from public.attendance a
  where a.employee_id = p_employee_id
    and not a.is_hidden
    and a.status = 'absent'
    and a.date >= v_month_start and a.date <= v_month_end;
  v_absent_deduction := greatest(v_absent_count - v_free_days, 0) * v_ded_amount;

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
