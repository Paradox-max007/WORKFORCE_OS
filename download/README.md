# PULSE — Generated files

## Database migration (run in Supabase SQL Editor)

**`20261104_payroll_idle.sql`** — REQUIRED for the new Payroll page & Idle Employees.

Run the whole file in Supabase → SQL Editor → New query → Run. It is
idempotent (`create or replace function`) and safe to re-run.

What it does:

1. `get_salary_sheet` — shared by Salary Sheet **and** the new Payroll page:
   - normal site groups no longer include the "No site" bucket;
   - new **Idle Employees** group, always last (employees with no current site,
     including zero-hours ones, plus unassigned/unrated hours);
   - per-employee `join_date`, `six_month_date`, `threshold_date` for the
     Payroll hours tooltip.
2. Permission leniency: the shared engine functions now accept
   `salary_sheet` **OR** the new `payroll` menu key.
3. NEW `unmark_employee_salary_paid` — revert a payment (super admin only,
   reason mandatory, audited).

Earlier migrations (only needed on a fresh database):

- `20261102b_jsonb_payload_tolerance.sql`
- `20261102c_menu_automation.sql`
- `20261103_trade_salary_system.sql`
- `20261103b_salary_sheet_edit.sql`

## After running the migration

- Refresh the app — **Salary Details → Payroll** appears (grant it to admins
  in Admin Management → Manage Permissions if needed; super admins see it
  immediately).
- The Salary Sheet now shows **Idle Employees** as the last section and no
  longer contains the Employee Settlement table (payments, advances and
  deductions moved to Payroll).
