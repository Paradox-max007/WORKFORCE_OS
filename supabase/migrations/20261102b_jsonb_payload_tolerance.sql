-- ============================================================================
-- PULSE Workforce OS — Migration 2026-11-02 (b): jsonb payload tolerance
-- ----------------------------------------------------------------------------
-- Fixes "null value in column \"full_name\" of relation \"employee\" violates
-- not-null constraint" when creating / editing employees (and silently storing
-- a JSON string instead of the items object for uniform entries).
--
-- Root cause: the app used to send jsonb RPC parameters pre-stringified
-- (JSON.stringify). PostgREST binds a JSON string value to a jsonb parameter
-- as a jsonb STRING scalar — so `p_employee->>'full_name'` returned null and
-- the INSERT/UPDATE failed the not-null constraint.
--
-- The app now passes plain objects; these re-created functions ADDITIONALLY
-- unwrap double-encoded string payloads (in the DECLARE section, before any
-- field is extracted), so any older deployed app build keeps working too.
-- Non-object payloads fail with a clear error instead of nulling columns.
--
-- Fully idempotent — safe to run any number of times (matches schema.sql).
-- Run in the Supabase SQL editor (or psql) against the project database.
-- ============================================================================

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
declare conflicting public.employee;
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;

  -- the payload must be a JSON object (after unwrapping) — anything else is a
  -- broken client and must fail loudly instead of silently nulling columns
  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'Invalid employee payload — expected a JSON object';
  end if;

  -- full_name is required — fail with a clear message instead of the raw
  -- not-null constraint error
  if coalesce(btrim(v_payload->>'full_name'), '') = '' then
    raise exception 'Full name is required';
  end if;

  -- manual IDs must be unique (case-insensitive)
  if v_code is not null then
    select * into conflicting from public.employee
      where lower(employee_code) = lower(v_code) limit 1;
    if conflicting.id is not null then
      raise exception 'Employee ID "%" is already taken by % — use another ID or leave it blank to auto-generate', v_code, conflicting.full_name;
    end if;
  end if;

  -- site must exist and be active
  if v_site is not null and not exists (select 1 from public.site where id = v_site and is_active) then
    raise exception 'The selected site does not exist or is inactive';
  end if;
  -- camp must exist and be active
  if v_camp is not null and not exists (select 1 from public.camp where id = v_camp and is_active) then
    raise exception 'The selected camp does not exist or is inactive';
  end if;
  -- block/room only make sense while the employee stays in a camp
  if v_camp is null then
    v_block := null;
    v_room := null;
  end if;

  -- opening balance validation (frontend validates too — never trust it alone)
  if v_opening < 0 or v_opening <> v_opening then
    raise exception 'Previous working hours cannot be negative';
  end if;
  if v_opening > 9999999999.99 then
    raise exception 'Previous working hours are unrealistically large';
  end if;

  -- one team leader per site
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
    camp_id, camp_block, camp_room, opening_hours
  ) values (
    btrim(v_payload->>'full_name'), coalesce(v_code, public.next_employee_code()),
    nullif(v_payload->>'nationality',''), (v_payload->>'date_of_birth')::date,
    nullif(v_payload->>'phone',''), nullif(v_payload->>'email',''), nullif(v_payload->>'address',''),
    nullif(v_payload->>'emergency_contact',''), nullif(v_payload->>'position',''),
    (v_payload->>'join_date')::date, nullif(v_payload->>'company_name',''),
    nullif(v_payload->>'passport_number',''), nullif(v_payload->>'passport_status',''),
    nullif(v_payload->>'id_number',''), nullif(v_payload->>'id_status',''),
    v_site, 5.0, 'active', nullif(v_payload->>'photo',''), v_is_leader, v_leader_site, v_camp,
    v_block, v_room, round(v_opening, 2)
  ) returning * into result;
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
-- opening balance: NULL/blank in the payload → keep the stored value; a number
-- → set it, but only a super admin may actually CHANGE it (the form always
-- sends the current value back, so normal edits pass through untouched)
declare v_opening numeric := nullif(v_payload->>'opening_hours','')::numeric;
declare v_prev_site uuid;
declare v_prev_opening numeric;
declare conflicting public.employee;
begin
  if not public.has_menu_permission('employees') then raise exception 'Access denied'; end if;

  -- the payload must be a JSON object (after unwrapping) — anything else is a
  -- broken client and must fail loudly instead of silently nulling columns
  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'Invalid employee payload — expected a JSON object';
  end if;

  if v_site is not null and not exists (select 1 from public.site where id = v_site and is_active) then
    raise exception 'The selected site does not exist or is inactive';
  end if;
  if v_camp is not null and not exists (select 1 from public.camp where id = v_camp and is_active) then
    raise exception 'The selected camp does not exist or is inactive';
  end if;
  -- block/room only make sense while the employee stays in a camp
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

  -- remember the previous site so the move can be logged below
  select current_site_id, opening_hours into v_prev_site, v_prev_opening from public.employee where id = p_id;

  -- historical opening balance: validated like on create; changing it is a
  -- super-admin-only adjustment so a lifetime total can never drift silently
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
    -- keep the stored name when a partial payload arrives without one —
    -- never null out a NOT NULL column
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
    updated_at        = now()
  where id = p_id returning * into result;

  -- log the site move (site → site, site → idle, idle → site) so the attendance
  -- sheet can keep the row under the original site with the new site shown
  -- across the merged moved-days cells
  if v_prev_site is distinct from v_site then
    insert into public.site_transfer (employee_id, from_site_id, to_site_id, effective_date)
    values (p_id, v_prev_site, v_site,
            coalesce(p_effective_date, (now() at time zone 'Asia/Dubai')::date));
  end if;
  return result;
end; $$;

create or replace function public.create_uniform_entry(
  p_employee_id uuid, p_document_type text, p_document_number text, p_items jsonb,
  p_site_name text default null, p_team_leader_name text default null,
  p_created_at timestamptz default now(), p_token_number int default null,
  p_is_renewal boolean default false, p_previous_token_id int default null
)
returns public.uniform_registry language plpgsql
security definer set search_path = public
as $$
declare
  result public.uniform_registry;
  emp public.employee;
  v_uniform_id int;
  v_token int;
  -- tolerate double-encoded payloads (see create_employee)
  v_items jsonb := case when jsonb_typeof(p_items) = 'string'
                        then (p_items #>> '{}')::jsonb else p_items end;
begin
  if not public.is_staff() then raise exception 'Access denied'; end if;
  if p_document_type not in ('id','passport') then raise exception 'Invalid document type'; end if;
  select * into emp from public.employee where id = p_employee_id;
  if emp.id is null then raise exception 'Employee not found'; end if;

  select coalesce(max(uniform_id),0) + 1 into v_uniform_id from public.uniform_registry;
  select coalesce(max(token_number),0) + 1 into v_token from public.uniform_registry;
  if p_token_number is not null and p_token_number > 0 then v_token := p_token_number; end if;
  if exists (select 1 from public.uniform_registry where uniform_id = v_uniform_id) then
    v_uniform_id := v_uniform_id + 1;
  end if;

  insert into public.uniform_registry
    (uniform_id, token_number, employee_id, employee_name, document_type, document_number,
     items, site_name, team_leader_name, is_renewal, previous_token_id, created_at, renewal_date)
  values
    (v_uniform_id, v_token, p_employee_id, emp.full_name, p_document_type, p_document_number,
     v_items, nullif(p_site_name,''), nullif(p_team_leader_name,''), p_is_renewal, p_previous_token_id,
     p_created_at, p_created_at + interval '6 months')
  returning * into result;
  return result;
end; $$;

create or replace function public.update_uniform_entry(
  p_id uuid, p_token_number int, p_document_type text, p_document_number text,
  p_items jsonb, p_site_name text default null, p_team_leader_name text default null,
  p_created_at timestamptz default now()
)
returns public.uniform_registry language plpgsql
security definer set search_path = public
as $$
declare result public.uniform_registry;
-- tolerate double-encoded payloads (see create_employee)
declare v_items jsonb := case when jsonb_typeof(p_items) = 'string'
                               then (p_items #>> '{}')::jsonb else p_items end;
begin
  if not public.is_staff() then raise exception 'Access denied'; end if;
  if p_document_type not in ('id','passport') then raise exception 'Invalid document type'; end if;
  update public.uniform_registry set
    token_number = p_token_number,
    document_type = p_document_type,
    document_number = p_document_number,
    items = v_items,
    site_name = nullif(p_site_name,''),
    team_leader_name = nullif(p_team_leader_name,''),
    created_at = p_created_at,
    renewal_date = p_created_at + interval '6 months'
  where id = p_id and not is_deleted and not is_hidden
  returning * into result;
  if result.id is null then raise exception 'Entry not found'; end if;
  return result;
end; $$;

-- keep the function grants from the schema's final pass
revoke execute on function public.create_employee(jsonb) from public;
revoke execute on function public.create_employee(jsonb) from anon;
grant execute on function public.create_employee(jsonb) to authenticated, service_role;
revoke execute on function public.update_employee(uuid, jsonb, date) from public;
revoke execute on function public.update_employee(uuid, jsonb, date) from anon;
grant execute on function public.update_employee(uuid, jsonb, date) to authenticated, service_role;
revoke execute on function public.create_uniform_entry(uuid, text, text, jsonb, text, text, timestamptz, int, boolean, int) from public;
revoke execute on function public.create_uniform_entry(uuid, text, text, jsonb, text, text, timestamptz, int, boolean, int) from anon;
grant execute on function public.create_uniform_entry(uuid, text, text, jsonb, text, text, timestamptz, int, boolean, int) to authenticated, service_role;
revoke execute on function public.update_uniform_entry(uuid, int, text, text, jsonb, text, text, timestamptz) from public;
revoke execute on function public.update_uniform_entry(uuid, int, text, text, jsonb, text, text, timestamptz) from anon;
grant execute on function public.update_uniform_entry(uuid, int, text, text, jsonb, text, text, timestamptz) to authenticated, service_role;
