#!/usr/bin/env python3
"""
Local-PostgreSQL verification of 20261105_payroll_inline.sql.

Loads the full chain (shim → base schema → seed → 20261103 → 20261103b →
20261104 → 20261105 twice for idempotency), then functionally verifies:

  T1  mark_employee_salary_paid on a DRAFT period succeeds (the finalized
      requirement is gone — "Mark Paid is active when the employee has salary")
  T2  mark_employee_salary_paid on a zero-gross employee fails with the new
      'No salary calculated' error
  T3  unmark_employee_salary_paid reverts (super admin, reason)
  T4  mark_employee_salary_paid with p_advance / p_deduction persists them
  T5  update_salary_sheet_row trade change (super admin) re-prices the month
  T6  update_salary_sheet_row with NO menu permission → Access denied
  T7  update_salary_sheet_row with ONLY the payroll permission → succeeds
      (20261105 leniency — this is the Payroll-page trade dropdown)
  T8  update_payroll_adjustment with only payroll permission → succeeds
      (the Payroll-page inline advance / deduction editing path)
  T9  paid employees stay protected (update_salary_sheet_row → error)

Everything runs inside ONE process because the sandbox reaps background
servers between shell calls.
"""
import os
import shutil
import subprocess
import sys

ROOT = '/home/z/my-project'
SCRIPTS = os.path.join(ROOT, 'scripts')
PGDATA = os.path.join(SCRIPTS, 'pgdata_payroll_test')

import pgserver  # noqa: E402

PSQL = os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin', 'psql')
MIG = os.path.join(ROOT, 'supabase', 'migrations')

subprocess.run(['pkill', '-f', 'pgdata_payroll_test'], capture_output=True)  # stale runs
shutil.rmtree(PGDATA, ignore_errors=True)
server = pgserver.get_server(PGDATA, cleanup_mode='stop')
base_uri = server.get_uri('postgres')
if subprocess.run([PSQL, base_uri, '-tAc',
                   "select 1 from pg_database where datname = 'pulse_payroll_test'"],
                  capture_output=True, text=True).stdout.strip() != '1':
    subprocess.run([PSQL, base_uri, '-q', '-c', 'create database pulse_payroll_test'],
                   check=True, capture_output=True, text=True)
uri = server.get_uri('pulse_payroll_test')


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


print('== 20261105 Payroll inline-edit migration verification (local PostgreSQL) ==')

chain_steps = [
    ('load Supabase shims', [os.path.join(SCRIPTS, 'test_shim.sql')]),
]

# patch out pgcrypto (gen_random_uuid is core SQL since PG13; the embedded
# server ships without the extension)
with open(os.path.join(ROOT, 'supabase', 'schema.sql')) as f:
    schema = f.read()
schema = schema.replace('create extension if not exists pgcrypto;',
                        '-- (pgcrypto skipped locally — gen_random_uuid() is core SQL)')
with open(os.path.join(SCRIPTS, 'schema_local.sql'), 'w') as f:
    f.write(schema)
chain_steps.append(('load full schema (incl. 20261104)', [os.path.join(SCRIPTS, 'schema_local.sql')]))
chain_steps.append(('seed super admin + plain admin', [os.path.join(SCRIPTS, 'test_seed.sql')]))
for name, files in chain_steps:
    ok, r = run(files)
    step(name, ok, r.stderr[-3000:])

ok, r = run([os.path.join(MIG, '20261105_payroll_inline.sql')])
step('run 20261105 migration', ok, r.stderr[-3000:])
ok, r = run([os.path.join(MIG, '20261105_payroll_inline.sql')])
step('run 20261105 again (idempotency)', ok, r.stderr[-3000:])

# ---------------------------------------------------------------------------
# fixtures — reuse the same shapes as test_functional.sql
# ---------------------------------------------------------------------------
FIXTURES = r"""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
drop table if exists tt;
create temp table tt (key text primary key, val text);

do $$
declare s1 uuid; r jsonb;
begin
  insert into public.site (name) values ('Inline Test Tower') returning id into s1;
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

  r := public.create_trade('Mason', 'brickwork', jsonb_build_array(
    jsonb_build_object('salary_role','standard','experience_tier','below_threshold','hourly_rate',9),
    jsonb_build_object('salary_role','standard','experience_tier','qualified','hourly_rate',20),
    jsonb_build_object('salary_role','team_leader','experience_tier','below_threshold','hourly_rate',11),
    jsonb_build_object('salary_role','team_leader','experience_tier','qualified','hourly_rate',22),
    jsonb_build_object('salary_role','supervisor','experience_tier','below_threshold','hourly_rate',13),
    jsonb_build_object('salary_role','supervisor','experience_tier','qualified','hourly_rate',24)
  ), true);
  insert into tt values ('trade_mason', r->>'id');
end $$;

do $$
declare r public.employee;
begin
  -- A: qualified electrician, 20h → 20 × 13 = 260 gross
  select * into r from public.create_employee(jsonb_build_object(
    'full_name','Ada Paid','join_date','2026-01-01','opening_hours','1500',
    'current_site_id',(select val from tt where key='s1'),
    'trade_id',(select val from tt where key='trade_elec'),
    'salary_role','standard','position','Electrician'));
  insert into tt values ('emp_a', r.id::text);

  -- B: no trade, no attendance → zero gross
  select * into r from public.create_employee(jsonb_build_object(
    'full_name','Bob Broke','join_date','2026-09-01','opening_hours','0',
    'current_site_id',(select val from tt where key='s1'),'position','Labourer'));
  insert into tt values ('emp_b', r.id::text);

  -- C: qualified electrician used for the trade-change permission tests
  select * into r from public.create_employee(jsonb_build_object(
    'full_name','Cy Change','join_date','2026-01-01','opening_hours','1400',
    'current_site_id',(select val from tt where key='s1'),
    'trade_id',(select val from tt where key='trade_elec'),
    'salary_role','standard','position','Electrician'));
  insert into tt values ('emp_c', r.id::text);
end $$;

insert into public.attendance (employee_id, date, status, hours) values
  ((select val::uuid from tt where key='emp_a'), date '2026-10-05', 'present', 10),
  ((select val::uuid from tt where key='emp_a'), date '2026-10-20', 'present', 10),
  ((select val::uuid from tt where key='emp_c'), date '2026-10-06', 'present', 10);

perform_seq;
"""

ok, r = run(sql=FIXTURES.replace('perform_seq;',
        'select public.generate_payroll_period(2026, 10) is not null as generated;'))
step('fixtures + generate draft payroll (Oct 2026)', ok and 'generated' in (r.stdout or ''),
     (r.stderr or '')[-2500:])

# T1 — pay on a DRAFT period (used to fail with "Finalize the payroll first")
ok, r = run(sql="""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
do $$
declare pe_id uuid; st text;
begin
  select pe.id into pe_id from public.payroll_employee pe
    join public.payroll_period p on p.id = pe.payroll_period_id
    join public.employee e on e.id = pe.employee_id
    where e.full_name = 'Ada Paid' and p.year = 2026 and p.month = 10;
  perform public.mark_employee_salary_paid(pe_id);
  select payment_status into st from public.payroll_employee where id = pe_id;
  if st <> 'paid' then raise exception 'FAIL T1: status=%', st; end if;
  if not exists (select 1 from public.payroll_audit_log
                  where action = 'payment' and period_id = (select id from public.payroll_period where year=2026 and month=10)) then
    raise exception 'FAIL T1: no payment audit row';
  end if;
  raise notice 'PASS T1: draft-period payment succeeds';
end $$;
""")
step('T1 mark paid on DRAFT period succeeds (has salary)', ok, r.stderr[-1500:])

# T2 — zero-gross employee
ok, r = run(sql="""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
do $$
declare pe_id uuid;
begin
  select pe.id into pe_id from public.payroll_employee pe
    join public.payroll_period p on p.id = pe.payroll_period_id
    join public.employee e on e.id = pe.employee_id
    where e.full_name = 'Bob Broke' and p.year = 2026 and p.month = 10;
  begin
    perform public.mark_employee_salary_paid(pe_id);
    raise exception 'FAIL T2: zero-gross employee was paid';
  exception when others then
    if sqlerrm not like '%No salary calculated%' then
      raise exception 'FAIL T2: unexpected error: %', sqlerrm;
    end if;
  end;
  raise notice 'PASS T2: zero-gross employee rejected';
end $$;
""")
step('T2 zero-gross employee rejected with new error', ok, r.stderr[-1500:])

# T3 — super-admin revert
ok, r = run(sql="""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
do $$
declare pe_id uuid; st text;
begin
  select pe.id into pe_id from public.payroll_employee pe
    join public.employee e on e.id = pe.employee_id
    where e.full_name = 'Ada Paid';
  perform public.unmark_employee_salary_paid(pe_id, 'migration test revert');
  select payment_status into st from public.payroll_employee where id = pe_id;
  if st <> 'unpaid' then raise exception 'FAIL T3: status=%', st; end if;
  raise notice 'PASS T3: revert works';
end $$;
""")
step('T3 super-admin revert works', ok, r.stderr[-1500:])

# T4 — pay with advance / deduction values
ok, r = run(sql="""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
do $$
declare pe_id uuid; adv numeric; ded numeric; net numeric; gross numeric;
begin
  select pe.id, pe.gross_salary into pe_id, gross from public.payroll_employee pe
    join public.employee e on e.id = pe.employee_id where e.full_name = 'Ada Paid';
  perform public.mark_employee_salary_paid(pe_id, 60, 20, 'migration test');
  select advance, deduction, net_salary into adv, ded, net
    from public.payroll_employee where id = pe_id;
  if adv <> 60 or ded <> 20 then raise exception 'FAIL T4: adv=% ded=%', adv, ded; end if;
  if net <> round(gross - 80, 2) then raise exception 'FAIL T4: net=% gross=%', net, gross; end if;
  raise notice 'PASS T4: advance/deduction persisted (net=%)', net;
end $$;
""")
step('T4 payment with advance/deduction persists settlement', ok, r.stderr[-1500:])

# T5 — trade change via update_salary_sheet_row as super admin re-prices
# (single DO block — temp tables don't survive psql -c boundaries)
ok, r = run(sql="""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
do $$
declare pe_id uuid; g_before numeric; g_after numeric; t uuid; e uuid;
begin
  select pe.id, pe.gross_salary, pe.employee_id into pe_id, g_before, e
    from public.payroll_employee pe join public.employee em on em.id = pe.employee_id
    where em.full_name = 'Cy Change';
  select id into t from public.trades where name = 'Mason';
  perform public.update_salary_sheet_row(jsonb_build_object(
    'payroll_employee_id', pe_id, 'trade_id', t));
  select gross_salary into g_after from public.payroll_employee where id = pe_id;
  if g_after = g_before then raise exception 'FAIL T5: gross not re-priced (% = %)', g_before, g_after; end if;
  if g_after <> 200 then raise exception 'FAIL T5: expected 200 (10h × 20), got %', g_after; end if;
  if (select trade_id from public.employee where id = e) is distinct from t then
    raise exception 'FAIL T5: employee.trade_id not overwritten';
  end if;
  raise notice 'PASS T5: trade change re-priced % -> %', g_before, g_after;
end $$;
""")
step('T5 trade change re-prices the month (super admin)', ok, r.stderr[-1500:])

# T6 — no permission → access denied
ok, r = run(sql="""
set app.current_uid = '00000000-0000-0000-0000-0000000000bb';
do $$
declare pe_id uuid;
begin
  select pe.id into pe_id from public.payroll_employee pe
    join public.employee em on em.id = pe.employee_id where em.full_name = 'Cy Change';
  begin
    perform public.update_salary_sheet_row(jsonb_build_object(
      'payroll_employee_id', pe_id, 'advance', 10));
    raise exception 'FAIL T6: plain admin could edit';
  exception when others then
    if sqlerrm not like '%Access denied%' then
      raise exception 'FAIL T6: unexpected error: %', sqlerrm;
    end if;
  end;
  raise notice 'PASS T6: access denied without permission';
end $$;
""")
step('T6 no-permission admin denied', ok, r.stderr[-1500:])

# T7 — payroll-only permission → update_salary_sheet_row succeeds (20261105)
ok, r = run(sql="""
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';
insert into public.menu_permission (profile_id, menu_key, allowed)
values ('00000000-0000-0000-0000-0000000000bb', 'payroll', true);
""")
step('T7a grant payroll permission to plain admin', ok, r.stderr[-1500:])

ok, r = run(sql="""
set app.current_uid = '00000000-0000-0000-0000-0000000000bb';
do $$
declare pe_id uuid; adv numeric;
begin
  select pe.id into pe_id from public.payroll_employee pe
    join public.employee em on em.id = pe.employee_id where em.full_name = 'Cy Change';
  perform public.update_salary_sheet_row(jsonb_build_object(
    'payroll_employee_id', pe_id, 'trade_id', (select id from public.trades where name = 'Electrician')));
  perform public.update_payroll_adjustment(pe_id, 25, 5, 'payroll admin inline edit');
  select advance into adv from public.payroll_employee where id = pe_id;
  if adv <> 25 then raise exception 'FAIL T7: advance=%', adv; end if;
  raise notice 'PASS T7: payroll-only admin edits trade + settlement';
end $$;
""")
step('T7 payroll-only admin: trade change + settlement edit', ok, r.stderr[-1500:])

# T8 — paid employees stay protected
ok, r = run(sql="""
set app.current_uid = '00000000-0000-0000-0000-0000000000bb';
do $$
declare pe_id uuid;
begin
  select pe.id into pe_id from public.payroll_employee pe
    join public.employee em on em.id = pe.employee_id where em.full_name = 'Ada Paid';
  begin
    perform public.update_salary_sheet_row(jsonb_build_object(
      'payroll_employee_id', pe_id, 'advance', 999));
    raise exception 'FAIL T8: paid employee editable';
  exception when others then
    if sqlerrm not like '%already marked paid%' then
      raise exception 'FAIL T8: unexpected error: %', sqlerrm;
    end if;
  end;
  raise notice 'PASS T8: paid employee protected';
end $$;
""")
step('T8 paid employee protected', ok, r.stderr[-1500:])

print()
if all(results):
    print(f'ALL {len(results)} STEPS PASSED')
    sys.exit(0)
print(f'{results.count(False)} STEP(S) FAILED')
sys.exit(1)
