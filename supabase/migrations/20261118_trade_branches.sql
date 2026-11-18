-- ============================================================================
-- 20261118 — BRANCH-OWNED TRADE BOOKS + BRANCH-SCOPED LEDGERS
-- ----------------------------------------------------------------------------
-- Each branch now owns its OWN trades and rate books: the SAME trade name
-- (e.g. "Electrician") can carry DIFFERENT hourly rates in different branches
-- and can never mix —
--   • trades.branch_id pins a trade (and its whole trade_rate_history grid)
--     to one branch; branch_id NULL = the shared "All Branches" book
--     (super admins only)
--   • the trade NAME is unique per book (shared book or branch), so the same
--     name may exist in many branches, each with its own rates
--   • normal admins only ever SEE the shared book + the trades of their
--     granted branches (list_trades), and can only create / edit / re-price
--     trades inside their granted branches (create_trade, update_trade,
--     update_trade_rates) — the shared book stays super-admin only
--   • a BRANCH-SPECIFIC trade may only be assigned to employees working at
--     a site of the SAME branch (constraint trigger; the shared book fits
--     everyone). A stored trade is never invalidated by a later site move.
--
-- Also: get_advance_book is now BRANCH-SCOPED for normal admins — they only
-- see the advance records of employees working at their granted sites
-- (branch sites + direct admin_site assignments), mirroring the attendance
-- grant model of 20261112b.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The column + the per-book unique name
-- ---------------------------------------------------------------------------
alter table public.trades
  add column if not exists branch_id uuid references public.branch(id) on delete set null;

create index if not exists trades_branch_idx on public.trades (branch_id);

-- the name is now unique PER BOOK (shared book or one branch): coalesce maps
-- the shared book (NULL) onto a sentinel uuid so two shared trades with the
-- same name still clash (plain NULLs would never collide in a unique index)
drop index if exists trades_name_unique_idx;
create unique index if not exists trades_name_branch_unique_idx
  on public.trades (
    lower(trim(name)),
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

comment on column public.trades.branch_id is
  'Owning branch — the trade and its rate book belong to this branch only. NULL = the shared All-Branches book (super admins only).';

-- ---------------------------------------------------------------------------
-- 2. Shared guard — may the caller manage this trade's book?
-- ---------------------------------------------------------------------------
create or replace function public.trade_manage_allowed(p_trade_id uuid)
returns boolean language plpgsql
stable security definer set search_path = public
as $$
declare v_branch uuid;
begin
  if not public.is_staff() then return false; end if;
  if public.is_super_admin() then return true; end if;

  select branch_id into v_branch from public.trades where id = p_trade_id;
  if v_branch is null then
    return false; -- the shared All-Branches book is super-admin only
  end if;

  return exists (
    select 1 from public.admin_branch ab
    where ab.profile_id = auth.uid() and ab.branch_id = v_branch
  );
end; $$;

comment on function public.trade_manage_allowed(uuid) is
  'True when the caller may edit / re-price the trade: super admin, or a normal admin holding the trade''s owning branch (admin_branch). The shared All-Branches book is super-admin only.';

revoke execute on function public.trade_manage_allowed(uuid) from public;
revoke execute on function public.trade_manage_allowed(uuid) from anon;
grant execute on function public.trade_manage_allowed(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. list_trades — branch_id in the payload + grant-scoped rows
-- ---------------------------------------------------------------------------
create or replace function public.list_trades()
returns jsonb language plpgsql stable
security definer set search_path = public
as $$
begin
  -- the employee form's trade dropdown needs this for every staff member
  -- (mirrors the trades_select table policy)
  if not public.is_staff() then raise exception 'Access denied'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'branch_id', t.branch_id,
      'description', t.description,
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
    from public.trades t
    -- BRANCH-OWNED BOOKS: normal admins get the shared All-Branches book plus
    -- the trades of their granted branches — another branch's book (and its
    -- rates) never leaks into their selection
    where public.is_super_admin()
       or t.branch_id is null
       or exists (
         select 1 from public.admin_branch ab
         where ab.profile_id = auth.uid() and ab.branch_id = t.branch_id
       )
  );
end; $$;

-- ---------------------------------------------------------------------------
-- 4. create_trade — p_branch_id + per-book uniqueness + grant check
--    (body = the 20261103 v2 with the 1900-01-01 first-rate backfill)
-- ---------------------------------------------------------------------------
create or replace function public.create_trade(
  p_name text, p_description text default null,
  p_rates jsonb default '[]'::jsonb, p_activate boolean default true,
  p_branch_id uuid default null
) returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_trade public.trades;
  v_actor text;
  v_rate jsonb;
  v_cells int := 0;
begin
  if not public.has_menu_permission('trade_management') then raise exception 'Access denied'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Trade name is required'; end if;

  -- branch ownership: super admins may create the shared book or any branch's
  -- trade; normal admins only inside their granted branches
  if public.is_super_admin() then
    if p_branch_id is not null
       and not exists (select 1 from public.branch where id = p_branch_id) then
      raise exception 'Branch not found';
    end if;
  else
    if p_branch_id is null or not exists (
      select 1 from public.admin_branch ab
      where ab.profile_id = auth.uid() and ab.branch_id = p_branch_id
    ) then
      raise exception 'Pick one of your granted branches for this trade';
    end if;
  end if;

  -- the SAME trade name may exist in DIFFERENT branches (each with its own
  -- rate book) — but never twice within the same book
  if exists (
    select 1 from public.trades
    where lower(trim(name)) = lower(trim(p_name))
      and coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(p_branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) then
    raise exception 'A trade named "%" already exists %',
      btrim(p_name),
      case when p_branch_id is null then 'in the shared All-Branches book'
           else 'in this branch' end;
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

  insert into public.trades (name, description, is_active, branch_id)
  values (btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_activate, false), p_branch_id)
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
          'Trade "' || v_trade.name || '" created with ' || v_cells || ' rate cells'
          || case when v_trade.branch_id is null then ' (All Branches)'
                  else ' (branch: ' || coalesce((select name from public.branch where id = v_trade.branch_id), '?') || ')' end);

  return jsonb_build_object('id', v_trade.id, 'name', v_trade.name,
    'branch_id', v_trade.branch_id, 'is_active', v_trade.is_active);
end; $$;

-- ---------------------------------------------------------------------------
-- 5. update_trade — branch grant + per-book uniqueness + optional branch move
-- ---------------------------------------------------------------------------
create or replace function public.update_trade(
  p_trade_id uuid, p_name text, p_description text default null,
  p_is_active boolean default null,
  p_branch_id uuid default null, p_keep_branch boolean default false
) returns void language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_actor text;
  v_branch uuid;
begin
  if not public.has_menu_permission('trade_management') then raise exception 'Access denied'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Trade name is required'; end if;

  select branch_id into v_branch from public.trades where id = p_trade_id;
  if v_branch is null and not exists (select 1 from public.trades where id = p_trade_id) then
    raise exception 'Trade not found';
  end if;

  -- branch-scoped editing: normal admins only touch their granted branches'
  -- trades — never the shared All-Branches book, never another branch's book
  if not public.trade_manage_allowed(p_trade_id) then
    raise exception 'You can only edit trades of your granted branches';
  end if;

  -- branch move (super admin only; p_keep_branch keeps the current book)
  if not coalesce(p_keep_branch, false) and not public.is_super_admin() then
    raise exception 'Only super admins can move a trade between books';
  end if;
  if not coalesce(p_keep_branch, false) then
    if p_branch_id is not null
       and not exists (select 1 from public.branch where id = p_branch_id) then
      raise exception 'Branch not found';
    end if;
    v_branch := p_branch_id;
  end if;

  -- per-book uniqueness (shared book or one branch)
  if exists (
    select 1 from public.trades
    where lower(trim(name)) = lower(trim(p_name))
      and id <> p_trade_id
      and coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(v_branch, '00000000-0000-0000-0000-000000000000'::uuid)
  ) then
    raise exception 'A trade named "%" already exists %',
      btrim(p_name),
      case when v_branch is null then 'in the shared All-Branches book'
           else 'in this branch' end;
  end if;

  update public.trades set
    name = btrim(p_name),
    description = nullif(btrim(coalesce(p_description, '')), ''),
    is_active = coalesce(p_is_active, public.trades.is_active),
    branch_id = v_branch
  where id = p_trade_id;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  insert into public.trade_rate_audit_log (trade_id, action, actor_id, actor_name, details)
  values (p_trade_id, 'update', auth.uid(), v_actor, 'Trade details updated');
end; $$;

-- ---------------------------------------------------------------------------
-- 6. update_trade_rates — same branch-grant gate (body = 20261103 v2)
-- ---------------------------------------------------------------------------
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
  -- rate books are branch-owned: a normal admin may only re-price the trades
  -- of their granted branches (the shared All-Branches book = super admin only)
  if not public.trade_manage_allowed(p_trade_id) then
    raise exception 'You can only change rates of trades in your granted branches';
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

-- ---------------------------------------------------------------------------
-- 7. Branch-owned employee trades — a branch-specific trade may only sit on
--    an employee whose site belongs to the SAME branch (checked when the
--    trade is ASSIGNED; a later site move never invalidates a stored trade)
-- ---------------------------------------------------------------------------
create or replace function public.employee_trade_branch_check()
returns trigger language plpgsql
security definer set search_path = public
as $$
declare
  v_branch uuid;
begin
  if new.trade_id is null then return new; end if;

  -- only when the trade is being (re)assigned — untouched trades survive
  -- every other employee edit (site moves included)
  if tg_op = 'UPDATE' and new.trade_id is not distinct from old.trade_id then
    return new;
  end if;

  select branch_id into v_branch from public.trades where id = new.trade_id;
  if v_branch is null then
    return new; -- the shared All-Branches book fits every employee
  end if;

  if new.current_site_id is null
     or not exists (
       select 1 from public.site s
       where s.id = new.current_site_id and s.branch_id = v_branch
     ) then
    raise exception 'The selected trade belongs to another branch — pick a trade of this employee''s branch (or the shared All-Branches book)';
  end if;

  return new;
end; $$;

drop trigger if exists trg_employee_trade_branch on public.employee;
create constraint trigger trg_employee_trade_branch
  after insert or update of trade_id, current_site_id on public.employee
  for each row execute function public.employee_trade_branch_check();

-- ---------------------------------------------------------------------------
-- 8. get_advance_book — branch-scoped for normal admins (site grants)
-- ---------------------------------------------------------------------------
create or replace function public.get_advance_book()
returns jsonb language plpgsql stable
security definer set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.has_menu_permission('salary_sheet')
     and not public.has_menu_permission('payroll')
     and not public.has_menu_permission('advance_book') then
    raise exception 'Access denied';
  end if;

  with recs as (
    select r.id, r.employee_id, r.amount, r.given_date,
           r.cut_year, r.cut_month, r.note, r.created_by, r.created_at,
           (r.source_period_id is not null) as from_time_card,
           e.full_name, e.employee_code, e.photo,
           -- DERIVED status — can never drift from the payroll data:
           -- cleared = the cut month's salary is PAID *and* this record was
           -- folded into it (applied_amount > 0). A record added AFTER the
           -- salary was paid never folded in → stays DUE for rescheduling.
           (coalesce(pe.payment_status, '') = 'paid' and r.applied_amount > 0) as cleared,
           pe.paid_at as cleared_at,
           (r.applied_amount > 0) as applied,
           (not (coalesce(pe.payment_status, '') = 'paid' and r.applied_amount > 0)
             and (r.cut_year, r.cut_month)
                 < (extract(year from now())::int, extract(month from now())::int)) as overdue
    from public.advance_record r
    join public.employee e on e.id = r.employee_id
    left join public.payroll_period p on p.year = r.cut_year and p.month = r.cut_month
    left join public.payroll_employee pe
      on pe.payroll_period_id = p.id and pe.employee_id = r.employee_id
    where public.is_super_admin()
       or (
         e.current_site_id is not null
         and public.site_access_allowed(e.current_site_id)
       )
  )
  select jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rec.id, 'employee_id', rec.employee_id,
        'full_name', rec.full_name, 'employee_code', rec.employee_code,
        'photo', rec.photo,
        'amount', rec.amount, 'given_date', rec.given_date,
        'cut_year', rec.cut_year, 'cut_month', rec.cut_month, 'note', rec.note,
        'from_time_card', rec.from_time_card,
        'cleared', rec.cleared,
        'cleared_at', rec.cleared_at,
        'applied', rec.applied,
        'overdue', rec.overdue,
        'created_by_name', (select coalesce(name, email) from public.profiles where id = rec.created_by),
        'created_at', rec.created_at
      ) order by rec.given_date desc, rec.created_at desc)
      from recs rec
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'due_count', count(*) filter (where not cleared),
      'due_amount', round(coalesce(sum(amount) filter (where not cleared), 0), 2),
      'overdue_count', count(*) filter (where not cleared and overdue),
      'overdue_amount', round(coalesce(sum(amount) filter (where not cleared and overdue), 0), 2),
      'cleared_count', count(*) filter (where cleared),
      'cleared_amount', round(coalesce(sum(amount) filter (where cleared), 0), 2)
    )
  )
  into v_result
  from recs;

  return v_result;
end; $$;

revoke execute on function public.create_trade(text, text, jsonb, boolean, uuid) from anon;
revoke execute on function public.update_trade(uuid, text, text, boolean, uuid, boolean) from anon;
