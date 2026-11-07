#!/usr/bin/env python3
"""
Local-PostgreSQL verification of 20261107_attendance_free_text.sql.

Loads the chain (shim -> full schema incl. the new note column + RPC ->
seed), then functionally verifies the free-text marking rules:

  T1  attendance.note column exists
  T2  'A'  -> absent (status='absent', hours null, note null)
  T3  'a'  -> absent (case-insensitive)
  T4  '10' -> present, hours=10, note null
  T5  'OT' -> present, hours NULL, note='OT'  (free text, NOT absent)
  T6  'travel day' -> present, note='travel day'
  T7  'absent' word -> NOT absent any more (free-text marker per user rule:
      only "A" counts as absent)
  T8  '' (clear) -> row removed
  T9  41-char text -> rejected (max 40)
  T10 '25' -> rejected (hours > 24)
  T11 '8h' -> free-text marker (present, no hours)
  T12 free text NEVER triggers the 3-consecutive-absence auto-warning
  T13 get_month_attendance returns the note (select a.*)
  ID  migration file re-runs cleanly on top of the loaded schema
"""
import os
import shutil
import subprocess

ROOT = '/home/z/my-project'
SCRIPTS = os.path.join(ROOT, 'scripts')
PGDATA = os.path.join(SCRIPTS, 'pgdata_att_free_text')

import pgserver  # noqa: E402

PSQL = os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin', 'psql')
MIG = os.path.join(ROOT, 'supabase', 'migrations')

subprocess.run(['pkill', '-f', 'pgdata_att_free_text'], capture_output=True)
shutil.rmtree(PGDATA, ignore_errors=True)
server = pgserver.get_server(PGDATA, cleanup_mode='stop')
base_uri = server.get_uri('postgres')
if subprocess.run([PSQL, base_uri, '-tAc',
                   "select 1 from pg_database where datname = 'pulse_att_ft'"],
                  capture_output=True, text=True).stdout.strip() != '1':
    subprocess.run([PSQL, base_uri, '-q', '-c', 'create database pulse_att_ft'],
                   check=True, capture_output=True, text=True)
uri = server.get_uri('pulse_att_ft')


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


print('== 20261107 attendance free-text markers migration verification ==')

with open(os.path.join(ROOT, 'supabase', 'schema.sql')) as f:
    schema = f.read()
schema = schema.replace('create extension if not exists pgcrypto;',
                        '-- (pgcrypto skipped locally — gen_random_uuid() is core SQL)')
with open(os.path.join(SCRIPTS, 'schema_local.sql'), 'w') as f:
    f.write(schema)

for name, files in [
    ('load Supabase shims', [os.path.join(SCRIPTS, 'test_shim.sql')]),
    ('load full schema (incl. note column + new mark_attendance)', [os.path.join(SCRIPTS, 'schema_local.sql')]),
    ('seed super admin + plain admin', [os.path.join(SCRIPTS, 'test_seed.sql')]),
]:
    ok, r = run(files)
    step(name, ok, r.stderr[-3000:])

ok, r = run([os.path.join(MIG, '20261107_attendance_free_text.sql')])
step('ID re-run 20261107 (idempotency)', ok, r.stderr[-2000:])

SUPER = '00000000-0000-0000-0000-0000000000aa'
ADMIN = '00000000-0000-0000-0000-0000000000bb'

# a site + an employee assigned to it, so date-effective site auth passes
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
insert into public.site (id, name, client_name, project_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Marina Heights Tower', 'Emaar', 'Phase 2')
on conflict (id) do nothing;
insert into public.employee (id, full_name, employee_code, current_site_id, join_date) values
  ('00000000-0000-0000-0000-0000000000b1', 'Test Marker', 'TM-001',
   '00000000-0000-0000-0000-0000000000a1', '2025-01-01')
on conflict (id) do nothing;
select 1 / case when exists (select 1 from public.employee where id = '00000000-0000-0000-0000-0000000000b1') then 1 else 0 end;
""")
step('seed site + employee', ok, r.stderr[-1500:])

E = '00000000-0000-0000-0000-0000000000b1'


def mark(day, value):
    return f"""
set app.current_uid = '{SUPER}';
select public.mark_attendance('{E}', '2026-10-{day:02d}', {value!r});
"""


ok, r = run(sql=mark(1, 'A'))
step("T2 'A' -> absent", ok, r.stderr[-1500:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select 1 / case when (select count(*) from public.attendance where employee_id='{E}' and date='2026-10-01' and status='absent' and hours is null and note is null) = 1 then 1 else 0 end;
""")
step('T2 stored absent/null/null', ok, r.stdout + r.stderr[-1500:])

ok, r = run(sql=mark(2, 'a'))
step("T3 'a' (lowercase) accepted", ok, r.stderr[-1500:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select 1 / case when (select count(*) from public.attendance where employee_id='{E}' and date='2026-10-02' and status='absent') = 1 then 1 else 0 end;
""")
step('T3 stored absent', ok, r.stdout + r.stderr[-1500:])

ok, r = run(sql=mark(3, '10'))
step("T4 '10' -> hours", ok, r.stderr[-1500:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select 1 / case when (select count(*) from public.attendance where employee_id='{E}' and date='2026-10-03' and status='present' and hours=10 and note is null) = 1 then 1 else 0 end;
""")
step('T4 stored present/10/null', ok, r.stdout + r.stderr[-1500:])

ok, r = run(sql=mark(4, 'OT'))
step("T5 'OT' -> free-text marker", ok, r.stderr[-1500:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select 1 / case when (select count(*) from public.attendance where employee_id='{E}' and date='2026-10-04' and status='present' and hours is null and note='OT') = 1 then 1 else 0 end;
""")
step('T5 stored present/null/OT (NOT absent)', ok, r.stdout + r.stderr[-1500:])

ok, r = run(sql=mark(5, 'travel day'))
step("T6 'travel day' -> marker", ok, r.stderr[-1500:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select 1 / case when (select count(*) from public.attendance where employee_id='{E}' and date='2026-10-05' and status='present' and hours is null and note='travel day') = 1 then 1 else 0 end;
""")
step('T6 stored present/null/travel day', ok, r.stdout + r.stderr[-1500:])

ok, r = run(sql=mark(6, 'absent'))
step("T7 'absent' word -> free text now", ok, r.stderr[-1500:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select 1 / case when (select count(*) from public.attendance where employee_id='{E}' and date='2026-10-06' and status='present' and note='absent') = 1 then 1 else 0 end;
""")
step('T7 only A counts as absent (word = marker)', ok, r.stdout + r.stderr[-1500:])

ok, r = run(sql=mark(4, ''))
step("T8 '' clears the record", ok, r.stderr[-1500:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select 1 / case when (select count(*) from public.attendance where employee_id='{E}' and date='2026-10-04') = 0 then 1 else 0 end;
""")
step('T8 row removed', ok, r.stdout + r.stderr[-1500:])

ok, r = run(sql=mark(7, 'x' * 41), expect_fail='40 characters')
step('T9 41-char marker rejected', ok, r.stderr[-1500:])

ok, r = run(sql=mark(8, '25'), expect_fail='between 0 and 24')
step('T10 hours > 24 rejected', ok, r.stderr[-1500:])

ok, r = run(sql=mark(9, '8h'))
step("T11 '8h' -> free-text marker", ok, r.stderr[-1500:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select 1 / case when (select count(*) from public.attendance where employee_id='{E}' and date='2026-10-09' and status='present' and hours is null and note='8h') = 1 then 1 else 0 end;
""")
step('T11 stored present/null/8h', ok, r.stdout + r.stderr[-1500:])

# T12 — free text must NEVER trigger the auto-warning even on consecutive days
ok, r = run(sql=(
    mark(11, 'H') + mark(12, 'H') + mark(13, 'H') + mark(14, 'H')
))
step('T12a 4 consecutive free-text days marked', ok, r.stderr[-2000:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select 1 / case when (select count(*) from public.warning where employee_id='{E}') = 0 then 1 else 0 end;
""")
step('T12b no auto-warning for free text', ok, r.stdout + r.stderr[-1500:])

# …but 3 real consecutive absences still do
ok, r = run(sql=(mark(18, 'A') + mark(19, 'A') + mark(20, 'A')))
step('T12c 3 consecutive A days marked', ok, r.stderr[-2000:])
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select 1 / case when (select count(*) from public.warning where employee_id='{E}' and reason like '%consecutive%') >= 1 then 1 else 0 end;
""")
step('T12d auto-warning still fires for real absences', ok, r.stdout + r.stderr[-1500:])

# T13 — get_month_attendance returns the note column (travel day, absent-word
# marker, 8h, and the four H days = 7 note rows)
ok, r = run(sql=f"""
set app.current_uid = '{SUPER}';
select 1 / case when (select count(*) from public.get_month_attendance('2026-10') where employee_id='{E}' and note is not null) = 7 then 1 else 0 end;
""")
step('T13 get_month_attendance returns notes (7 rows)', ok, r.stdout + r.stderr[-1500:])

# permission check still enforced for plain admins
ok, r = run(sql=f"""
set app.current_uid = '{ADMIN}';
select public.mark_attendance('{E}', '2026-10-21', 'OT');
""", expect_fail='Access denied')
step('T14 plain admin still blocked', ok, r.stderr[-1500:])

print()
print(f"== {sum(results)}/{len(results)} steps passed ==")
raise SystemExit(0 if all(results) else 1)
