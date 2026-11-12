-- ============================================================================
-- 20261112b — BRANCH-SCOPED SITE ACCESS (branch grants unlock sites + attendance)
-- ----------------------------------------------------------------------------
-- "Granted access" for a normal admin now means:
--     the sites of the branches granted to them (public.admin_branch)
--   PLUS any directly assigned site (public.admin_site).
-- Super admins keep unrestricted access. Sites WITHOUT a branch are only
-- reachable by super admins and admins with a direct site assignment.
--
-- This migration centralises the check in public.site_access_allowed(p_site_id)
-- and re-points every attendance data-plane guard at it:
--   • get_month_attendance        — which records an admin can SEE
--   • mark_attendance             — which days an admin can MARK
--   • create_attendance_share_link / list_attendance_share_links /
--     grant_attendance_share_edit — which share links an admin can manage
--   • share_link_select RLS policy
-- (bulk_mark_attendance delegates to mark_attendance — no change needed.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The shared guard — one place decides if the caller may work with a site
-- ---------------------------------------------------------------------------
create or replace function public.site_access_allowed(p_site_id uuid)
returns boolean language plpgsql
stable security definer set search_path = public
as $$
begin
  -- not signed in / not staff → nothing is allowed
  if not public.is_staff() then
    return false;
  end if;

  -- super admins see and manage every site
  if public.is_super_admin() then
    return true;
  end if;

  -- directly assigned site (Admin Management → Site Access)
  if exists (
    select 1 from public.admin_site a
    where a.profile_id = auth.uid() and a.site_id = p_site_id
  ) then
    return true;
  end if;

  -- any site owned by a branch granted to this admin
  -- (Admin Management → Manage Permissions → Branch access / Assign Branches)
  return exists (
    select 1
    from public.site s
    join public.admin_branch ab on ab.branch_id = s.branch_id
    where s.id = p_site_id
      and ab.profile_id = auth.uid()
  );
end; $$;

comment on function public.site_access_allowed(uuid) is
  'True when the caller may view / mark / share the site: super admin, direct admin_site assignment, or the site belongs to a branch granted via admin_branch.';

revoke execute on function public.site_access_allowed(uuid) from public;
revoke execute on function public.site_access_allowed(uuid) from anon;
grant execute on function public.site_access_allowed(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. get_month_attendance — records visible to the caller (date-effective)
-- ---------------------------------------------------------------------------
create or replace function public.get_month_attendance(p_month text)
returns setof public.attendance language plpgsql
security definer set search_path = public
as $$
begin
  if not public.has_menu_permission('attendance') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;

  -- Only REAL records are returned: days with no record simply stay blank in
  -- the marking sheet (no auto-created 8h defaults). Future days render blank
  -- and are locked client-side.
  -- Site authorization is DATE-EFFECTIVE: a normal admin sees a record when
  -- the employee belonged to one of their GRANTED sites (branch sites +
  -- direct assignments) on that record's date (an employee moved mid-month
  -- keeps their old site's history visible there).
  return query
    select a.* from public.attendance a
    join public.employee e on e.id = a.employee_id
    where to_char(a.date, 'YYYY-MM') = p_month
      and not a.is_hidden
      and e.status <> 'deleted'
      and (
        public.is_super_admin()
        or public.site_access_allowed(public.emp_site_on_date(e.id, a.date))
      )
    order by a.date;
end; $$;

-- ---------------------------------------------------------------------------
-- 3. mark_attendance — permission + date-effective site checks + shared core
-- ---------------------------------------------------------------------------
create or replace function public.mark_attendance(
  p_employee_id uuid, p_date date, p_value text default null
)
returns public.attendance language plpgsql
security definer set search_path = public
as $$
declare
  v_emp_site uuid;
begin
  if not public.has_menu_permission('attendance') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;

  -- site-scoped marking is DATE-EFFECTIVE: normal admins may only mark days
  -- the employee belonged to one of their GRANTED sites on (branch sites +
  -- direct assignments; an employee moved mid-month stays markable at the old
  -- site for the days before the move and at the new site afterwards).
  -- Idle days remain super-admin only.
  select public.emp_site_on_date(p_employee_id, p_date) into v_emp_site;
  if not public.is_super_admin() then
    if v_emp_site is null then
      raise exception 'This employee has no site on this date — only super admins can mark idle employees';
    end if;
    if not public.site_access_allowed(v_emp_site) then
      raise exception 'Access denied — you can only mark attendance for your granted branches and assigned sites';
    end if;
  end if;

  return public.mark_attendance_core(p_employee_id, p_date, p_value, auth.uid());
end; $$;

-- ---------------------------------------------------------------------------
-- 4. share links — create / list / re-grant edit now follow the same grants
-- ---------------------------------------------------------------------------
create or replace function public.create_attendance_share_link(
  p_site_id uuid, p_month text
)
returns jsonb language plpgsql
security definer set search_path = public
as $$
declare
  v_site public.site%rowtype;
  v_link public.attendance_share_link%rowtype;
  v_reused boolean := false;
begin
  if not public.has_menu_permission('attendance') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;

  select * into v_site from public.site where id = p_site_id and is_active;
  if v_site.id is null then
    raise exception 'Site not found';
  end if;

  -- normal admins may only share links for their granted sites
  -- (branch sites + direct assignments)
  if not public.site_access_allowed(p_site_id) then
    raise exception 'Access denied — you can only share links for your granted branches and assigned sites';
  end if;

  if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Invalid month — expected YYYY-MM';
  end if;

  -- ONE LINK PER SITE + DAY: today's link for this site + month already
  -- exists → hand it back instead of creating another (newest wins when
  -- legacy same-day duplicates are present)
  select * into v_link
  from public.attendance_share_link
  where site_id = p_site_id
    and month_key = p_month
    and created_at::date = current_date
  order by created_at desc
  limit 1;

  if v_link.id is not null then
    v_reused := true;
  else
    insert into public.attendance_share_link
      (token, site_id, site_name, month_key, created_by)
    values (
      substr(md5(gen_random_uuid()::text || clock_timestamp()::text || random()::text), 1, 20),
      v_site.id, v_site.name, p_month, auth.uid()
    )
    returning * into v_link;
  end if;

  return jsonb_build_object(
    'id', v_link.id, 'token', v_link.token,
    'site_id', v_link.site_id, 'site_name', v_link.site_name,
    'month_key', v_link.month_key,
    'created_by', v_link.created_by,
    'created_by_name', (select name from public.profiles where id = v_link.created_by),
    'created_at', v_link.created_at,
    'status', v_link.status, 'submitted_at', v_link.submitted_at,
    'submitted_by', v_link.submitted_by, 'submit_count', v_link.submit_count,
    'edit_granted_at', v_link.edit_granted_at, 'edit_granted_by', v_link.edit_granted_by,
    'reused', v_reused);
end; $$;

-- every link the caller may see, newest first (the right sidebar)
create or replace function public.list_attendance_share_links()
returns jsonb language plpgsql
security definer set search_path = public
as $$
declare
  v_rows jsonb;
begin
  if not public.is_staff() then
    raise exception 'Access denied';
  end if;

  select coalesce(jsonb_agg(row order by (row->>'created_at') desc), '[]'::jsonb)
  into v_rows
  from (
    select jsonb_build_object(
      'id', l.id, 'token', l.token, 'site_id', l.site_id, 'site_name', l.site_name,
      'month_key', l.month_key, 'created_by', l.created_by,
      'created_by_name', (select name from public.profiles where id = l.created_by),
      'created_at', l.created_at, 'status', l.status, 'submitted_at', l.submitted_at,
      'submitted_by', l.submitted_by, 'submit_count', l.submit_count,
      'edit_granted_at', l.edit_granted_at, 'edit_granted_by', l.edit_granted_by) as row
    from public.attendance_share_link l
    where public.is_super_admin()
       or l.site_id is null
       or public.site_access_allowed(l.site_id)
  ) t;

  return v_rows;
end; $$;

-- re-open editing on a submitted link (any admin responsible for the site)
create or replace function public.grant_attendance_share_edit(
  p_token text
)
returns void language plpgsql
security definer set search_path = public
as $$
declare
  v_link public.attendance_share_link%rowtype;
begin
  if not public.has_menu_permission('attendance') and not public.has_menu_permission('employees') then
    raise exception 'Access denied';
  end if;

  select * into v_link from public.attendance_share_link where token = p_token;
  if v_link.id is null then
    raise exception 'Link not found';
  end if;

  if not public.is_super_admin() then
    if v_link.site_id is null or not public.site_access_allowed(v_link.site_id) then
      raise exception 'Access denied — you can only manage links for your granted branches and assigned sites';
    end if;
  end if;

  update public.attendance_share_link
    set status = 'active',
        edit_granted_at = now(),
        edit_granted_by = auth.uid()
    where id = v_link.id;
end; $$;

revoke execute on function public.create_attendance_share_link(uuid, text) from anon;
revoke execute on function public.list_attendance_share_links() from anon;
revoke execute on function public.grant_attendance_share_edit(text) from anon;

-- ---------------------------------------------------------------------------
-- 5. share-link RLS — same grant set for the direct table read
-- ---------------------------------------------------------------------------
drop policy if exists share_link_select on public.attendance_share_link;
create policy share_link_select on public.attendance_share_link
  for select using (
    public.is_staff() and (
      public.is_super_admin()
      or site_id is null
      or public.site_access_allowed(site_id)
    )
  );
