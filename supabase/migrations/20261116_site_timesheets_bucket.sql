-- ============================================================================
-- PULSE Workforce OS — Site Timesheets / Time Cards storage bucket
-- ----------------------------------------------------------------------------
-- Private Supabase Storage bucket for the per-site monthly documents shown on
-- the new Site Timesheets page (Sites → "Timesheet / Time Cards" button).
--
-- Object layout (the path IS the document's identity — one file per slot,
-- uploading replaces the previous file of that slot):
--   site_<siteId>/<YYYY-MM>/time-card.<ext>   — monthly time card (PDF)
--   site_<siteId>/<YYYY-MM>/timesheet.<ext>   — monthly timesheet (XLSX/PDF)
--
-- The bucket is PRIVATE: previews and downloads go through short-lived signed
-- URLs created by the signed-in admin's browser. Only authenticated users
-- with an admin profile (role 'admin' or 'super_admin') may touch the files.
--
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query).
-- Re-running is safe — every statement is idempotent.
-- ============================================================================

-- 1. the bucket (private, 50 MB per file) ------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('site-timesheets', 'site-timesheets', false, 52428800)
on conflict (id) do update
  set public     = false,
      file_size_limit = 52428800;

-- 2. policies — authenticated admins only ------------------------------------
drop policy if exists "site timesheets: admins select" on storage.objects;
drop policy if exists "site timesheets: admins insert" on storage.objects;
drop policy if exists "site timesheets: admins update" on storage.objects;
drop policy if exists "site timesheets: admins delete" on storage.objects;

create policy "site timesheets: admins select"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'site-timesheets'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'super_admin')
    )
  );

create policy "site timesheets: admins insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'site-timesheets'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'super_admin')
    )
  );

create policy "site timesheets: admins update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'site-timesheets'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'super_admin')
    )
  )
  with check (
    bucket_id = 'site-timesheets'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'super_admin')
    )
  );

create policy "site timesheets: admins delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'site-timesheets'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'super_admin')
    )
  );
