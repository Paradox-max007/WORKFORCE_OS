-- ============================================================================
-- 20261113c — Branch names readable by every signed-in staff member
-- ----------------------------------------------------------------------------
-- The Employees list / details / Excel export / CV PDF now show each
-- employee's owner BRANCH (employee → site → branch, joined client-side via
-- the nested PostgREST embed site:current_site_id(name, branch:branch_id(name))).
--
-- public.site is already readable by every signed-in staff member on purpose
-- (historical records — payroll snapshots, transfers, working-hours history —
-- keep resolving names across branches). Branch NAMES now follow the same
-- rule so the new Branch column resolves for every employee an admin is
-- allowed to see — e.g. a normal admin holding the employees_all_branches
-- grant views employees of branches that were never granted to them; without
-- this policy the embedded branch row would come back NULL (RLS left join)
-- and the Branch column would show "—" for those employees.
--
-- Page-level scoping is UNCHANGED:
--   • the Branches page + every branch dropdown still read through the
--     scoped list_branches() RPC (super admin → all; normal admin →
--     assigned branches only)
--   • create/update/delete branch, set_site_branch, set_admin_branch stay
--     super-admin gated RPCs
--   • public.admin_branch stays readable as self + super admin only
-- ============================================================================

drop policy if exists branch_select on public.branch;
create policy branch_select on public.branch
  for select using (public.is_staff());
