-- ============================================================================
-- PULSE Workforce OS — Cancellation papers bucket
-- ----------------------------------------------------------------------------
-- The signed cancellation paper (PDF or image scan) attached to an APPROVED
-- cancellation request gets its own DEDICATED private bucket, separate from
-- the employee identity documents.
--
-- Storage model (identical scheme to 20261118b_employee_documents.sql):
--   • PRIVATE bucket 'cancellation-papers' — files are uploaded by the ADMIN'S
--     BROWSER already encrypted with AES-256-GCM (object layout:
--     cancel_<requestId>/paper.<ext>.bin = iv ‖ ciphertext), so even direct
--     bucket access reveals nothing usable.
--   • the AES key lives in the one-row `document_vault_key` table OUTSIDE the
--     bucket (shared with the employee documents vault) — created here again
--     idempotently so this migration is self-contained.
--
-- This script also MOVES any papers that were stored in the
-- 'employee-documents' bucket (folder cancel_<id>/) by earlier builds into
-- the new bucket, so nothing disappears.
--
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query).
-- Re-running is safe — every statement is idempotent.
-- ============================================================================

-- 1. the bucket (private, 20 MB per file — encrypted uploads stay under the
--    client's 15 MB plaintext limit) ------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('cancellation-papers', 'cancellation-papers', false, 20971520)
on conflict (id) do update
  set public         = false,
      file_size_limit = 20971520;

-- 2. bucket policies — authenticated admins only -------------------------------
drop policy if exists "cancellation papers: admins select" on storage.objects;
drop policy if exists "cancellation papers: admins insert" on storage.objects;
drop policy if exists "cancellation papers: admins update" on storage.objects;
drop policy if exists "cancellation papers: admins delete" on storage.objects;

create policy "cancellation papers: admins select"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'cancellation-papers'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'super_admin')
    )
  );

create policy "cancellation papers: admins insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'cancellation-papers'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'super_admin')
    )
  );

create policy "cancellation papers: admins update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'cancellation-papers'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'super_admin')
    )
  )
  with check (
    bucket_id = 'cancellation-papers'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'super_admin')
    )
  );

create policy "cancellation papers: admins delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'cancellation-papers'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'super_admin')
    )
  );

-- 3. the shared AES vault key (same table as the employee documents vault) ------
--    Idempotent re-creation so this migration also works on projects that have
--    not run 20261118b_employee_documents.sql yet.
create table if not exists public.document_vault_key (
  id        int primary key,
  key_b64   text not null,
  created_at timestamptz not null default now()
);

alter table public.document_vault_key enable row level security;

drop policy if exists "vault key: admins select" on public.document_vault_key;
drop policy if exists "vault key: admins insert" on public.document_vault_key;

create policy "vault key: admins select"
  on public.document_vault_key for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'super_admin')
    )
  );

-- the FIRST admin to upload a document creates the key; later inserts lose
-- the race and adopt the stored key (handled by the app)
create policy "vault key: admins insert"
  on public.document_vault_key for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'super_admin')
    )
  );

-- 4. MOVE papers stored by earlier builds in the 'employee-documents' bucket
--    (folder cancel_<requestId>/) into the new bucket. The SQL editor runs the
--    whole script in one transaction, so the copy + delete is atomic. ---------
insert into storage.objects (bucket_id, name, owner, created_at, updated_at, metadata, version)
select 'cancellation-papers', o.name, o.owner, o.created_at, o.updated_at, o.metadata, o.version
from storage.objects o
where o.bucket_id = 'employee-documents' and o.name like 'cancel\_%'
on conflict do nothing;

delete from storage.objects
where bucket_id = 'employee-documents' and name like 'cancel\_%';
