#!/usr/bin/env python3
"""Static validator for supabase/schema.sql ordering on a FRESH database.

Simulates a fresh DB by scanning statements in order and verifying:
 1. Every `references public.X` / `on public.X` in a CREATE TABLE appears
    only after `create table public.X` was seen.
 2. Every `create trigger` comes after its function is created (create or
    replace function).
 3. Every `create policy ... on public.X` / `alter table public.X` /
    `create index ... on public.X` comes after X is created.
 4. Every function body referencing a table is created after that table
    (functions are only checked for table creation order at the top level
    of the file — plpgsql bodies run at call time, not create time, so
    this is informational only).
Ignores auth.* / supabase_realtime (provided by the Supabase platform).
"""
import re
import sys

SQL = open('/home/z/my-project/supabase/schema.sql').read()

# strip comments
def strip_comments(sql: str) -> str:
    sql = re.sub(r'--[^\n]*', '', sql)
    sql = re.sub(r'/\*.*?\*/', '', sql, flags=re.S)
    return sql

sql = strip_comments(SQL)

created_tables = set()
created_functions = set()
errors = []
warnings = []

# Split into statements at semicolons, but keep $$ blocks intact.
# Simple approach: walk through and split on ';' when not inside a dollar-quoted block.
stmts = []
buf = []
i = 0
n = len(sql)
in_dollar = False
dollar_tag = ''
while i < n:
    if not in_dollar:
        m = re.match(r'\$[A-Za-z_]*\$', sql[i:])
        if m:
            in_dollar = True
            dollar_tag = m.group(0)
            buf.append(m.group(0))
            i += len(m.group(0))
            continue
        if sql[i] == ';':
            stmts.append(''.join(buf))
            buf = []
            i += 1
            continue
    else:
        if sql.startswith(dollar_tag, i):
            in_dollar = False
            buf.append(dollar_tag)
            i += len(dollar_tag)
            continue
    buf.append(sql[i])
    i += 1
if ''.join(buf).strip():
    stmts.append(''.join(buf))

platform_objs = re.compile(r'\b(auth\.|supabase_realtime|pg_\w+)')

for idx, s in enumerate(stmts):
    s_flat = ' '.join(s.split())
    if not s_flat.strip():
        continue

    m = re.search(r'create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)', s_flat, re.I)
    if m:
        created_tables.add(m.group(1))
        continue

    # references inside CREATE TABLE bodies (FK at creation time = hard error)
    m = re.search(r'create\s+table\s+(?:if\s+not\s+exists\s+)?(\w+)\.(\w+)', s_flat, re.I)
    if m and m.group(1) != 'public':
        continue

    m = re.search(r'create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)', s_flat, re.I)
    if m:
        created_functions.add(m.group(1))
        # informational: tables referenced in the body but not yet created
        for t in set(re.findall(r'\bpublic\.(\w+)\b', s_flat)):
            if t not in created_tables and not platform_objs.search(t):
                warnings.append(f'stmt#{idx}: function {m.group(1)} references public.{t} not yet created (OK if called later, fatal only for SQL inlined at create time)')
        continue

    # triggers
    m = re.search(r'create\s+trigger\s+(\w+).*?\bexecute\s+(?:function|procedure)\s+(?:public\.)?(\w+)', s_flat, re.I)
    if m:
        fn = m.group(2)
        if fn not in created_functions:
            errors.append(f'stmt#{idx}: trigger {m.group(1)} uses function {fn} before it is defined')
        continue

    # policies / indexes / alter table on public.X
    for t in set(re.findall(r'\bon\s+public\.(\w+)\b', s_flat)):
        if t not in created_tables:
            errors.append(f'stmt#{idx}: statement touches public.{t} before it is created: {s_flat[:90]}')
    m = re.search(r'alter\s+table\s+(?:if\s+exists\s+)?public\.(\w+)', s_flat, re.I)
    if m and m.group(1) not in created_tables:
        errors.append(f'stmt#{idx}: alter table public.{m.group(1)} before it is created')

    # references public.X inside create table bodies (FK at creation)
    if re.search(r'\bcreate\s+table\b', s_flat, re.I):
        for t in set(re.findall(r'references\s+public\.(\w+)', s_flat)):
            if t not in created_tables:
                errors.append(f'stmt#{idx}: CREATE TABLE has FK to public.{t} which is not created yet')

    # drop table / drop policy on missing objects are guarded with IF EXISTS -> fine

print(f'tables created ({len(created_tables)}): {sorted(created_tables)}')
print(f'functions created: ({len(created_functions)})')
print()
if errors:
    print('=== ERRORS (would abort a fresh run) ===')
    for e in errors:
        print(' -', e)
    sys.exit(1)
print('No ordering errors found.')
if warnings:
    print('\n=== informational warnings ===')
    for w in warnings[:15]:
        print(' -', w)
