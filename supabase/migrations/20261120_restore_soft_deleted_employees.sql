-- ============================================================================
-- 20261120 — Soft delete becomes fully restorable
-- ----------------------------------------------------------------------------
-- delete_employee_cascade already SOFT-deletes: the employee gets
-- status 'deleted' and their related rows are only flagged is_hidden —
-- nothing is ever removed from the database.
--
-- This migration widens restore_employee so a super admin can bring a
-- soft-DELETED employee back too (not just a cancelled one), and restoring
-- one unhides every record the soft delete hid:
--   attendance, warnings, fines, leave requests, cancellation requests,
--   uniform registry entries.
--
-- The Employees page "Cancelled / Deleted" status filter lists both kinds
-- (listCancelledEmployees now selects status in ('cancelled','deleted')).
-- ============================================================================

create or replace function public.restore_employee(p_id uuid)
returns void language plpgsql
security definer set search_path = public
as $$
declare emp public.employee;
begin
  if not public.is_super_admin() then raise exception 'Only super admins can restore archived employees'; end if;
  select * into emp from public.employee where id = p_id;
  if emp.id is null then raise exception 'Employee not found'; end if;
  if emp.status not in ('cancelled', 'deleted') then
    raise exception 'Only cancelled or deleted employees can be restored';
  end if;

  -- a soft delete only HID the employee's records — restoring one brings
  -- every hidden row back (attendance, warnings, fines, leaves, uniforms…)
  if emp.status = 'deleted' then
    update public.attendance           set is_hidden = false where employee_id = p_id;
    update public.warning              set is_hidden = false where employee_id = p_id;
    update public.fine                 set is_hidden = false where employee_id = p_id;
    update public.leave_request        set is_hidden = false where employee_id = p_id;
    update public.cancellation_request set is_hidden = false where employee_id = p_id;
    update public.uniform_registry     set is_deleted = false, is_hidden = false where employee_id = p_id;
  end if;

  update public.employee set status = 'active' where id = p_id;
end; $$;

grant execute on function public.restore_employee(uuid) to authenticated;
