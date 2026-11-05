# PULSE — Generated files

## Database migrations (run in Supabase SQL Editor)

**`20261105b_audit_employee_names.sql`** + **`20261105c_companies.sql`** —
REQUIRED for this update.

Run each whole file in Supabase → SQL Editor → New query → Run. Both are
idempotent (`create or replace function` / `create table if not exists`) and
safe to re-run.

### `20261105b_audit_employee_names.sql` — human-readable payroll audit

1. **Backfill** — every raw employee UUID inside existing
   `payroll_audit_log.details` rows is replaced with
   `Full Name (EMPLOYEE_CODE)`.
2. `mark_employee_salary_paid`, `unmark_employee_salary_paid` and
   `reset_payroll_employee_auto` are recreated so **new audit entries are
   written with the employee name + code** instead of the database id
   (payment rules unchanged).

### `20261105c_companies.sql` — companies get their own table

1. New **`company`** table (id, name, created_at, unique name) with RLS
   (staff read, employee editors insert) + realtime publication.
2. `create_company` RPC (permission-checked, duplicate-safe) used by the
   **"+ Add New Company…"** option in the employee form.
3. **Seed** — every distinct company name already used by an employee
   becomes a company row (employees keep storing the name in
   `employee.company_name`; no employee-table migration is needed).

Earlier migrations (only needed on a fresh database):

- `20261102b_jsonb_payload_tolerance.sql`
- `20261102c_menu_automation.sql`
- `20261103_trade_salary_system.sql`
- `20261103b_salary_sheet_edit.sql`
- `20261104_payroll_idle.sql`
- `20261105_payroll_inline.sql`

## What changed in this update

### Salary Sheet & Payroll

- **Search** (name / employee ID / trade) on both pages — always visible in
  the sticky bar; the Salary Sheet filters rows inside every site section
  (empty sections hide, counters update), the Payroll narrows the table
  (footer totals follow the visible rows; the top cards stay period totals).
- **Payroll filters**: by **trade** and by **nationality** (options built
  from the current period), plus a Clear button and a shown/total counter.
- **Audit trail (Payroll) is collapsed** behind an expandable
  **Audit trail (N)** icon button — clicking it reveals every audit entry;
  audits now show the **employee name + code**, never the database id.
- Hours tooltip: "Below threshold" is now **"Below 1000 h / 6 months"**
  (badge, this-month line, site-distribution column, rate category).
- The "always last" chip was removed from the Salary Sheet's Idle Employees
  section (it still renders last, just without the label).

### Employee Details

- The **Personal Information box is split in two** — the second card is
  **Notices & Fines**: the employee's warnings + fines, newest first, as a
  **carousel** (prev/next + dots + counter when there are several). Every
  slide **hyperlinks to that notification** — it opens the Notifications Hub
  straight on the Warnings or Fines tab.

### Add / Edit Employee

- **Phone** now has a **country-code dropdown** (+971, +966, +91, … next to
  the local number; legacy "+code number" values are parsed back in, unknown
  codes fall back to "Other" and are preserved as typed).
- "Position (free text)" is now **"Position as per Visa"**.
- **Company Name is a dropdown** fed by the new companies table, with an
  inline **"+ Add New Company…"** option (created on the fly and selected
  automatically). Existing employee companies appear automatically.

### Notifications Hub

- Tabs are deep-linkable — the Notices & Fines card on Employee Details
  jumps straight to the right tab; the sidebar always opens the Requests
  tab.
