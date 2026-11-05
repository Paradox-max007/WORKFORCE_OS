-- ============================================================================
-- PULSE Workforce OS — 20261105c: Manpower companies (own table)
-- ----------------------------------------------------------------------------
-- The Add / Edit Employee form's "Company Name" becomes a dropdown fed by a
-- dedicated `company` table (with an inline "+ Add New Company…" option in the
-- UI). Employees keep storing the company NAME in employee.company_name —
-- no employee-table migration is needed; the table is the dropdown source.
--
--   1. company table (id, name, created_at) + unique name
--   2. RLS: every staff member can read; employee editors can create
--   3. create_company RPC (permission-checked, duplicate-safe)
--   4. seed from the distinct company names already on employees
--   5. realtime publication
-- ============================================================================

create table if not exists public.company (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

alter table public.company enable row level security;

drop policy if exists company_select on public.company;
create policy company_select on public.company for select using (public.is_staff());

drop policy if exists company_insert on public.company;
create policy company_insert on public.company for insert with check (public.has_menu_permission('employees'));

-- ---------------------------------------------------------------------------
-- create_company — used by the "+ Add New Company…" flow in the employee form
-- ---------------------------------------------------------------------------
create or replace function public.create_company(p_name text)
returns public.company language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_company public.company;
begin
  if not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Company name is required';
  end if;
  if exists (select 1 from public.company where lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A company named "%" already exists', btrim(p_name);
  end if;

  insert into public.company (name)
  values (btrim(p_name))
  returning * into v_company;

  return v_company;
end; $$;

-- ---------------------------------------------------------------------------
-- Seed — every distinct company already used by an employee becomes a row
-- ---------------------------------------------------------------------------
insert into public.company (name)
select distinct company_name
from public.employee
where coalesce(btrim(company_name), '') <> ''
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Realtime — publish so open forms refresh when a company is added
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.company;
exception when duplicate_object then null; end $$;
