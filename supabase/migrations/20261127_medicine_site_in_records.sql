-- ============================================================================
-- 20261127_medicine_site_in_records.sql
-- ----------------------------------------------------------------------------
-- Dispense records now carry the EMPLOYEE'S SITE (their current site — the
-- same membership the record scoping uses), so the Medicine Registry records
-- list and the shared medicine record dialog (Payroll MED tag included) show
-- WHERE the employee works.
--
--   1. list_medicine_records  → adds 'site_name' (left join site)
--   2. dispense_medicine      → adds 'site_name' to the returned payload
--   3. replica identity full  → realtime UPDATE/DELETE events for the tables
--      these flows write: with RLS enabled and the DEFAULT replica identity,
--      Supabase Realtime cannot evaluate the old row's visibility and simply
--      DROPS UPDATE/DELETE events — which is why an employee moved by the
--      attendance page's Add Employee (update_employee = an UPDATE on
--      public.employee), a stock decrement on public.medicine or a
--      medicine_record mark-paid/delete never reached open pages live.
--      INSERT events were always delivered; these four tables need FULL.
-- ============================================================================

alter table public.employee        replica identity full;
alter table public.medicine        replica identity full;
alter table public.medicine_record replica identity full;
alter table public.payroll_employee replica identity full;

-- ---------------------------------------------------------------------------
-- 1. list_medicine_records — with the employee's site name
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
        'site_name', s.name,
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
    left join public.site s on s.id = e.current_site_id
    left join public.payroll_period p on p.year = r.cut_year and p.month = r.cut_month
    left join public.payroll_employee pe
      on pe.payroll_period_id = p.id and pe.employee_id = r.employee_id
    where public.is_super_admin() or (
      e.current_site_id is not null and (
        e.current_site_id in (select site_id from public.admin_site where profile_id = auth.uid())
        or e.current_site_id in (
          select s2.id from public.site s2
          where s2.branch_id in (select branch_id from public.admin_branch where profile_id = auth.uid()))
      ))
  ) rows;
$$;

-- ---------------------------------------------------------------------------
-- 2. dispense_medicine — return the employee's site name with the new record
--    (full body rewrite: only the return payload changes)
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
    'site_name', (select name from public.site where id = v_emp.current_site_id),
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
-- 3. grants (same blanket pattern as the base schema)
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
