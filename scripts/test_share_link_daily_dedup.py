#!/usr/bin/env python3
"""
Local-PostgreSQL verification of 20261108c_share_link_one_per_day.sql
(create_attendance_share_link becomes idempotent per site + month + day).

Loads the chain (shim -> full schema incl. share links -> seed -> the NEW
migration re-applied on top), then functionally verifies:

  D1  first create of the day inserts a fresh link (reused = false)
  D2  second create, same site + month, same day → SAME token, reused = true,
      and still exactly ONE row for that site + month today
  D3  a different site still gets its own fresh link the same day
  D4  the same site but a DIFFERENT month gets a fresh link the same day
      (one link per site + month per day)
  D5  yesterday's link does NOT block today: after backdating a link by one
      day, create returns a NEW link (reused = false)
  D6  submitted link still counts as today's link: create hands the SAME
      locked link back (reused = true, status = submitted, no extra row) —
      the admin path is grant-edit, not a duplicate paper
  D7  legacy same-day duplicates: with two rows backdated into today, create
      returns the NEWEST one and inserts nothing
  ID  migration file re-runs cleanly on top of the loaded schema
"""
import os
import shutil
import subprocess

ROOT = '/home/z/my-project'
SCRIPTS = os.path.join(ROOT, 'scripts')
PGDATA = os.path.join(SCRIPTS, 'pgdata_share_dedup')

import pgserver  # noqa: E402

PSQL = os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin', 'psql')
MIG = os.path.join(ROOT, 'supabase', 'migrations')

subprocess.run(['pkill', '-f', 'pgdata_share_dedup'], capture_output=True)
shutil.rmtree(PGDATA, ignore_errors=True)
server = pgserver.get_server(PGDATA, cleanup_mode='stop')
base_uri = server.get_uri('postgres')
if subprocess.run([PSQL, base_uri, '-tAc',
                   "select 1 from pg_database where datname = 'pulse_dedup'"],
                  capture_output=True, text=True).stdout.strip() != '1':
    subprocess.run([PSQL, base_uri, '-q', '-c', 'create database pulse_dedup'],
                   check=True, capture_output=True, text=True)
uri = server.get_uri('pulse_dedup')

SUPER = '00000000-0000-0000-0000-0000000000aa'
SITE = '00000000-0000-0000-0000-0000000000a1'
SITE2 = '00000000-0000-0000-0000-0000000000a2'


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


print('== 20261108c one-link-per-site-per-day verification ==')

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
    ('apply 20261108c migration', [os.path.join(MIG, '20261108c_share_link_one_per_day.sql')]),
]:
    ok, out, err = psql(files, [])
    step(name, ok, err[-2500:])

ok, out, err = psql([os.path.join(MIG, '20261108c_share_link_one_per_day.sql')], [])
step('ID re-run 20261108c (idempotency)', ok, err[-2000:])

ok, out, err = as_uid(SUPER, f"""
insert into public.site (id, name, client_name, project_name) values
  ('{SITE}', 'Marina Heights Tower', 'Emaar', 'Phase 2'),
  ('{SITE2}', 'Red Coast Compound', 'Red Coast Dev.', 'Villas')
on conflict (id) do nothing;
select 1;
""")
step('seed sites', ok, err[-1500:])

# D1 first create of the day ---------------------------------------------------
d1 = q(SUPER, f"select (r->>'token') || '|' || (r->>'reused') from public.create_attendance_share_link('{SITE}', '2026-11') r")
step('D1a first create returns a token', len(d1.split('|')[0]) == 20, d1)
token1 = d1.split('|')[0]
step('D1b first create is NOT a reuse (reused = false)', d1.endswith('|false'), d1)

# D2 second create same day → same link ----------------------------------------
d2 = q(SUPER, f"select (r->>'token') || '|' || (r->>'reused') from public.create_attendance_share_link('{SITE}', '2026-11') r")
step('D2a second create same day returns the SAME token', d2.split('|')[0] == token1, f'{token1} vs {d2}')
step('D2b second create flags reused = true', d2.endswith('|true'), d2)
d2c = q(SUPER, f"select count(*) from public.attendance_share_link where site_id = '{SITE}' and month_key = '2026-11' and created_at::date = current_date")
step('D2c still exactly ONE row for that site + month today', d2c == '1', d2c)

# D3 different site same day → its own fresh link ------------------------------
d3 = q(SUPER, f"select (r->>'token') || '|' || (r->>'reused') from public.create_attendance_share_link('{SITE2}', '2026-11') r")
step('D3 other site gets its own fresh link (new token, reused = false)',
     len(d3.split('|')[0]) == 20 and d3.endswith('|false'), d3)

# D4 same site, different month → fresh link -----------------------------------
d4 = q(SUPER, f"select (r->>'token') || '|' || (r->>'reused') from public.create_attendance_share_link('{SITE}', '2026-10') r")
step('D4 same site other month gets a fresh link (reused = false)',
     len(d4.split('|')[0]) == 20 and d4.endswith('|false') and d4.split('|')[0] != token1, d4)

# D5 yesterday's link doesn't block today --------------------------------------
ok, out, err = as_uid(SUPER, f"""
update public.attendance_share_link
   set created_at = created_at - interval '1 day'
 where site_id = '{SITE}' and month_key = '2026-11';
select 1;
""")
step('D5a backdate the site link by one day', ok, err[-1000:])
d5 = q(SUPER, f"select (r->>'token') || '|' || (r->>'reused') from public.create_attendance_share_link('{SITE}', '2026-11') r")
step('D5b new day → NEW link (reused = false, token differs)',
     d5.endswith('|false') and d5.split('|')[0] != token1, f'{token1} vs {d5}')
token_today = d5.split('|')[0]

# D6 submitted link still counts as today's link -------------------------------
ok, out, err = as_uid(SUPER, f"""
update public.attendance_share_link
   set status = 'submitted', submitted_at = now()
 where token = '{token_today}';
select 1;
""")
step('D6a lock today\'s link (simulate a submission)', ok, err[-1000:])
d6 = q(SUPER, f"""select (r->>'token') || '|' || (r->>'reused') || '|' || (r->>'status')
 from public.create_attendance_share_link('{SITE}', '2026-11') r""")
step('D6b submitted link is handed back (same token, reused, status submitted)',
     d6 == f'{token_today}|true|submitted', d6)
d6c = q(SUPER, f"select count(*) from public.attendance_share_link where site_id = '{SITE}' and month_key = '2026-11' and created_at::date = current_date")
step('D6c no duplicate row was inserted for the submitted link', d6c == '1', d6c)

# D7 legacy same-day duplicates → newest wins, nothing inserted -----------------
ok, out, err = as_uid(SUPER, f"""
insert into public.attendance_share_link (token, site_id, site_name, month_key, created_by, created_at)
values ('legacyoldtoken0000000', '{SITE}', 'Marina Heights Tower', '2026-11', null, now() - interval '2 hours');
select 1;
""")
step('D7a seed a legacy duplicate created earlier today', ok, err[-1000:])
d7 = q(SUPER, f"select (r->>'token') || '|' || (r->>'reused') from public.create_attendance_share_link('{SITE}', '2026-11') r")
step('D7b newest of today\'s links wins and nothing new is inserted',
     d7 == f'{token_today}|true', d7)
d7c = q(SUPER, f"select count(*) from public.attendance_share_link where site_id = '{SITE}' and month_key = '2026-11' and created_at::date = current_date")
step('D7c legacy duplicates are preserved (row count stays 2)', d7c == '2', d7c)

print()
print(f'== {sum(results)}/{len(results)} steps passed ==')
if not all(results):
    raise SystemExit(1)
