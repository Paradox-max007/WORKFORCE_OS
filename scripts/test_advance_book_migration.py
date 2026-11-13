#!/usr/bin/env python3
"""
Local-PostgreSQL verification of 20261113e_advance_book.sql.

  CHAIN   shim → full schema → seed admins → 20261113c → 20261113d → 20261113e
  ID      the migration re-runs cleanly (idempotency)
  T1      add a record cut OCT (past month) → folds into the existing Oct row
          (advance 100, advance_book_applied 100, net 160) + book JSON due/overdue
  T2      reschedule to NOV → Oct advance back to 0, applied 0, net 260
  T3      generate the Nov period AFTER the record exists → the generate hook
          folds the book in (Nov advance 100, applied 100, net 160)
  T4      manual Advance edit coexists: set 150 by hand (applied stays 100),
          then add a second 50 record → advance 200, applied 150, net 60
  T5      get_advance_book totals (2 due, 150)
  T6      mark the Nov salary PAID → both records flip to cleared (derived),
          advance_book_due empties, cleared totals correct
  T7      cleared records are locked (edit + delete both raise)
  T8      unmark → records are due again (derived status follows the toggle)
  T9      delete a due record → sync removes exactly its part (advance 150)
  T10     PAID rows are skipped by the sync: a new record cut to the paid month
          leaves the payroll row untouched (stays due for rescheduling)
  T11     no session (auth.uid() null) → Access denied

Everything runs inside ONE process because the sandbox reaps background
servers between shell calls.
"""
import os
import shutil
import subprocess
import sys

ROOT = '/home/z/my-project'
SCRIPTS = os.path.join(ROOT, 'scripts')
PGDATA = os.path.join(SCRIPTS, 'pgdata_ab_test')

import pgserver  # noqa: E402

PSQL = os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin', 'psql')
MIG = os.path.join(ROOT, 'supabase', 'migrations')

subprocess.run(['pkill', '-f', 'pgdata_ab_test'], capture_output=True)  # stale runs
shutil.rmtree(PGDATA, ignore_errors=True)
server = pgserver.get_server(PGDATA, cleanup_mode='stop')
base_uri = server.get_uri('postgres')
if subprocess.run([PSQL, base_uri, '-tAc',
                   "select 1 from pg_database where datname = 'pulse_ab_test'"],
                  capture_output=True, text=True).stdout.strip() != '1':
    subprocess.run([PSQL, base_uri, '-q', '-c', 'create database pulse_ab_test'],
                   check=True, capture_output=True, text=True)
uri = server.get_uri('pulse_ab_test')


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


print('== 20261113e advance book migration verification (local PostgreSQL) ==')

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
    ('run 20261113d (time card net payable)',
     [os.path.join(MIG, '20261113d_time_card_net_payable.sql')]),
    ('run 20261113e (advance book)',
     [os.path.join(MIG, '20261113e_advance_book.sql')]),
    ('re-run 20261113e (idempotency)',
     [os.path.join(MIG, '20261113e_advance_book.sql')]),
]:
    ok, r = run(files)
    step(name, ok, r.stderr[-3000:])

SUPER = '00000000-0000-0000-0000-0000000000aa'   # test_seed super admin

# ---------------------------------------------------------------------------
# fixtures — site + trade (qualified standard = 13/h) + one employee with
# 2 × 10 h attendance in BOTH Oct and Nov 2026 → 260 gross per month
# ---------------------------------------------------------------------------
FIXTURES = f"""
set app.current_uid = '{SUPER}';
do $$
declare s1 uuid; r jsonb; e public.employee;
begin
  insert into public.site (name) values ('Advance Tower') returning id into s1;

  r := public.create_trade('Electrician AB', 'wiring', jsonb_build_array(
    jsonb_build_object('salary_role','standard','experience_tier','below_threshold','hourly_rate',8),
    jsonb_build_object('salary_role','standard','experience_tier','qualified','hourly_rate',13),
    jsonb_build_object('salary_role','team_leader','experience_tier','below_threshold','hourly_rate',10),
    jsonb_build_object('salary_role','team_leader','experience_tier','qualified','hourly_rate',15),
    jsonb_build_object('salary_role','supervisor','experience_tier','below_threshold','hourly_rate',12),
    jsonb_build_object('salary_role','supervisor','experience_tier','qualified','hourly_rate',18)
  ), true);

  select * into e from public.create_employee(jsonb_build_object(
    'full_name','Book Keeper','join_date','2026-01-01','opening_hours','1500',
    'current_site_id', s1, 'trade_id', (r->>'id')::uuid,
    'salary_role','standard','position','Electrician'));
end $$;

insert into public.attendance (employee_id, date, status, hours)
select e.id, d.dt, 'present', 10
from public.employee e
cross join (values (date '2026-10-05'), (date '2026-10-20'),
                   (date '2026-11-05'), (date '2026-11-20')) as d(dt)
where e.full_name = 'Book Keeper';

select public.generate_payroll_period(2026, 10) is not null as generated;
"""
ok, r = run(sql=FIXTURES)
step('fixtures + generate draft payroll (Oct 2026)',
     ok and 'generated' in (r.stdout or ''), (r.stderr or '')[-2500:])

# ---------------------------------------------------------------------------
# T1 — add a record cut OCT (a past month): folds into the EXISTING Oct row
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  v_emp uuid; v_adv numeric; v_applied numeric; v_net numeric;
  v_book jsonb; v_sheet jsonb; v_due jsonb;
begin
  select e.id into v_emp from public.employee e where e.full_name = 'Book Keeper';

  perform public.save_advance_record(jsonb_build_object(
    'employee_id', v_emp, 'amount', 100, 'given_date', '2026-10-20',
    'cut_year', 2026, 'cut_month', 10, 'note', 'cash advance — site A'));

  select pe.advance, pe.advance_book_applied, pe.net_salary
    into v_adv, v_applied, v_net
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 10 and pe.employee_id = v_emp;
  if v_adv <> 100 or v_applied <> 100 or v_net <> 160 then
    raise exception 'FAIL T1: Oct advance=% applied=% net=% (expected 100/100/160)',
      v_adv, v_applied, v_net;
  end if;

  v_book := public.get_advance_book();
  if (v_book->'totals'->>'due_count')::int <> 1
     or (v_book->'totals'->>'due_amount')::numeric <> 100 then
    raise exception 'FAIL T1: totals=%', v_book->'totals';
  end if;
  if not (v_book->'records'->0->>'overdue')::boolean then
    raise exception 'FAIL T1: Oct 2026 cut is in the past — record must be overdue';
  end if;
  if not (v_book->'records'->0->>'applied')::boolean then
    raise exception 'FAIL T1: record folded into an existing payroll — applied must be true';
  end if;

  v_sheet := public.get_salary_sheet(2026, 10);
  select x into v_due from jsonb_array_elements(v_sheet->'employees') x
   where x->>'full_name' = 'Book Keeper';
  if (v_due->>'advance_book_applied')::numeric <> 100 then
    raise exception 'FAIL T1: sheet advance_book_applied=%', v_due->>'advance_book_applied';
  end if;
  if jsonb_array_length(v_due->'advance_book_due') <> 1 then
    raise exception 'FAIL T1: advance_book_due must list 1 record';
  end if;
end $$;
""")
step('T1 record cut Oct folds into the Oct row (advance 100 / applied 100 / net 160)',
     ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# T2 — reschedule the record to NOV: Oct advance returns to 0
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  v_emp uuid; v_id uuid; v_adv numeric; v_applied numeric; v_net numeric;
begin
  select e.id into v_emp from public.employee e where e.full_name = 'Book Keeper';
  select r.id into v_id from public.advance_record r where r.employee_id = v_emp;

  perform public.save_advance_record(jsonb_build_object(
    'id', v_id, 'employee_id', v_emp, 'amount', 100, 'given_date', '2026-10-20',
    'cut_year', 2026, 'cut_month', 11, 'note', 'rescheduled to November'));

  select pe.advance, pe.advance_book_applied, pe.net_salary
    into v_adv, v_applied, v_net
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 10 and pe.employee_id = v_emp;
  if v_adv <> 0 or v_applied <> 0 or v_net <> 260 then
    raise exception 'FAIL T2: Oct advance=% applied=% net=% (expected 0/0/260)',
      v_adv, v_applied, v_net;
  end if;
end $$;
""")
step('T2 reschedule to Nov clears the Oct row (advance 0 / applied 0 / net 260)',
     ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# T3 — generate the NOV period now: the generate hook folds the record in
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  v_emp uuid; v_adv numeric; v_applied numeric; v_net numeric; v_gross numeric;
begin
  select e.id into v_emp from public.employee e where e.full_name = 'Book Keeper';
  perform public.generate_payroll_period(2026, 11);

  select pe.advance, pe.advance_book_applied, pe.net_salary, pe.gross_salary
    into v_adv, v_applied, v_net, v_gross
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = v_emp;
  if v_gross <> 260 then raise exception 'FAIL T3: Nov gross=% (expected 260)', v_gross; end if;
  if v_adv <> 100 or v_applied <> 100 or v_net <> 160 then
    raise exception 'FAIL T3: Nov advance=% applied=% net=% (expected 100/100/160)',
      v_adv, v_applied, v_net;
  end if;
end $$;
""")
step('T3 generate hook folds the record into the new Nov row (100 / 100 / 160)',
     ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# T4 — manual Advance edit coexists with the book: set 150 by hand, then add
#      a second 50 record → advance 200, applied 150
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  v_emp uuid; v_pe uuid; v_adv numeric; v_applied numeric; v_net numeric;
begin
  select e.id into v_emp from public.employee e where e.full_name = 'Book Keeper';
  select pe.id into v_pe
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = v_emp;

  perform public.update_payroll_adjustment(v_pe, 150, 0, null);
  select pe.advance, pe.advance_book_applied into v_adv, v_applied
  from public.payroll_employee pe where pe.id = v_pe;
  if v_adv <> 150 or v_applied <> 100 then
    raise exception 'FAIL T4a: advance=% applied=% (expected 150/100)', v_adv, v_applied;
  end if;

  perform public.save_advance_record(jsonb_build_object(
    'employee_id', v_emp, 'amount', 50, 'given_date', '2026-11-10',
    'cut_year', 2026, 'cut_month', 11, 'note', 'second advance'));
  select pe.advance, pe.advance_book_applied, pe.net_salary
    into v_adv, v_applied, v_net
  from public.payroll_employee pe where pe.id = v_pe;
  if v_adv <> 200 or v_applied <> 150 or v_net <> 60 then
    raise exception 'FAIL T4b: advance=% applied=% net=% (expected 200/150/60)',
      v_adv, v_applied, v_net;
  end if;
end $$;
""")
step('T4 manual advance edit coexists (150 by hand + 50 record → 200 / 150 / 60)',
     ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# T5 — totals reflect both due records
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare v_book jsonb;
begin
  v_book := public.get_advance_book();
  if (v_book->'totals'->>'due_count')::int <> 2
     or (v_book->'totals'->>'due_amount')::numeric <> 150
     or (v_book->'totals'->>'cleared_count')::int <> 0 then
    raise exception 'FAIL T5: totals=%', v_book->'totals';
  end if;
end $$;
""")
step('T5 book totals: 2 due records, 150 due, 0 cleared', ok, r.stderr[-1500:])

# ---------------------------------------------------------------------------
# T6 — mark the Nov salary PAID → both records flip to cleared (derived),
#      the sheet empties advance_book_due
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  v_emp uuid; v_pe uuid; v_book jsonb; v_sheet jsonb; v_due jsonb; n int;
begin
  select e.id into v_emp from public.employee e where e.full_name = 'Book Keeper';
  select pe.id into v_pe
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = v_emp;

  perform public.mark_employee_salary_paid(v_pe);

  v_book := public.get_advance_book();
  if (v_book->'totals'->>'cleared_count')::int <> 2
     or (v_book->'totals'->>'cleared_amount')::numeric <> 150
     or (v_book->'totals'->>'due_count')::int <> 0 then
    raise exception 'FAIL T6: totals=%', v_book->'totals';
  end if;
  if (v_book->'records'->0->>'cleared_at') is null then
    raise exception 'FAIL T6: cleared_at must carry the payment timestamp';
  end if;

  v_sheet := public.get_salary_sheet(2026, 11);
  select x into v_due from jsonb_array_elements(v_sheet->'employees') x
   where x->>'full_name' = 'Book Keeper';
  select jsonb_array_length(v_due->'advance_book_due') into n;
  if n <> 0 then raise exception 'FAIL T6: advance_book_due must be empty (got %)', n; end if;
end $$;
""")
step('T6 marking the Nov salary paid clears both records (derived status)',
     ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# T7 — cleared records are locked: edit and delete both raise
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare v_id uuid; v_emp uuid;
begin
  select id, employee_id into v_id, v_emp from public.advance_record limit 1;
  begin
    perform public.save_advance_record(jsonb_build_object(
      'id', v_id, 'employee_id', v_emp, 'amount', 10,
      'cut_year', 2026, 'cut_month', 12));
    raise exception 'FAIL T7a: editing a cleared record must raise';
  exception when others then
    if sqlerrm not like 'This advance is already cleared%' then
      raise exception 'FAIL T7a: unexpected error: %', sqlerrm;
    end if;
  end;
  begin
    perform public.delete_advance_record(v_id);
    raise exception 'FAIL T7b: deleting a cleared record must raise';
  exception when others then
    if sqlerrm not like 'This advance is already cleared%' then
      raise exception 'FAIL T7b: unexpected error: %', sqlerrm;
    end if;
  end;
end $$;
""")
step('T7 cleared records cannot be edited or deleted (both raise)', ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# T8 — unmark → both records are due again
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  v_pe uuid; v_book jsonb;
begin
  select pe.id into v_pe
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  join public.employee e on e.id = pe.employee_id
  where p.year = 2026 and p.month = 11 and e.full_name = 'Book Keeper';

  perform public.unmark_employee_salary_paid(v_pe, 'test revert');

  v_book := public.get_advance_book();
  if (v_book->'totals'->>'due_count')::int <> 2
     or (v_book->'totals'->>'cleared_count')::int <> 0 then
    raise exception 'FAIL T8: totals=%', v_book->'totals';
  end if;
end $$;
""")
step('T8 unmarking the salary flips both records back to due', ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# T9 — delete a DUE record: exactly its part is removed (200 → 150)
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  v_emp uuid; v_id uuid; v_adv numeric; v_applied numeric; v_net numeric;
begin
  select e.id into v_emp from public.employee e where e.full_name = 'Book Keeper';
  select r.id into v_id from public.advance_record r
  where r.employee_id = v_emp and r.amount = 50;

  perform public.delete_advance_record(v_id);

  select pe.advance, pe.advance_book_applied, pe.net_salary
    into v_adv, v_applied, v_net
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = v_emp;
  if v_adv <> 150 or v_applied <> 100 or v_net <> 110 then
    raise exception 'FAIL T9: advance=% applied=% net=% (expected 150/100/110)',
      v_adv, v_applied, v_net;
  end if;
end $$;
""")
step('T9 deleting a due record removes exactly its part (150 / 100 / 110)',
     ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# T10 — PAID rows are skipped: re-pay Nov, then add a record cut NOV →
#       the payroll row stays untouched, the record stays due
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  v_emp uuid; v_pe uuid; v_adv numeric; v_applied numeric; v_book jsonb;
begin
  select e.id into v_emp from public.employee e where e.full_name = 'Book Keeper';
  select pe.id into v_pe
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = v_emp;
  perform public.mark_employee_salary_paid(v_pe);

  perform public.save_advance_record(jsonb_build_object(
    'employee_id', v_emp, 'amount', 60, 'given_date', '2026-11-12',
    'cut_year', 2026, 'cut_month', 11, 'note', 'late entry into a paid month'));

  select pe.advance, pe.advance_book_applied into v_adv, v_applied
  from public.payroll_employee pe where pe.id = v_pe;
  if v_adv <> 150 or v_applied <> 100 then
    raise exception 'FAIL T10: paid row must be skipped — advance=% applied=% (expected 150/100)',
      v_adv, v_applied;
  end if;

  v_book := public.get_advance_book();
  if (v_book->'totals'->>'due_count')::int <> 1 then
    raise exception 'FAIL T10: the new record must stay due, totals=%', v_book->'totals';
  end if;
end $$;
""")
step('T10 the sync skips PAID rows (record stays due for rescheduling)',
     ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# T11 — access control: no session → Access denied
# ---------------------------------------------------------------------------
ok, r = run(sql="""
set app.current_uid = '';
select public.get_advance_book();
""", expect_fail='Access denied')
step('T11 no session → get_advance_book raises Access denied', ok, r.stderr[-800:])

# ---------------------------------------------------------------------------
print()
passed = sum(results)
print(f'== {passed}/{len(results)} steps passed ==')
if passed != len(results):
    sys.exit(1)
