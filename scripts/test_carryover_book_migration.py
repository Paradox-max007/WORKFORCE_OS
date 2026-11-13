#!/usr/bin/env python3
"""
Local-PostgreSQL verification of 20261113f_time_card_carryover_book.sql.

  CHAIN   shim → full schema (20261113f baked in) → seed admins →
          20261113c → 20261113d → 20261113e → 20261113f → re-run f
  ID      the migration re-runs cleanly (idempotency)
  L1      LEGACY conversion: an old direct-write carryover (advance 104 +
          note, carryover_applied 104, no book record) becomes a normal
          advance book record (cut = the very next month, note rebuilt,
          from_time_card) and advance_book_applied is raised — the advance
          VALUE is untouched; the payroll sheet lists it as a due record
  L2      no DOUBLE-COUNT: re-saving the same time card is a no-op
          (advance 104 / applied 104 unchanged)
  C1      a NEW negative difference creates the book record (104, cut Nov,
          due — no Nov row yet) and the Nov period exists
  C2      generate Nov folds the record in (B: 104/104/156); the legacy
          employee's row regenerates around its preserved advance (A too)
  C3      re-saving a different amount updates the record + the advance
          (130/130/130)
  C4      the time card now matches → the record is deleted and the advance
          returns to 0 (0/0/260)
  C5      a POSITIVE difference creates no record (0 records, advance 0)
  C6      recreate (12 h → 104), RESCHEDULE to Dec by hand, then re-save
          8 h → amount follows the time card (156) but the user's cut month
          (Dec) is PRESERVED and the Nov row stays untouched
  C7      generate Dec (156/156/104) → mark paid → the record is CLEARED
          (from_time_card badge kept); totals 1 due / 1 cleared
  C8      re-saving after the clear RAISES ('already cleared')
  C9      the audit trail holds the 5 carryover actions
  C10     the unique index blocks a second record for the same source period
  C11     no session (auth.uid() null) → Access denied

Everything runs inside ONE process because the sandbox reaps background
servers between shell calls.
"""
import os
import shutil
import subprocess
import sys

ROOT = '/home/z/my-project'
SCRIPTS = os.path.join(ROOT, 'scripts')
PGDATA = os.path.join(SCRIPTS, 'pgdata_cb_test')

import pgserver  # noqa: E402

PSQL = os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin', 'psql')
MIG = os.path.join(ROOT, 'supabase', 'migrations')

subprocess.run(['pkill', '-f', 'pgdata_cb_test'], capture_output=True)  # stale runs
shutil.rmtree(PGDATA, ignore_errors=True)
server = pgserver.get_server(PGDATA, cleanup_mode='stop')
base_uri = server.get_uri('postgres')
if subprocess.run([PSQL, base_uri, '-tAc',
                   "select 1 from pg_database where datname = 'pulse_cb_test'"],
                  capture_output=True, text=True).stdout.strip() != '1':
    subprocess.run([PSQL, base_uri, '-q', '-c', 'create database pulse_cb_test'],
                   check=True, capture_output=True, text=True)
uri = server.get_uri('pulse_cb_test')


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


print('== 20261113f time-card carryover → advance book (local PostgreSQL) ==')

# ---- load the chain ---------------------------------------------------------
with open(os.path.join(ROOT, 'supabase', 'schema.sql')) as f:
    schema = f.read()
schema = schema.replace('create extension if not exists pgcrypto;',
                        '-- (pgcrypto skipped locally — gen_random_uuid() is core SQL)')
with open(os.path.join(SCRIPTS, 'schema_local.sql'), 'w') as f:
    f.write(schema)

F = '20261113f_time_card_carryover_book.sql'
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
    ('run 20261113f (carryover → book)',
     [os.path.join(MIG, F)]),
    ('re-run 20261113f (idempotency)',
     [os.path.join(MIG, F)]),
]:
    ok, r = run(files)
    step(name, ok, r.stderr[-3000:])

SUPER = '00000000-0000-0000-0000-0000000000aa'   # test_seed super admin

# ---------------------------------------------------------------------------
# fixtures — site + trade (qualified standard = 13/h) + two employees with
# 2 × 10 h attendance in Oct 2026 → 260 gross each
# ---------------------------------------------------------------------------
FIXTURES = f"""
set app.current_uid = '{SUPER}';
do $$
declare s1 uuid; r jsonb; a public.employee; b public.employee;
begin
  insert into public.site (name) values ('Carry Tower') returning id into s1;

  r := public.create_trade('Carry Electrician', 'wiring', jsonb_build_array(
    jsonb_build_object('salary_role','standard','experience_tier','below_threshold','hourly_rate',8),
    jsonb_build_object('salary_role','standard','experience_tier','qualified','hourly_rate',13),
    jsonb_build_object('salary_role','team_leader','experience_tier','below_threshold','hourly_rate',10),
    jsonb_build_object('salary_role','team_leader','experience_tier','qualified','hourly_rate',15),
    jsonb_build_object('salary_role','supervisor','experience_tier','below_threshold','hourly_rate',12),
    jsonb_build_object('salary_role','supervisor','experience_tier','qualified','hourly_rate',18)
  ), true);

  select * into a from public.create_employee(jsonb_build_object(
    'full_name','Legacy Keeper','join_date','2026-01-01','opening_hours','1500',
    'current_site_id', s1, 'trade_id', (r->>'id')::uuid,
    'salary_role','standard','position','Electrician'));
  select * into b from public.create_employee(jsonb_build_object(
    'full_name','Fresh Face','join_date','2026-01-01','opening_hours','1500',
    'current_site_id', s1, 'trade_id', (r->>'id')::uuid,
    'salary_role','standard','position','Electrician'));
end $$;

insert into public.attendance (employee_id, date, status, hours)
select e.id, d.dt, 'present', 10
from public.employee e
cross join (values (date '2026-10-05'), (date '2026-10-20')) as d(dt)
where e.full_name in ('Legacy Keeper', 'Fresh Face');

select public.generate_payroll_period(2026, 10) is not null as generated;
"""
ok, r = run(sql=FIXTURES)
step('fixtures + generate draft payroll (Oct 2026)',
     ok and 'generated' in (r.stdout or ''), (r.stderr or '')[-2500:])

# ---------------------------------------------------------------------------
# L1 — LEGACY state (what the pre-f carryover left behind), then the data
#      migration converts it into a normal advance book record
# ---------------------------------------------------------------------------
LEGACY = f"""
set app.current_uid = '{SUPER}';
do $$
declare
  s1 uuid; p_oct uuid; p_nov uuid; a uuid;
begin
  select id into s1 from public.site where name = 'Carry Tower';
  select id into p_oct from public.payroll_period where year = 2026 and month = 10;
  select e.id into a from public.employee e where e.full_name = 'Legacy Keeper';

  -- next month's period + row exactly as the OLD carryover wrote them
  insert into public.payroll_period (year, month) values (2026, 11) returning id into p_nov;
  insert into public.payroll_employee (
    payroll_period_id, employee_id, gross_salary, advance, deduction,
    absent_deduction, net_salary, notes
  ) values (p_nov, a, 0, 104, 0, 0, -104,
    '[Time card Oct 2026] time card 12.00 h vs attendance 20.00 h → 104.00 added to advance');

  -- the time card entry + its tracking
  insert into public.payroll_time_card (
    payroll_period_id, site_id, employee_id, time_card_hours, carryover_applied
  ) values (p_oct, s1, a, 12, 104);
end $$;
"""
ok, r = run(sql=LEGACY)
step('L1a simulate a legacy direct-write carryover', ok, r.stderr[-2000:])

ok, r = run(files=[os.path.join(MIG, F)])
step('L1b re-run the migration (data conversion do-block)', ok, r.stderr[-2000:])

ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  a uuid; p_oct uuid; v_adv numeric; v_applied numeric; v_net numeric;
  v_rec public.advance_record; v_book jsonb; v_sheet jsonb; v_due jsonb; n int;
begin
  select e.id into a from public.employee e where e.full_name = 'Legacy Keeper';
  select id into p_oct from public.payroll_period where year = 2026 and month = 10;

  select * into v_rec from public.advance_record
  where employee_id = a and source_period_id = p_oct;
  if v_rec.id is null then raise exception 'FAIL L1: no converted record'; end if;
  if v_rec.amount <> 104 or v_rec.cut_year <> 2026 or v_rec.cut_month <> 11 then
    raise exception 'FAIL L1: amount=% cut=%/% (expected 104 / 2026-11)',
      v_rec.amount, v_rec.cut_year, v_rec.cut_month;
  end if;
  if v_rec.applied_amount <> 0 then
    raise exception 'FAIL L1: unpaid cut month → applied_amount must be 0';
  end if;
  if v_rec.note not like '[Time card Oct 2026]%' or v_rec.note not like '%cutting from Nov 2026%' then
    raise exception 'FAIL L1: note=%', v_rec.note;
  end if;

  -- the advance VALUE is untouched; only the marker moved
  select pe.advance, pe.advance_book_applied, pe.net_salary
    into v_adv, v_applied, v_net
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = a;
  if v_adv <> 104 or v_applied <> 104 or v_net <> -104 then
    raise exception 'FAIL L1: advance=% applied=% net=% (expected 104/104/-104)',
      v_adv, v_applied, v_net;
  end if;

  -- the book lists it as due + from_time_card
  v_book := public.get_advance_book();
  select x into v_due from jsonb_array_elements(v_book->'records') x
   where x->>'full_name' = 'Legacy Keeper';
  if v_due is null then raise exception 'FAIL L1: record missing from the book'; end if;
  if not (v_due->>'from_time_card')::boolean then
    raise exception 'FAIL L1: from_time_card must be true';
  end if;
  if (v_due->>'cleared')::boolean then
    raise exception 'FAIL L1: the Nov salary is unpaid — the record must be due';
  end if;

  -- the payroll sheet exposes it as a due record of the employee
  v_sheet := public.get_salary_sheet(2026, 10);
  select x into v_due from jsonb_array_elements(v_sheet->'employees') x
   where x->>'full_name' = 'Legacy Keeper';
  select jsonb_array_length(v_due->'advance_book_due') into n;
  if n <> 1 then raise exception 'FAIL L1: advance_book_due must list 1 record (got %)', n; end if;
end $$;
""")
step('L1c legacy carryover converted (record 104 cut Nov / row 104-104 / book due + badge)',
     ok, r.stderr[-2500:])

# ---------------------------------------------------------------------------
# L2 — re-saving the SAME time card must be a no-op (no double count)
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  s1 uuid; p_oct uuid; a uuid; v_adv numeric; v_applied numeric; v_net numeric; n int;
begin
  select id into s1 from public.site where name = 'Carry Tower';
  select id into p_oct from public.payroll_period where year = 2026 and month = 10;
  select e.id into a from public.employee e where e.full_name = 'Legacy Keeper';

  perform public.save_site_time_card_hours(p_oct, s1,
    jsonb_build_array(jsonb_build_object('employee_id', a, 'hours', 12)));

  select pe.advance, pe.advance_book_applied, pe.net_salary
    into v_adv, v_applied, v_net
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = a;
  if v_adv <> 104 or v_applied <> 104 or v_net <> -104 then
    raise exception 'FAIL L2: advance=% applied=% net=% (expected 104/104/-104)',
      v_adv, v_applied, v_net;
  end if;
  select count(*) into n from public.advance_record where employee_id = a;
  if n <> 1 then raise exception 'FAIL L2: expected exactly 1 record (got %)', n; end if;
end $$;
""")
step('L2 re-saving the same time card is a no-op (no double count)', ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# C1 — a NEW negative difference creates the book record (cut = next month)
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  s1 uuid; p_oct uuid; b uuid; v_rec public.advance_record; n int; v_status text;
begin
  select id into s1 from public.site where name = 'Carry Tower';
  select id into p_oct from public.payroll_period where year = 2026 and month = 10;
  select e.id into b from public.employee e where e.full_name = 'Fresh Face';

  perform public.save_site_time_card_hours(p_oct, s1,
    jsonb_build_array(jsonb_build_object('employee_id', b, 'hours', 12)));

  select * into v_rec from public.advance_record where employee_id = b;
  if v_rec.id is null then raise exception 'FAIL C1: no record created'; end if;
  if v_rec.amount <> 104 or v_rec.cut_year <> 2026 or v_rec.cut_month <> 11 then
    raise exception 'FAIL C1: amount=% cut=%/% (expected 104 / 2026-11)',
      v_rec.amount, v_rec.cut_year, v_rec.cut_month;
  end if;
  if v_rec.source_period_id is distinct from p_oct then
    raise exception 'FAIL C1: source_period_id must be the Oct period';
  end if;
  if v_rec.applied_amount <> 0 then
    raise exception 'FAIL C1: no Nov row yet → applied_amount must be 0';
  end if;
  if v_rec.note not like '%cutting from Nov 2026%' then
    raise exception 'FAIL C1: note=%', v_rec.note;
  end if;

  -- the Nov period exists (created by the carryover) but B has no row yet
  select status into v_status from public.payroll_period where year = 2026 and month = 11;
  if v_status is null then raise exception 'FAIL C1: the Nov period must exist'; end if;
  select count(*) into n from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = b;
  if n <> 0 then raise exception 'FAIL C1: B must not have a Nov row before generation'; end if;
end $$;
""")
step('C1 negative difference → book record (104, cut Nov, source Oct, due)', ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# C2 — generate Nov: the record folds into B's row; A's legacy row keeps its
#      advance (regenerated around it)
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
insert into public.attendance (employee_id, date, status, hours)
select e.id, d.dt, 'present', 10
from public.employee e
cross join (values (date '2026-11-05'), (date '2026-11-20')) as d(dt)
where e.full_name in ('Legacy Keeper', 'Fresh Face');
select public.generate_payroll_period(2026, 11) is not null as generated;
""")
ok2 = ok and 'generated' in (r.stdout or '')
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  a uuid; b uuid; v_adv numeric; v_applied numeric; v_net numeric; v_gross numeric;
begin
  select e.id into a from public.employee e where e.full_name = 'Legacy Keeper';
  select e.id into b from public.employee e where e.full_name = 'Fresh Face';

  select pe.advance, pe.advance_book_applied, pe.net_salary, pe.gross_salary
    into v_adv, v_applied, v_net, v_gross
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = b;
  if v_gross <> 260 or v_adv <> 104 or v_applied <> 104 or v_net <> 156 then
    raise exception 'FAIL C2b: B gross=% advance=% applied=% net=% (expected 260/104/104/156)',
      v_gross, v_adv, v_applied, v_net;
  end if;

  select pe.advance, pe.advance_book_applied, pe.net_salary, pe.gross_salary
    into v_adv, v_applied, v_net, v_gross
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = a;
  if v_gross <> 260 or v_adv <> 104 or v_applied <> 104 or v_net <> 156 then
    raise exception 'FAIL C2a: A gross=% advance=% applied=% net=% (expected 260/104/104/156)',
      v_gross, v_adv, v_applied, v_net;
  end if;
end $$;
""")
step('C2 generate Nov folds the record in (B 104/104/156; A keeps its legacy advance)',
     ok and ok2, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# C3 — re-saving a different amount updates the record AND the advance
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  s1 uuid; p_oct uuid; b uuid; v_adv numeric; v_applied numeric; v_net numeric;
  v_rec public.advance_record;
begin
  select id into s1 from public.site where name = 'Carry Tower';
  select id into p_oct from public.payroll_period where year = 2026 and month = 10;
  select e.id into b from public.employee e where e.full_name = 'Fresh Face';

  perform public.save_site_time_card_hours(p_oct, s1,
    jsonb_build_array(jsonb_build_object('employee_id', b, 'hours', 10)));

  select * into v_rec from public.advance_record where employee_id = b;
  if v_rec.amount <> 130 then raise exception 'FAIL C3: record amount=% (expected 130)', v_rec.amount; end if;
  if v_rec.note not like '%→ 130.00 cutting from Nov 2026%' then
    raise exception 'FAIL C3: note=%', v_rec.note;
  end if;

  select pe.advance, pe.advance_book_applied, pe.net_salary
    into v_adv, v_applied, v_net
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = b;
  if v_adv <> 130 or v_applied <> 130 or v_net <> 130 then
    raise exception 'FAIL C3: advance=% applied=% net=% (expected 130/130/130)',
      v_adv, v_applied, v_net;
  end if;
end $$;
""")
step('C3 re-save updates record + advance (130 / 130 / 130)', ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# C4 — the time card now MATCHES the attendance → the record is deleted
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  s1 uuid; p_oct uuid; b uuid; v_adv numeric; v_applied numeric; v_net numeric; n int;
begin
  select id into s1 from public.site where name = 'Carry Tower';
  select id into p_oct from public.payroll_period where year = 2026 and month = 10;
  select e.id into b from public.employee e where e.full_name = 'Fresh Face';

  perform public.save_site_time_card_hours(p_oct, s1,
    jsonb_build_array(jsonb_build_object('employee_id', b, 'hours', 20)));

  select count(*) into n from public.advance_record where employee_id = b;
  if n <> 0 then raise exception 'FAIL C4: the record must be deleted (got %)', n; end if;

  select pe.advance, pe.advance_book_applied, pe.net_salary
    into v_adv, v_applied, v_net
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = b;
  if v_adv <> 0 or v_applied <> 0 or v_net <> 260 then
    raise exception 'FAIL C4: advance=% applied=% net=% (expected 0/0/260)',
      v_adv, v_applied, v_net;
  end if;
end $$;
""")
step('C4 matching time card deletes the record (advance back to 0)', ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# C5 — a POSITIVE difference (time card above attendance) creates no record
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  s1 uuid; p_oct uuid; b uuid; n int; v_adv numeric;
begin
  select id into s1 from public.site where name = 'Carry Tower';
  select id into p_oct from public.payroll_period where year = 2026 and month = 10;
  select e.id into b from public.employee e where e.full_name = 'Fresh Face';

  perform public.save_site_time_card_hours(p_oct, s1,
    jsonb_build_array(jsonb_build_object('employee_id', b, 'hours', 25)));

  select count(*) into n from public.advance_record where employee_id = b;
  if n <> 0 then raise exception 'FAIL C5: a positive difference must not create a record'; end if;
  select pe.advance into v_adv
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = b;
  if v_adv <> 0 then raise exception 'FAIL C5: advance=% (expected 0)', v_adv; end if;
end $$;
""")
step('C5 positive difference → no record, no advance', ok, r.stderr[-2000:])

# ---------------------------------------------------------------------------
# C6 — recreate the record, RESCHEDULE it to Dec by hand, then re-save: the
#      amount follows the time card but the user's cut month is preserved
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  s1 uuid; p_oct uuid; b uuid; v_rec public.advance_record;
  v_adv numeric; v_applied numeric; v_net numeric;
begin
  select id into s1 from public.site where name = 'Carry Tower';
  select id into p_oct from public.payroll_period where year = 2026 and month = 10;
  select e.id into b from public.employee e where e.full_name = 'Fresh Face';

  -- recreate (12 h → 104, cut Nov)
  perform public.save_site_time_card_hours(p_oct, s1,
    jsonb_build_array(jsonb_build_object('employee_id', b, 'hours', 12)));
  select pe.advance into v_adv
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = b;
  if v_adv <> 104 then raise exception 'FAIL C6a: advance=% (expected 104)', v_adv; end if;

  -- the user reschedules the record to Dec
  select * into v_rec from public.advance_record where employee_id = b;
  perform public.save_advance_record(jsonb_build_object(
    'id', v_rec.id, 'employee_id', b, 'amount', v_rec.amount,
    'given_date', v_rec.given_date, 'cut_year', 2026, 'cut_month', 12,
    'note', v_rec.note));

  select pe.advance, pe.advance_book_applied, pe.net_salary
    into v_adv, v_applied, v_net
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = b;
  if v_adv <> 0 or v_applied <> 0 or v_net <> 260 then
    raise exception 'FAIL C6b: after reschedule advance=% applied=% net=% (expected 0/0/260)',
      v_adv, v_applied, v_net;
  end if;

  -- re-save 8 h → needed 156; the record's amount + note follow, the cut
  -- month (Dec) is PRESERVED and the Nov row stays untouched
  perform public.save_site_time_card_hours(p_oct, s1,
    jsonb_build_array(jsonb_build_object('employee_id', b, 'hours', 8)));

  select * into v_rec from public.advance_record where employee_id = b;
  if v_rec.amount <> 156 then raise exception 'FAIL C6c: amount=% (expected 156)', v_rec.amount; end if;
  if v_rec.cut_year <> 2026 or v_rec.cut_month <> 12 then
    raise exception 'FAIL C6c: cut=%/% (the user reschedule to Dec must be preserved)',
      v_rec.cut_year, v_rec.cut_month;
  end if;
  if v_rec.note not like '%cutting from Dec 2026%' then
    raise exception 'FAIL C6c: note must name the actual cut month (Dec), got %', v_rec.note;
  end if;

  select pe.advance, pe.advance_book_applied, pe.net_salary
    into v_adv, v_applied, v_net
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 11 and pe.employee_id = b;
  if v_adv <> 0 or v_applied <> 0 or v_net <> 260 then
    raise exception 'FAIL C6d: Nov row must be untouched (got %/%/%)', v_adv, v_applied, v_net;
  end if;
end $$;
""")
step('C6 reschedule preserved: amount follows the time card, cut month stays Dec',
     ok, r.stderr[-2500:])

# ---------------------------------------------------------------------------
# C7 — generate Dec, pay it → the record is CLEARED (with the time-card badge)
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
insert into public.attendance (employee_id, date, status, hours)
select e.id, d.dt, 'present', 10
from public.employee e
cross join (values (date '2026-12-05'), (date '2026-12-20')) as d(dt)
where e.full_name = 'Fresh Face';
select public.generate_payroll_period(2026, 12) is not null as generated;
""")
ok2 = ok and 'generated' in (r.stdout or '')
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  b uuid; v_pe uuid; v_adv numeric; v_applied numeric; v_net numeric;
  v_book jsonb; v_rec jsonb;
begin
  select e.id into b from public.employee e where e.full_name = 'Fresh Face';
  select pe.id into v_pe
  from public.payroll_employee pe
  join public.payroll_period p on p.id = pe.payroll_period_id
  where p.year = 2026 and p.month = 12 and pe.employee_id = b;

  select pe.advance, pe.advance_book_applied, pe.net_salary
    into v_adv, v_applied, v_net
  from public.payroll_employee pe where pe.id = v_pe;
  if v_adv <> 156 or v_applied <> 156 or v_net <> 104 then
    raise exception 'FAIL C7a: Dec advance=% applied=% net=% (expected 156/156/104)',
      v_adv, v_applied, v_net;
  end if;

  perform public.mark_employee_salary_paid(v_pe);

  v_book := public.get_advance_book();
  select x into v_rec from jsonb_array_elements(v_book->'records') x
   where x->>'full_name' = 'Fresh Face';
  if not (v_rec->>'cleared')::boolean then
    raise exception 'FAIL C7b: the record must be cleared after the Dec salary was paid';
  end if;
  if not (v_rec->>'from_time_card')::boolean then
    raise exception 'FAIL C7b: from_time_card must stay true';
  end if;
  if (v_rec->>'cleared_at') is null then
    raise exception 'FAIL C7b: cleared_at must carry the payment timestamp';
  end if;

  -- totals: A's legacy record still due (Nov unpaid), B's cleared
  if (v_book->'totals'->>'due_count')::int <> 1
     or (v_book->'totals'->>'cleared_count')::int <> 1
     or (v_book->'totals'->>'cleared_amount')::numeric <> 156 then
    raise exception 'FAIL C7c: totals=%', v_book->'totals';
  end if;
end $$;
""")
step('C7 Dec generated + paid → record cleared (badge kept; totals 1 due / 1 cleared)',
     ok and ok2, r.stderr[-2500:])

# ---------------------------------------------------------------------------
# C8 — re-saving the time card after the clear must RAISE
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  s1 uuid; p_oct uuid; b uuid;
begin
  select id into s1 from public.site where name = 'Carry Tower';
  select id into p_oct from public.payroll_period where year = 2026 and month = 10;
  select e.id into b from public.employee e where e.full_name = 'Fresh Face';

  perform public.save_site_time_card_hours(p_oct, s1,
    jsonb_build_array(jsonb_build_object('employee_id', b, 'hours', 6)));
  raise exception 'FAIL C8: re-saving after the clear must raise';
end $$;
""", expect_fail='already cleared')
step('C8 re-saving after the clear raises (paid salaries are history)', ok, r.stderr[-1200:])

# ---------------------------------------------------------------------------
# C9 — the audit trail holds the carryover actions
#      (C1 create, C3 update, C4 remove, C6 recreate, C6c update = 5)
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare n int;
begin
  select count(*) into n from public.payroll_audit_log
  where action = 'time_card_carryover';
  if n <> 5 then
    raise exception 'FAIL C9: expected 5 time_card_carryover audits, got %', n;
  end if;
end $$;
""")
step('C9 audit trail holds the 5 carryover actions', ok, r.stderr[-1200:])

# ---------------------------------------------------------------------------
# C10 — the unique index blocks a second record for the same source period
# ---------------------------------------------------------------------------
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
do $$
declare
  p_oct uuid; b uuid; r public.advance_record;
begin
  select id into p_oct from public.payroll_period where year = 2026 and month = 10;
  select e.id into b from public.employee e where e.full_name = 'Fresh Face';
  select * into r from public.advance_record where employee_id = b;

  insert into public.advance_record
    (employee_id, amount, given_date, cut_year, cut_month, source_period_id)
  values
    (b, 50, current_date, 2027, 1, p_oct);
  raise exception 'FAIL C10: the duplicate insert must violate the unique index';
end $$;
""", expect_fail='uq_advance_record_source')
step('C10 one carryover record per (source period, employee) — unique index', ok, r.stderr[-1200:])

# ---------------------------------------------------------------------------
# C11 — access control: no session → Access denied
# ---------------------------------------------------------------------------
ok, r = run(sql="""
set app.current_uid = '';
do $$
declare s1 uuid; p_oct uuid;
begin
  select id into s1 from public.site where name = 'Carry Tower';
  select id into p_oct from public.payroll_period where year = 2026 and month = 10;
  perform public.save_site_time_card_hours(p_oct, s1, '[]'::jsonb);
end $$;
""", expect_fail='Access denied')
step('C11 no session → save_site_time_card_hours raises Access denied', ok, r.stderr[-1200:])

# ---------------------------------------------------------------------------
print()
passed = sum(results)
print(f'== {passed}/{len(results)} steps passed ==')
if passed != len(results):
    sys.exit(1)
