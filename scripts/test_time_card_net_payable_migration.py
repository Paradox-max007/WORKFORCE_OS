#!/usr/bin/env python3
"""
Local-PostgreSQL verification of 20261113d_time_card_net_payable.sql.

Context: the migration failed to apply on Supabase with
    ERROR: 42601: syntax error at or near "("
    LINE 209:  raise exception (
PL/pgSQL's RAISE does not take a parenthesised argument list — the message
format string follows the level directly. The file was fixed to
    raise exception '...', v_next_month_name;
and this script verifies the corrected migration end to end:

  CHAIN   shim → full schema → seed admins → 20261113c → FIXED 20261113d →
          20261113e → 20261113f (the carryover now goes through the
          Advance Book — see test_carryover_book_migration.py for the deep
          coverage)
  ID      the migration re-runs cleanly (idempotency)
  T1      negative time-card difference → a normal ADVANCE BOOK record
          (amount 104, cut = the very next month, note, from_time_card)
          + carryover_applied tracking + audit row + the Nov period
  T2      re-saving updates the record (104 → 130); generating Nov folds it
          into that month's Advance column (advance 130 / applied 130)
  T3      next period finalized → the (fixed) RAISE EXCEPTION fires and the
          whole save rolls back
  T4      get_salary_sheet v4 exposes time_card_hours / time_card_amount on
          employee rows + time_card totals on the site group

Everything runs inside ONE process because the sandbox reaps background
servers between shell calls.
"""
import os
import shutil
import subprocess
import sys

ROOT = '/home/z/my-project'
SCRIPTS = os.path.join(ROOT, 'scripts')
PGDATA = os.path.join(SCRIPTS, 'pgdata_tc_test')

import pgserver  # noqa: E402

PSQL = os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin', 'psql')
MIG = os.path.join(ROOT, 'supabase', 'migrations')

subprocess.run(['pkill', '-f', 'pgdata_tc_test'], capture_output=True)  # stale runs
shutil.rmtree(PGDATA, ignore_errors=True)
server = pgserver.get_server(PGDATA, cleanup_mode='stop')
base_uri = server.get_uri('postgres')
if subprocess.run([PSQL, base_uri, '-tAc',
                   "select 1 from pg_database where datname = 'pulse_tc_test'"],
                  capture_output=True, text=True).stdout.strip() != '1':
    subprocess.run([PSQL, base_uri, '-q', '-c', 'create database pulse_tc_test'],
                   check=True, capture_output=True, text=True)
uri = server.get_uri('pulse_tc_test')


def run(files=(), sql=None, expect_fail=None):
    args = [PSQL, uri, '-q', '-v', 'ON_ERROR_STOP=1']
    for f in files:
        args += ['-f', f]
    if sql:
        args += ['-c', sql]
    r = subprocess.run(args, capture_output=True, text=True, timeout=240)
    if expect_fail:
        ok = r.returncode != 0 and expect_fail in (r.stderr or '')
        return ok, r
    return r.returncode == 0, r


results = []


def step(name, ok, detail=''):
    results.append(ok)
    print(('  OK  ' if ok else '  FAIL') + ' ' + name + ('' if ok else f'\n{detail}'))


print('== 20261113d time card net payable migration verification (local PostgreSQL) ==')

# ---- load the chain ---------------------------------------------------------
with open(os.path.join(ROOT, 'supabase', 'schema.sql')) as f:
    schema = f.read()
schema = schema.replace('create extension if not exists pgcrypto;',
                        '-- (pgcrypto skipped locally — gen_random_uuid() is core SQL)')
with open(os.path.join(SCRIPTS, 'schema_local.sql'), 'w') as f:
    f.write(schema)

for name, files in [
    ('load Supabase shims', [os.path.join(SCRIPTS, 'test_shim.sql')]),
    ('load full schema', [os.path.join(SCRIPTS, 'schema_local.sql')]),
    ('seed super admin + plain admin', [os.path.join(SCRIPTS, 'test_seed.sql')]),
    ('run 20261113c (payroll time card base)',
     [os.path.join(MIG, '20261113c_payroll_time_card.sql')]),
    ('run FIXED 20261113d (user-reported 42601 near "(" must be gone)',
     [os.path.join(MIG, '20261113d_time_card_net_payable.sql')]),
    ('re-run 20261113d (idempotency)',
     [os.path.join(MIG, '20261113d_time_card_net_payable.sql')]),
    ('run 20261113e (advance book)',
     [os.path.join(MIG, '20261113e_advance_book.sql')]),
    ('run 20261113f (carryover → advance book)',
     [os.path.join(MIG, '20261113f_time_card_carryover_book.sql')]),
]:
    ok, r = run(files)
    step(name, ok, r.stderr[-3000:])

SUPER = '00000000-0000-0000-0000-0000000000aa'   # test_seed super admin

# ---------------------------------------------------------------------------
# fixtures — site + trade (qualified standard = 13/h) + two employees with
# 2 × 10 h attendance in Oct 2026 → 20 h each, gross 20 × 13 = 260 each
# ---------------------------------------------------------------------------
FIXTURES = f"""
set app.current_uid = '{SUPER}';
do $$
declare s1 uuid; r jsonb; e public.employee;
begin
  insert into public.site (name) values ('Time Card Tower') returning id into s1;

  r := public.create_trade('Electrician TC', 'wiring', jsonb_build_array(
    jsonb_build_object('salary_role','standard','experience_tier','below_threshold','hourly_rate',8),
    jsonb_build_object('salary_role','standard','experience_tier','qualified','hourly_rate',13),
    jsonb_build_object('salary_role','team_leader','experience_tier','below_threshold','hourly_rate',10),
    jsonb_build_object('salary_role','team_leader','experience_tier','qualified','hourly_rate',15),
    jsonb_build_object('salary_role','supervisor','experience_tier','below_threshold','hourly_rate',12),
    jsonb_build_object('salary_role','supervisor','experience_tier','qualified','hourly_rate',18)
  ), true);

  select * into e from public.create_employee(jsonb_build_object(
    'full_name','Ada Negative','join_date','2026-01-01','opening_hours','1500',
    'current_site_id', s1, 'trade_id', (r->>'id')::uuid,
    'salary_role','standard','position','Electrician'));

  select * into e from public.create_employee(jsonb_build_object(
    'full_name','Cy Positive','join_date','2026-01-01','opening_hours','1500',
    'current_site_id', s1, 'trade_id', (r->>'id')::uuid,
    'salary_role','standard','position','Electrician'));
end $$;

insert into public.attendance (employee_id, date, status, hours)
select e.id, d.dt, 'present', 10
from public.employee e
cross join (values (date '2026-10-05'), (date '2026-10-20')) as d(dt)
where e.full_name in ('Ada Negative', 'Cy Positive');

select public.generate_payroll_period(2026, 10) is not null as generated;
"""
ok, r = run(sql=FIXTURES)
step('fixtures + generate draft payroll (Oct 2026)',
     ok and 'generated' in (r.stdout or ''), (r.stderr or '')[-2500:])

# fixture sanity — both employees 20 h × 13 = 260 gross
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare n int; mn numeric; mx numeric;
begin
  select count(*), min(pe.gross_salary), max(pe.gross_salary) into n, mn, mx
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 10;
  if n <> 2 or mn <> 260 or mx <> 260 then
    raise exception 'FAIL fixtures: n=% min=% max=% (expected 2 × 260)', n, mn, mx;
  end if;
end $$;
""")
step('fixture sanity — 2 employees, 260 gross each', ok, r.stderr[-1500:])

# ---------------------------------------------------------------------------
# T1 — negative difference: time card 12 h vs attendance 20 h
#      extra = (12 − 20) × 13 = −104 → an advance book record of 104 with
#      the DEFAULT CUT MONTH = the very next month (Nov 2026)
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  v_period uuid; v_site uuid; v_emp uuid; v_next uuid;
  v_rec public.advance_record; v_applied numeric; n int;
begin
  select p.id into v_period from public.payroll_period p where p.year = 2026 and p.month = 10;
  select s.id into v_site from public.site s where s.name = 'Time Card Tower';
  select e.id into v_emp from public.employee e where e.full_name = 'Ada Negative';

  perform public.save_site_time_card_hours(v_period, v_site,
    jsonb_build_array(jsonb_build_object('employee_id', v_emp, 'hours', '12')));

  select p.id into v_next from public.payroll_period p where p.year = 2026 and p.month = 11;
  if v_next is null then raise exception 'FAIL T1: Nov 2026 payroll period was not created'; end if;

  select * into v_rec from public.advance_record
  where employee_id = v_emp and source_period_id = v_period;
  if v_rec.id is null then raise exception 'FAIL T1: no advance book record for Ada'; end if;
  if v_rec.amount <> 104 or v_rec.cut_year <> 2026 or v_rec.cut_month <> 11 then
    raise exception 'FAIL T1: record amount=% cut=%/% (expected 104 / 2026-11)',
      v_rec.amount, v_rec.cut_year, v_rec.cut_month;
  end if;
  if v_rec.note is null or v_rec.note not like '[Time card Oct 2026] time card 12.00 h vs attendance 20.00 h%'
    or v_rec.note not like '%cutting from Nov 2026%'
    then raise exception 'FAIL T1: carryover note = "%"', v_rec.note; end if;

  select tc.carryover_applied into v_applied from public.payroll_time_card tc
  where tc.payroll_period_id = v_period and tc.employee_id = v_emp;
  if v_applied is null or v_applied <> 104 then
    raise exception 'FAIL T1: carryover_applied=% (expected 104)', v_applied;
  end if;

  select count(*) into n from public.payroll_audit_log
  where period_id = v_period and action = 'time_card_carryover';
  if n < 1 then raise exception 'FAIL T1: no time_card_carryover audit row'; end if;
end $$;
""")
step('T1 negative difference → advance book record 104 cut Nov 2026 (+note, tracking, audit)',
     ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# T2 — re-save with 10 h: needed = |(10 − 20) × 13| = 130 → the record is
#      updated to 130; generating Nov folds it into the Advance column
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  v_period uuid; v_site uuid; v_emp uuid; v_next uuid;
  v_rec public.advance_record; v_applied numeric; v_adv numeric; v_book numeric;
begin
  select p.id into v_period from public.payroll_period p where p.year = 2026 and p.month = 10;
  select s.id into v_site from public.site s where s.name = 'Time Card Tower';
  select e.id into v_emp from public.employee e where e.full_name = 'Ada Negative';

  perform public.save_site_time_card_hours(v_period, v_site,
    jsonb_build_array(jsonb_build_object('employee_id', v_emp, 'hours', '10')));

  select * into v_rec from public.advance_record
  where employee_id = v_emp and source_period_id = v_period;
  if v_rec.amount <> 130 then raise exception 'FAIL T2: record amount=% (expected 130)', v_rec.amount; end if;
  if v_rec.note is null or v_rec.note not like '[Time card Oct 2026] time card 10.00 h vs attendance 20.00 h%'
    then raise exception 'FAIL T2: carryover note = "%"', v_rec.note; end if;

  select tc.carryover_applied into v_applied from public.payroll_time_card tc
  where tc.payroll_period_id = v_period and tc.employee_id = v_emp;
  if v_applied <> 130 then
    raise exception 'FAIL T2: carryover_applied=% (expected 130)', v_applied;
  end if;

  -- generating the next month folds the record into its Advance column
  perform public.generate_payroll_period(2026, 11);
  select p.id into v_next from public.payroll_period p where p.year = 2026 and p.month = 11;
  select pe.advance, pe.advance_book_applied into v_adv, v_book
  from public.payroll_employee pe
  where pe.payroll_period_id = v_next and pe.employee_id = v_emp;
  if v_adv <> 130 or v_book <> 130 then
    raise exception 'FAIL T2: Nov advance=% applied=% (expected 130/130)', v_adv, v_book;
  end if;
end $$;
""")
step('T2 re-save updates the record to 130; generating Nov folds it in (130 / 130)',
     ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# T3 — next month finalized → the FIXED raise exception must fire and the
#      whole save must roll back
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare v_next uuid;
begin
  select p.id into v_next from public.payroll_period p where p.year = 2026 and p.month = 11;
  perform public.finalize_payroll_period(v_next);
end $$;
""")
step('T3a finalize the Nov 2026 payroll period', ok, r.stderr[-1500:])

ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select public.save_site_time_card_hours(
  (select p.id from public.payroll_period p where p.year = 2026 and p.month = 10),
  (select s.id from public.site s where s.name = 'Time Card Tower'),
  jsonb_build_array(jsonb_build_object(
    'employee_id', (select e.id from public.employee e where e.full_name = 'Ada Negative'),
    'hours', '8')));
""", expect_fail='already finalized')
step('T3b carryover change on a finalized next period raises (the fixed RAISE)', ok,
     'did NOT get the expected "already finalized" error\n' + (r.stdout or '')[-400:]
     + (r.stderr or '')[-1500:])

ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  v_period uuid; v_emp uuid; v_next uuid;
  v_h numeric; v_applied numeric; v_adv numeric; v_amt numeric;
begin
  select p.id into v_period from public.payroll_period p where p.year = 2026 and p.month = 10;
  select e.id into v_emp from public.employee e where e.full_name = 'Ada Negative';
  select p.id into v_next from public.payroll_period p where p.year = 2026 and p.month = 11;

  select tc.time_card_hours, tc.carryover_applied into v_h, v_applied
  from public.payroll_time_card tc
  where tc.payroll_period_id = v_period and tc.employee_id = v_emp;
  if v_h is null or v_h <> 10 or v_applied is null or v_applied <> 130 then
    raise exception 'FAIL T3: entry hours=% applied=% (expected 10 / 130 — full rollback)', v_h, v_applied;
  end if;

  select amount into v_amt from public.advance_record
  where employee_id = v_emp and source_period_id = v_period;
  if v_amt is null or v_amt <> 130 then
    raise exception 'FAIL T3: record amount=% (expected 130 — rollback)', v_amt;
  end if;

  select pe.advance into v_adv from public.payroll_employee pe
  where pe.payroll_period_id = v_next and pe.employee_id = v_emp;
  if v_adv is null or v_adv <> 130 then
    raise exception 'FAIL T3: Nov advance=% (expected 130 — rollback)', v_adv;
  end if;
end $$;
""")
step('T3c failed save rolled back completely (entry + record + advance untouched)', ok, r.stderr[-1500:])

# ---------------------------------------------------------------------------
# T4 — positive difference: Cy time card 24 h vs attendance 20 h → +52 shows
#      in the salary sheet (NO carryover); Ada shows −130 (10 h vs 20 h)
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  v_period uuid; v_site uuid; v_emp uuid;
  sheet jsonb; emp_row jsonb; grp jsonb; n int;
begin
  select p.id into v_period from public.payroll_period p where p.year = 2026 and p.month = 10;
  select s.id into v_site from public.site s where s.name = 'Time Card Tower';
  select e.id into v_emp from public.employee e where e.full_name = 'Cy Positive';

  perform public.save_site_time_card_hours(v_period, v_site,
    jsonb_build_array(jsonb_build_object('employee_id', v_emp, 'hours', '24')));

  -- positive difference → no carryover record for Cy (the Nov row may
  -- exist from the T2 generation — what matters is the advance stays 0)
  select count(*) into n from public.advance_record
  where employee_id = v_emp and source_period_id = v_period;
  if n <> 0 then raise exception 'FAIL T4: positive difference must not create an advance book record'; end if;
  select count(*) into n from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = v_emp
    and pe.advance <> 0;
  if n <> 0 then raise exception 'FAIL T4: positive difference must not touch the Nov advance'; end if;

  sheet := public.get_salary_sheet(2026, 10);

  emp_row := (select x from jsonb_array_elements(sheet->'employees') x
              where x->>'full_name' = 'Cy Positive');
  if emp_row is null then raise exception 'FAIL T4: Cy missing from the sheet'; end if;
  if coalesce((emp_row->>'time_card_hours')::numeric, -1) <> 24 then
    raise exception 'FAIL T4: Cy time_card_hours=% (expected 24)', emp_row->>'time_card_hours';
  end if;
  if coalesce((emp_row->>'time_card_amount')::numeric, -1) <> 52 then
    raise exception 'FAIL T4: Cy time_card_amount=% (expected 52)', emp_row->>'time_card_amount';
  end if;

  emp_row := (select x from jsonb_array_elements(sheet->'employees') x
              where x->>'full_name' = 'Ada Negative');
  if coalesce((emp_row->>'time_card_amount')::numeric, 0) <> -130 then
    raise exception 'FAIL T4: Ada time_card_amount=% (expected -130)', emp_row->>'time_card_amount';
  end if;

  grp := (select x from jsonb_array_elements(sheet->'sites') x
          where x->>'site_name' = 'Time Card Tower');
  if grp is null then raise exception 'FAIL T4: site group missing from the sheet'; end if;
  if coalesce((grp->>'time_card_total')::numeric, -1) <> 34 then
    raise exception 'FAIL T4: site time_card_total=% (expected 34)', grp->>'time_card_total';
  end if;
  if coalesce((grp->>'time_card_amount_total')::numeric, 0) <> -78 then
    raise exception 'FAIL T4: site time_card_amount_total=% (expected -78)', grp->>'time_card_amount_total';
  end if;
end $$;
""")
step('T4 salary sheet v4: time_card amounts per employee + site group totals', ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
print()
passed = sum(results)
print(f'== {passed}/{len(results)} steps passed ==')
if passed != len(results):
    sys.exit(1)
