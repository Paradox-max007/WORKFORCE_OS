-- ============================================================================
-- 20261103 — Trade & Salary system
-- ----------------------------------------------------------------------------
-- Implements the confirmed business rules:
--   • Eligibility is OR: 6 calendar months from join_date OR 1,000 lifetime
--     working hours (opening balance INCLUDED), whichever happens first.
--   • Hours are split at the qualification point (mid-shift for the 1,000-hour
--     route; whole-day for the six-month anniversary date).
--   • No retroactive rate changes — rates are effective-dated
--     (trade_rate_history), assignments are effective-dated
--     (employee_salary_assignment).
--   • Site attribution is historical: every hour belongs to the site the
--     employee actually worked at on that date (emp_site_on_date).
--   • Payroll is a snapshot: drafts recalculate live, finalization locks the
--     calculation, reopening is audited.
--
-- ADDITIVE only — no existing table or column is dropped or narrowed.
-- Idempotent: safe to run any number of times.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------------

-- 1a. Trades (Electrician, Plumber, …) --------------------------------------
create table if not exists public.trades (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- case/whitespace-insensitive unique trade name
create unique index if not exists trades_name_unique_idx
  on public.trades (lower(trim(name)));

-- 1b. Employee columns (trade + salary classification) ----------------------
alter table public.employee add column if not exists trade_id uuid references public.trades(id);
alter table public.employee add column if not exists salary_role text not null default 'standard';
alter table public.employee drop constraint if exists employee_salary_role_check;
alter table public.employee add constraint employee_salary_role_check
  check (salary_role in ('standard', 'team_leader', 'supervisor'));

-- 1c. Effective-dated trade rates --------------------------------------------
-- An admin edits a rate → the previous period is closed (effective_to) and a
-- new record starts. Historical payroll never re-prices itself silently.
create table if not exists public.trade_rate_history (
  id               uuid primary key default gen_random_uuid(),
  trade_id         uuid not null references public.trades(id) on delete cascade,
  salary_role      text not null check (salary_role in ('standard', 'team_leader', 'supervisor')),
  experience_tier  text not null check (experience_tier in ('below_threshold', 'qualified')),
  hourly_rate      numeric(10,2) not null check (hourly_rate >= 0),
  effective_from   date not null,
  effective_to     date,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);
create index if not exists idx_trade_rate_trade on public.trade_rate_history(trade_id);
create index if not exists idx_trade_rate_cell on public.trade_rate_history(trade_id, salary_role, experience_tier, effective_from);

-- 1d. Effective-dated employee trade/role assignments ------------------------
-- Changing trade or salary role mid-month keeps old work at the old
-- classification — the old assignment applies before the effective date.
create table if not exists public.employee_salary_assignment (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employee(id) on delete cascade,
  trade_id       uuid not null references public.trades(id) on delete restrict,
  salary_role    text not null check (salary_role in ('standard', 'team_leader', 'supervisor')),
  effective_from date not null,
  effective_to   date,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index if not exists idx_salary_assign_emp on public.employee_salary_assignment(employee_id, effective_from);

-- 1e. Payroll period (one per month) -----------------------------------------
create table if not exists public.payroll_period (
  id           uuid primary key default gen_random_uuid(),
  year         int  not null check (year between 2000 and 2100),
  month        int  not null check (month between 1 and 12),
  status       text not null default 'draft' check (status in ('draft', 'finalized')),
  created_by   uuid,
  finalized_by uuid,
  finalized_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (year, month)
);

-- 1f. Payroll employee (one per employee per month — settlement unit) --------
create table if not exists public.payroll_employee (
  id                      uuid primary key default gen_random_uuid(),
  payroll_period_id       uuid not null references public.payroll_period(id) on delete cascade,
  employee_id             uuid not null references public.employee(id) on delete cascade,
  opening_lifetime_hours  numeric(12,2) not null default 0,
  closing_lifetime_hours  numeric(12,2) not null default 0,
  total_hours             numeric(12,2) not null default 0,
  below_threshold_hours   numeric(12,2) not null default 0,
  qualified_hours         numeric(12,2) not null default 0,
  unrated_hours           numeric(12,2) not null default 0,
  unassigned_hours        numeric(12,2) not null default 0,
  gross_salary            numeric(12,2) not null default 0,
  advance                 numeric(12,2) not null default 0 check (advance >= 0),
  deduction               numeric(12,2) not null default 0 check (deduction >= 0),
  net_salary              numeric(12,2) not null default 0,
  payment_status          text not null default 'unpaid' check (payment_status in ('unpaid', 'paid')),
  paid_at                 timestamptz,
  paid_by                 uuid,
  notes                   text,
  trade_id_snapshot       uuid,
  salary_role_snapshot    text,
  updated_at              timestamptz not null default now(),
  unique (payroll_period_id, employee_id)
);
create index if not exists idx_payroll_emp_period on public.payroll_employee(payroll_period_id);

-- 1g. Payroll employee × site (Salary Sheet site-group rows) ------------------
create table if not exists public.payroll_employee_site (
  id                    uuid primary key default gen_random_uuid(),
  payroll_employee_id   uuid not null references public.payroll_employee(id) on delete cascade,
  site_id               uuid,
  site_name_snapshot    text not null,
  total_hours           numeric(12,2) not null default 0,
  below_threshold_hours numeric(12,2) not null default 0,
  qualified_hours       numeric(12,2) not null default 0,
  standard_hours        numeric(12,2) not null default 0,
  team_leader_hours     numeric(12,2) not null default 0,
  supervisor_hours      numeric(12,2) not null default 0,
  gross_salary          numeric(12,2) not null default 0,
  has_missing_rate      boolean not null default false,
  calculation_details   jsonb
);
-- site_id is nullable (hours at no site) — a plain UNIQUE would treat NULLs as
-- distinct, so uniqueness is enforced on the coalesced key.
create unique index if not exists idx_payroll_emp_site_key
  on public.payroll_employee_site (payroll_employee_id, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- 1h. Salary lines (one row = hours × one rate; explainable payroll) ---------
create table if not exists public.payroll_salary_line (
  id                  uuid primary key default gen_random_uuid(),
  payroll_employee_id uuid not null references public.payroll_employee(id) on delete cascade,
  site_id             uuid,
  site_name_snapshot  text not null,
  attendance_date     date not null,
  trade_id            uuid,
  trade_name_snapshot text not null,
  salary_role_snapshot text not null,
  experience_tier     text not null check (experience_tier in ('below_threshold', 'qualified')),
  hours               numeric(12,2) not null check (hours > 0),
  hourly_rate         numeric(10,2) not null,
  gross_amount        numeric(12,2) not null
);
create index if not exists idx_payroll_line_emp on public.payroll_salary_line(payroll_employee_id);

-- 1i. Payroll audit log (finalize / reopen / payment / backdated rates) -------
create table if not exists public.payroll_audit_log (
  id          uuid primary key default gen_random_uuid(),
  period_id   uuid references public.payroll_period(id) on delete cascade,
  action      text not null,
  actor_id    uuid,
  actor_name  text,
  details     text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_payroll_audit_period on public.payroll_audit_log(period_id, created_at);

-- rate-change audit (works even outside payroll periods)
create table if not exists public.trade_rate_audit_log (
  id          uuid primary key default gen_random_uuid(),
  trade_id    uuid not null references public.trades(id) on delete cascade,
  action      text not null,
  actor_id    uuid,
  actor_name  text,
  details     text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. NON-OVERLAP GUARDS (triggers — no extension required)
-- ---------------------------------------------------------------------------

create or replace function public.trg_trade_rate_no_overlap()
returns trigger language plpgsql as $$
declare v_overlap int;
begin
  select count(*) into v_overlap from public.trade_rate_history r
  where r.trade_id = new.trade_id
    and r.salary_role = new.salary_role
    and r.experience_tier = new.experience_tier
    and r.id <> new.id
    and coalesce(new.effective_to, 'infinity'::date) >= r.effective_from
    and coalesce(r.effective_to, 'infinity'::date) >= new.effective_from;
  if v_overlap > 0 then
    raise exception 'Overlapping rate periods for trade % (% / %) — close the previous period first',
      new.trade_id, new.salary_role, new.experience_tier;
  end if;
  return new;
end; $$;
drop trigger if exists trade_rate_no_overlap on public.trade_rate_history;
create trigger trade_rate_no_overlap before insert or update on public.trade_rate_history
  for each row execute function public.trg_trade_rate_no_overlap();

create or replace function public.trg_salary_assign_no_overlap()
returns trigger language plpgsql as $$
declare v_overlap int;
begin
  select count(*) into v_overlap from public.employee_salary_assignment a
  where a.employee_id = new.employee_id
    and a.id <> new.id
    and coalesce(new.effective_to, 'infinity'::date) >= a.effective_from
    and coalesce(a.effective_to, 'infinity'::date) >= new.effective_from;
  if v_overlap > 0 then
    raise exception 'Overlapping trade assignments for employee % — close the previous assignment first',
      new.employee_id;
  end if;
  return new;
end; $$;
drop trigger if exists salary_assign_no_overlap on public.employee_salary_assignment;
create trigger salary_assign_no_overlap before insert or update on public.employee_salary_assignment
  for each row execute function public.trg_salary_assign_no_overlap();

-- trades.updated_at touch
drop trigger if exists trg_trades_touch on public.trades;
create trigger trg_trades_touch before update on public.trades
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. RLS — salary data is RPC-only; trades readable by staff
-- ---------------------------------------------------------------------------
alter table public.trades                  enable row level security;
alter table public.trade_rate_history      enable row level security;
alter table public.employee_salary_assignment enable row level security;
alter table public.payroll_period          enable row level security;
alter table public.payroll_employee        enable row level security;
alter table public.payroll_employee_site   enable row level security;
alter table public.payroll_salary_line     enable row level security;
alter table public.payroll_audit_log       enable row level security;
alter table public.trade_rate_audit_log    enable row level security;

drop policy if exists trades_select on public.trades;
create policy trades_select on public.trades for select using (public.is_staff());

-- payroll / rate history / assignments: NO direct table policies — every read
-- and write goes through the security-definer RPCs below, which check menu
-- permissions (has_menu_permission) per operation.

-- ---------------------------------------------------------------------------
-- 4. HELPER LOOKUPS
-- ---------------------------------------------------------------------------

-- Trade + salary role applicable to an employee on a given date.
-- Prefers the effective-dated assignment; falls back to the employee row
-- (legacy employees mapped before the assignment table existed).
create or replace function public.emp_trade_on_date(p_employee_id uuid, p_date date)
returns jsonb language sql stable
security definer set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object('trade_id', a.trade_id, 'salary_role', a.salary_role)
     from public.employee_salary_assignment a
     where a.employee_id = p_employee_id
       and a.effective_from <= p_date
       and (a.effective_to is null or a.effective_to >= p_date)
     order by a.effective_from desc limit 1),
    (select jsonb_build_object('trade_id', e.trade_id, 'salary_role', e.salary_role)
     from public.employee e where e.id = p_employee_id)
  );
$$;

-- Effective hourly rate for a trade × role × tier on a date (null = unrated).
create or replace function public.trade_rate_on(
  p_trade_id uuid, p_salary_role text, p_experience_tier text, p_date date
) returns numeric language sql stable
security definer set search_path = public
as $$
  select r.hourly_rate
  from public.trade_rate_history r
  where r.trade_id = p_trade_id
    and r.salary_role = p_salary_role
    and r.experience_tier = p_experience_tier
    and r.effective_from <= p_date
    and (r.effective_to is null or r.effective_to >= p_date)
  order by r.effective_from desc limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 5. ELIGIBILITY
--    Q = min(join_date + 6 calendar months, date lifetime hours reach 1,000)
--    Opening balance counts toward the 1,000 hours; >= 1,000 opening hours
--    qualifies from the employment start date.
-- ---------------------------------------------------------------------------
create or replace function public.get_employee_salary_eligibility(
  p_employee_id uuid, p_as_of date default null
) returns jsonb language plpgsql stable
security definer set search_path = public
as $$
declare
  emp record;
  v_as_of date := coalesce(p_as_of, (now() at time zone 'Asia/Dubai')::date);
  v_six_month date;
  v_threshold_date date;
  v_tracked numeric;
  v_lifetime numeric;
  v_opening numeric;
  v_qual_date date;
  v_reason text;
  v_current jsonb;
  v_current_rate numeric;
  v_tier text;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;

  select e.*, t.name as trade_name into emp
  from public.employee e
  left join public.trades t on t.id = e.trade_id
  where e.id = p_employee_id and e.status <> 'deleted';
  if emp.id is null then raise exception 'Employee not found'; end if;

  v_opening := coalesce(emp.opening_hours, 0);

  -- six calendar months from employment start (Postgres clamps month-end:
  -- Aug 31 + 6 months = Feb 28/29)
  v_six_month := (coalesce(emp.join_date, emp.created_at::date) + interval '6 months')::date;

  -- first date where opening + cumulative attendance hours reach the threshold
  select d, cum into v_threshold_date, v_lifetime from (
    select a.date as d,
           v_opening + sum(a.hours) over (order by a.date) as cum
    from public.attendance a
    where a.employee_id = p_employee_id
      and not a.is_hidden and a.hours is not null and a.hours > 0
    order by a.date
  ) t where cum >= 1000 order by d limit 1;

  select coalesce(sum(a.hours), 0) into v_tracked
  from public.attendance a
  where a.employee_id = p_employee_id
    and not a.is_hidden and a.hours is not null and a.hours > 0;

  v_lifetime := round(v_opening + v_tracked, 2);

  -- qualification = the EARLIER route (opening >= 1000 → from employment start)
  if v_opening >= 1000 then
    v_qual_date := coalesce(emp.join_date, emp.created_at::date);
    v_reason := 'opening_balance';
  else
    v_qual_date := least(v_six_month, coalesce(v_threshold_date, '9999-12-31'::date));
    if v_qual_date = '9999-12-31'::date then
      v_qual_date := null;
    elsif v_threshold_date is not null and v_threshold_date < v_six_month then
      v_reason := 'thousand_hours';
    else
      v_reason := 'six_months';
    end if;
  end if;

  -- current applicable rate (trade × role × current tier, as of v_as_of)
  v_current := public.emp_trade_on_date(p_employee_id, v_as_of);
  if (v_current->>'trade_id') is not null then
    v_tier := case when v_qual_date is not null and v_as_of >= v_qual_date
                   then 'qualified' else 'below_threshold' end;
    v_current_rate := public.trade_rate_on(
      (v_current->>'trade_id')::uuid, v_current->>'salary_role', v_tier, v_as_of);
  end if;

  return jsonb_build_object(
    'employee_id',        emp.id,
    'full_name',          emp.full_name,
    'employee_code',      emp.employee_code,
    'join_date',          emp.join_date,
    'opening_hours',      round(v_opening, 2),
    'tracked_hours',      round(v_tracked, 2),
    'lifetime_hours',     v_lifetime,
    'six_month_date',     v_six_month,
    'threshold_hours',    1000,
    'threshold_date',     v_threshold_date,
    'hours_to_threshold', greatest(0, round(1000 - v_lifetime, 2)),
    'progress_percent',   least(100, round(100.0 * v_lifetime / 1000, 1)),
    'qualified',          v_qual_date is not null and v_as_of >= v_qual_date,
    'qualification_date', v_qual_date,
    'qualification_reason', v_reason,
    'as_of',              v_as_of,
    'trade_id',           (v_current->>'trade_id'),
    'trade_name',         case when (v_current->>'trade_id') is not null
                               then coalesce((select name from public.trades where id = (v_current->>'trade_id')::uuid), null)
                          end,
    'salary_role',        coalesce(v_current->>'salary_role', emp.salary_role),
    'current_rate',       v_current_rate
  );
end; $$;

-- Assignment history for one employee (newest first).
create or replace function public.get_employee_salary_history(p_employee_id uuid)
returns jsonb language sql stable
security definer set search_path = public
as $$
  select coalesce(jsonb_agg(row order by effective_from desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', a.id,
      'employee_id', a.employee_id,
      'employee_name', e.full_name,
      'trade_id', a.trade_id,
      'trade_name', t.name,
      'salary_role', a.salary_role,
      'effective_from', a.effective_from,
      'effective_to', a.effective_to,
      'created_at', a.created_at
    ) as row
    from public.employee_salary_assignment a
    join public.employee e on e.id = a.employee_id
    join public.trades t on t.id = a.trade_id
    where a.employee_id = p_employee_id
  ) s;
$$;

-- ---------------------------------------------------------------------------
-- 6. THE CALCULATION ENGINE (single source of truth — frontend never computes)
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
-- 7. PAYROLL GENERATION / LIFECYCLE
-- ---------------------------------------------------------------------------

-- Internal: recalculate one employee's month into the (draft) period.
-- Preserves manually entered advance / deduction / notes / payment state.
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
  v_sites jsonb := '{}'::jsonb;   -- coalesced site key → aggregate object
  v_agg jsonb;
begin
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
    v_agg := jsonb_set(v_agg, '{' || (v_line->>'experience_tier') || '_hours}',
      to_jsonb(round(((v_agg->(v_line->>'experience_tier') || '_hours')::numeric + v_tier_hours), 2)));
    v_role_hours := (v_agg->((v_line->>'salary_role') || '_hours'))::numeric + v_tier_hours;
    v_agg := jsonb_set(v_agg, '{' || (v_line->>'salary_role') || '_hours}', to_jsonb(round(v_role_hours, 2)));
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
      (v_line->'site_id')::uuid,
      v_line->>'site_name',
      (v_line->>'date')::date,
      (v_line->'trade_id')::uuid,
      v_line->>'trade_name',
      v_line->>'salary_role',
      v_line->>'experience_tier',
      (v_line->>'hours')::numeric,
      (v_line->>'hourly_rate')::numeric,
      (v_line->>'gross_amount')::numeric
    );
  end loop;
end; $$;

-- Generate (or refresh) a month's draft payroll.
create or replace function public.generate_payroll_period(p_year int, p_month int)
returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_period public.payroll_period;
  v_month_end date := (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day')::date;
  v_emp record;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;

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

-- Finalize: lock the calculation snapshot.
create or replace function public.finalize_payroll_period(p_payroll_period_id uuid)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_period public.payroll_period;
declare v_actor text;
begin
  if not public.has_menu_permission('salary_sheet') or not public.is_super_admin() then
    raise exception 'Access denied';
  end if;
  select * into v_period from public.payroll_period where id = p_payroll_period_id;
  if v_period.id is null then raise exception 'Payroll period not found'; end if;
  if v_period.status = 'finalized' then raise exception 'Payroll is already finalized'; end if;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  update public.payroll_period
    set status = 'finalized', finalized_by = auth.uid(), finalized_at = now()
    where id = p_payroll_period_id;
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (p_payroll_period_id, 'finalize', auth.uid(), v_actor,
          'Payroll ' || v_period.year || '/' || v_period.month || ' finalized — calculation locked');
end; $$;

-- Reopen: audited (a reason is mandatory; pre-reopen totals are recorded).
create or replace function public.reopen_payroll_period(p_payroll_period_id uuid, p_reason text)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_period public.payroll_period;
  v_actor text;
  v_totals text;
begin
  if not public.has_menu_permission('salary_sheet') or not public.is_super_admin() then
    raise exception 'Access denied';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to reopen a payroll period';
  end if;
  select * into v_period from public.payroll_period where id = p_payroll_period_id;
  if v_period.id is null then raise exception 'Payroll period not found'; end if;
  if v_period.status <> 'finalized' then raise exception 'Payroll is not finalized'; end if;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  select 'employees=' || count(*) || ', gross=' || coalesce(sum(gross_salary), 0) ||
         ', advances=' || coalesce(sum(advance), 0) || ', deductions=' || coalesce(sum(deduction), 0) ||
         ', net=' || coalesce(sum(net_salary), 0) || ', paid=' || count(*) filter (where payment_status = 'paid')
    into v_totals
  from public.payroll_employee where payroll_period_id = p_payroll_period_id;

  update public.payroll_period
    set status = 'draft', finalized_by = null, finalized_at = null
    where id = p_payroll_period_id;
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (p_payroll_period_id, 'reopen', auth.uid(), v_actor,
          'Reopened: ' || btrim(p_reason) || ' — previous snapshot: ' || v_totals);
end; $$;

-- Edit advance / deduction / notes (allowed while unpaid — draft or finalized).
create or replace function public.update_payroll_adjustment(
  p_payroll_employee_id uuid, p_advance numeric, p_deduction numeric, p_notes text
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_pe public.payroll_employee;
begin
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;
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

-- Record payment (requires a finalized period).
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
  if not public.has_menu_permission('salary_sheet') then raise exception 'Access denied'; end if;
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
-- 8. SALARY SHEET READ (grouped by site, consolidated settlement)
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
                'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                            'site_id', l.site_id, 'site_name', l.site_name_snapshot,
                            'date', l.attendance_date, 'trade_id', l.trade_id,
                            'trade_name', l.trade_name_snapshot,
                            'salary_role', l.salary_role_snapshot,
                            'experience_tier', l.experience_tier,
                            'hours', l.hours, 'hourly_rate', l.hourly_rate,
                            'gross_amount', l.gross_amount) order by l.attendance_date), '[]'::jsonb)
                          from public.payroll_salary_line l
                          where l.payroll_employee_id = pe.id)
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
-- 9. TRADE MANAGEMENT RPCs
-- ---------------------------------------------------------------------------
create or replace function public.list_trades()
returns jsonb language sql stable
security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'name', t.name, 'description', t.description,
    'is_active', t.is_active, 'created_at', t.created_at, 'updated_at', t.updated_at,
    'current_rates', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'trade_id', r.trade_id, 'salary_role', r.salary_role,
        'experience_tier', r.experience_tier, 'hourly_rate', r.hourly_rate,
        'effective_from', r.effective_from, 'effective_to', r.effective_to,
        'created_at', r.created_at) order by r.salary_role, r.experience_tier),
        '[]'::jsonb)
      from public.trade_rate_history r
      where r.trade_id = t.id
        and r.effective_from <= current_date
        and (r.effective_to is null or r.effective_to >= current_date))
  ) order by t.name), '[]'::jsonb)
  from public.trades t;
$$;

create or replace function public.get_trade_rate_history(p_trade_id uuid)
returns jsonb language sql stable
security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'trade_id', r.trade_id, 'salary_role', r.salary_role,
    'experience_tier', r.experience_tier, 'hourly_rate', r.hourly_rate,
    'effective_from', r.effective_from, 'effective_to', r.effective_to,
    'created_at', r.created_at
  ) order by r.salary_role, r.experience_tier, r.effective_from desc), '[]'::jsonb)
  from public.trade_rate_history r where r.trade_id = p_trade_id;
$$;

-- p_rates: [{"salary_role":"standard","experience_tier":"below_threshold","hourly_rate":8}, …]
-- p_activate requires ALL six rate cells.
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
        round((v_rate->>'hourly_rate')::numeric, 2), current_date, auth.uid()
      );
    end if;
  end loop;

  insert into public.trade_rate_audit_log (trade_id, action, actor_id, actor_name, details)
  values (v_trade.id, 'create', auth.uid(), v_actor,
          'Trade "' || v_trade.name || '" created with ' || v_cells || ' rate cells');

  return jsonb_build_object('id', v_trade.id, 'name', v_trade.name,
    'is_active', v_trade.is_active);
end; $$;

create or replace function public.update_trade(
  p_trade_id uuid, p_name text, p_description text default null,
  p_is_active boolean default null
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_actor text;
begin
  if not public.has_menu_permission('trade_management') then raise exception 'Access denied'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Trade name is required'; end if;
  if exists (select 1 from public.trades
             where lower(trim(name)) = lower(trim(p_name)) and id <> p_trade_id) then
    raise exception 'A trade named "%" already exists', btrim(p_name);
  end if;
  if not exists (select 1 from public.trades where id = p_trade_id) then
    raise exception 'Trade not found';
  end if;

  update public.trades set
    name = btrim(p_name),
    description = nullif(btrim(coalesce(p_description, '')), ''),
    is_active = coalesce(p_is_active, public.trades.is_active)
  where id = p_trade_id;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  insert into public.trade_rate_audit_log (trade_id, action, actor_id, actor_name, details)
  values (p_trade_id, 'update', auth.uid(), v_actor, 'Trade details updated');
end; $$;

-- Close the open period for the provided cells and start a new one.
-- Backdated effective dates (before today) need a super admin.
create or replace function public.update_trade_rates(
  p_trade_id uuid, p_rates jsonb, p_effective_from date default null
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_actor text;
  v_rate jsonb;
  v_eff date := coalesce(p_effective_from, current_date);
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
      set effective_to = v_eff - 1
      where trade_id = p_trade_id
        and salary_role = (v_rate->>'salary_role')
        and experience_tier = (v_rate->>'experience_tier')
        and effective_from < v_eff
        and (effective_to is null or effective_to >= v_eff);

    insert into public.trade_rate_history (
      trade_id, salary_role, experience_tier, hourly_rate, effective_from, effective_to, created_by
    ) values (
      p_trade_id, v_rate->>'salary_role', v_rate->>'experience_tier',
      round((v_rate->>'hourly_rate')::numeric, 2), v_eff, v_cap, auth.uid()
    );

    insert into public.trade_rate_audit_log (trade_id, action, actor_id, actor_name, details)
    values (p_trade_id, 'rate_change', auth.uid(), v_actor,
            v_cell || ' = ' || round((v_rate->>'hourly_rate')::numeric, 2) ||
            ' AED/h effective ' || v_eff ||
            case when v_cap is not null then ' (until ' || v_cap || ')' else '' end);
  end loop;
end; $$;

-- Explicit trade/role change with an effective date (also used by the form).
create or replace function public.assign_employee_trade(
  p_employee_id uuid, p_trade_id uuid, p_salary_role text,
  p_effective_date date default null
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_eff date := coalesce(p_effective_date, (now() at time zone 'Asia/Dubai')::date);
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;
  if p_salary_role not in ('standard','team_leader','supervisor') then
    raise exception 'Invalid salary role';
  end if;
  if not exists (select 1 from public.employee where id = p_employee_id) then
    raise exception 'Employee not found';
  end if;

  perform public.apply_employee_assignment(p_employee_id, p_trade_id, p_salary_role, v_eff);

  if p_trade_id is not null then
    update public.employee set trade_id = p_trade_id, salary_role = p_salary_role, updated_at = now()
      where id = p_employee_id;
  else
    update public.employee set trade_id = null, updated_at = now() where id = p_employee_id;
  end if;
end; $$;

-- Internal: replace the assignment effective from p_eff.
--   • an assignment starting exactly on p_eff is replaced (same-day re-assignment)
--   • a strictly future-scheduled assignment caps the new one (it wins from its date)
--   • the currently open assignment is closed the day before p_eff
--   • p_trade_id null → the history just ends (trade removed)
create or replace function public.apply_employee_assignment(
  p_employee_id uuid, p_trade_id uuid, p_salary_role text, p_eff date
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_cap date;
begin
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

-- ---------------------------------------------------------------------------
-- 10. WIRE TRADES INTO create_employee / update_employee
--     (first assignment from the join date; changes close the old assignment)
-- ---------------------------------------------------------------------------
create or replace function public.create_employee(p_employee jsonb)
returns public.employee language plpgsql
security definer set search_path = public
as $$
declare result public.employee;
-- tolerate double-encoded payloads: an app build that sent JSON.stringify(p_employee)
-- delivers a jsonb STRING — unwrap it once, up front, so every `->>` below works
-- (declare defaults run before the body, so the unwrap must live HERE)
declare v_payload jsonb := case when jsonb_typeof(p_employee) = 'string'
                                 then (p_employee #>> '{}')::jsonb else p_employee end;
declare v_site uuid := nullif(v_payload->>'current_site_id','');
declare v_camp uuid := nullif(v_payload->>'camp_id','');
declare v_block text := nullif(btrim(coalesce(v_payload->>'camp_block','')), '');
declare v_room  text := nullif(btrim(coalesce(v_payload->>'camp_room','')), '');
declare v_leader_site uuid := nullif(v_payload->>'team_leader_site_id','');
declare v_is_leader boolean := coalesce((v_payload->>'is_team_leader')::boolean, false);
-- historical opening balance: blank / missing / null → 0 (new employees)
declare v_opening numeric := coalesce(nullif(v_payload->>'opening_hours','')::numeric, 0);
-- manual employee ID: use it as-is; blank → auto-generate (PUL-YYYY-NNN)
declare v_code text := nullif(btrim(coalesce(v_payload->>'employee_code','')), '');
declare v_trade uuid := nullif(v_payload->>'trade_id','');
declare v_role text := coalesce(nullif(v_payload->>'salary_role',''), 'standard');
declare conflicting public.employee;
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;

  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'Invalid employee payload — expected a JSON object';
  end if;
  if coalesce(btrim(v_payload->>'full_name'), '') = '' then
    raise exception 'Full name is required';
  end if;
  if v_role not in ('standard','team_leader','supervisor') then
    raise exception 'Invalid salary role';
  end if;
  if v_trade is not null and not exists (select 1 from public.trades where id = v_trade and is_active) then
    raise exception 'The selected trade does not exist or is inactive';
  end if;

  if v_code is not null then
    select * into conflicting from public.employee
      where lower(employee_code) = lower(v_code) limit 1;
    if conflicting.id is not null then
      raise exception 'Employee ID "%" is already taken by % — use another ID or leave it blank to auto-generate', v_code, conflicting.full_name;
    end if;
  end if;

  if v_site is not null and not exists (select 1 from public.site where id = v_site and is_active) then
    raise exception 'The selected site does not exist or is inactive';
  end if;
  if v_camp is not null and not exists (select 1 from public.camp where id = v_camp and is_active) then
    raise exception 'The selected camp does not exist or is inactive';
  end if;
  if v_camp is null then
    v_block := null;
    v_room := null;
  end if;

  if v_opening < 0 or v_opening <> v_opening then
    raise exception 'Previous working hours cannot be negative';
  end if;
  if v_opening > 9999999999.99 then
    raise exception 'Previous working hours are unrealistically large';
  end if;

  if v_is_leader and v_leader_site is not null then
    select * into conflicting from public.employee
      where is_team_leader and team_leader_site_id = v_leader_site and status <> 'deleted' limit 1;
    if conflicting.id is not null then
      raise exception 'Another employee (%) is already the team leader of this site', conflicting.full_name;
    end if;
  end if;

  insert into public.employee (
    full_name, employee_code, nationality, date_of_birth, phone, email, address,
    emergency_contact, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, rating, status, photo, is_team_leader, team_leader_site_id,
    camp_id, camp_block, camp_room, opening_hours, trade_id, salary_role
  ) values (
    btrim(v_payload->>'full_name'), coalesce(v_code, public.next_employee_code()),
    nullif(v_payload->>'nationality',''), (v_payload->>'date_of_birth')::date,
    nullif(v_payload->>'phone',''), nullif(v_payload->>'email',''), nullif(v_payload->>'address',''),
    nullif(v_payload->>'emergency_contact',''), nullif(v_payload->>'position',''),
    (v_payload->>'join_date')::date, nullif(v_payload->>'company_name',''),
    nullif(v_payload->>'passport_number',''), nullif(v_payload->>'passport_status',''),
    nullif(v_payload->>'id_number',''), nullif(v_payload->>'id_status',''),
    v_site, 5.0, 'active', nullif(v_payload->>'photo',''), v_is_leader, v_leader_site, v_camp,
    v_block, v_room, round(v_opening, 2), v_trade, v_role
  ) returning * into result;

  -- first salary assignment runs from the join date (or today when unknown)
  if v_trade is not null then
    insert into public.employee_salary_assignment (employee_id, trade_id, salary_role, effective_from, created_by)
    values (result.id, v_trade, v_role,
            coalesce(result.join_date, (now() at time zone 'Asia/Dubai')::date), auth.uid());
  end if;

  return result;
end; $$;

create or replace function public.update_employee(p_id uuid, p_employee jsonb, p_effective_date date default null)
returns public.employee language plpgsql
security definer set search_path = public
as $$
declare result public.employee;
-- tolerate double-encoded payloads (see create_employee)
declare v_payload jsonb := case when jsonb_typeof(p_employee) = 'string'
                                 then (p_employee #>> '{}')::jsonb else p_employee end;
declare v_site uuid := nullif(v_payload->>'current_site_id','');
declare v_camp uuid := nullif(v_payload->>'camp_id','');
declare v_block text := nullif(btrim(coalesce(v_payload->>'camp_block','')), '');
declare v_room  text := nullif(btrim(coalesce(v_payload->>'camp_room','')), '');
declare v_leader_site uuid := nullif(v_payload->>'team_leader_site_id','');
declare v_is_leader boolean := coalesce((v_payload->>'is_team_leader')::boolean, false);
declare v_opening numeric := nullif(v_payload->>'opening_hours','')::numeric;
declare v_trade uuid := nullif(v_payload->>'trade_id','');
declare v_role text := coalesce(nullif(v_payload->>'salary_role',''), 'standard');
declare v_prev_site uuid;
declare v_prev_opening numeric;
declare v_prev_trade uuid;
declare v_prev_role text;
declare v_eff date := coalesce(p_effective_date, (now() at time zone 'Asia/Dubai')::date);
declare conflicting public.employee;
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;

  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'Invalid employee payload — expected a JSON object';
  end if;
  if v_role not in ('standard','team_leader','supervisor') then
    raise exception 'Invalid salary role';
  end if;
  if v_trade is not null and not exists (select 1 from public.trades where id = v_trade) then
    raise exception 'The selected trade does not exist';
  end if;

  if v_site is not null and not exists (select 1 from public.site where id = v_site and is_active) then
    raise exception 'The selected site does not exist or is inactive';
  end if;
  if v_camp is not null and not exists (select 1 from public.camp where id = v_camp and is_active) then
    raise exception 'The selected camp does not exist or is inactive';
  end if;
  if v_camp is null then
    v_block := null;
    v_room := null;
  end if;

  if v_is_leader and v_leader_site is not null then
    select * into conflicting from public.employee
      where is_team_leader and team_leader_site_id = v_leader_site
        and status <> 'deleted' and id <> p_id limit 1;
    if conflicting.id is not null then
      raise exception 'Another employee (%) is already the team leader of this site', conflicting.full_name;
    end if;
  end if;

  select current_site_id, opening_hours, trade_id, salary_role
    into v_prev_site, v_prev_opening, v_prev_trade, v_prev_role
  from public.employee where id = p_id;

  if v_opening is not null then
    if v_opening < 0 or v_opening <> v_opening then
      raise exception 'Previous working hours cannot be negative';
    end if;
    if v_opening > 9999999999.99 then
      raise exception 'Previous working hours are unrealistically large';
    end if;
    if v_opening <> v_prev_opening and not public.is_super_admin() then
      raise exception 'Only super admins can adjust the historical opening balance';
    end if;
  end if;

  update public.employee set
    full_name         = coalesce(nullif(btrim(coalesce(v_payload->>'full_name','')), ''), public.employee.full_name),
    nationality       = nullif(v_payload->>'nationality',''),
    date_of_birth     = (v_payload->>'date_of_birth')::date,
    phone             = nullif(v_payload->>'phone',''),
    email             = nullif(v_payload->>'email',''),
    address           = nullif(v_payload->>'address',''),
    emergency_contact = nullif(v_payload->>'emergency_contact',''),
    position          = nullif(v_payload->>'position',''),
    join_date         = (v_payload->>'join_date')::date,
    company_name      = nullif(v_payload->>'company_name',''),
    passport_number   = nullif(v_payload->>'passport_number',''),
    passport_status   = nullif(v_payload->>'passport_status',''),
    id_number         = nullif(v_payload->>'id_number',''),
    id_status         = nullif(v_payload->>'id_status',''),
    current_site_id   = v_site,
    camp_id           = v_camp,
    camp_block        = v_block,
    camp_room         = v_room,
    photo             = nullif(v_payload->>'photo',''),
    is_team_leader    = v_is_leader,
    team_leader_site_id = case when v_is_leader then v_leader_site else null end,
    opening_hours     = coalesce(round(v_opening, 2), public.employee.opening_hours),
    trade_id          = v_trade,
    salary_role       = v_role,
    updated_at        = now()
  where id = p_id returning * into result;

  -- log the site move (site → site, site → idle, idle → site)
  if v_prev_site is distinct from v_site then
    insert into public.site_transfer (employee_id, from_site_id, to_site_id, effective_date)
    values (p_id, v_prev_site, v_site, v_eff);
  end if;

  -- trade / salary-role change → replace the assignment from the effective
  -- date (old work keeps the old classification)
  if v_prev_trade is distinct from v_trade or v_prev_role is distinct from v_role then
    perform public.apply_employee_assignment(p_id, v_trade, v_role, v_eff);
  end if;

  return result;
end; $$;

-- ---------------------------------------------------------------------------
-- 11. DEFAULT PERMISSIONS for the two new menus (trade_management,
--     salary_sheet): admins get NO access until a super admin grants it —
--     they are financial menus. Super admins always pass has_menu_permission.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 12. REALTIME — publish the new tables so the UI refreshes live
--     (each statement is individually idempotent)
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.trades;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.trade_rate_history;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.employee_salary_assignment;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.payroll_period;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.payroll_employee;
exception when duplicate_object then null; end $$;
