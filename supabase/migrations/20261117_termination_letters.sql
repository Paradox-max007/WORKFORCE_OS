-- ============================================================================
-- 20261117 — TERMINATION LETTERS (Notifications Hub → Letters tab)
-- ----------------------------------------------------------------------------
-- Formal letters & notices issued from the Notifications Hub:
--   • WARNING LETTERS and FINE NOTICES are generated from the existing
--     warning / fine records (no new tables) — see src/lib/notices.ts
--   • TERMINATION LETTERS get their own record type so every issued letter
--     is kept, re-downloadable and attributable:
--
--     public.termination_letter
--       (id, employee_id, reason, effective_date, notice_basis,
--        custom_body, created_by, is_hidden, created_at)
--
--   • create_termination_letter(...) RPC — permission-checked insert +
--     notification for every super admin (mirrors issue_warning)
--   • public.notification.type now also allows 'termination' so the hub's
--     activity strip can carry termination events
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
create table if not exists public.termination_letter (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employee(id) on delete cascade,
  reason         text not null,
  effective_date date not null,
  notice_basis   text not null default 'with_notice'
                 check (notice_basis in ('immediate','with_notice','payment_in_lieu')),
  custom_body    text,              -- free-text letter body; null = standard format
  created_by     uuid references public.profiles(id) on delete set null,
  is_hidden      boolean not null default false,
  created_at     timestamptz not null default now()
);

-- read access mirrors warning/fine (writes go through the RPC below)
drop policy if exists termination_letter_select on public.termination_letter;
create policy termination_letter_select on public.termination_letter
  for select using (public.is_staff());

-- ---------------------------------------------------------------------------
-- 2. RPC — create a termination letter (+ notify super admins)
-- ---------------------------------------------------------------------------
create or replace function public.create_termination_letter(
  p_employee_id    uuid,
  p_reason         text,
  p_effective_date date,
  p_notice_basis   text default 'with_notice',
  p_custom_body    text default null
)
returns public.termination_letter language plpgsql
security definer set search_path = public
as $$
declare result public.termination_letter;
declare emp public.employee;
begin
  if not public.has_menu_permission('notifications') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Reason is required';
  end if;
  if p_effective_date is null then
    raise exception 'Effective date is required';
  end if;
  if p_notice_basis not in ('immediate','with_notice','payment_in_lieu') then
    p_notice_basis := 'with_notice';
  end if;

  select * into emp from public.employee where id = p_employee_id;
  if emp.id is null then raise exception 'Employee not found'; end if;

  insert into public.termination_letter
    (employee_id, reason, effective_date, notice_basis, custom_body, created_by)
  values
    (p_employee_id, p_reason, p_effective_date, p_notice_basis, nullif(trim(coalesce(p_custom_body, '')), ''), auth.uid())
  returning * into result;

  perform public.notify_super_admins('New Termination Letter',
    emp.full_name || ' (' || emp.employee_code || ') — termination letter issued (effective '
    || to_char(p_effective_date, 'YYYY-MM-DD') || '): ' || p_reason, 'termination');
  return result;
end; $$;

-- ---------------------------------------------------------------------------
-- 3. Notification type gains 'termination'
-- ---------------------------------------------------------------------------
alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification
  add constraint notification_type_check
  check (type in ('request','warning','fine','termination'));
