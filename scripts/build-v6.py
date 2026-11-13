#!/usr/bin/env python3
"""Build get_salary_sheet v6 = migration d's v4 body (time card fields +
rich idle rows) + migration e's advance-book fields, and insert it into
20261113f before the grants section (replacing any previous v6 insert)."""
import re

ROOT = '/home/z/my-project'
D = f'{ROOT}/supabase/migrations/20261113d_time_card_net_payable.sql'
F = f'{ROOT}/supabase/migrations/20261113f_time_card_carryover_book.sql'

src = open(D).read()
pat = re.compile(r'create or replace function public\.get_salary_sheet\(.*?\nend; \$\$;', re.S)
defs = pat.findall(src)
v4 = defs[-1]

# insert the advance-book fields right after the 'advance' field (v5 placement)
anchor = "    'advance', pe.advance,\n"
addition = """    'advance_book_applied', pe.advance_book_applied,
    'advance_book_due', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'amount', r.amount, 'given_date', r.given_date,
        'cut_year', r.cut_year, 'cut_month', r.cut_month, 'note', r.note)
        order by r.cut_year, r.cut_month, r.created_at), '[]'::jsonb)
      from public.advance_record r
      where r.employee_id = pe.employee_id
        and not exists (
          select 1 from public.payroll_period p2
          join public.payroll_employee pe2
            on pe2.payroll_period_id = p2.id and pe2.employee_id = r.employee_id
          where p2.year = r.cut_year and p2.month = r.cut_month
            and pe2.payment_status = 'paid'
            and r.applied_amount > 0)),
"""
assert src.count(anchor) >= 1 and anchor in v4, 'anchor not found in v4'
v6 = v4.replace(anchor, anchor + addition, 1)
assert v6 != v4 and 'advance_book_due' in v6

header = """-- ---------------------------------------------------------------------------
-- 3b. get_salary_sheet v6 — REPAIRS a regression of 20261113e: its v5 was
--     built from a pre-20261113d body and silently DROPPED
--       • the per-employee time_card_hours / time_card_amount fields and the
--         per-site time_card_total / time_card_amount_total (20261113d)
--       • the Idle Employees no-site HOURS rows (the (a) part of the group)
--     v6 restores them and KEEPS the advance-book fields of v5
--     (advance_book_applied / advance_book_due). Body = v4 + book fields.
-- ---------------------------------------------------------------------------
"""

mig = open(F).read()
marker = '-- ---------------------------------------------------------------------------\n-- 4. DATA MIGRATION'
if 'get_salary_sheet v6' in mig:
    # replace the previous v6 block (between its header and the section-4 marker)
    start = mig.index('-- ---------------------------------------------------------------------------\n-- 3b. get_salary_sheet v6')
    end = mig.index(marker)
    mig = mig[:start] + header + v6 + '\n\n' + mig[end:]
else:
    idx = mig.index(marker)
    mig = mig[:idx] + header + v6 + '\n\n' + mig[idx:]
open(F, 'w').write(mig)
print(f'v6 inserted: {len(v6.splitlines())} lines')
print('time_card fields:', v6.count("'time_card_hours'"), '| advance_book fields:', v6.count('advance_book_'))
