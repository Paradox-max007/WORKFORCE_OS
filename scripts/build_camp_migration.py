#!/usr/bin/env python3
"""Build 20261105d migration: get_salary_sheet returns camp_id/camp_name per
employee (Payroll camp filter), and patch supabase/schema.sql in place.

Reads the LATEST get_salary_sheet definition from supabase/schema.sql,
injects the camp join + json fields into the consolidated employees query,
writes supabase/migrations/20261105d_payroll_camp_filters.sql and rewrites
the same function inside supabase/schema.sql.
"""
import re
from pathlib import Path

ROOT = Path('/home/z/my-project')
SCHEMA = ROOT / 'supabase/schema.sql'
MIGRATION = ROOT / 'supabase/migrations/20261105d_payroll_camp_filters.sql'

sql = SCHEMA.read_text()

# ---- locate the latest get_salary_sheet definition -------------------------
start_marker = 'create or replace function public.get_salary_sheet(p_year int, p_month int)'
start = sql.rindex(start_marker)          # last definition = the live one
end_marker = 'end; $$;'
end = sql.index(end_marker, start) + len(end_marker)
fn = sql[start:end]

# ---- 1. json fields: camp after 'status', e.status, (employees section) ----
# The consolidated employees block contains 'status', e.status, — only there
# (site groups/idle rows have no 'status' key).
needle = "    'status', e.status,\n"
assert fn.count(needle) == 1, f"expected 1 status needle, got {fn.count(needle)}"
fn_new = fn.replace(
    needle,
    "    'status', e.status,\n"
    "    'camp_id', e.camp_id,\n"
    "    'camp_name', c.name,\n",
)

# ---- 2. join: add camp join to the employees FROM clause --------------------
join_needle = (
    "  from public.payroll_employee pe\n"
    "  join public.employee e on e.id = pe.employee_id\n"
    "  left join public.trades t on t.id = pe.trade_id_snapshot\n"
    "  where pe.payroll_period_id = v_period.id;\n"
)
assert fn_new.count(join_needle) == 1, f"expected 1 join needle, got {fn_new.count(join_needle)}"
fn_new = fn_new.replace(
    join_needle,
    "  from public.payroll_employee pe\n"
    "  join public.employee e on e.id = pe.employee_id\n"
    "  left join public.trades t on t.id = pe.trade_id_snapshot\n"
    "  left join public.camp c on c.id = e.camp_id\n"
    "  where pe.payroll_period_id = v_period.id;\n",
)

# sanity: the camp fields must exist exactly once each in the new function
assert fn_new.count("'camp_id', e.camp_id") == 1
assert fn_new.count('left join public.camp c on c.id = e.camp_id') == 1

header = """-- ============================================================================
-- PULSE Workforce OS — 20261105d: camp data for the Payroll filters
-- ----------------------------------------------------------------------------
-- The Payroll page gets the SAME filter set as the Employees page (region,
-- country, camp, trade, status). Region/country/trade/status are already in
-- the payload — camp is not, so get_salary_sheet now also returns the
-- employee's accommodation camp on every consolidated employee row:
--
--   camp_id   uuid  — employee.camp_id (null when no camp is assigned)
--   camp_name text  — camp.name at read time (label for the filter dropdown)
--
-- Purely additive: no table, no data change, no permission change. The
-- function is recreated in full (create or replace) — idempotent, safe to
-- re-run. Demo mode mirrors the same fields in src/lib/data/demo-salary.ts.
-- ============================================================================

"""

MIGRATION.write_text(header + fn_new + '\n')

# ---- patch schema.sql in place ---------------------------------------------
SCHEMA.write_text(sql[:start] + fn_new + sql[end:])

print(f'migration written: {MIGRATION} ({len((header + fn_new).splitlines())} lines)')
print('schema.sql patched in place')
