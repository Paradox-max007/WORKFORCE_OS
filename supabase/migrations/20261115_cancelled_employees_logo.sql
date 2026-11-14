-- ============================================================================
-- 20261115 — CANCELLED EMPLOYEES + CUSTOM COMPANY LOGO
-- ----------------------------------------------------------------------------
-- Part 1 (CANCELLED status): approving a Cancellation Request no longer
--   deletes the employee. The employee moves to status 'cancelled' — they
--   disappear from every working list (roster, sites, camps, marking sheets)
--   but KEEP all past records (attendance, salary sheet, advances, uniforms,
--   warnings, fines, leaves) for future reference. They are listed under
--   Employees → status filter "Cancelled" and can be restored by a super
--   admin at any time (restore_employee RPC).
--
-- Part 2 (logo): Site Settings gains a custom company logo (data:/https:
--   URL) shown in the sidebar, the sign-in screen and as the browser favicon.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1a. employee.status now allows 'cancelled'
-- ---------------------------------------------------------------------------
do $$
declare v_con text;
begin
  select conname into v_con from pg_constraint
   where conrelid = 'public.employee'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%pending_deletion%';
  if v_con is not null then
    execute format('alter table public.employee drop constraint %I', v_con);
  end if;
end $$;

alter table public.employee
  add constraint employee_status_check
  check (status in ('active','pending_deletion','deleted','cancelled'));

-- ---------------------------------------------------------------------------
-- 1b. request_employee_deletion — cancelled employees cannot be re-requested
--     (they are already out of the roster)
-- ---------------------------------------------------------------------------
create or replace function public.request_employee_deletion(p_employee_id uuid, p_reason text default null)
returns public.cancellation_request language plpgsql
security definer set search_path = public
as $$
declare result public.cancellation_request;
declare emp public.employee;
begin
  if not public.is_staff() then raise exception 'Access denied'; end if;
  select * into emp from public.employee where id = p_employee_id;
  if emp.id is null then raise exception 'Employee not found'; end if;
  if emp.status = 'deleted' then raise exception 'This employee is already deleted'; end if;
  if emp.status = 'cancelled' then raise exception 'This employee is already cancelled'; end if;
  if emp.status = 'pending_deletion' then raise exception 'This employee already has a pending deletion request'; end if;

  insert into public.cancellation_request (employee_id, reason, status, requested_by)
  values (p_employee_id, p_reason, 'pending', auth.uid()) returning * into result;

  update public.employee set status = 'pending_deletion' where id = p_employee_id;

  perform public.notify_super_admins(
    'New Cancellation Request',
    emp.full_name || ' (' || emp.employee_code || ') is pending deletion approval' ||
    case when coalesce(p_reason,'') <> '' then ' — ' || p_reason else '' end,
    'request'
  );
  return result;
end; $$;

-- ---------------------------------------------------------------------------
-- 1c. review_cancellation_request — approve now CANCELS (never deletes):
--     the employee keeps every past record; the site slot is freed and the
--     team-leader flag is cleared.
-- ---------------------------------------------------------------------------
create or replace function public.review_cancellation_request(p_id uuid, p_approve boolean)
returns void language plpgsql
security definer set search_path = public
as $$
declare req public.cancellation_request;
declare emp public.employee;
begin
  if not public.is_super_admin() then raise exception 'Only super admins can review requests'; end if;
  select * into req from public.cancellation_request where id = p_id;
  if req.id is null then raise exception 'Request not found'; end if;
  if req.status <> 'pending' then raise exception 'Only pending requests can be reviewed'; end if;
  select * into emp from public.employee where id = req.employee_id;

  if p_approve then
    update public.cancellation_request set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
    -- CANCEL, not delete: history stays for future reference
    update public.employee set status = 'cancelled', current_site_id = null, is_team_leader = false, team_leader_site_id = null
      where id = req.employee_id;
  else
    update public.cancellation_request set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
    update public.employee set status = 'active' where id = req.employee_id and status = 'pending_deletion';
  end if;

  if req.requested_by is not null then
    insert into public.notification (profile_id, title, message, type)
    values (req.requested_by,
      'Cancellation Request ' || case when p_approve then 'Approved' else 'Rejected' end,
      'The cancellation request for ' || coalesce(emp.full_name,'the employee') || ' has been ' ||
        case when p_approve
          then 'approved — the employee was moved to the cancelled list (all past records kept).'
          else 'rejected and the employee was restored.' end,
      'request');
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- 1d. restore_employee — super admin brings a cancelled employee back to
--     'active' (used from the Employees page → Cancelled list)
-- ---------------------------------------------------------------------------
create or replace function public.restore_employee(p_id uuid)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Only super admins can restore cancelled employees'; end if;
  if not exists (select 1 from public.employee where id = p_id and status = 'cancelled') then
    raise exception 'Only cancelled employees can be restored';
  end if;
  update public.employee set status = 'active' where id = p_id;
end; $$;

grant execute on function public.restore_employee(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. site_settings.logo_url — custom company logo (data:/https: URL,
--    null = the default PULSE mark). Patch semantics like every field:
--    p_logo_url null = keep, '' = reset to default.
-- ---------------------------------------------------------------------------
alter table public.site_settings add column if not exists logo_url text;

-- drop + recreate so the new parameter exists with a stable signature
drop function if exists public.update_site_settings(text, text, text, text, boolean, text, text, text);

create or replace function public.get_site_settings()
returns jsonb language plpgsql stable
security definer set search_path = public
as $$
declare
  s public.site_settings;
  v_actor text;
begin
  if not public.is_staff() then raise exception 'Access denied'; end if;

  select * into s from public.site_settings where id = 1;
  if s.id is null then
    return jsonb_build_object(
      'project_name', 'PULSE Workforce',
      'company_name', 'PULSE WORKFORCE OS LLC.',
      'logo_url', null,
      'theme', 'dark',
      'accent', 'violet',
      'ai_enabled', false,
      'ai_base_url', 'https://api.openai.com/v1',
      'ai_model', 'gpt-4o-mini',
      'ai_api_key_masked', '',
      'updated_at', null,
      'updated_by_name', null);
  end if;

  select coalesce(name, email) into v_actor from public.profiles where id = s.updated_by;
  return jsonb_build_object(
    'project_name', s.project_name,
    'company_name', s.company_name,
    'logo_url', s.logo_url,
    'theme', s.theme,
    'accent', s.accent,
    'ai_enabled', s.ai_enabled,
    'ai_base_url', s.ai_base_url,
    'ai_model', s.ai_model,
    'ai_api_key_masked', case when s.ai_api_key = '' then ''
                              else '••••••••' || right(s.ai_api_key, 4) end,
    'updated_at', s.updated_at,
    'updated_by_name', v_actor);
end; $$;

create or replace function public.update_site_settings(
  p_project_name text,
  p_company_name text,
  p_logo_url     text,
  p_theme        text,
  p_accent       text,
  p_ai_enabled   boolean,
  p_ai_base_url  text,
  p_ai_model     text,
  p_ai_api_key   text
) returns jsonb language plpgsql volatile
security definer set search_path = public
as $$
declare
  v_before public.site_settings;
  v_actor text;
  v_key text;
  v_logo text;
begin
  if not public.is_super_admin() then
    raise exception 'Only super admins can change site settings';
  end if;

  if p_theme is not null and p_theme not in ('dark', 'light') then
    raise exception 'Unknown theme';
  end if;
  if p_accent is not null and p_accent not in ('violet', 'emerald', 'amber', 'rose') then
    raise exception 'Unknown accent color';
  end if;
  if p_project_name is not null and length(btrim(p_project_name)) = 0 then
    raise exception 'Project name cannot be empty';
  end if;
  if p_project_name is not null and length(btrim(p_project_name)) > 60 then
    raise exception 'Project name is too long (max 60 characters)';
  end if;
  if p_company_name is not null and length(btrim(p_company_name)) = 0 then
    raise exception 'Company name cannot be empty';
  end if;
  if p_company_name is not null and length(btrim(p_company_name)) > 120 then
    raise exception 'Company name is too long (max 120 characters)';
  end if;
  -- logo: '' = reset to default (null), otherwise a data: or http(s): URL
  if p_logo_url is not null and p_logo_url <> ''
     and p_logo_url !~ '^(data:image/|https?://)' then
    raise exception 'Logo must be an image data URL or an http(s) URL';
  end if;
  if p_logo_url is not null and length(p_logo_url) > 2000000 then
    raise exception 'Logo is too large — use an image under ~1.5 MB';
  end if;
  if p_ai_base_url is not null and p_ai_base_url !~ '^https?://' then
    raise exception 'AI base URL must be a valid http(s) URL, e.g. https://api.openai.com/v1';
  end if;
  if p_ai_model is not null and length(btrim(p_ai_model)) = 0 then
    raise exception 'AI model cannot be empty';
  end if;

  select * into v_before from public.site_settings where id = 1;

  -- resolve the effective key for the enable-guard
  v_key := coalesce(p_ai_api_key, v_before.ai_api_key);
  if p_ai_enabled is true and coalesce(v_key, '') = '' then
    raise exception 'Save an API key before enabling the AI assistant';
  end if;

  -- '' clears back to the default logo (null)
  v_logo := case when p_logo_url = '' then null else coalesce(p_logo_url, v_before.logo_url, null) end;

  insert into public.site_settings (id, project_name, company_name, logo_url, theme, accent,
                                    ai_enabled, ai_base_url, ai_model, ai_api_key,
                                    updated_at, updated_by)
  values (1,
    coalesce(nullif(btrim(coalesce(p_project_name, '')), ''), v_before.project_name, 'PULSE Workforce'),
    coalesce(nullif(btrim(coalesce(p_company_name, '')), ''), v_before.company_name, 'PULSE WORKFORCE OS LLC.'),
    v_logo,
    coalesce(p_theme, v_before.theme, 'dark'),
    coalesce(p_accent, v_before.accent, 'violet'),
    coalesce(p_ai_enabled, v_before.ai_enabled, false),
    coalesce(rtrim(p_ai_base_url, '/'), v_before.ai_base_url, 'https://api.openai.com/v1'),
    coalesce(nullif(btrim(coalesce(p_ai_model, '')), ''), v_before.ai_model, 'gpt-4o-mini'),
    coalesce(p_ai_api_key, v_before.ai_api_key, ''),
    now(), auth.uid())
  on conflict (id) do update set
    project_name = excluded.project_name,
    company_name = excluded.company_name,
    logo_url     = excluded.logo_url,
    theme        = excluded.theme,
    accent       = excluded.accent,
    ai_enabled   = excluded.ai_enabled,
    ai_base_url  = excluded.ai_base_url,
    ai_model     = excluded.ai_model,
    ai_api_key   = excluded.ai_api_key,
    updated_at   = excluded.updated_at,
    updated_by   = excluded.updated_by;

  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  return jsonb_build_object(
    'project_name', (select project_name from public.site_settings where id = 1),
    'company_name', (select company_name from public.site_settings where id = 1),
    'logo_url', (select logo_url from public.site_settings where id = 1),
    'theme', (select theme from public.site_settings where id = 1),
    'accent', (select accent from public.site_settings where id = 1),
    'ai_enabled', (select ai_enabled from public.site_settings where id = 1),
    'ai_base_url', (select ai_base_url from public.site_settings where id = 1),
    'ai_model', (select ai_model from public.site_settings where id = 1),
    'ai_api_key_masked', (select case when ai_api_key = '' then ''
                                      else '••••••••' || right(ai_api_key, 4) end
                            from public.site_settings where id = 1),
    'updated_at', now(),
    'updated_by_name', v_actor);
end; $$;

grant execute on function public.update_site_settings(text, text, text, text, text, boolean, text, text, text) to authenticated;
