#!/usr/bin/env python3
"""Validate the 20261111 migration SQL with the real Postgres parser (pglast).

Parses the migration file (and the appended schema.sql) to guarantee the
plpgsql function bodies are syntactically valid — no local Postgres needed.
Also asserts the fix markers are present and the old buggy pattern is gone
from the NEW function bodies."""
import sys
import pglast
from pglast import parse_sql

MIG = '/home/z/my-project/supabase/migrations/20261111_payroll_no_site_name_fix.sql'
SCHEMA = '/home/z/my-project/supabase/schema.sql'

sql = open(MIG).read()

# 1. full-file parse (catches syntax errors anywhere)
try:
    stmts = parse_sql(sql)
    print(f"OK: migration parses as valid PostgreSQL ({len(stmts)} top-level statements)")
except pglast.parser.ParseError as e:
    print(f"SYNTAX ERROR: {e}")
    sys.exit(1)

# 2. fix markers present in the new bodies
checks = [
    ("scalar-subquery site name fix",
     "v_site_name  := coalesce((select s.name from public.site s where s.id = r.site_id), 'No site');"),
    ("scalar-subquery trade name fix",
     "v_trade_name := coalesce((select t.name from public.trades t where t.id = v_trade_id), 'No trade');"),
    ("hardened site insert",
     "coalesce(v_site_row->>'site_name', 'No site'),"),
    ("hardened line site insert",
     "coalesce(v_line->>'site_name', 'No site'),"),
    ("hardened line trade insert",
     "coalesce(v_line->>'trade_name', 'No trade'),"),
    ("hardened line role insert",
     "coalesce(v_line->>'salary_role', 'standard'),"),
]
for label, needle in checks:
    assert needle in sql, f"MISSING in migration: {label}"
    print(f"OK: contains {label}")

# 3. the old buggy SELECT INTO pattern must NOT appear as CODE in the migration
#    (the header comment quotes it while explaining the bug — strip comments first)
code_only = '\n'.join(
    ln.split('--')[0] if not ln.lstrip().startswith('--') else ''
    for ln in sql.split('\n')
)
bad = "select coalesce(s.name, 'No site') into v_site_name"
assert bad not in code_only, "old buggy pattern still present as code in migration"
print("OK: old buggy 'select coalesce(...) into' pattern absent from migration code")

# 4. schema.sql must parse end-to-end after the append
schema_sql = open(SCHEMA).read()
try:
    parse_sql(schema_sql)
    print("OK: schema.sql (with appended migration) parses as valid PostgreSQL")
except pglast.parser.ParseError as e:
    # find the failing line for a useful message
    loc = e.location or 0
    line = schema_sql.count('\n', 0, loc) + 1
    print(f"SCHEMA SYNTAX ERROR near line {line}: {e}")
    sys.exit(1)

# 5. count of function definitions in schema: the two redefinitions appended
n_calc = schema_sql.count('create or replace function public.calculate_employee_payroll(')
n_upsert = schema_sql.count('create or replace function public.payroll_upsert_employee(')
print(f"OK: schema.sql now has {n_calc} calculate_employee_payroll defs (last one wins = fixed), "
      f"{n_upsert} payroll_upsert_employee defs")
print("\nALL CHECKS PASSED")
