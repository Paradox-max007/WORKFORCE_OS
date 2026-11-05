#!/usr/bin/env python3
"""
Local-PostgreSQL verification of 20261105b_audit_employee_names.sql and
20261105c_companies.sql.

Loads the full chain (shim → full schema incl. the new sections → seed), then
functionally verifies:

  C1  company table exists; create_company works (super admin) & selects
  C2  create_company duplicate name → rejected
  C3  create_company without the employees permission → Access denied
  C4  20261105c re-run seeds companies from existing employees (idempotent)
  A1  mark_employee_salary_paid audit shows NAME (CODE), no raw UUID
  A2  unmark_employee_salary_paid audit shows NAME (CODE), no raw UUID
  A3  reset_payroll_employee_auto audit shows NAME (CODE), no raw UUID
  A4  backfill — a legacy audit row with a raw employee UUID is rewritten
  ID  both migrations re-run cleanly (idempotency)

Everything runs inside ONE process because the sandbox reaps background
servers between shell calls.
"""
import os
import shutil
import subprocess
import sys

ROOT = '/home/z/my-project'
SCRIPTS = os.path.join(ROOT, 'scripts')
PGDATA = os.path.join(SCRIPTS, 'pgdata_audit_test')

import pgserver  # noqa: E402

PSQL = os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin', 'psql')
MIG = os.path.join(ROOT, 'supabase', 'migrations')

subprocess.run(['pkill', '-f', 'pgdata_audit_test'], capture_output=True)  # stale runs
shutil.rmtree(PGDATA, ignore_errors=True)
server = pgserver.get_server(PGDATA, cleanup_mode='stop')
base_uri = server.get_uri('postgres')
if subprocess.run([PSQL, base_uri, '-tAc',
                   "select 1 from pg_database where datname = 'pulse_audit_test'"],
                  capture_output=True, text=True).stdout.strip() != '1':
    subprocess.run([PSQL, base_uri, '-q', '-c', 'create database pulse_audit_test'],
                   check=True, capture_output=True, text=True)
uri = server.get_uri('pulse_audit_test')


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


print('== 20261105b/c audit-names + companies migration verification (local PostgreSQL) ==')

# ---- load the chain ---------------------------------------------------------
with open(os.path.join(ROOT, 'supabase', 'schema.sql')) as f:
    schema = f.read()
schema = schema.replace('create extension if not exists pgcrypto;',
                        '-- (pgcrypto skipped locally — gen_random_uuid() is core SQL)')
with open(os.path.join(SCRIPTS, 'schema_local.sql'), 'w') as f:
    f.write(schema)

for name, files in [
    ('load Supabase shims', [os.path.join(SCRIPTS, 'test_shim.sql')]),
    ('load full schema (incl. 20261105b/c sections)', [os.path.join(SCRIPTS, 'schema_local.sql')]),
    ('seed super admin + plain admin', [os.path.join(SCRIPTS, 'test_seed.sql')]),
]:
    ok, r = run(files)
    step(name, ok, r.stderr[-3000:])

# idempotency — the migration files re-run on top of the loaded schema
ok, r = run([os.path.join(MIG, '20261105b_audit_employee_names.sql')])
step('re-run 20261105b (idempotency)', ok, r.stderr[-2000:])
ok, r = run([os.path.join(MIG, '20261105c_companies.sql')])
step('re-run 20261105c (idempotency)', ok, r.stderr[-2000:])

# ---- fixtures ----------------------------------------------------------------
ok, r = run(sql=r"""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
drop table if exists tt;
create temp table tt (key text primary key, val text);
do $$
declare s1 uuid; r jsonb; emp public.employee;
begin
  insert into public.site (name) values ('Audit Test Tower') returning id into s1;
  insert into tt values ('s1', s1::text);

  r := public.create_trade('Electrician', 'wiring', jsonb_build_array(
    jsonb_build_object('salary_role','standard','experience_tier','below_threshold','hourly_rate',8),
    jsonb_build_object('salary_role','standard','experience_tier','qualified','hourly_rate',13),
    jsonb_build_object('salary_role','team_leader','experience_tier','below_threshold','hourly_rate',10),
    jsonb_build_object('salary_role','team_leader','experience_tier','qualified','hourly_rate',15),
    jsonb_build_object('salary_role','supervisor','experience_tier','below_threshold','hourly_rate',12),
    jsonb_build_object('salary_role','supervisor','experience_tier','qualified','hourly_rate',18)
  ), true);
  insert into tt values ('trade_elec', r->>'id');

  select * into emp from public.create_employee(jsonb_build_object(
    'full_name','Ada Audit','join_date','2026-01-01','opening_hours','1500',
    'company_name','Acme Contracting',
    'current_site_id',(select val from tt where key='s1'),
    'trade_id',(select val from tt where key='trade_elec'),
    'salary_role','standard','position','Electrician'));
  insert into tt values ('emp_a', emp.id::text);
end $$;

insert into public.attendance (employee_id, date, status, hours) values
  ((select val::uuid from tt where key='emp_a'), date '2026-10-05', 'present', 10),
  ((select val::uuid from tt where key='emp_a'), date '2026-10-20', 'present', 10);

select public.generate_payroll_period(2026, 10) is not null as generated;
""")
step('fixtures + generate draft payroll (Oct 2026)', ok and 'generated' in (r.stdout or ''),
     (r.stderr or '')[-2500:])

# ---- C1 create_company works --------------------------------------------------
ok, r = run(sql=r"""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
do $$
declare c public.company;
begin
  c := public.create_company('Gulf Contracting LLC');
  if c.name is distinct from 'Gulf Contracting LLC' or c.id is null then
    raise exception 'FAIL C1: bad company %', c;
  end if;
  raise notice 'PASS C1: created %', c.name;
end $$;
""")
step('C1 create_company (super admin)', ok, r.stderr[-1500:])

# ---- C2 duplicate rejected ------------------------------------------------------
ok, r = run(sql="""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
select public.create_company('Gulf Contracting LLC');
""", expect_fail='already exists')
step('C2 duplicate company name rejected', ok, r.stderr[-600:])

# ---- C3 permission check --------------------------------------------------------
ok, r = run(sql="""
set app.current_uid = '00000000-0000-0000-0000-0000000000bb';
select public.create_company('Sneaky Co');
""", expect_fail='Access denied')
step('C3 create_company without permission → Access denied', ok, r.stderr[-600:])

# ---- C4 re-run 20261105c seeds companies from employees ------------------------
ok, r = run([os.path.join(MIG, '20261105c_companies.sql')])
ok2 = run(sql="select count(*)::int from public.company where name = 'Acme Contracting';")
step("C4 re-seed picks up the employee's company",
     ok and ok2[0] and '1' in (ok2[1].stdout or ''), (r.stderr or '')[-800:] + (ok2[1].stderr or '')[-400:])

# ---- A1 mark paid audit shows NAME (CODE) --------------------------------------
ok, r = run(sql=r"""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
do $$
declare pe_id uuid; d text;
begin
  select pe.id into pe_id from public.payroll_employee pe
    join public.payroll_period p on p.id = pe.payroll_period_id
    join public.employee e on e.id = pe.employee_id
    where e.full_name = 'Ada Audit' and p.year = 2026 and p.month = 10;
  perform public.mark_employee_salary_paid(pe_id);
  select details into d from public.payroll_audit_log
    where action = 'payment' order by created_at desc limit 1;
  if d not like 'Ada Audit (%' or d not like '%marked paid' then raise exception 'FAIL A1: details=%', d; end if;
  if d ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}' then raise exception 'FAIL A1: raw uuid leaked: %', d; end if;
  raise notice 'PASS A1: %', d;
end $$;
""")
step('A1 mark paid audit = "Ada Audit (PUL-…)"', ok, r.stderr[-1500:])

# ---- A2 unmark audit shows NAME (CODE) ------------------------------------------
ok, r = run(sql=r"""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
do $$
declare pe_id uuid; d text;
begin
  select pe.id into pe_id from public.payroll_employee pe
    join public.payroll_period p on p.id = pe.payroll_period_id
    join public.employee e on e.id = pe.employee_id
    where e.full_name = 'Ada Audit' and p.year = 2026 and p.month = 10;
  perform public.unmark_employee_salary_paid(pe_id, 'test revert');
  select details into d from public.payroll_audit_log
    where action = 'unpayment' order by created_at desc limit 1;
  if d not like 'Ada Audit (%' or d not like '%reverted to unpaid%' then raise exception 'FAIL A2: details=%', d; end if;
  if d not like '%test revert' then raise exception 'FAIL A2: reason missing: %', d; end if;
  raise notice 'PASS A2: %', d;
end $$;
""")
step('A2 unmark audit = "Ada Audit (PUL-…) reverted — reason"', ok, r.stderr[-1500:])

# ---- A3 manual edit + reset_auto audit shows NAME (CODE) ------------------------
ok, r = run(sql=r"""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
do $$
declare pe_id uuid; d text;
begin
  select pe.id into pe_id from public.payroll_employee pe
    join public.payroll_period p on p.id = pe.payroll_period_id
    join public.employee e on e.id = pe.employee_id
    where e.full_name = 'Ada Audit' and p.year = 2026 and p.month = 10;

  update public.payroll_employee set manually_edited = true where id = pe_id;
  perform public.reset_payroll_employee_auto(pe_id);
  select details into d from public.payroll_audit_log
    where action = 'reset_auto' order by created_at desc limit 1;
  if d not like 'Salary sheet row of Ada Audit (%' then
    raise exception 'FAIL A3: details=%', d;
  end if;
  raise notice 'PASS A3: %', d;
end $$;
""")
step('A3 reset_auto audit = "Salary sheet row of Ada Audit (PUL-…)"', ok, r.stderr[-1500:])

# ---- A4 backfill rewrites legacy UUID audit rows --------------------------------
ok, r = run(sql=r"""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
insert into public.payroll_audit_log (period_id, action, actor_id, actor_name, details)
select p.id, 'payment', null, 'Legacy', 'Employee ' || e.id || ' marked paid'
from public.employee e, public.payroll_period p
where e.full_name = 'Ada Audit' and p.year = 2026 and p.month = 10;
""")
ok2, r2 = run([os.path.join(MIG, '20261105b_audit_employee_names.sql')])
ok3, r3 = run(sql=r"""
do $$
declare d text;
begin
  select details into d from public.payroll_audit_log
    where actor_name = 'Legacy' limit 1;
  if d not like 'Employee Ada Audit (%' then raise exception 'FAIL A4: details=%', d; end if;
  if d ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}' then raise exception 'FAIL A4: uuid leaked: %', d; end if;
  raise notice 'PASS A4: %', d;
end $$;
""")
step('A4 backfill rewrites legacy "Employee <uuid>" audit rows',
     ok and ok2 and ok3, (r.stderr or '')[-500:] + (r2.stderr or '')[-800:] + (r3.stderr or '')[-800:])

# ---- summary -------------------------------------------------------------------
print()
passed = sum(results)
print(f'== RESULT: {passed}/{len(results)} checks passed ==')
sys.exit(0 if passed == len(results) else 1)
