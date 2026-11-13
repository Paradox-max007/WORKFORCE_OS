#!/usr/bin/env python3
"""Re-append the final 20261113f migration to supabase/schema.sql and
scripts/schema_local.sql (strips any previously appended copy first) and
refreshes the download/ copy."""
import os

ROOT = '/home/z/my-project'
MIG = os.path.join(ROOT, 'supabase', 'migrations', '20261113f_time_card_carryover_book.sql')
MARK = '20261113f — TIME-CARD CARRYOVER → ADVANCE BOOK RECORD'

with open(MIG) as f:
    mig = f.read()
with open(os.path.join(ROOT, 'download', '20261113f_time_card_carryover_book.sql'), 'w') as f:
    f.write(mig)

for path in ('supabase/schema.sql', 'scripts/schema_local.sql'):
    full = os.path.join(ROOT, path)
    with open(full) as f:
        lines = f.readlines()
    start = None
    for i, l in enumerate(lines):
        if MARK in l:
            start = i
            break
    if start is not None:
        # walk back over the header separator line(s) + blank lines above it
        while start > 0 and (
            lines[start - 1].strip() == ''
            or lines[start - 1].lstrip().startswith('-- ==')):
            start -= 1
        lines = lines[:start]
    # strip trailing blank lines, then append a single separator + migration
    while lines and lines[-1].strip() == '':
        lines.pop()
    lines.append('\n')
    lines.extend(mig.splitlines(keepends=True))
    if not lines[-1].endswith('\n'):
        lines[-1] += '\n'
    with open(full, 'w') as f:
        f.writelines(lines)
    print(f'{path}: {len(lines)} lines')
print('synced 20261113f -> schema.sql / schema_local.sql / download/')
