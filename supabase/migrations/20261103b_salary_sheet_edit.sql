-- ============================================================================
-- 20261103b — Salary Sheet: rate fix, sitewise breakdown, sheet editing
-- ----------------------------------------------------------------------------
-- 1. RATE FIX ("rate for the trade is not added"):
--    A trade's FIRST rate set now covers ALL HISTORY (effective 1900-01-01)
--    instead of only "from today". Previously every attendance day before
--    the trade's creation date was unrated → the salary sheet showed
--    "missing rate". Existing first periods are repaired by §2c.
-- 2. SITEWISE BREAKDOWN:
--    Unpriced hours (no trade / no effective rate) are attributed to the
--    site where they were WORKED — not to a generic "No site" bucket. An
--    employee who moved mid-month appears at EVERY site they worked at
--    (historical attribution), including moved-out employees.
-- 3. SHEET EDITING (the sheet record has priority):
--    Edit Mode in the Salary Sheet overrides hours, rate, gross, trade,
--    advance and deduction. A manually edited settlement is NEVER
--    overwritten by the automatic recalculation, and a trade picked in the
--    sheet overwrites the employee's stored trade/assignment data.
--    reset_payroll_employee_auto returns an employee to automatic pricing.
--
-- Idempotent — safe to run any number of times.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. manual-edit flags + 'manual' salary-line tier
-- ---------------------------------------------------------------------------
alter table public.payroll_employee      add column if not exists manually_edited boolean not null default false;
alter table public.payroll_employee_site add column if not exists manually_edited boolean not null default false;

-- a hand-edited site row collapses into one "manual" rate line
alter table public.payroll_salary_line drop constraint if exists payroll_salary_line_experience_tier_check;
do $$ begin
  alter table public.payroll_salary_line add constraint payroll_salary_line_experience_tier_check
    check (experience_tier in ('below_threshold', 'qualified', 'manual'));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. TRADE RATES — first rate of a cell covers history
-- ---------------------------------------------------------------------------

-- 2a. create_trade: initial rates effective from the beginning of time
--     (the trade did not exist before, so nothing is retroactively re-priced;
--     all past attendance of assigned employees now finds a rate).
create or replace function public.create_trade(
  p_name text, p_description text default null,
  p_rates jsonb default '[]'::jsonb, p_activate boolean default true
) returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_trade public.trades;
  v_actor text;
  v_rate jsonb;
  v_cells int := 0;
  v_expected text := 'standard:below_threshold,standard:qualified,team_leader:below_threshold,team_leader:qualified,supervisor:below_threshold,supervisor:qualified';
begin
  if not public.has_menu_permission('trade_management') then raise exception 'Access denied'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Trade name is required'; end if;

  if exists (select 1 from public.trades where lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A trade named "%" already exists', btrim(p_name);
  end if;

  -- tolerate double-encoded payloads (see create_employee)
  if jsonb_typeof(p_rates) = 'string' then p_rates := (p_rates #>> '{}')::jsonb; end if;
  if p_rates is null or jsonb_typeof(p_rates) <> 'array' then
    raise exception 'Rates must be a JSON array';
  end if;

  select count(distinct (r->>'salary_role') || ':' || (r->>'experience_tier')) into v_cells
  from jsonb_array_elements(p_rates) r
  where (r->>'hourly_rate')::numeric >= 0;
  if p_activate and v_cells < 6 then
    raise exception 'Configure all six rate cells (3 salary roles × 2 experience tiers) before activating the trade';
  end if;

  insert into public.trades (name, description, is_active)
  values (btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_activate, false))
  returning * into v_trade;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  for v_rate in select * from jsonb_array_elements(p_rates) loop
    if (v_rate->>'salary_role') in ('standard','team_leader','supervisor')
       and (v_rate->>'experience_tier') in ('below_threshold','qualified')
       and (v_rate->>'hourly_rate')::numeric >= 0 then
      insert into public.trade_rate_history (
        trade_id, salary_role, experience_tier, hourly_rate, effective_from, created_by
      ) values (
        v_trade.id, v_rate->>'salary_role', v_rate->>'experience_tier',
        round((v_rate->>'hourly_rate')::numeric, 2), date '1900-01-01', auth.uid()
      );
    end if;
  end loop;

  insert into public.trade_rate_audit_log (trade_id, action, actor_id, actor_name, details)
  values (v_trade.id, 'create', auth.uid(), v_actor,
          'Trade "' || v_trade.name || '" created with ' || v_cells || ' rate cells');

  return jsonb_build_object('id', v_trade.id, 'name', v_trade.name,
    'is_active', v_trade.is_active);
end; $$;

-- 2b. update_trade_rates: when a cell had NO earlier rate, the new (first)
--     rate is backdated to 1900-01-01 — "adding the missing rate" fixes past
--     months instead of leaving them unrated. Cells with an earlier period
--     keep the effective-dated behaviour (no retroactive re-pricing).
create or replace function public.update_trade_rates(
  p_trade_id uuid, p_rates jsonb, p_effective_from date default null
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_actor text;
  v_rate jsonb;
  v_eff date := coalesce(p_effective_from, current_date);
  v_eff_cell date;               -- effective date used for this cell
  v_cell text;
  v_cap date;
begin
  if not public.has_menu_permission('trade_management') then raise exception 'Access denied'; end if;
  if not exists (select 1 from public.trades where id = p_trade_id) then
    raise exception 'Trade not found';
  end if;
  if v_eff < current_date and not public.is_super_admin() then
    raise exception 'Only super admins can backdate rate changes';
  end if;

  -- tolerate double-encoded payloads (see create_employee)
  if jsonb_typeof(p_rates) = 'string' then p_rates := (p_rates #>> '{}')::jsonb; end if;
  if p_rates is null or jsonb_typeof(p_rates) <> 'array' or jsonb_array_length(p_rates) = 0 then
    raise exception 'Provide at least one rate to change';
  end if;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();

  for v_rate in select * from jsonb_array_elements(p_rates) loop
    if (v_rate->>'salary_role') not in ('standard','team_leader','supervisor')
       or (v_rate->>'experience_tier') not in ('below_threshold','qualified') then
      raise exception 'Invalid rate cell';
    end if;
    if (v_rate->>'hourly_rate')::numeric is null or (v_rate->>'hourly_rate')::numeric < 0 then
      raise exception 'Hourly rate must be 0 or more';
    end if;
    v_cell := (v_rate->>'salary_role') || '/' || (v_rate->>'experience_tier');

    -- first rate ever for this cell → covers history (1900-01-01)
    if not exists (
      select 1 from public.trade_rate_history h
      where h.trade_id = p_trade_id
        and h.salary_role = (v_rate->>'salary_role')
        and h.experience_tier = (v_rate->>'experience_tier')
        and h.effective_from < v_eff
    ) then
      v_eff_cell := date '1900-01-01';
    else
      v_eff_cell := v_eff;
    end if;

    -- a rate scheduled for exactly this date is replaced by the new one
    delete from public.trade_rate_history
      where trade_id = p_trade_id
        and salary_role = (v_rate->>'salary_role')
        and experience_tier = (v_rate->>'experience_tier')
        and effective_from = v_eff;

    -- a strictly future-scheduled rate caps the new period (it wins from its date)
    select min(effective_from) - 1 into v_cap
    from public.trade_rate_history
    where trade_id = p_trade_id
      and salary_role = (v_rate->>'salary_role')
      and experience_tier = (v_rate->>'experience_tier')
      and effective_from > v_eff;

    -- close the currently open period the day before the new effective date
    update public.trade_rate_history
      set effective_to = v_eff_cell - 1
      where trade_id = p_trade_id
        and salary_role = (v_rate->>'salary_role')
        and experience_tier = (v_rate->>'experience_tier')
        and effective_from < v_eff_cell
        and (effective_to is null or effective_to >= v_eff_cell);

    insert into public.trade_rate_history (
      trade_id, salary_role, experience_tier, hourly_rate, effective_from, effective_to, created_by
    ) values (
      p_trade_id, v_rate->>'salary_role', v_rate->>'experience_tier',
      round((v_rate->>'hourly_rate')::numeric, 2), v_eff_cell, v_cap, auth.uid()
    );

    insert into public.trade_rate_audit_log (trade_id, action, actor_id, actor_name, details)
    values (p_trade_id, 'rate_change', auth.uid(), v_actor,
            v_cell || ' = ' || round((v_rate->>'hourly_rate')::numeric, 2) ||
            ' AED/h effective ' || v_eff_cell ||
            case when v_cap is not null then ' (until ' || v_cap || ')' else '' end);
  end loop;
end; $$;

-- 2c. DATA REPAIR: backdate the earliest period of every rate cell to
--     1900-01-01 (trades created by the previous version started their rates
--     "today", leaving all earlier attendance unrated).
update public.trade_rate_history r
  set effective_from = date '1900-01-01'
  where r.effective_from > date '1900-01-01'
    and not exists (
      select 1 from public.trade_rate_history e
      where e.trade_id = r.trade_id
        and e.salary_role = r.salary_role
        and e.experience_tier = r.experience_tier
        and e.effective_from < r.effective_from);

-- ---------------------------------------------------------------------------
-- 3. CALCULATION ENGINE — unpriced hours attributed to the worked site
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
  v_key text;
  r record;
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_unrated numeric := 0;
  v_unassigned numeric := 0;
  v_unassigned_sites jsonb := '{}'::jsonb;  -- site key → unassigned hours
  v_unrated_sites jsonb := '{}'::jsonb;     -- site key → unrated hours
  v_gross numeric := 0;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;

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
        -- no trade: the hours still belong to the site where they were worked
        v_unassigned := v_unassigned + r.hours;
        v_key := coalesce(r.site_id::text, '__none__');
        v_unassigned_sites := jsonb_set(v_unassigned_sites, array[v_key],
          to_jsonb(round(coalesce((v_unassigned_sites->>v_key)::numeric, 0) + r.hours, 2)));
      else
        select name into v_trade_name from public.trades where id = v_trade_id;
        select coalesce(s.name, 'No site') into v_site_name
        from public.site s where s.id = r.site_id;
        -- below-threshold segment
        if v_b > 0 then
          v_rate := public.trade_rate_on(v_trade_id, v_role, 'below_threshold', r.date);
          if v_rate is null then
            v_unrated := v_unrated + v_b;
            v_key := coalesce(r.site_id::text, '__none__');
            v_unrated_sites := jsonb_set(v_unrated_sites, array[v_key],
              to_jsonb(round(coalesce((v_unrated_sites->>v_key)::numeric, 0) + v_b, 2)));
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
          if v_rate is null then
            v_unrated := v_unrated + v_q;
            v_key := coalesce(r.site_id::text, '__none__');
            v_unrated_sites := jsonb_set(v_unrated_sites, array[v_key],
              to_jsonb(round(coalesce((v_unrated_sites->>v_key)::numeric, 0) + v_q, 2)));
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
    'unassigned_sites',         v_unassigned_sites,
    'unrated_sites',            v_unrated_sites,
    'gross_salary',             round(v_gross, 2),
    'lines',                    v_lines
  );
end; $$;

-- ---------------------------------------------------------------------------
-- 4. PAYROLL REFRESH — manual sheet edits win; unpriced hours per site
-- ---------------------------------------------------------------------------
create or replace function public.payroll_upsert_employee(
  p_period public.payroll_period, p_employee_id uuid
) returns void language plpgsql
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
  v_unpriced numeric;
  v_site_name text;
  v_sites jsonb := '{}'::jsonb;   -- coalesced site key → aggregate object
  v_agg jsonb;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;

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

  -- unpriced hours (no trade / no effective rate) belong to the site where
  -- they were WORKED; only hours with no site at all land in "No site".
  -- An employee who moved mid-month therefore appears at every site they
  -- worked at, with the hours of that site.
  for v_key in select jsonb_object_keys(calc->'unassigned_sites') loop
    v_unpriced := (calc->'unassigned_sites'->>v_key)::numeric;
    v_agg := v_sites->v_key;
    if v_agg is null then
      if v_key = '__none__' then
        v_agg := jsonb_build_object('site_id', null, 'site_name', 'No site',
          'total_hours', 0, 'below_threshold_hours', 0, 'qualified_hours', 0,
          'standard_hours', 0, 'team_leader_hours', 0, 'supervisor_hours', 0,
          'gross_salary', 0, 'has_missing_rate', false);
      else
        select coalesce(s.name, 'No site') into v_site_name
        from public.site s where s.id = v_key::uuid;
        v_agg := jsonb_build_object('site_id', to_jsonb(v_key::uuid),
          'site_name', coalesce(v_site_name, 'No site'),
          'total_hours', 0, 'below_threshold_hours', 0, 'qualified_hours', 0,
          'standard_hours', 0, 'team_leader_hours', 0, 'supervisor_hours', 0,
          'gross_salary', 0, 'has_missing_rate', false);
      end if;
    end if;
    v_agg := jsonb_set(v_agg, '{total_hours}',
      to_jsonb(round(((v_agg->>'total_hours')::numeric + v_unpriced), 2)));
    v_sites := jsonb_set(v_sites, array[v_key], v_agg);
  end loop;

  for v_key in select jsonb_object_keys(calc->'unrated_sites') loop
    v_unpriced := (calc->'unrated_sites'->>v_key)::numeric;
    v_agg := v_sites->v_key;
    if v_agg is null then
      if v_key = '__none__' then
        v_agg := jsonb_build_object('site_id', null, 'site_name', 'No site',
          'total_hours', 0, 'below_threshold_hours', 0, 'qualified_hours', 0,
          'standard_hours', 0, 'team_leader_hours', 0, 'supervisor_hours', 0,
          'gross_salary', 0, 'has_missing_rate', false);
      else
        select coalesce(s.name, 'No site') into v_site_name
        from public.site s where s.id = v_key::uuid;
        v_agg := jsonb_build_object('site_id', to_jsonb(v_key::uuid),
          'site_name', coalesce(v_site_name, 'No site'),
          'total_hours', 0, 'below_threshold_hours', 0, 'qualified_hours', 0,
          'standard_hours', 0, 'team_leader_hours', 0, 'supervisor_hours', 0,
          'gross_salary', 0, 'has_missing_rate', false);
      end if;
    end if;
    v_agg := jsonb_set(v_agg, '{total_hours}',
      to_jsonb(round(((v_agg->>'total_hours')::numeric + v_unpriced), 2)));
    v_agg := jsonb_set(v_agg, '{has_missing_rate}', 'true');
    v_sites := jsonb_set(v_sites, array[v_key], v_agg);
  end loop;

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
-- 5. SALARY SHEET READ — expose the manual-edit flags
-- ---------------------------------------------------------------------------
create or replace function public.get_salary_sheet(p_year int, p_month int)
returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_period public.payroll_period;
  v_totals jsonb;
  v_sites jsonb := '[]'::jsonb;
  v_employees jsonb;
  v_audit jsonb;
  v_rows jsonb;
  v_group record;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;

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

  -- site groups (employee × site rows, gross at that site) — keyed by site id,
  -- never by name (two sites may share a name)
  for v_group in
    select s.site_id, s.site_name_snapshot as site_name,
           count(*)::int as employees,
           round(sum(s.total_hours), 2) as total_hours,
           round(sum(s.gross_salary), 2) as gross_salary
    from public.payroll_employee_site s
    join public.payroll_employee pe on pe.id = s.payroll_employee_id
    where pe.payroll_period_id = v_period.id
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
      'salary_role', pe.salary_role_snapshot
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
      'rows', v_rows
    );
  end loop;

  -- consolidated per-employee settlements (advance/deduction/net exactly once)
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

-- ---------------------------------------------------------------------------
-- 6. SALARY SHEET EDITING
--     THE SHEET RECORD HAS PRIORITY over other stored data: values edited
--     here overwrite the stored data and are never touched by the automatic
--     recalculation (until reset_payroll_employee_auto).
-- ---------------------------------------------------------------------------

-- the assignment helper is also used from the Salary Sheet (salary_sheet
-- permission), not only from the employee form (employees permission)
create or replace function public.apply_employee_assignment(
  p_employee_id uuid, p_trade_id uuid, p_salary_role text, p_eff date
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_cap date;
begin
  if not public.has_menu_permission('employees')
     and not public.has_menu_permission('salary_sheet') then
    raise exception 'Access denied';
  end if;

  delete from public.employee_salary_assignment
    where employee_id = p_employee_id and effective_from = p_eff;

  select min(effective_from) - 1 into v_cap
  from public.employee_salary_assignment
  where employee_id = p_employee_id and effective_from > p_eff;

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

-- Update one employee's Salary Sheet row.
--   p_payload:
--   {
--     "payroll_employee_id": "<uuid>",          (required)
--     "trade_id": "<uuid>" | null,              (present → overwrite the stored trade)
--     "advance": 500, "deduction": 100,         (optional, >= 0)
--     "notes": "text" | null,                   (optional)
--     "sites": [                                (optional — manual overrides)
--       {"site_id": "<uuid>"|null, "total_hours": 176,
--        "hourly_rate": 8.5, "gross_salary": 1496}
--     ]
--   }
-- Rules:
--   • paid employees are protected (reopen the payroll first);
--   • a trade change overwrites employee.trade_id and the assignment history
--     from the 1st of the payroll month (the whole month prices at the new
--     trade) and re-prices the employee automatically when no manual site
--     values exist;
--   • any manual site override marks the settlement manually_edited — the
--     sheet record then wins over every recalculation.
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
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;
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

  -- 1. trade picked in the sheet → OVERWRITE the stored trade + assignment
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

-- Return an employee's settlement to automatic calculation (draft periods).
create or replace function public.reset_payroll_employee_auto(p_payroll_employee_id uuid)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_pe public.payroll_employee;
  v_period public.payroll_period;
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

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (v_period.id, 'reset_auto', auth.uid(), v_actor,
          'Salary sheet row of employee ' || v_pe.employee_id || ' returned to automatic calculation');
end; $$;

-- ---------------------------------------------------------------------------
-- 7. REALTIME — publish the sheet detail tables
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.payroll_employee_site;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.payroll_salary_line;
exception when duplicate_object then null; end $$;
