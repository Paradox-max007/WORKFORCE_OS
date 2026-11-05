#!/usr/bin/env python3
"""
Local-PostgreSQL verification of 20261105e_payment_notes.sql.

Loads the chain (shim → full schema incl. the new 20261105e section → seed),
then functionally verifies:

  T1  card_type table exists; seeded with Lulu Card + C3 Card
  T2  create_card_type works (permission-checked) + duplicate rejected
  T3  employee.payment_type / card_type_id columns exist; FK enforced
  T4  set_employee_payment_method: cash / card (needs card) / invalid rejected
  T5  clearing payment (null) works
  T6  employee_note table + add_employee_note / list / delete RPCs
  T7  add_employee_note empty note rejected
  T8  get_salary_sheet returns payment_type + card_type per employee row
  T9  payment fields survive update_employee (form edit must not clear them)
  ID  migration file re-runs cleanly on top of the loaded schema (idempotency)

Everything runs inside ONE process because the sandbox reaps background
servers between shell calls.
"""
import os
import shutil
import subprocess
import sys

ROOT = '/home/z/my-project'
SCRIPTS = os.path.join(ROOT, 'scripts')
PGDATA = os.path.join(SCRIPTS, 'pgdata_pay_test')

import pgserver  # noqa: E402

PSQL = os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin', 'psql')
MIG = os.path.join(ROOT, 'supabase', 'migrations')

subprocess.run(['pkill', '-f', 'pgdata_pay_test'], capture_output=True)  # stale runs
shutil.rmtree(PGDATA, ignore_errors=True)
server = pgserver.get_server(PGDATA, cleanup_mode='stop')
base_uri = server.get_uri('postgres')
if subprocess.run([PSQL, base_uri, '-tAc',
                   "select 1 from pg_database where datname = 'pulse_pay_test'"],
                  capture_output=True, text=True).stdout.strip() != '1':
    subprocess.run([PSQL, base_uri, '-q', '-c', 'create database pulse_pay_test'],
                   check=True, capture_output=True, text=True)
uri = server.get_uri('pulse_pay_test')


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


print('== 20261105e payment method + employee notes migration verification ==')

# ---- load the chain ---------------------------------------------------------
with open(os.path.join(ROOT, 'supabase', 'schema.sql')) as f:
    schema = f.read()
schema = schema.replace('create extension if not exists pgcrypto;',
                        '-- (pgcrypto skipped locally — gen_random_uuid() is core SQL)')
with open(os.path.join(SCRIPTS, 'schema_local.sql'), 'w') as f:
    f.write(schema)

for name, files in [
    ('load Supabase shims', [os.path.join(SCRIPTS, 'test_shim.sql')]),
    ('load full schema (incl. 20261105e section)', [os.path.join(SCRIPTS, 'schema_local.sql')]),
    ('seed super admin + plain admin', [os.path.join(SCRIPTS, 'test_seed.sql')]),
]:
    ok, r = run(files)
    step(name, ok, r.stderr[-3000:])

# idempotency — the migration file re-runs on top of the loaded schema
ok, r = run([os.path.join(MIG, '20261105e_payment_notes.sql')])
step('re-run 20261105e (idempotency)', ok, r.stderr[-2000:])

# ---- functional checks --------------------------------------------------------
SUPER = '00000000-0000-0000-0000-0000000000aa'   # test_seed super admin
ADMIN = '00000000-0000-0000-0000-0000000000bb'   # plain admin (no menus granted)

# T1 — card_type table + seeds
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select 1 / case when count(*) = 2 then 1 else 0 end from public.card_type
where name in ('Lulu Card', 'C3 Card');
""")
step('T1 card_type seeded with Lulu Card + C3 Card', ok, r.stdout + r.stderr[-1500:])

# T2 — create_card_type + duplicate rejection + permission check
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare c public.card_type;
begin
  c := public.create_card_type('Emirates NBD Card');
  if c.name <> 'Emirates NBD Card' then raise exception 'bad name'; end if;
end $$;
""")
step('T2a create_card_type works', ok, r.stderr[-1500:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select public.create_card_type('lulu card');
""", expect_fail='already exists')
step('T2b duplicate card type rejected', ok, r.stderr[-1500:])
ok, r = run(sql=f"""
set app.current_uid = '{ADMIN}';
select public.create_card_type('Nope Card');
""", expect_fail='Access denied')
step('T2c create_card_type permission-checked', ok, r.stderr[-1500:])

# T3 — employee columns exist (FK enforced below on the fixture employee)
ok, r = run(sql="""
select 1 / case when count(*) = 2 then 1 else 0 end from information_schema.columns
where table_schema='public' and table_name='employee'
  and column_name in ('payment_type','card_type_id');
""")
step('T3a employee.payment_type + card_type_id columns exist', ok, r.stderr[-1500:])

# fixture employee for T3b + T4-T9 (create_trade needs ALL 6 rate cells)
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  s1 uuid; r jsonb; emp public.employee; ct public.card_type;
begin
  insert into public.site (name) values ('Pay Test Tower') returning id into s1;
  r := public.create_trade('Electrician', 'wiring', jsonb_build_array(
    jsonb_build_object('salary_role','standard','experience_tier','below_threshold','hourly_rate',8),
    jsonb_build_object('salary_role','standard','experience_tier','qualified','hourly_rate',13),
    jsonb_build_object('salary_role','team_leader','experience_tier','below_threshold','hourly_rate',10),
    jsonb_build_object('salary_role','team_leader','experience_tier','qualified','hourly_rate',15),
    jsonb_build_object('salary_role','supervisor','experience_tier','below_threshold','hourly_rate',12),
    jsonb_build_object('salary_role','supervisor','experience_tier','qualified','hourly_rate',18)
  ), true);
  select * into ct from public.card_type where name = 'Lulu Card';
  select * into emp from public.create_employee(jsonb_build_object(
    'full_name','Nora Pay','join_date','2026-01-01','opening_hours','1500',
    'current_site_id', s1, 'trade_id', r->>'id', 'salary_role','standard',
    'position','Electrician'));
  update public.employee set payment_type='card', card_type_id=ct.id
    where id = emp.id;
end $$;
""")
step('fixture employee with Lulu card', ok, r.stderr[-1500:])

ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
update public.employee set card_type_id = gen_random_uuid()
where full_name = 'Nora Pay';
""", expect_fail='violates foreign key')
step('T3b card_type_id FK enforced', ok, r.stderr[-1500:])

# T4 — set_employee_payment_method validation matrix
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select public.set_employee_payment_method(
  (select id from public.employee where full_name='Nora Pay'), 'card', null);
""", expect_fail='Select the card type first')
step('T4a card without card type rejected', ok, r.stderr[-1000:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select public.set_employee_payment_method(
  (select id from public.employee where full_name='Nora Pay'), 'paypal', null);
""", expect_fail='must be cash or card')
step('T4b invalid payment type rejected', ok, r.stderr[-1000:])
ok, r = run(sql=f"""
set app.current_uid = '{ADMIN}';
select public.set_employee_payment_method(
  (select id from public.employee where full_name='Nora Pay'), 'cash', null);
""", expect_fail='Access denied')
step('T4c set method permission-checked', ok, r.stderr[-1000:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare e public.employee;
begin
  e := public.set_employee_payment_method(
    (select id from public.employee where full_name='Nora Pay'), 'cash', null);
  if e.payment_type <> 'cash' or e.card_type_id is not null then
    raise exception 'cash must clear the card type';
  end if;
  e := public.set_employee_payment_method(
    (select id from public.employee where full_name='Nora Pay'), 'card',
    (select id from public.card_type where name='C3 Card'));
  if e.payment_type <> 'card' or e.card_type_id is null then
    raise exception 'card must store the card type';
  end if;
end $$;
""")
step('T4d cash clears card; card stores it', ok, r.stderr[-1500:])

# T5 — clearing (null)
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare e public.employee;
begin
  e := public.set_employee_payment_method(
    (select id from public.employee where full_name='Nora Pay'), null, null);
  if e.payment_type is not null or e.card_type_id is not null then
    raise exception 'null must clear both';
  end if;
end $$;
""")
step('T5 null clears the payment method', ok, r.stderr[-1500:])

# T6 — employee notes: add / list / delete
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare n jsonb; lst jsonb;
begin
  n := public.add_employee_note(
    (select id from public.employee where full_name='Nora Pay'),
    'Prefers cash handover at the Sonapur office.');
  if n->>'note' is null or (n->>'author_name') is null then
    raise exception 'note VM must carry note + author_name';
  end if;
  perform public.add_employee_note(
    (select id from public.employee where full_name='Nora Pay'),
    'Lulu card renewed until 2027.');
  lst := public.list_employee_notes();
  if jsonb_array_length(lst) <> 2 then raise exception 'expected 2 notes'; end if;
  perform public.delete_employee_note(((lst->0)->>'id')::uuid);
  lst := public.list_employee_notes();
  if jsonb_array_length(lst) <> 1 then raise exception 'expected 1 note after delete'; end if;
end $$;
""")
step('T6 add / list / delete employee notes', ok, r.stderr[-1500:])

# T7 — empty note rejected + permission check
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select public.add_employee_note(
  (select id from public.employee where full_name='Nora Pay'), '   ');
""", expect_fail='Note text is required')
step('T7a empty note rejected', ok, r.stderr[-1000:])
ok, r = run(sql=f"""
set app.current_uid = '{ADMIN}';
select public.add_employee_note(
  (select id from public.employee where full_name='Nora Pay'), 'hi');
""", expect_fail='Access denied')
step('T7b add note permission-checked', ok, r.stderr[-1000:])

# T8 — get_salary_sheet returns payment fields (restore card first)
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select public.set_employee_payment_method(
  (select id from public.employee where full_name='Nora Pay'), 'card',
  (select id from public.card_type where name='Lulu Card'));
""")
step('T8a restore card payment', ok, r.stderr[-1500:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select public.generate_payroll_period(2026, 11);
""")
step('T8b generate payroll period', ok, r.stderr[-1500:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare sheet jsonb; row jsonb;
begin
  sheet := public.get_salary_sheet(2026, 11);
  row := (select x from jsonb_array_elements(sheet->'employees') x
          where x->>'full_name' = 'Nora Pay');
  if row is null then raise exception 'Nora Pay missing from sheet'; end if;
  if row->>'payment_type' <> 'card' or row->>'card_type' <> 'Lulu Card' then
    raise exception 'payment fields wrong: % / %', row->>'payment_type', row->>'card_type';
  end if;
end $$;
""")
step('T8c get_salary_sheet carries payment_type + card_type', ok, r.stdout + r.stderr[-1500:])

# T9 — update_employee (form save) must not clear the payment fields
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare e public.employee;
begin
  e := public.update_employee(
    (select id from public.employee where full_name='Nora Pay'),
    jsonb_build_object('full_name','Nora Pay','phone','+971 50 000 0000'));
  if e.payment_type <> 'card' or e.card_type_id is null then
    raise exception 'update_employee cleared the payment method!';
  end if;
end $$;
""")
step('T9 update_employee preserves payment fields', ok, r.stderr[-1500:])

# cleanup probe employee
run(sql="delete from public.employee where full_name = 'Nora Pay';")

print()
passed = sum(results)
print(f'RESULT: {passed}/{len(results)} checks passed')
sys.exit(0 if passed == len(results) else 1)
