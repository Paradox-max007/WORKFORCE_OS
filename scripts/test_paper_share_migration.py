#!/usr/bin/env python3
"""
Local-PostgreSQL verification of 20261108b_attendance_paper_share.sql
(the PAPER-styled shared sheet: signature-column marking on the A4 daily form).

Loads the chain (shim -> full schema incl. share links + paper extension ->
seed), then functionally verifies:

  P1  snapshot carries is_team_leader / is_supervisor + client_name /
      project_name (paper header + row tints)
  P2  submit with p_paper_date + p_extras: signature marks applied through the
      shared engine into public.attendance (SAME table the in-app Excel reads)
  P3  frozen snapshot carries paper_date / extras / total_present / total_absent,
      with totals computed SERVER-SIDE (crew final marks + extra rows)
  P4  legacy snapshot (no paper_date) gets paper_date back-filled with the save
      date when read back through get_shared_attendance_sheet
  P5  extras sanitisation: >10 rows dropped, long values trimmed to caps,
      empty rows normalised
  P6  paper_date clamped into the month and never the future
  P7  submit result includes paper_date / totals
  P8  one-time lock + grant-edit lifecycle intact on the new signature
  P9  old 3-arg submit overload GONE (no stale overload), new one executable
      by anon
  ID  migration file re-runs cleanly on top of the loaded schema
"""
import os
import shutil
import subprocess

ROOT = '/home/z/my-project'
SCRIPTS = os.path.join(ROOT, 'scripts')
PGDATA = os.path.join(SCRIPTS, 'pgdata_paper_share')

import pgserver  # noqa: E402

PSQL = os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin', 'psql')
MIG = os.path.join(ROOT, 'supabase', 'migrations')

subprocess.run(['pkill', '-f', 'pgdata_paper_share'], capture_output=True)
shutil.rmtree(PGDATA, ignore_errors=True)
server = pgserver.get_server(PGDATA, cleanup_mode='stop')
base_uri = server.get_uri('postgres')
if subprocess.run([PSQL, base_uri, '-tAc',
                   "select 1 from pg_database where datname = 'pulse_paper'"],
                  capture_output=True, text=True).stdout.strip() != '1':
    subprocess.run([PSQL, base_uri, '-q', '-c', 'create database pulse_paper'],
                   check=True, capture_output=True, text=True)
uri = server.get_uri('pulse_paper')

SUPER = '00000000-0000-0000-0000-0000000000aa'
SITE = '00000000-0000-0000-0000-0000000000a1'
E1 = '00000000-0000-0000-0000-0000000000b1'
E2 = '00000000-0000-0000-0000-0000000000b2'
TL = '00000000-0000-0000-0000-0000000000b4'


def psql(args, sqls, want_fail=None):
    cmd = [PSQL, uri, '-q', '-v', 'ON_ERROR_STOP=1']
    for f in args:
        cmd += ['-f', f]
    for s in sqls:
        cmd += ['-c', s]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if want_fail:
        return (r.returncode != 0 and want_fail in (r.stderr or '')), r.stdout, r.stderr
    return r.returncode == 0, r.stdout, r.stderr


def as_uid(uid, *sqls, want_fail=None):
    pre = f"select set_config('app.current_uid', '{uid}', false)"
    return psql([], [pre, *sqls], want_fail=want_fail)


def q(uid, sql):
    pre = f"select set_config('app.current_uid', '{uid}', false)"
    cmd = [PSQL, uri, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', pre, '-c', sql]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        return f'ERR: {r.stderr.strip()[:300]}'
    lines = [l for l in r.stdout.splitlines() if l.strip()]
    return lines[-1] if lines else ''


results = []


def step(name, ok, detail=''):
    results.append(ok)
    print(('  OK  ' if ok else '  FAIL') + ' ' + name + ('' if ok else f'\n{detail}'))


print('== 20261108b paper-styled shared sheet migration verification ==')

with open(os.path.join(ROOT, 'supabase', 'schema.sql')) as f:
    schema = f.read()
schema = schema.replace('create extension if not exists pgcrypto;',
                        '-- (pgcrypto skipped locally — gen_random_uuid() is core SQL)')
with open(os.path.join(SCRIPTS, 'schema_local.sql'), 'w') as f:
    f.write(schema)

for name, files in [
    ('load Supabase shims', [os.path.join(SCRIPTS, 'test_shim.sql')]),
    ('load full schema (incl. paper share)', [os.path.join(SCRIPTS, 'schema_local.sql')]),
    ('seed super admin', [os.path.join(SCRIPTS, 'test_seed.sql')]),
]:
    ok, out, err = psql(files, [])
    step(name, ok, err[-2500:])

ok, out, err = psql([os.path.join(MIG, '20261108b_attendance_paper_share.sql')], [])
step('ID re-run 20261108b (idempotency)', ok, err[-2000:])

# seed -----------------------------------------------------------------------
ok, out, err = as_uid(SUPER, f"""
insert into public.site (id, name, client_name, project_name) values
  ('{SITE}', 'Marina Heights Tower', 'Emaar Properties', 'Phase 2 — Podium')
on conflict (id) do nothing;
insert into public.employee (id, full_name, employee_code, current_site_id, join_date, rating, is_team_leader, team_leader_site_id, position) values
  ('{E1}', 'Rajesh Kumar', 'TM-001', '{SITE}', '2025-01-01', 4.5, false, null, 'General Helper'),
  ('{E2}', 'Muhammad Iqbal', 'TM-002', '{SITE}', '2025-01-01', 4.5, false, null, 'Site Supervisor'),
  ('{TL}', 'Arun Nair', 'TM-004', '{SITE}', '2025-01-01', 4.5, true, '{SITE}', 'Mason')
on conflict (id) do nothing;
select 1;
""")
step('seed site + employees (TL + supervisor)', ok, err[-1500:])

ok, out, err = as_uid(SUPER, f"select public.create_attendance_share_link('{SITE}', '2026-11');")
step('create link', ok, err[-1200:])
token = q(SUPER, f"""select token from public.attendance_share_link
 where site_id = '{SITE}' order by created_at desc limit 1""")

# P1 enriched live snapshot ---------------------------------------------------
sheet = q('', f"select public.get_shared_attendance_sheet('{token}')::text")
s = sheet.replace(' ', '')
p1a = '"client_name":"EmaarProperties"' in s
p1b = '"project_name":"Phase2—Podium"' in s
p1c = '"is_team_leader":true' in s and '"is_supervisor":true' in s
p1d = '"is_team_leader":false' in s
step('P1 live view carries client/project names + TL/supervisor flags',
     p1a and p1b and p1c and p1d, sheet[:500])

# P2 submit with paper date + extras (anon path) -------------------------------
entries = f'''[{{"employee_id":"{E1}","date":"2026-11-05","value":"10"}},
 {{"employee_id":"{E2}","date":"2026-11-05","value":"A"}},
 {{"employee_id":"{TL}","date":"2026-11-05","value":"9.5"}}]'''
extras = '''[{"name":"Walk-in Helper","code":"EX-01","trade":"Helper","mark":"10"},
 {"name":"Temp Electrician","code":"EX-02","trade":"Electrician","mark":"A"},
 {"name":"","code":"","trade":"","mark":""}]'''
ok, out, err = as_uid('',
    f"select public.submit_shared_attendance_sheet('{token}', '{entries}'::jsonb, 'Site Supervisor', '2026-11-05'::date, '{extras}'::jsonb);")
step('P2a anon submit with paper_date + extras accepted', ok, err[-1500:])
t2a = q(SUPER, f"""select status || '|' || coalesce(hours::text,'') from public.attendance
 where employee_id = '{E1}' and date = '2026-11-05'""")
t2b = q(SUPER, f"select status from public.attendance where employee_id = '{E2}' and date = '2026-11-05'")
t2c = q(SUPER, f"""select coalesce(hours::text,'') from public.attendance
 where employee_id = '{TL}' and date = '2026-11-05'""")
step('P2b marks written to public.attendance (same table as the Excel)',
     t2a.startswith('present|10') and t2b == 'absent' and t2c.startswith('9.5'),
     f'{t2a} | {t2b} | {t2c}')

# P3 frozen snapshot -----------------------------------------------------------
snap = q(SUPER, f"""select sheet_data::text from public.attendance_share_link
 where token = '{token}'""")
sn = snap.replace(' ', '')
p3a = '"paper_date":"2026-11-05"' in sn
p3b = '"total_present":3' in sn and '"total_absent":2' in sn
p3c = '"Walk-inHelper"' in sn and '"TempElectrician"' in sn
p3d = '"is_team_leader":true' in sn
p3e = '"client_name":"EmaarProperties"' in sn
step('P3 frozen snapshot: paper_date + server-computed totals (3 present, 2 absent) + extras + flags',
     p3a and p3b and p3c and p3d and p3e, snap[:700])

# P4 legacy snapshot back-fill --------------------------------------------------
ok, out, err = as_uid(SUPER, f"""
update public.attendance_share_link
  set sheet_data = sheet_data - 'paper_date'
 where token = '{token}';
select 1;
""")
sheet2 = q('', f"select public.get_shared_attendance_sheet('{token}')::text")
p4a = '"paper_date":"2026-11-0' in sheet2.replace(' ', '')  # save date of THIS run
step('P4 legacy snapshot (no paper_date) back-filled with the save date',
     ok and p4a, sheet2[:400])

# P5 extras sanitisation ---------------------------------------------------------
import json as _json
ok, out, err = as_uid(SUPER, f"select public.grant_attendance_share_edit('{token}');")
extras5 = _json.dumps(
    [{'name': 'N' * 200, 'code': 'C', 'trade': 'T', 'mark': '8'}]
    + [{'name': f'X{i}', 'code': f'C{i}', 'trade': f'T{i}', 'mark': '8'} for i in range(14)]
)
ok2, out2, err2 = as_uid('',
    f"""select public.submit_shared_attendance_sheet('{token}', '[]'::jsonb, null,
        null, '{extras5}'::jsonb);""")
snap2 = q(SUPER, f"""select sheet_data::text from public.attendance_share_link where token = '{token}'""")
sn2 = snap2.replace(' ', '')
n_extras = q(SUPER, f"""select jsonb_array_length(sheet_data->'extras') from public.attendance_share_link where token = '{token}'""")
len_ok = q(SUPER, f"""select length((sheet_data->'extras'->0->>'name')) from public.attendance_share_link where token = '{token}'""")
step('P5 extras sanitised (max 10 rows, name capped at 80)',
     ok and ok2 and n_extras == '10' and len_ok == '80', f'{n_extras} | {len_ok} | {err2[-300:]}')

# P6 paper_date clamped ---------------------------------------------------------
ok, out, err = as_uid(SUPER, f"select public.grant_attendance_share_edit('{token}');")
res = q('', f"""select (public.submit_shared_attendance_sheet('{token}', '[]'::jsonb, null, '2099-01-01'::date, '[]'::jsonb)->>'paper_date');""")
step('P6 future paper_date clamped (never after today / month end)',
     res <= '2026-11-07' and res >= '2026-11-01', res)

# P7 result shape ----------------------------------------------------------------
ok, out, err = as_uid(SUPER, f"select public.grant_attendance_share_edit('{token}');")
res = q('', f"""select public.submit_shared_attendance_sheet('{token}', '[]'::jsonb)::text""")
r = res.replace(' ', '')
step('P7 submit result carries paper_date + totals',
     '"paper_date":"2026-11-' in r and '"total_present":' in r and '"total_absent":' in r, res[:300])

# P8 lifecycle intact -------------------------------------------------------------
ok, out, err = as_uid('', f"select public.submit_shared_attendance_sheet('{token}', '[]'::jsonb);",
                      want_fail='already submitted and is locked')
t8b = q(SUPER, f"select submit_count from public.attendance_share_link where token = '{token}'")
step('P8 one-time lock still enforced on the new signature', ok and t8b == '4', f'{t8b} | {err[-300:]}')

# P9 overloads / ACL --------------------------------------------------------------
n_old = q('', """select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'submit_shared_attendance_sheet'""")
t9b = q('', "select has_function_privilege('anon', 'public.submit_shared_attendance_sheet(text, jsonb, text, date, jsonb)', 'execute')")
step('P9 single overload (old 3-arg dropped), new one executable by anon',
     n_old == '1' and t9b == 't', f'{n_old} | {t9b}')

print()
passed = sum(results)
print(f'== {passed}/{len(results)} steps passed ==')
if passed < len(results):
    raise SystemExit(1)
