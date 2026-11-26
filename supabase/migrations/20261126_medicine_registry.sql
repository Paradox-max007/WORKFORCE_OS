-- ============================================================================
-- 20261126 — MEDICINE REGISTRY (new sidebar menu, controlled access)
-- ----------------------------------------------------------------------------
-- Basic medicines handed to employees:
--   • public.medicine        — the stock list (name, rate per tablet, quantity
--                              available, active switch)
--   • public.medicine_record — every dispense: employee, DATE + TIME taken,
--                              item lines (snapshots), total amount, paid flag
--
-- PAYMENT / DEDUCTION RULE:
--   • paid at the counter  → paid = true, paid_at set — payroll is never
--                            touched (no deduction at all)
--   • not paid             → the total deducts from the employee's COMING
--                            salary: the dispense month's settlement while it
--                            is still unpaid, otherwise next month's. The
--                            amount is folded into that month's payroll
--                            DEDUCTION column by medicine_deduction_sync_
--                            period (payroll_employee.medicine_deduction_
--                            applied tracks the folded part — the same pattern
--                            the Advance Book uses for the Advance column).
--                            The Payroll page shows it with a MED tag;
--                            clicking the tag opens the medicine record.
--   • Derived status (can never drift): cleared = the cut month's salary was
--     PAID with the record folded in (applied_amount > 0). Cleared records are
--     history — they cannot be marked paid or deleted afterwards.
--
-- Access: has_menu_permission('medicine_registry') — a new super-admin
-- toggle, default OFF (controlled access, like every financial menu).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.medicine (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  rate_per_tablet    numeric(12,2) not null check (rate_per_tablet >= 0),
  quantity_available int not null default 0 check (quantity_available >= 0),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_medicine_name on public.medicine(name);

create table if not exists public.medicine_record (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employee(id) on delete cascade,
  -- date AND time the employee took the medicines
  dispensed_at   timestamptz not null default now(),
  -- snapshot lines: [{medicine_id, medicine_name, rate_per_tablet, quantity, amount}]
  items          jsonb not null,
  total_amount   numeric(12,2) not null check (total_amount >= 0),
  paid           boolean not null default false,
  paid_at        timestamptz,
  -- salary month an UNPAID record deducts from (null when paid)
  cut_year       int check (cut_year is null or cut_year between 2000 and 2100),
  cut_month      int check (cut_month is null or cut_month between 1 and 12),
  -- how much of this record currently sits inside the cut month's Deduction
  applied_amount numeric(12,2) not null default 0,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists idx_medicine_record_employee on public.medicine_record(employee_id);
create index if not exists idx_medicine_record_cut on public.medicine_record(cut_year, cut_month);

alter table public.medicine         enable row level security;
alter table public.medicine_record  enable row level security;

-- reads mirror warning / fine / termination_letter (writes go through the
-- security-definer RPCs below)
drop policy if exists medicine_select on public.medicine;
create policy medicine_select on public.medicine
  for select using (public.is_staff());
drop policy if exists medicine_record_select on public.medicine_record;
create policy medicine_record_select on public.medicine_record
  for select using (public.is_staff());

do $$ begin
  alter publication supabase_realtime add table public.medicine;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.medicine_record;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. payroll_employee.medicine_deduction_applied — how much of the stored
--    deduction was contributed by UNPAID medicine records scheduled for THIS
--    period (advance_book_applied's twin for the Deduction column)
-- ---------------------------------------------------------------------------
alter table public.payroll_employee
  add column if not exists medicine_deduction_applied numeric(12,2) not null default 0;

-- ---------------------------------------------------------------------------
-- 3. medicine_deduction_sync_period — recompute the medicine part of one
--    month's Deduction columns (mirrors advance_book_sync_period)
-- ---------------------------------------------------------------------------
create or replace function public.medicine_deduction_sync_period(p_year int, p_month int)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_period public.payroll_period;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll')
     and not public.has_menu_permission('medicine_registry') then
    raise exception 'Access denied';
  end if;

  select * into v_period from public.payroll_period
  where year = p_year and month = p_month;
  if v_period.id is null then return; end if;

  -- (a) rows whose records were paid / deleted / moved away: drop the old
  --     medicine part (clamped at 0 so the deduction >= 0 constraint can
  --     never fire)
  update public.payroll_employee pe set
    deduction = greatest(0, round(pe.deduction - pe.medicine_deduction_applied, 2)),
    medicine_deduction_applied = 0,
    net_salary = pe.gross_salary
                   - pe.advance
                   - greatest(0, round(pe.deduction - pe.medicine_deduction_applied, 2))
                   - pe.absent_deduction,
    updated_at = now()
  where pe.payroll_period_id = v_period.id
    and pe.payment_status <> 'paid'
    and pe.medicine_deduction_applied <> 0
    and not exists (
      select 1 from public.medicine_record mr
      where mr.employee_id = pe.employee_id
        and mr.paid = false
        and mr.cut_year = p_year and mr.cut_month = p_month);

  -- (b) rows with scheduled records: set / refresh the medicine part (idempotent)
  update public.payroll_employee pe set
    deduction = greatest(0, round(pe.deduction - pe.medicine_deduction_applied + v_sum.med_sum, 2)),
    medicine_deduction_applied = v_sum.med_sum,
    net_salary = pe.gross_salary
                   - pe.advance
                   - greatest(0, round(pe.deduction - pe.medicine_deduction_applied + v_sum.med_sum, 2))
                   - pe.absent_deduction,
    updated_at = now()
  from (
    select mr.employee_id, round(sum(mr.total_amount), 2) as med_sum
    from public.medicine_record mr
    where mr.paid = false and mr.cut_year = p_year and mr.cut_month = p_month
    group by mr.employee_id
  ) v_sum
  where pe.payroll_period_id = v_period.id
    and pe.employee_id = v_sum.employee_id
    and pe.payment_status <> 'paid'
    and pe.medicine_deduction_applied is distinct from v_sum.med_sum;

  -- (b2) per-record markers: every unpaid record scheduled for this month
  --      whose row exists and is UNPAID counts as folded in (full amount
  --      inside the Deduction column). Records of PAID rows keep their frozen
  --      marker — that is exactly what distinguishes "recovered by the paid
  --      salary" from "added after the payment" (cleared vs due).
  update public.medicine_record mr set
    applied_amount = round(mr.total_amount, 2)
  where mr.paid = false and mr.cut_year = p_year and mr.cut_month = p_month
    and exists (
      select 1 from public.payroll_employee pe
      where pe.payroll_period_id = v_period.id
        and pe.employee_id = mr.employee_id
        and pe.payment_status <> 'paid')
    and mr.applied_amount is distinct from round(mr.total_amount, 2);

  -- (b3) markers of records whose payroll row DISAPPEARED (regeneration
  --      dropped the employee) drop back to 0 → the record is due again.
  --      PAID rows never land here — their markers stay frozen as the
  --      "recovered by that salary" evidence (the cleared status).
  update public.medicine_record mr set
    applied_amount = 0
  where mr.applied_amount <> 0
    and mr.cut_year = p_year and mr.cut_month = p_month
    and not exists (
      select 1 from public.payroll_employee pe
      where pe.payroll_period_id = v_period.id
        and pe.employee_id = mr.employee_id);
end; $$;

-- ---------------------------------------------------------------------------
-- 4. save_medicine — add / edit a stock entry
--    payload: { id?, name, rate_per_tablet, quantity_available, is_active? }
-- ---------------------------------------------------------------------------
create or replace function public.save_medicine(p_payload jsonb)
returns public.medicine language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_id uuid := nullif(p_payload->>'id', '')::uuid;
  v_name text := btrim(coalesce(p_payload->>'name', ''));
  v_rate numeric := (p_payload->>'rate_per_tablet')::numeric;
  v_qty int := (p_payload->>'quantity_available')::int;
  v_active boolean := nullif(p_payload->>'is_active', '')::boolean;
  v_med public.medicine;
begin
  if not public.has_menu_permission('medicine_registry') then
    raise exception 'Access denied';
  end if;
  if v_name is null or length(v_name) = 0 then
    raise exception 'Medicine name is required';
  end if;
  if v_rate is null or v_rate < 0 then
    raise exception 'Rate per tablet must be 0 or more';
  end if;
  if v_qty is null or v_qty < 0 then
    raise exception 'Quantity available must be 0 or more';
  end if;

  if exists (select 1 from public.medicine
             where lower(name) = lower(v_name) and id is distinct from v_id) then
    raise exception '"%" already exists in the stock list', v_name;
  end if;

  if v_id is not null then
    update public.medicine set
      name = v_name,
      rate_per_tablet = round(v_rate, 2),
      quantity_available = v_qty,
      is_active = coalesce(v_active, public.medicine.is_active),
      updated_at = now()
    where id = v_id
    returning * into v_med;
    if v_med.id is null then raise exception 'Medicine not found'; end if;
    return v_med;
  end if;

  insert into public.medicine (name, rate_per_tablet, quantity_available, is_active)
  values (v_name, round(v_rate, 2), v_qty, coalesce(v_active, true))
  returning * into v_med;
  return v_med;
end; $$;

-- ---------------------------------------------------------------------------
-- 5. delete_medicine — remove a stock entry (records keep their snapshots)
-- ---------------------------------------------------------------------------
create or replace function public.delete_medicine(p_id uuid)
returns void language plpgsql volatile
security definer set search_path = public
as $$
begin
  if not public.has_menu_permission('medicine_registry') then
    raise exception 'Access denied';
  end if;
  if not exists (select 1 from public.medicine where id = p_id) then
    raise exception 'Medicine not found';
  end if;
  delete from public.medicine where id = p_id;
end; $$;

-- ---------------------------------------------------------------------------
-- 6. dispense_medicine — record medicines handed to an employee
--    payload: { employee_id, items: [{medicine_id, quantity}], paid,
--               dispensed_at? }
--    • validates every line (active medicine, quantity ≥ 1, in stock)
--    • decrements the stock, stores item SNAPSHOT lines + the total
--    • paid  → payroll untouched
--      unpaid → cut month = the dispense month while its settlement is
--      unpaid, else next month; the amount is folded into that month's
--      Deduction column by the sync
--    • returns the new record (joined with the employee, derived status)
-- ---------------------------------------------------------------------------
create or replace function public.dispense_medicine(p_payload jsonb)
returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_emp public.employee;
  v_items jsonb := p_payload->'items';
  v_paid boolean := coalesce((p_payload->>'paid')::boolean, false);
  v_dispensed_at timestamptz := coalesce(nullif(p_payload->>'dispensed_at', '')::timestamptz, now());
  v_actor text;
  v_line jsonb;
  v_med public.medicine;
  v_qty int;
  v_amount numeric;
  v_out_items jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_cut_year int;
  v_cut_month int;
  v_month_paid boolean;
  v_next_month date;
  v_period_id uuid;
  v_items_text text;
  v_rec public.medicine_record;
begin
  if not public.has_menu_permission('medicine_registry') then
    raise exception 'Access denied';
  end if;

  select * into v_emp from public.employee
  where id = (p_payload->>'employee_id')::uuid and status <> 'deleted';
  if v_emp.id is null then raise exception 'Employee not found'; end if;
  if v_emp.status = 'cancelled' then
    raise exception 'This employee is cancelled — restore them before dispensing medicines';
  end if;

  if v_items is null or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'Select at least one medicine';
  end if;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();

  -- validate + snapshot every line BEFORE touching the stock
  for i in 0 .. jsonb_array_length(v_items) - 1 loop
    v_line := v_items->i;
    select * into v_med from public.medicine where id = (v_line->>'medicine_id')::uuid;
    if v_med.id is null or not v_med.is_active then
      raise exception 'Medicine not found or inactive';
    end if;
    v_qty := (v_line->>'quantity')::int;
    if v_qty is null or v_qty < 1 then
      raise exception 'Enter how many % the employee takes', v_med.name;
    end if;
    if v_qty > v_med.quantity_available then
      raise exception 'Only % × % left in stock', v_med.quantity_available, v_med.name;
    end if;
    v_amount := round(v_med.rate_per_tablet * v_qty, 2);
    v_out_items := v_out_items || jsonb_build_object(
      'medicine_id', v_med.id, 'medicine_name', v_med.name,
      'rate_per_tablet', v_med.rate_per_tablet, 'quantity', v_qty, 'amount', v_amount);
    v_total := v_total + v_amount;
  end loop;
  v_total := round(v_total, 2);

  -- COMING SALARY: the dispense month's settlement while it is still unpaid —
  -- a paid settlement can never absorb it, so roll to the next month
  v_cut_year  := extract(year  from (v_dispensed_at at time zone 'Asia/Dubai'))::int;
  v_cut_month := extract(month from (v_dispensed_at at time zone 'Asia/Dubai'))::int;
  if not v_paid then
    select coalesce((
      select pe.payment_status = 'paid'
      from public.payroll_period p
      join public.payroll_employee pe
        on pe.payroll_period_id = p.id and pe.employee_id = v_emp.id
      where p.year = v_cut_year and p.month = v_cut_month
    ), false) into v_month_paid;
    if v_month_paid then
      select (make_date(v_cut_year, v_cut_month, 1) + interval '1 month')::date into v_next_month;
      v_cut_year  := extract(year  from v_next_month)::int;
      v_cut_month := extract(month from v_next_month)::int;
    end if;
  end if;

  -- decrement the stock
  for i in 0 .. jsonb_array_length(v_items) - 1 loop
    v_line := v_items->i;
    update public.medicine set
      quantity_available = quantity_available - ((v_line->>'quantity')::int),
      updated_at = now()
    where id = (v_line->>'medicine_id')::uuid;
  end loop;

  insert into public.medicine_record
    (employee_id, dispensed_at, items, total_amount, paid, paid_at,
     cut_year, cut_month, created_by)
  values
    (v_emp.id, v_dispensed_at, v_out_items, v_total, v_paid,
     case when v_paid then now() end,
     case when v_paid then null else v_cut_year  end,
     case when v_paid then null else v_cut_month end,
     auth.uid())
  returning * into v_rec;

  if not v_paid then
    perform public.medicine_deduction_sync_period(v_cut_year, v_cut_month);
  end if;

  -- audit trail (the cut month's period when one exists)
  select id into v_period_id from public.payroll_period
  where year = v_rec.cut_year and month = v_rec.cut_month;
  select string_agg(format('%s ×%s', x->>'medicine_name', x->>'quantity'), ', ')
  into v_items_text from jsonb_array_elements(v_rec.items) x;
  insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
  values (v_period_id, 'medicine_add', auth.uid(), v_actor,
          'Medicine: ' || v_items_text || ' given to ' || coalesce(v_emp.full_name, 'Unknown employee')
          || ' (' || coalesce(v_emp.employee_code, '—') || ') — '
          || round(v_rec.total_amount, 2)
          || case when v_rec.paid then ' paid at the counter'
                  else ' UNPAID → deducts from the '
                       || to_char(make_date(v_rec.cut_year, v_rec.cut_month, 1), 'TMMonth YYYY')
                       || ' salary (MED tag)' end);

  return jsonb_build_object(
    'id', v_rec.id,
    'employee_id', v_rec.employee_id,
    'employee_name', v_emp.full_name,
    'employee_code', v_emp.employee_code,
    'photo', v_emp.photo,
    'dispensed_at', v_rec.dispensed_at,
    'items', v_rec.items,
    'total_amount', v_rec.total_amount,
    'paid', v_rec.paid,
    'paid_at', v_rec.paid_at,
    'cut_year', v_rec.cut_year,
    'cut_month', v_rec.cut_month,
    'applied_amount', v_rec.applied_amount,
    'cleared', false,
    'cleared_at', null,
    'created_by_name', v_actor,
    'created_at', v_rec.created_at);
end; $$;

-- ---------------------------------------------------------------------------
-- 7. set_medicine_record_paid — the employee paid later: removes the pending
--    salary deduction (the sync re-folds the cut month without this record).
--    Cleared records (already recovered by a PAID salary) are refused.
-- ---------------------------------------------------------------------------
create or replace function public.set_medicine_record_paid(p_id uuid)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare v_rec public.medicine_record;
begin
  if not public.has_menu_permission('medicine_registry') then
    raise exception 'Access denied';
  end if;
  select * into v_rec from public.medicine_record where id = p_id;
  if v_rec.id is null then raise exception 'Medicine record not found'; end if;
  if v_rec.paid then return; end if;

  if exists (
    select 1 from public.payroll_period p
    join public.payroll_employee pe
      on pe.payroll_period_id = p.id and pe.employee_id = v_rec.employee_id
    where p.year = v_rec.cut_year and p.month = v_rec.cut_month
      and pe.payment_status = 'paid'
      and v_rec.applied_amount > 0) then
    raise exception 'This amount was already deducted from the paid % % salary — it cannot be marked paid afterwards',
      to_char(make_date(v_rec.cut_year, v_rec.cut_month, 1), 'TMMonth'), v_rec.cut_year;
  end if;

  update public.medicine_record set
    paid = true, paid_at = now(), cut_year = null, cut_month = null, applied_amount = 0
  where id = p_id;

  perform public.medicine_deduction_sync_period(v_rec.cut_year, v_rec.cut_month);
end; $$;

-- ---------------------------------------------------------------------------
-- 8. delete_medicine_record — annul a dispense that was never recovered by a
--    paid salary: restores the stock and removes the pending deduction.
--    Cleared records are kept as history.
-- ---------------------------------------------------------------------------
create or replace function public.delete_medicine_record(p_id uuid)
returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_rec public.medicine_record;
  v_line jsonb;
begin
  if not public.has_menu_permission('medicine_registry') then
    raise exception 'Access denied';
  end if;
  select * into v_rec from public.medicine_record where id = p_id;
  if v_rec.id is null then raise exception 'Medicine record not found'; end if;

  if exists (
    select 1 from public.payroll_period p
    join public.payroll_employee pe
      on pe.payroll_period_id = p.id and pe.employee_id = v_rec.employee_id
    where p.year = v_rec.cut_year and p.month = v_rec.cut_month
      and pe.payment_status = 'paid'
      and v_rec.applied_amount > 0) then
    raise exception 'This amount was already deducted from the paid % % salary — cleared records are kept as history',
      to_char(make_date(v_rec.cut_year, v_rec.cut_month, 1), 'TMMonth'), v_rec.cut_year;
  end if;

  -- restore the stock (the dispense is annulled)
  for v_line in select * from jsonb_array_elements(v_rec.items) loop
    update public.medicine set
      quantity_available = quantity_available + (v_line->>'quantity')::int,
      updated_at = now()
    where id = (v_line->>'medicine_id')::uuid;
  end loop;

  delete from public.medicine_record where id = p_id;
  perform public.medicine_deduction_sync_period(v_rec.cut_year, v_rec.cut_month);
end; $$;

-- ---------------------------------------------------------------------------
-- 9. list_medicine_records — the full history, newest first, with employee
--    names + DERIVED status. Normal admins only see the records of employees
--    working at one of their GRANTED sites (direct assignments + branch
--    sites), mirroring the demo scoping / the Advance Book philosophy.
-- ---------------------------------------------------------------------------
create or replace function public.list_medicine_records()
returns jsonb language sql stable
security definer set search_path = public
as $$
  select coalesce(jsonb_agg(payload order by dispensed_at desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
        'id', r.id, 'employee_id', r.employee_id,
        'employee_name', e.full_name, 'employee_code', e.employee_code,
        'photo', e.photo,
        'dispensed_at', r.dispensed_at,
        'items', r.items,
        'total_amount', r.total_amount,
        'paid', r.paid, 'paid_at', r.paid_at,
        'cut_year', r.cut_year, 'cut_month', r.cut_month,
        'applied_amount', r.applied_amount,
        'cleared', (coalesce(pe.payment_status, '') = 'paid' and r.applied_amount > 0),
        'cleared_at', case when coalesce(pe.payment_status, '') = 'paid' and r.applied_amount > 0
                           then pe.paid_at end,
        'created_by_name', (select coalesce(name, email) from public.profiles where id = r.created_by),
        'created_at', r.created_at
      ) as payload,
      r.dispensed_at as dispensed_at
    from public.medicine_record r
    join public.employee e on e.id = r.employee_id
    left join public.payroll_period p on p.year = r.cut_year and p.month = r.cut_month
    left join public.payroll_employee pe
      on pe.payroll_period_id = p.id and pe.employee_id = r.employee_id
    where public.is_super_admin() or (
      e.current_site_id is not null and (
        e.current_site_id in (select site_id from public.admin_site where profile_id = auth.uid())
        or e.current_site_id in (
          select s.id from public.site s
          where s.branch_id in (select branch_id from public.admin_branch where profile_id = auth.uid()))
      ))
  ) rows;
$$;

-- ---------------------------------------------------------------------------
-- 10. generate_payroll_period v2 — 20261113e's body plus the medicine sync
--     at the end, so records scheduled for a month that had no payroll yet
--     fold into the Deduction column when that month is generated
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

  -- fold UNPAID medicine records scheduled for this month into the Deduction
  perform public.medicine_deduction_sync_period(p_year, p_month);

  return jsonb_build_object('id', v_period.id, 'year', v_period.year,
    'month', v_period.month, 'status', v_period.status);
end; $$;

-- ---------------------------------------------------------------------------
-- 11. grants (same blanket pattern as the base schema)
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
