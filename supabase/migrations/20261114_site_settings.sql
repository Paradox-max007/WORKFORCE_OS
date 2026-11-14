-- ============================================================================
-- 20261114 — SITE SETTINGS (Site Settings page, super admin only)
-- ----------------------------------------------------------------------------
-- Org-wide configuration edited from the new Site Settings sidebar page:
--
--   • Branding   — project_name (sidebar, browser title, auth screens) and
--                  company_name (legal name printed on the attendance paper)
--   • Appearance — org-wide theme (dark/light) + accent (violet/emerald/
--                  amber/rose) applied for EVERY signed-in admin
--   • AI bot     — the upcoming in-app AI assistant connection: an
--                  OpenAI-compatible base URL + API key + model, configured
--                  here and consumed by the /api/ai proxy route
--
-- Storage: public.site_settings — a SINGLETON table (id fixed to 1), the
-- same pattern as deduction_settings (20261111c).
--
--   1. get_site_settings — any signed-in staff member can read the public
--      fields + a MASKED API key (the raw key NEVER leaves the database).
--   2. update_site_settings — super admin only; every field is a patch
--      (null = keep the current value). p_ai_api_key: null = keep, '' = clear.
--   3. The table joins the supabase_realtime publication so theme / accent /
--      branding changes propagate live to every open browser.
-- ============================================================================

create table if not exists public.site_settings (
  id           int primary key default 1 check (id = 1),
  -- display name of the project (sidebar, browser title, auth screens)
  project_name text not null default 'PULSE Workforce',
  -- legal company name printed on the attendance paper
  company_name text not null default 'PULSE WORKFORCE OS LLC.',
  -- org-wide look
  theme        text not null default 'dark' check (theme in ('dark', 'light')),
  accent       text not null default 'violet' check (accent in ('violet', 'emerald', 'amber', 'rose')),
  -- AI assistant connection (OpenAI-compatible endpoint)
  ai_enabled   boolean not null default false,
  ai_base_url  text not null default 'https://api.openai.com/v1',
  ai_model     text not null default 'gpt-4o-mini',
  ai_api_key   text not null default '',
  updated_at   timestamptz,
  updated_by   uuid
);

insert into public.site_settings (id)
values (1)
on conflict (id) do nothing;

alter table public.site_settings enable row level security;
-- all access flows through the RPCs below (security definer)

-- broadcast changes to every client (theme / accent / branding follow live)
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'site_settings'
  ) then
    return;
  end if;
  alter publication supabase_realtime add table public.site_settings;
exception
  when others then null; -- publication missing on this environment → skip
end $$;

-- ---------------------------------------------------------------------------
-- 1. get_site_settings — the effective settings (any signed-in staff).
--    The API key is returned MASKED (last 4 characters only).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2. update_site_settings — super admin only; null params keep the current
--    value (patch semantics). The AI key is write-only: null = unchanged,
--    '' = cleared. Enabling the assistant requires a stored key.
-- ---------------------------------------------------------------------------
create or replace function public.update_site_settings(
  p_project_name text,
  p_company_name text,
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

  insert into public.site_settings (id, project_name, company_name, theme, accent,
                                    ai_enabled, ai_base_url, ai_model, ai_api_key,
                                    updated_at, updated_by)
  values (1,
    coalesce(nullif(btrim(coalesce(p_project_name, '')), ''), v_before.project_name, 'PULSE Workforce'),
    coalesce(nullif(btrim(coalesce(p_company_name, '')), ''), v_before.company_name, 'PULSE WORKFORCE OS LLC.'),
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

grant execute on function public.get_site_settings() to authenticated;
grant execute on function public.update_site_settings(text, text, text, text, boolean, text, text, text) to authenticated;
