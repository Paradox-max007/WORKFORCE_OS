-- ============================================================================
-- PULSE Workforce OS — 20261105e: payment method + employee sticky notes
-- ----------------------------------------------------------------------------
-- Two features requested for the Payroll / Employees screens:
--
-- 1. PAYMENT METHOD (cash or a payroll card)
--      employee.payment_type   'cash' | 'card' | null  (set from the Employee
--                              Details → Document Details card)
--      employee.card_type_id   → card_type(id)         (required when 'card')
--      card_type table         Lulu Card, C3 Card, …   (grows via "+ Add New")
--      get_salary_sheet now also returns payment_type + card_type per
--      employee row so the Payroll page shows a Payment Method column and a
--      payment filter (All / Cash / each card type / Not set).
--
-- 2. EMPLOYEE NOTES (sticky-note style quick comments)
--      employee_note table — employee-level comments written from the notes
--      icon next to each employee name in the Payroll page. Not tied to a
--      payroll period: quick future reference about the person.
--
-- Everything is idempotent (create or replace / if not exists) — safe to re-run.
-- Demo mode mirrors the same shapes in src/lib/data/demo-store.ts + demo-api.ts.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. card_type table (Lulu Card, C3 Card, …)
-- ---------------------------------------------------------------------------
create table if not exists public.card_type (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

alter table public.card_type enable row level security;

drop policy if exists card_type_select on public.card_type;
create policy card_type_select on public.card_type for select using (public.is_staff());

drop policy if exists card_type_insert on public.card_type;
create policy card_type_insert on public.card_type for insert with check (public.has_menu_permission('employees'));

insert into public.card_type (name)
values ('Lulu Card'), ('C3 Card')
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- 2. employee columns (payment method)
-- ---------------------------------------------------------------------------
alter table public.employee
  add column if not exists payment_type text null check (payment_type in ('cash', 'card'));

alter table public.employee
  add column if not exists card_type_id uuid null;

alter table public.employee drop constraint if exists employee_card_type_fk;
alter table public.employee
  add constraint employee_card_type_fk
  foreign key (card_type_id) references public.card_type(id);

-- ---------------------------------------------------------------------------
-- 3. create_card_type — the "+ Add New Card Type…" flow (details page)
-- ---------------------------------------------------------------------------
create or replace function public.create_card_type(p_name text)
returns public.card_type language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_card public.card_type;
begin
  if not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Card type name is required';
  end if;
  if exists (select 1 from public.card_type where lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A card type named "%" already exists', btrim(p_name);
  end if;

  insert into public.card_type (name)
  values (btrim(p_name))
  returning * into v_card;

  return v_card;
end; $$;

-- ---------------------------------------------------------------------------
-- 4. set_employee_payment_method — Employee Details → Document Details
--    p_payment_type: 'cash' | 'card' | null (null clears the method).
--    'card' requires an existing card type; 'cash'/null drop the card type.
-- ---------------------------------------------------------------------------
create or replace function public.set_employee_payment_method(
  p_employee_id uuid,
  p_payment_type text,
  p_card_type_id uuid default null
)
returns public.employee language plpgsql volatile
security definer set search_path = public
as $$
declare result public.employee;
begin
  if not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;
  if p_payment_type is not null and p_payment_type not in ('cash', 'card') then
    raise exception 'Payment type must be cash or card';
  end if;

  if p_payment_type = 'card' then
    if p_card_type_id is null then
      raise exception 'Select the card type first';
    end if;
    if not exists (select 1 from public.card_type where id = p_card_type_id) then
      raise exception 'The selected card type does not exist';
    end if;
  end if;

  update public.employee set
    payment_type = p_payment_type,
    card_type_id = case when p_payment_type = 'card' then p_card_type_id else null end,
    updated_at   = now()
  where id = p_employee_id
  returning * into result;

  if result.id is null then
    raise exception 'Employee not found';
  end if;
  return result;
end; $$;

-- ---------------------------------------------------------------------------
-- 5. employee_note table (Payroll sticky notes)
-- ---------------------------------------------------------------------------
create table if not exists public.employee_note (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employee(id) on delete cascade,
  note        text not null,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

create index if not exists employee_note_employee_idx on public.employee_note (employee_id, created_at desc);

alter table public.employee_note enable row level security;

drop policy if exists employee_note_select on public.employee_note;
create policy employee_note_select on public.employee_note for select using (public.is_staff());

-- writes go through the permission-checked RPCs below (employees OR payroll
-- menu — the notes icon lives on the Payroll page)

-- ---------------------------------------------------------------------------
-- 6. Employee-note RPCs (list / add / delete)
-- ---------------------------------------------------------------------------
create or replace function public.list_employee_notes()
returns jsonb language sql stable
security definer set search_path = public
as $$
  select coalesce(jsonb_agg(payload order by (payload->>'created_at') desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'id', n.id,
             'employee_id', n.employee_id,
             'note', n.note,
             'author_name', (select coalesce(name, email) from public.profiles where id = n.created_by),
             'created_at', n.created_at
           ) as payload
    from public.employee_note n
  ) notes;
$$;

create or replace function public.add_employee_note(p_employee_id uuid, p_note text)
returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_note public.employee_note;
begin
  if not public.has_menu_permission('employees')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'Note text is required';
  end if;
  if not exists (select 1 from public.employee where id = p_employee_id) then
    raise exception 'Employee not found';
  end if;

  insert into public.employee_note (employee_id, note, created_by)
  values (p_employee_id, btrim(p_note), auth.uid())
  returning * into v_note;

  return jsonb_build_object(
    'id', v_note.id,
    'employee_id', v_note.employee_id,
    'note', v_note.note,
    'author_name', (select coalesce(name, email) from public.profiles where id = v_note.created_by),
    'created_at', v_note.created_at
  );
end; $$;

create or replace function public.delete_employee_note(p_id uuid)
returns void language plpgsql volatile
security definer set search_path = public
as $$
begin
  if not public.has_menu_permission('employees')
     and not public.has_menu_permission('payroll') then
    raise exception 'Access denied';
  end if;
  delete from public.employee_note where id = p_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 7. get_salary_sheet — same function, now also returning payment_type +
--    card_type on every consolidated employee row (Payroll column + filter)
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

-- ---------------------------------------------------------------------------
-- 8. Realtime — publish so open pages refresh when card types / notes change
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.card_type;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.employee_note;
exception when duplicate_object then null; end $$;
