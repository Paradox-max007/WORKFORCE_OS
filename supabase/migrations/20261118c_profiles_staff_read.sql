-- ============================================================================
-- PULSE Workforce OS — Admin directory readable by every admin
-- ----------------------------------------------------------------------------
-- The Sites form now assigns a site's attendance marker ("supervisor") by
-- picking an admin from a searchable dropdown — which needs the admin list
-- (names, emails, roles) for NORMAL admins too, not just super admins.
--
-- profiles holds no secrets (name, email, role, theme, accent, created_at —
-- passwords live in auth.users), and the same staff-wide read is already the
-- policy for branches (20261113c_branch_read_all_staff.sql).
--
-- Run once in the Supabase SQL editor. Idempotent.
-- ============================================================================

drop policy if exists profiles_select on public.profiles;

create policy profiles_select on public.profiles
  for select using (public.is_staff());
