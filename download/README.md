# PULSE — Generated files

## Database migration (run in Supabase SQL Editor)

**`20261105_payroll_inline.sql`** — REQUIRED for the new Payroll editing features.

Run the whole file in Supabase → SQL Editor → New query → Run. It is
idempotent (`create or replace function`) and safe to re-run.

What it does:

1. `mark_employee_salary_paid` — **Mark Paid no longer requires a finalized
   period.** It is active whenever the employee HAS a salary this month
   (`gross_salary > 0`); a zero-salary employee is rejected with
   "No salary calculated for this employee this month". Payments keep the
   who/when audit trail and paid employees stay protected.
2. `update_salary_sheet_row` + `apply_employee_assignment` — permission
   leniency `salary_sheet OR payroll`, so the **Trade dropdown on the Payroll
   page** (edit mode) saves through the exact same RPC as the Salary Sheet:
   it overwrites the stored trade + assignment history from the 1st of the
   payroll month and re-prices the month — Salary Sheet, Employee Details,
   the Attendance page and the Attendance PDF all read the same rows, so they
   update together.

Verified locally on PostgreSQL (15 checks incl. idempotency — see
`scripts/test_payroll_inline_migration.py`).

Earlier migrations (only needed on a fresh database):

- `20261102b_jsonb_payload_tolerance.sql`
- `20261102c_menu_automation.sql`
- `20261103_trade_salary_system.sql`
- `20261103b_salary_sheet_edit.sql`
- `20261104_payroll_idle.sql`

## What changed in this update (Payroll page)

- **Advance & Deduction are always-visible columns** — no separate edit
  button. In **Edit mode** (sticky Edit button, top bar — like the Salary
  Sheet) they become inline inputs that save on blur/Enter.
- **Trade dropdown in edit mode** — pick a trade, it saves immediately and
  propagates to every linked page.
- **Mark Paid is active whenever the employee has a salary** (gross > 0);
  the payment dialog confirms the settlement summary (gross − advance −
  deduction = net) and records who/when.
- **New cards at the top: Paid salary** (Σ net of paid employees) and
  **Balance to pay** (Σ net of unpaid).
- **Net Payable column + totals footer row** (hours, advance, deduction,
  gross, net).
- The Salary Sheet's **Idle Employees** section always renders LAST, after
  all site sections.
- The Attendance page & Attendance PDF now show the employee's real **trade**
  (was the free-text position; falls back to position when no trade is
  assigned).
