# PULSE — Generated files

## Database migrations (run in Supabase SQL Editor)

**`20261112b_branch_scoped_site_access.sql`** — REQUIRED for the Branch
Access update (run after `20261112_branches.sql`).

Run the whole file in Supabase → SQL Editor → New query → Run. It is
idempotent (`create or replace function`) and safe to re-run.

### `20261112b_branch_scoped_site_access.sql` — branch grants unlock sites & attendance

"Granted access" for a normal admin now means the sites of the **branches
granted to them** PLUS any **directly assigned site** (Site Access). Sites
without a branch are super-admin / direct-assignment only.

1. New shared guard **`site_access_allowed(p_site_id)`** — one place decides
   if the caller may view / mark / share a site (super admin, direct
   `admin_site` assignment, or the site belongs to a granted `admin_branch`).
2. **`get_month_attendance`** — an admin only sees records of employees who
   were at one of their granted sites on that date.
3. **`mark_attendance`** — same grant set for marking (idle days stay
   super-admin only).
4. **Share links** — `create_attendance_share_link`,
   `list_attendance_share_links`, `grant_attendance_share_edit` and the
   `share_link_select` RLS policy all follow the same grants.

UI changes that come with it: branch **grant/revoke toggles inside
Admin Management → Manage Permissions** (under the Branches menu), the
super-admin **Attendance page is branch-wise** (each branch a collapsible
row), and normal admins only see the sites + attendance granted to them.

**`20261112_branches.sql`** — REQUIRED for the Branches update (run after all
earlier migrations if you haven't already).

Run the whole file in Supabase → SQL Editor → New query → Run. It is
idempotent (`create or replace function`) and safe to re-run.

### `20261112_branches.sql` — branches, site owner branch & admin branch access

New **Branches** system: a branch owns multiple work sites
(`site.branch_id`, nullable), and normal admins only see the branches
assigned to them (`admin_branch`) while super admins see and manage
everything.

1. New tables `public.branch` and `public.admin_branch` (+ RLS: super admins
   read all branches, normal admins only their assigned ones).
2. `site.branch_id` column (FK → branch, `on delete set null` — deleting a
   branch leaves its sites as "no branch").
3. RPCs: `list_branches` (scoped, with site/employee counts),
   `create_branch`, `update_branch`, `delete_branch`, `set_site_branch`,
   `set_admin_branch`; `create_site` / `update_site` now accept `p_branch_id`.
4. `branch` + `admin_branch` added to the Realtime publication.

After running it: create branches on the new **Branches** page, assign sites
to them (Branches page or the site form), and grant branch access to normal
admins from **Admin Management → Branches** (GitBranch icon). Super admins
get a branch-wise collapsible Sites page automatically.

### `20261105d_payroll_camp_filters.sql` — earlier update (camp data for the Payroll filters)

`get_salary_sheet` (the shared Salary Sheet / Payroll read model) now also
returns **`camp_id` + `camp_name`** on every consolidated employee row, read
live from `employee.camp_id → camp.name`. This powers the new **camp
filter** on the Payroll page. Purely additive — no table or data changes.

### Earlier required migrations

**`20261105b_audit_employee_names.sql`** + **`20261105c_companies.sql`** —
run each whole file in the SQL Editor if not applied yet. Both are
idempotent and safe to re-run.

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

### Payroll

- **Full filter set — same as the Employees page**: **region** (Africans,
  Asians, Arabs/Middle East, …) cascading into **country**, plus **camp**
  (with a "No camp assigned" option), **trade** and **status** (Paid /
  Unpaid / Active / Working / Idle / Pending deletion). Search (name, ID,
  trade) stays; a Clear button resets everything.
- **Wider layout**: the page and the table now use the full width (matches
  the Attendance page) with roomier cells, so the ten columns no longer
  feel congested.
- **Hours tooltip is viewport-aware**: it flips below the row when there is
  no room above and never hides behind the sticky header/action bar.

### Employee Details

- **Space-managed two-column layout**: the left column stacks **Personal
  Information** over **Notices & Fines** (and the passport/ID documents);
  the tall **Professional Information** card (with salary eligibility) sits
  on the right with the record metadata below it.

### Add / Edit Employee

- The phone country-code dropdowns now **list only the dial codes**
  (+971, +966, +91, … — no country names), ordered Gulf → South Asia →
  South-East Asia → Africa, i.e. mostly African and Asian countries.
- **Emergency Contact** also gets the country-code dropdown.
- The note under the phone field was removed.

### Previous update (kept for reference)

#### Salary Sheet & Payroll

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

#### Employee Details (previous)

- The **Personal Information box is split in two** — the second card is
  **Notices & Fines**: the employee's warnings + fines, newest first, as a
  **carousel** (prev/next + dots + counter when there are several). Every
  slide **hyperlinks to that notification** — it opens the Notifications Hub
  straight on the Warnings or Fines tab.

#### Add / Edit Employee (previous)

- **Phone** now has a **country-code dropdown** (+971, +966, +91, … next to
  the local number; legacy "+code number" values are parsed back in, unknown
  codes fall back to "Other" and are preserved as typed).
- "Position (free text)" is now **"Position as per Visa"**.
- **Company Name is a dropdown** fed by the new companies table, with an
  inline **"+ Add New Company…"** option (created on the fly and selected
  automatically). Existing employee companies appear automatically.

#### Notifications Hub (previous)

- Tabs are deep-linkable — the Notices & Fines card on Employee Details
  jumps straight to the right tab; the sidebar always opens the Requests
  tab.
