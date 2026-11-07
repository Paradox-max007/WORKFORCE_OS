-- ============================================================================
-- 20261108c — ONE SHARE LINK PER SITE + DAY
-- ----------------------------------------------------------------------------
-- User request:
--   Clicking "Send Link" used to generate a NEW link every time. Instead:
--   • if NO link was generated for that site on the current day → generate
--     one exactly as before
--   • if a link was ALREADY generated today → return that same link
--     (reused = true) so the UI just opens the links sidebar with it
--   • never create multiple links for the same site on the same date
--
-- What changes:
--   create_attendance_share_link becomes idempotent per (site, month, day):
--   before inserting it looks for a link of the same site + month created
--   TODAY and hands back the newest one with 'reused': true. Legacy
--   same-day duplicates (created before this fix) are never deleted — links
--   already sent on WhatsApp must keep working; the newest one wins.
--   A submitted link still counts as today's link: re-sharing that day hands
--   the same locked link back, and the admin can re-grant edit access on it
--   (the one-time-use philosophy is preserved — no duplicate papers).
--
--   No unique index is added on purpose: existing rows may already contain
--   same-day duplicates; the function-level check is enough (the UI button
--   is serialized per site and every create goes through this RPC).
-- ============================================================================

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

  -- normal admins may only share links for their assigned sites
  if not public.is_super_admin() then
    if not exists (
      select 1 from public.admin_site where profile_id = auth.uid() and site_id = p_site_id
    ) then
      raise exception 'Access denied — you can only share links for your assigned sites';
    end if;
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

comment on function public.create_attendance_share_link(uuid, text) is
  'Send Link action — ONE link per site + month per day: returns today''s existing link (reused=true) instead of creating a duplicate; the UI then just opens the links sidebar.';
