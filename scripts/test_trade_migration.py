#!/usr/bin/env python3
"""
Local-PostgreSQL verification of 20261103_trade_salary_system.sql.

Reproduces the exact Supabase failure (get_employee_salary_history), then runs
the fixed migration twice (idempotency incl. over the half-applied state) and
executes the full functional suite against the real base schema.
Everything runs inside ONE process because the sandbox reaps background
servers between shell calls.
"""
import os
import shutil
import subprocess
import sys

ROOT = '/home/z/my-project'
SCRIPTS = os.path.join(ROOT, 'scripts')
PGDATA = os.path.join(SCRIPTS, 'pgdata_test')

import pgserver  # noqa: E402

PSQL = os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin', 'psql')
MIGRATION = os.path.join(ROOT, 'supabase', 'migrations', '20261103_trade_salary_system.sql')
BUGGY = os.path.join(SCRIPTS, 'migration_buggy.sql')

# ---------------------------------------------------------------- setup ----
subprocess.run(['pkill', '-f', 'pgdata_test'], capture_output=True)  # stale runs
shutil.rmtree(PGDATA, ignore_errors=True)
server = pgserver.get_server(PGDATA, cleanup_mode='stop')
# get_uri() does not create the database — make it explicitly when missing
base_uri = server.get_uri('postgres')
if subprocess.run([PSQL, base_uri, '-tAc',
                   "select 1 from pg_database where datname = 'pulse_test'"],
                  capture_output=True, text=True).stdout.strip() != '1':
    subprocess.run([PSQL, base_uri, '-q', '-c', 'create database pulse_test'],
                   check=True, capture_output=True, text=True)
uri = server.get_uri('pulse_test')

# the buggy version the user actually ran in Supabase
with open(BUGGY, 'w') as f:
    f.write(subprocess.run(
        ['git', '-C', ROOT, 'show', '044ef59:supabase/migrations/20261103_trade_salary_system.sql'],
        capture_output=True, text=True, check=True).stdout)

# base schema minus the pgcrypto extension line (gen_random_uuid is core)
with open(os.path.join(SCRIPTS, 'base_schema.sql')) as f:
    base = f.read()
base = base.replace('create extension if not exists pgcrypto;',
                    '-- (pgcrypto skipped locally — gen_random_uuid() is core SQL)')
with open(os.path.join(SCRIPTS, 'base_schema_local.sql'), 'w') as f:
    f.write(base)


def run(files=(), expect_fail=None):
    args = [PSQL, uri, '-q', '-v', 'ON_ERROR_STOP=1']
    for f in files:
        args += ['-f', f]
    r = subprocess.run(args, capture_output=True, text=True, timeout=240)
    if expect_fail:
        ok = r.returncode != 0 and expect_fail in (r.stderr or '')
        return ok, r
    return r.returncode == 0, r


results = []


def step(name, ok, detail=''):
    results.append(ok)
    print(('  OK  ' if ok else '  FAIL') + ' ' + name + ('' if ok else f'\n{detail}'))


print('== Trade & Salary migration verification (local PostgreSQL 16) ==')

ok, r = run([os.path.join(SCRIPTS, 'test_shim.sql')])
step('load Supabase shims', ok, r.stderr[-2000:])

ok, r = run([os.path.join(SCRIPTS, 'base_schema_local.sql')])
step('load base schema (pre-trade, commit 0e0e398)', ok, r.stderr[-3000:])

ok, r = run([os.path.join(SCRIPTS, 'test_seed.sql')])
step('seed super admin + plain admin', ok, r.stderr[-2000:])

ok, r = run([BUGGY], expect_fail='effective_from')
step('reproduce the Supabase error (column "effective_from" does not exist)', ok,
     f'stderr: {r.stderr[-800:]}' if not ok else r.stderr.strip().splitlines()[-1])

ok, r = run([MIGRATION])
step('run FIXED migration (over the half-applied state)', ok, r.stderr[-3000:])

ok, r = run([MIGRATION])
step('run FIXED migration again (idempotency)', ok, r.stderr[-3000:])

ok, r = run([os.path.join(SCRIPTS, 'test_functional.sql')])
out = (r.stdout or '') + (r.stderr or '')
passes = [ln for ln in out.splitlines() if 'PASS:' in ln]
step(f'functional suite ({len(passes)} checks)', ok and len(passes) >= 9, r.stderr[-4000:])
for p in passes:
    print('       ' + p[p.index('PASS:'):].strip())

print()
if all(results):
    print(f'ALL {len(results)} STEPS PASSED')
    sys.exit(0)
print(f'{results.count(False)} STEP(S) FAILED')
sys.exit(1)
