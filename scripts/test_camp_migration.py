#!/usr/bin/env python3
"""
Local-PostgreSQL verification of 20261105d_payroll_camp_filters.sql.

Loads the full chain (shim → full schema incl. the camp-fields section →
seed), then functionally verifies:

  C1  get_salary_sheet employees rows carry camp_id/camp_name matching
      employee.camp_id → camp.name
  C2  employees without a camp get camp_id/camp_name = null
  C3  changing an employee's camp is reflected on the next read (read-time
      join, no snapshot staleness)
  C4  the payroll page filter inputs all exist on the payload:
      nationality, status, trade_id, camp_id (region/country derive from
      nationality client-side)
  ID  the migration re-runs cleanly (idempotent create-or-replace)

Everything runs inside ONE process because the sandbox reaps background
servers between shell calls.
"""
import os
import shutil
import subprocess
import sys
import json

ROOT = '/home/z/my-project'
SCRIPTS = os.path.join(ROOT, 'scripts')
PGDATA = os.path.join(SCRIPTS, 'pgdata_camp_test')

import pgserver  # noqa: E402

PSQL = os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin', 'psql')
MIG = os.path.join(ROOT, 'supabase', 'migrations')

subprocess.run(['pkill', '-f', 'pgdata_camp_test'], capture_output=True)  # stale runs
shutil.rmtree(PGDATA, ignore_errors=True)
server = pgserver.get_server(PGDATA, cleanup_mode='stop')
base_uri = server.get_uri('postgres')
if subprocess.run([PSQL, base_uri, '-tAc',
                   "select 1 from pg_database where datname = 'pulse_camp_test'"],
                  capture_output=True, text=True).stdout.strip() != '1':
    subprocess.run([PSQL, base_uri, '-q', '-c', 'create database pulse_camp_test'],
                   check=True, capture_output=True, text=True)
uri = server.get_uri('pulse_camp_test')

# pgcrypto is unavailable on the local cluster — gen_random_uuid() is core SQL
with open(os.path.join(ROOT, 'supabase', 'schema.sql')) as f:
    schema = f.read()
schema = schema.replace('create extension if not exists pgcrypto;',
                        '-- (pgcrypto skipped locally — gen_random_uuid() is core SQL)')
with open(os.path.join(SCRIPTS, 'schema_local.sql'), 'w') as f:
    f.write(schema)


def run(files=(), sql=None):
    env = {**os.environ, 'PGOPTIONS': "-c app.current_uid=00000000-0000-0000-0000-0000000000aa"}
    args = [PSQL, uri, '-q', '-v', 'ON_ERROR_STOP=1']
    for f in files:
        args += ['-f', f]
    if sql:
        args += ['-c', sql]
    r = subprocess.run(args, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr)
        sys.exit(f'FAILED: {files or sql}')
    return r.stdout


def one(query):
    env = {**os.environ, 'PGOPTIONS': "-c app.current_uid=00000000-0000-0000-0000-0000000000aa"}
    return subprocess.run([PSQL, uri, '-tAc', query],
                          capture_output=True, text=True, env=env).stdout.strip()


failures = []

# ---- load the full chain ----------------------------------------------------
run([os.path.join(SCRIPTS, 'test_shim.sql'),
     os.path.join(SCRIPTS, 'schema_local.sql'),
     os.path.join(SCRIPTS, 'test_seed.sql')])
print('loaded shim → schema (incl. camp-fields get_salary_sheet) → seed')

# ---- fixtures: camp, employees (one camp-assigned, one not), attendance -----
run(sql=r"""
do $$
declare s1 uuid; camp_id uuid; e1 public.employee; e2 public.employee;
begin
  insert into public.site (name) values ('Camp Filter Tower') returning id into s1;

  insert into public.camp (name) values ('Camp Filter Camp')
  on conflict (name) do update set is_active = true
  returning id into camp_id;
  insert into public.camp (name) values ('Camp Filter Camp 2')
  on conflict (name) do update set is_active = true;

  e1 := public.create_employee(jsonb_build_object(
    'full_name','Cleo Camped','join_date','2026-01-01','opening_hours','1500',
    'current_site_id', s1, 'salary_role','standard','position','Steel fixer'));
  perform public.assign_employee_camp(e1.id, camp_id);

  e2 := public.create_employee(jsonb_build_object(
    'full_name','Umar Uncamped','join_date','2026-01-01','opening_hours','1200',
    'current_site_id', s1, 'salary_role','standard','position','Carpenter'));
  raise notice 'created % / %', e1.id, e2.id;
end $$;

insert into public.attendance (employee_id, date, status, hours)
select e.id, d::date, 'present', 10
from public.employee e
cross join generate_series(date '2026-11-02', date '2026-11-06', interval '1 day') d
where e.full_name in ('Cleo Camped','Umar Uncamped');
""")
print('fixtures created (camp-assigned + uncamped employees, Nov attendance)')

year, month = 2026, 11
run(sql=f"select public.generate_payroll_period({year}, {month});")
print('payroll period generated')

payload = json.loads(one(f"select public.get_salary_sheet({year}, {month});"))
emps = payload['employees']
print(f"get_salary_sheet returned {len(emps)} employee rows")
if not emps:
    failures.append('no employees in the report')
    sys.exit('\n'.join(failures))

with_camp = one("""
select e.id || '|' || c.name from public.employee e
join public.camp c on c.id = e.camp_id
where e.full_name = 'Cleo Camped'
""")
without_camp = one("select e.id from public.employee e where e.full_name = 'Umar Uncamped'")
if not with_camp:
    failures.append('C1: camped fixture employee missing')
if not without_camp:
    failures.append('C2: uncamped fixture employee missing')

# C1 — camp fields match the employee's camp
if with_camp:
    emp_id, camp_name = with_camp.split('|', 1)
    row = next((e for e in emps if e['employee_id'] == emp_id), None)
    if row is None:
        failures.append('C1: employee not in period rows')
    elif not row.get('camp_id') or row.get('camp_name') != camp_name:
        failures.append(f"C1: expected camp {camp_name!r}, got {row.get('camp_name')!r}")
    else:
        print(f"C1 ok — {row['full_name']}: camp_id set, camp_name={row['camp_name']!r}")

# C2 — no camp → nulls
if without_camp:
    row = next((e for e in emps if e['employee_id'] == without_camp), None)
    if row is None:
        failures.append('C2: employee not in period rows')
    elif row.get('camp_id') is not None or row.get('camp_name') is not None:
        failures.append(f"C2: expected nulls, got {row.get('camp_id')!r}/{row.get('camp_name')!r}")
    else:
        print(f"C2 ok — {row['full_name']}: camp_id/camp_name null")

# C3 — moving an employee to another camp is reflected on the next read
if with_camp:
    emp_id, _ = with_camp.split('|', 1)
    other_camp = one("""
select name from public.camp
where id <> (select camp_id from public.employee where id = '""" + emp_id + """')
order by name limit 1
""")
    if other_camp:
        run(sql=f"""
select public.assign_employee_camp('{emp_id}',
  (select id from public.camp where name = '{other_camp}'));
""")
        payload = json.loads(one(f"select public.get_salary_sheet({year}, {month});"))
        row = next((e for e in payload['employees'] if e['employee_id'] == emp_id), None)
        if row and row.get('camp_name') == other_camp:
            print(f"C3 ok — camp change reflected immediately ({other_camp!r})")
        else:
            failures.append(f"C3: expected {other_camp!r} after move, got {row and row.get('camp_name')!r}")

# C4 — all client-side filter inputs exist on the payload
sample = emps[0] if emps else {}
for key in ('nationality', 'status', 'trade_id', 'camp_id', 'camp_name', 'sites'):
    if key not in sample:
        failures.append(f"C4: payload misses key {key!r}")
if emps:
    print('C4 ok — nationality/status/trade_id/camp_id/camp_name/sites all present')

# ID — migration re-runs cleanly
try:
    run([os.path.join(MIG, '20261105d_payroll_camp_filters.sql')])
    print('ID ok — migration re-runs cleanly')
except SystemExit:
    failures.append('ID: migration re-run failed')

print()
if failures:
    print('FAILURES:')
    for f in failures:
        print(' -', f)
    sys.exit(1)
print('ALL CHECKS PASSED')
