#!/usr/bin/env python3
"""
Local-PostgreSQL verification of 20261108_attendance_share_links.sql.

Loads the chain (shim -> full schema incl. share links -> seed), then
functionally verifies the whole share-link lifecycle:

  T1  attendance_share_link table exists, RLS enabled
  T2  mark_attendance_core NOT executable by anon/authenticated (ACL revoked)
  T3  super admin creates a link (token + site snapshot + month)
  T4  get_shared_attendance_sheet with no session (anon path) -> live crew
      with markable days + current marks
  T5  submit_shared_attendance_sheet (anon path) applies hours / A / free
      text through the shared marking engine
  T6  link flips to submitted: get sheet returns the SAVED snapshot +
      submitted_at timestamp
  T7  second submit on the same link -> locked error (one-time use)
  T8  invalid / unknown token -> exists=false (get) / 'Link not found' (submit)
  T9  grant_attendance_share_edit by an assigned admin re-opens editing;
      sheet is live again; second submit works (submit_count = 2)
  T10 admin WITHOUT the site assigned cannot create / grant edit
  T11 invalid month key rejected
  T12 submit skips future dates + other-site days (date-effective engine)
  T13 mark_attendance regression: permission + parse behaviour intact
  T14 rating engine + 3-consecutive-absences auto-warning fire via the
      shared submit path (warning row + super-admin notification)
  T15 list_attendance_share_links scoped: super sees all, admin sees only
      their assigned sites' links, newest first
  ID  migration file re-runs cleanly on top of the loaded schema

NOTE: the local psql connects as the cluster superuser, which bypasses
EXECUTE revokes — direct-call denial is therefore verified through the
role ACL (has_function_privilege) instead of an actual anon session.
"""
import os
import shutil
import subprocess

ROOT = '/home/z/my-project'
SCRIPTS = os.path.join(ROOT, 'scripts')
PGDATA = os.path.join(SCRIPTS, 'pgdata_share_links')

import pgserver  # noqa: E402

PSQL = os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin', 'psql')
MIG = os.path.join(ROOT, 'supabase', 'migrations')

subprocess.run(['pkill', '-f', 'pgdata_share_links'], capture_output=True)
shutil.rmtree(PGDATA, ignore_errors=True)
server = pgserver.get_server(PGDATA, cleanup_mode='stop')
base_uri = server.get_uri('postgres')
if subprocess.run([PSQL, base_uri, '-tAc',
                   "select 1 from pg_database where datname = 'pulse_share'"],
                  capture_output=True, text=True).stdout.strip() != '1':
    subprocess.run([PSQL, base_uri, '-q', '-c', 'create database pulse_share'],
                   check=True, capture_output=True, text=True)
uri = server.get_uri('pulse_share')

SUPER = '00000000-0000-0000-0000-0000000000aa'
ADMIN = '00000000-0000-0000-0000-0000000000bb'
SITE = '00000000-0000-0000-0000-0000000000a1'
SITE2 = '00000000-0000-0000-0000-0000000000a2'
E1 = '00000000-0000-0000-0000-0000000000b1'
E2 = '00000000-0000-0000-0000-0000000000b2'
E3 = '00000000-0000-0000-0000-0000000000b3'


def psql(args, sqls, want_fail=None):
    """Run SQL files (-f) + statements (-c) in ONE psql session; returns
    (ok, stdout, stderr)."""
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
    """Run statements with app.current_uid set (uid='' → anonymous)."""
    pre = f"select set_config('app.current_uid', '{uid}', false)"
    return psql([], [pre, *sqls], want_fail=want_fail)


def q(uid, sql):
    """Single SELECT under a uid (tuples-only); returns the LAST output line
    or 'ERR: …' when the statement fails."""
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


print('== 20261108 attendance share links migration verification ==')

with open(os.path.join(ROOT, 'supabase', 'schema.sql')) as f:
    schema = f.read()
schema = schema.replace('create extension if not exists pgcrypto;',
                        '-- (pgcrypto skipped locally — gen_random_uuid() is core SQL)')
with open(os.path.join(SCRIPTS, 'schema_local.sql'), 'w') as f:
    f.write(schema)

for name, files in [
    ('load Supabase shims', [os.path.join(SCRIPTS, 'test_shim.sql')]),
    ('load full schema (incl. share links)', [os.path.join(SCRIPTS, 'schema_local.sql')]),
    ('seed super admin + plain admin', [os.path.join(SCRIPTS, 'test_seed.sql')]),
]:
    ok, out, err = psql(files, [])
    step(name, ok, err[-2500:])

ok, out, err = psql([os.path.join(MIG, '20261108_attendance_share_links.sql')], [])
step('ID re-run 20261108 (idempotency)', ok, err[-2000:])
# re-running 20261108 re-creates the old 3-arg submit overload that 20261108b
# dropped — re-apply the rest of the chain (real migration order) so the final
# state converges back to the single 5-arg overload a deployed database has
for _mig in ('20261108b_attendance_paper_share.sql', '20261108c_share_link_one_per_day.sql'):
    ok, out, err = psql([os.path.join(MIG, _mig)], [])
    step(f'ID chain re-run {_mig}', ok, err[-2000:])

ok, out, err = as_uid(SUPER, f"""
insert into public.site (id, name, client_name, project_name) values
  ('{SITE}', 'Marina Heights Tower', 'Emaar', 'Phase 2'),
  ('{SITE2}', 'Red Coast Compound', 'Red Coast Dev.', 'Villas')
on conflict (id) do nothing;
insert into public.employee (id, full_name, employee_code, current_site_id, join_date, rating) values
  ('{E1}', 'Rajesh Kumar', 'TM-001', '{SITE}', '2025-01-01', 4.5),
  ('{E2}', 'Muhammad Iqbal', 'TM-002', '{SITE}', '2025-01-01', 4.5),
  ('{E3}', 'Arun Nair', 'TM-003', '{SITE2}', '2025-01-01', 4.5)
on conflict (id) do nothing;
insert into public.admin_site (profile_id, site_id) values ('{ADMIN}', '{SITE}')
on conflict do nothing;
insert into public.menu_permission (profile_id, menu_key, allowed)
values ('{ADMIN}', 'attendance', true)
on conflict do nothing;
select 1;
""")
step('seed sites + employees + admin assignment', ok, err[-1500:])

# T1 table + RLS --------------------------------------------------------------
t1 = q('', "select count(*) from pg_tables where tablename = 'attendance_share_link' and rowsecurity")
step('T1 table exists + RLS enabled', t1 == '1', t1)

# T2 core not executable by anon/authenticated (ACL) --------------------------
t2a = q('', "select has_function_privilege('anon', 'public.mark_attendance_core(uuid, date, text, uuid)', 'execute')")
t2b = q('', "select has_function_privilege('authenticated', 'public.mark_attendance_core(uuid, date, text, uuid)', 'execute')")
t2c = q('', "select has_function_privilege('anon', 'public.build_shared_sheet_snapshot(uuid)', 'execute')")
step('T2 core + snapshot builder not executable by anon/authenticated',
     t2a == 'f' and t2b == 'f' and t2c == 'f', f'{t2a} | {t2b} | {t2c}')

# T3 create link --------------------------------------------------------------
ok, out, err = as_uid(SUPER, f"select public.create_attendance_share_link('{SITE}', '2026-11');")
step('T3a super admin creates link', ok, err[-1500:])
token = q(SUPER, f"""select token from public.attendance_share_link
 where site_id = '{SITE}' order by created_at desc limit 1""")
step('T3b token generated (20 hex chars)', len(token) == 20, token)

# T4 anon get sheet -----------------------------------------------------------
sheet = q('', f"select public.get_shared_attendance_sheet('{token}')::text")
s = sheet.replace(' ', '')
t4a = '"exists":true' in s and '"status":"active"' in s
t4b = 'RajeshKumar' in sheet.replace(' ', '') and 'ArunNair' not in sheet.replace(' ', '')
t4c = '"markable"' in s
step('T4 anon get sheet: active, live crew (site only), markable days', t4a and t4b and t4c, sheet[:600])

# T5 anon submit --------------------------------------------------------------
entries = f'''[{{"employee_id":"{E1}","date":"2026-11-02","value":"10"}},
 {{"employee_id":"{E1}","date":"2026-11-03","value":"A"}},
 {{"employee_id":"{E1}","date":"2026-11-04","value":"OT"}},
 {{"employee_id":"{E2}","date":"2026-11-02","value":"8.5"}},
 {{"employee_id":"{E2}","date":"2026-11-03","value":""}}]'''
ok, out, err = as_uid('',
    f"select public.submit_shared_attendance_sheet('{token}', '{entries}'::jsonb, 'Site Supervisor');")
step('T5a anon submit accepted', ok, err[-1500:])
t5b = q(SUPER, f"""select status || '|' || coalesce(hours::text,'') || '|' || coalesce(note,'')
 from public.attendance where employee_id = '{E1}' and date = '2026-11-02'""")
t5c = q(SUPER, f"select status from public.attendance where employee_id = '{E1}' and date = '2026-11-03'")
t5d = q(SUPER, f"""select status || '|' || coalesce(hours::text,'null') || '|' || coalesce(note,'null')
 from public.attendance where employee_id = '{E1}' and date = '2026-11-04'""")
t5e = q(SUPER, f"select hours from public.attendance where employee_id = '{E2}' and date = '2026-11-02'")
step('T5b hours applied (10h)', t5b.startswith('present|10') and t5b.endswith('|'), t5b)
step('T5c A applied (absent)', t5c == 'absent', t5c)
step('T5d free text applied (present, no hours, note kept)', t5d == 'present|null|OT', t5d)
step('T5e decimal hours applied (8.5)', t5e.startswith('8.5'), t5e)

# T6 submitted → saved snapshot ------------------------------------------------
sheet2 = q('', f"select public.get_shared_attendance_sheet('{token}')::text")
s2 = sheet2.replace(' ', '')
t6a = '"status":"submitted"' in s2 and '"snapshot"' in s2
t6b = '"submitted_at":"202' in s2
t6c = '"RajeshKumar"' in s2 and '"total_hours"' in s2 and '"totals"' in s2
step('T6 locked view: status submitted, snapshot + saved timestamp + totals',
     t6a and t6b and t6c, sheet2[:600])

# T7 one-time use --------------------------------------------------------------
ok, out, err = as_uid('', f"select public.submit_shared_attendance_sheet('{token}', '[]'::jsonb);",
                      want_fail='already submitted and is locked')
step('T7 second submit rejected (one-time use)', ok, err[-800:])

# T8 unknown token -------------------------------------------------------------
t8a = q('', "select (public.get_shared_attendance_sheet('deadbeef')->>'exists')::text")
ok, out, err = as_uid('', "select public.submit_shared_attendance_sheet('deadbeef', '[]'::jsonb);",
                      want_fail='Link not found')
step('T8 unknown token: get -> exists=false, submit -> Link not found',
     t8a == 'false' and ok, f'{t8a} | {err[-300:]}')

# T9 grant edit access by ASSIGNED admin → live again → resubmit --------------
ok, out, err = as_uid(ADMIN, f"select public.grant_attendance_share_edit('{token}');")
step('T9a assigned admin grants edit access', ok, err[-1200:])
sheet3 = q('', f"select public.get_shared_attendance_sheet('{token}')::text")
s3 = sheet3.replace(' ', '')
t9b = '"status":"active"' in s3 and '"employees":[{"id"' in s3
step('T9b link live again (employees visible)', t9b, sheet3[:300])
ok, out, err = as_uid('',
    f"""select public.submit_shared_attendance_sheet('{token}',
      '[{{"employee_id":"{E1}","date":"2026-11-05","value":"9"}}]'::jsonb, null);""")
step('T9c resubmit after grant works', ok, err[-1200:])
t9d = q(SUPER, f"select submit_count from public.attendance_share_link where token = '{token}'")
step('T9d submit_count = 2', t9d == '2', t9d)

# T10 admin WITHOUT the site assigned ------------------------------------------
ok, out, err = as_uid(ADMIN, f"select public.create_attendance_share_link('{SITE2}', '2026-11');",
                      want_fail='only share links for your assigned sites')
step('T10a unassigned admin cannot create a link for another site', ok, err[-600:])
ok, out, err = as_uid(SUPER, f"select public.create_attendance_share_link('{SITE2}', '2026-11');")
step('T10b super creates site2 link', ok, err[-800:])
token2 = q(SUPER, f"""select token from public.attendance_share_link
 where site_id = '{SITE2}' order by created_at desc limit 1""")
ok, out, err = as_uid(ADMIN, f"select public.grant_attendance_share_edit('{token2}');",
                      want_fail='only manage links for your assigned sites')
step('T10c unassigned admin cannot grant edit on another site', ok, err[-600:])

# T11 invalid month ------------------------------------------------------------
ok, out, err = as_uid(SUPER, f"select public.create_attendance_share_link('{SITE}', 'Nov-2026');",
                      want_fail='Invalid month')
step('T11 invalid month rejected', ok, err[-600:])

# T12 skipped entries (future + other site + bad employee) ---------------------
# ONE LINK PER SITE + DAY (20261108c): SITE's link was already created today
# (T3a) and is submitted now — age it by a day to model the next day, so this
# create inserts a fresh active link for SITE again
ok, out, err = as_uid(SUPER, f"""
update public.attendance_share_link
   set created_at = created_at - interval '1 day'
 where site_id = '{SITE}';
select public.create_attendance_share_link('{SITE}', '2026-11');
""")
step('T12a day rollover → fresh SITE link', ok, err[-800:])
token3 = q(SUPER, f"""select token from public.attendance_share_link
 where site_id = '{SITE}' and status = 'active' order by created_at desc limit 1""")
step('T12b fresh active link captured', len(token3) == 20, token3)
res = q('', f"""select public.submit_shared_attendance_sheet('{token3}',
 '[{{"employee_id":"{E1}","date":"2099-01-01","value":"8"}},
   {{"employee_id":"{E3}","date":"2026-11-06","value":"8"}},
   {{"employee_id":"00000000-0000-0000-0000-00000000dead","date":"2026-11-06","value":"8"}},
   {{"employee_id":"{E1}","date":"2026-11-06","value":"12"}}]'::jsonb)::text""")
r = res.replace(' ', '')
step('T12 future / other-site / unknown-employee entries skipped',
     '"applied":1' in r and '"skipped":3' in r, res)

# T13 mark_attendance regression ------------------------------------------------
ok, out, err = as_uid(SUPER, f"select public.mark_attendance('{E2}', '2026-11-10', '7.5');")
t13a = ok
ok, out, err = as_uid(ADMIN, f"select public.mark_attendance('{E3}', '2026-11-10', '8');",
                      want_fail='only mark attendance for your assigned sites')
t13b = ok
t13c = q(SUPER, f"select hours from public.attendance where employee_id = '{E2}' and date = '2026-11-10'")
step('T13 mark_attendance regression (works for assigned, denied for others, hours saved)',
     t13a and t13b and t13c.startswith('7.5'), f'{t13a} {t13b} {t13c}')

# T14 auto-warning via submit path ----------------------------------------------
# token3 was submitted in T12 → grant edit then submit 3 consecutive A for E2
# (PAST days only — future dates are skipped by design; today is 2026-11-07)
ok, out, err = as_uid(SUPER, f"select public.grant_attendance_share_edit('{token3}');")
ok, out, err = as_uid('', f"""select public.submit_shared_attendance_sheet('{token3}',
 '[{{"employee_id":"{E2}","date":"2026-11-03","value":"A"}},
   {{"employee_id":"{E2}","date":"2026-11-04","value":"A"}},
   {{"employee_id":"{E2}","date":"2026-11-05","value":"A"}}]'::jsonb);""")
step('T14a submit 3 consecutive A', ok, err[-1200:])
t14b = q(SUPER, f"""select count(*) from public.warning
 where employee_id = '{E2}' and is_auto_generated and absent_dates::text like '%2026-11-05%'""")
t14c = q(SUPER, f"""select count(*) from public.notification n
 join public.profiles p on p.id = n.profile_id
 where p.role = 'super_admin' and n.title = 'Auto-Generated Warning'""")
try:
    t14ok = int(t14b) >= 1 and int(t14c) >= 1
except ValueError:
    t14ok = False
step('T14b auto-warning + super-admin notification created', t14ok, f'{t14b} {t14c}')

# T15 list scoping ---------------------------------------------------------------
lst_admin = q(ADMIN, 'select public.list_attendance_share_links()::text')
t15a = 'Marina Heights Tower' in lst_admin and 'Red Coast Compound' not in lst_admin
lst_super = q(SUPER, 'select public.list_attendance_share_links()::text')
t15b = 'Marina Heights Tower' in lst_super and 'Red Coast Compound' in lst_super
order = q(SUPER, """select (x->>'site_name') from (
  select jsonb_array_elements(public.list_attendance_share_links()) as x) t limit 1""")
t15c = order == 'Marina Heights Tower'  # newest = last created was for SITE
step('T15 list scoped (admin: assigned site only; super: all; newest first)',
     t15a and t15b and t15c, f'{t15a} {t15b} | first={order}')

print()
passed = sum(results)
print(f'== {passed}/{len(results)} steps passed ==')
if passed < len(results):
    raise SystemExit(1)
