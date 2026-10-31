#!/usr/bin/env python3
"""Generate supabase/seed.sql — realistic demo dataset for PULSE Workforce OS.

Run AFTER supabase/schema.sql (in the Supabase SQL Editor). The seed is one
atomic, idempotent DO block: re-running it is a no-op once the marker site
exists.

Dataset design (October 2026 = current month, Dubai work week Sun–Thu):
  • 4 sites, 3 camps, 22 employees, 3 login accounts (1 super + 2 site admins)
  • date-effective transfer showcase:
      – E-MOVE-1: Site 1 → Site 3 effective Oct 25, recorded 20:00, with the
        25th already marked 17:00  → the move displays from Oct 26
      – E-MOVE-2: Site 2 → Site 4 (Oct 10) → Site 1 (Oct 20) — 3 segments
      – E-MOVE-3: Site 3 → idle (Oct 18) — unassigned segment
      – E-IDLE-1: idle → Site 4 (Oct 15)
  • attendance for every worked Sun–Thu (10h default, sprinkled 8h/12h,
    one 3-day absence streak + matching auto-warning, one single absence)
  • warnings, fines, leave requests (pending/approved/rejected), one
    cancellation request, 5 uniform-registry entries (one overdue renewal),
    notifications for the super admin
"""
from datetime import date, timedelta

# ---------------------------------------------------------------- IDs (fixed, so re-runs and cross-references are stable)
def uid(prefix: str, n: int) -> str:
    return f"{prefix.ljust(8, '0')}-0000-4000-8000-{n:012d}"

SUPER  = uid('a', 1)   # super admin profile / auth user
ADMIN_A = uid('a', 2)  # site admin A (Marina Bay + Desert Rose)
ADMIN_B = uid('a', 3)  # site admin B (Metro Extension)
S1, S2, S3, S4 = (uid('b', i) for i in (1, 2, 3, 4))          # sites
C1, C2, C3      = (uid('c', i) for i in (1, 2, 3))            # camps
def emp(n: int) -> str: return uid('d', n)                    # employees

# ---------------------------------------------------------------- static data
SITES = [
    (S1, 'Marina Bay Tower', 'Emaar Properties', 'Marina Bay Tower — Core & Shell'),
    (S2, 'Desert Rose Mall', 'Al-Futtaim Group', 'Desert Rose Mall — Fit-Out Phase 2'),
    (S3, 'Sheikh Zayed Metro Extension', 'RTA Dubai', 'SZR Metro Line — Station Civil Works'),
    (S4, 'Palm Jumeirah Villas', 'Nakheel', 'Villa Handover — Phase 3 Snagging'),
]
CAMPS = [
    (C1, 'Al Quoz Labour Camp', 'Al Quoz Industrial 3, Dubai', 250, 'Blocks A–C; bus pickup 05:15'),
    (C2, 'Jebel Ali Workers Village', 'Jebel Ali Industrial 1, Dubai', 400, 'Near Gate 2 canteen'),
    (C3, 'Sonapur Accommodation Camp', 'Sonapur, Dubai', 180, 'Quiet hours 22:00–05:00'),
]

# (num, name, nationality, position, site, camp, block, room, join, rating,
#  leader?, passport, id, phone)
E: list[dict] = []
def add(n, name, nat, pos, site, camp, block, room, join, rating,
        leader=False, passport='Valid', idc='Valid'):
    E.append(dict(n=n, name=name, nat=nat, pos=pos, site=site, camp=camp,
                  block=block, room=room, join=join, rating=rating,
                  leader=leader, passport=passport, idc=idc))

# Site 1 — Marina Bay Tower (6)
add(1,  'Ahmed Al Mansoori',   'UAE',        'Site Foreman',   S1, C1, 'B', '204', '2024-03-11', 4.8, leader=True)
add(2,  'Ramesh Kumar',        'India',      'Steel Fixer',    S1, C1, 'B', '108', '2024-06-02', 4.6)
add(3,  'Joseph Santos',       'Philippines','HVAC Technician',S1, C1, 'A', '112', '2025-01-20', 4.9)
add(4,  'Kamal Hossain',       'Bangladesh', 'Mason',          S1, C2, 'D', '311', '2024-09-15', 4.3)
add(5,  'Tika Bahadur Gurung', 'Nepal',      'Scaffolder',     S1, C1, 'B', '222', '2025-04-07', 4.5)
add(6,  'Grace Wanjiru',       'Kenya',      'Site Nurse',     S1, C3, 'A', '005', '2025-08-01', 5.0)
# Site 2 — Desert Rose Mall (5)
add(7,  'Mohd Rafiq',          'Pakistan',   'Site Foreman',   S2, C2, 'D', '305', '2024-02-19', 4.7, leader=True)
add(8,  'Deepak Thapa',        'Nepal',      'Electrician',    S2, C2, 'C', '218', '2024-11-05', 4.4)
add(9,  'Nguyen Van Minh',     'Vietnam',    'Painter',        S2, C2, 'D', '402', '2025-03-17', 4.2)
add(10, 'Samuel Osei',         'Ghana',      'Carpenter',      S2, C3, 'B', '117', '2025-06-09', 4.1)
add(11, 'Imran Sheikh',        'Pakistan',   'Helper',         S2, C3, 'B', '119', '2026-01-12', 3.9, passport='Expired')
# Site 3 — Metro Extension (4)
add(12, 'Wong Kei',            'Hong Kong',  'Site Supervisor',S3, C1, 'A', '303', '2024-05-23', 4.9, leader=True)
add(13, 'Dilip Chaudhary',     'India',      'Welder',         S3, C1, 'A', '308', '2025-02-14', 4.6)
add(14, 'Abdelrahman Fadl',    'Sudan',      'Steel Fixer',    S3, C1, 'C', '126', '2025-07-30', 4.0)
add(15, 'Ravi Perera',         'Sri Lanka',  'Surveyor',       S3, C3, 'C', '204', '2026-02-02', 4.8)
# Site 4 — Palm Jumeirah Villas (2)
add(16, 'Hassan Jaber',        'Lebanon',    'Site Supervisor',S4, C2, 'A', '101', '2025-05-05', 4.5, leader=True)
add(17, 'Mario Dizon',         'Philippines','Cleaner',        S4, C2, 'A', '104', '2026-03-16', 4.2)
# Idle (1)
add(18, 'Faisal Al Zarooni',   'UAE',        'Driver',         None, C3, 'A', '010', '2026-04-20', 4.4)
# Movers (4) — current_site_id set below after transfers
add(19, 'Rahul Sharma',        'India',      'Steel Fixer',    S3, C1, 'B', '205', '2024-08-18', 4.7)   # S1→S3 Oct 25 @20:00, 25th marked 17:00
add(20, 'Mohammed Yousuf',     'Egypt',      'Carpenter',      S1, C2, 'D', '310', '2025-09-01', 4.3)   # S2→S4 Oct 10 → S1 Oct 20
add(21, 'Aung San',            'Myanmar',    'Helper',         None, C3, 'C', '215', '2025-10-11', 4.1) # S3→idle Oct 18
add(22, 'Bilal Akhtar',        'Pakistan',   'Plumber',        S4, C2, 'C', '221', '2025-12-15', 4.5)   # idle→S4 Oct 15

MOVES = {
    19: [(S1, S3, '2026-10-25', '2026-10-25 20:00:00+04')],                       # the 8 PM rule demo
    20: [(S2, S4, '2026-10-10', '2026-10-10 08:00:00+04'),
         (S4, S1, '2026-10-20', '2026-10-20 08:00:00+04')],                       # A → B → C chain
    21: [(S3, None, '2026-10-18', '2026-10-18 09:00:00+04')],                     # → idle
    22: [(None, S4, '2026-10-15', '2026-10-15 10:00:00+04')],                     # idle → site
}
# employees on approved sick leave Oct 12–13 (attendance blank there)
SICK_LEAVE_EMP = 3
# 3-day absence streak (Oct 5–7) + matching auto-warning
STREAK_EMP = 11
SINGLE_ABSENT = {8: ['2026-10-14']}

def code(n: int) -> str: return f'ASM-2026-{n:03d}'

# ---------------------------------------------------------------- calendar
OCT = date(2026, 10, 1)
DAYS = [OCT + timedelta(days=i) for i in range(31)]            # Oct 1–31
def is_workday(d: date) -> bool:                                # Sun–Thu week
    return d.weekday() in (6, 0, 1, 2, 3)                       # Mon=0 … Sun=6
def ymds(d: date) -> str: return d.isoformat()

def segment_site(n: int, d: date) -> str | None:
    """Which site owns employee n on day d (mirrors the app engine for seeding)."""
    s = d.isoformat()
    cur = next(e for e in E if e['n'] == n)
    site = cur['site']
    for (frm, to, eff, _at) in MOVES.get(n, []):
        if s >= eff:
            site = to
    return site

# ---------------------------------------------------------------- emit SQL
out: list[str] = []
w = out.append

w("""-- ============================================================================
-- PULSE Workforce OS — Demo Seed Data
-- ============================================================================
-- Run this in the Supabase SQL Editor AFTER supabase/schema.sql.
-- One atomic, idempotent DO block: re-running it does nothing once applied.
--
-- Demo logins (email / password):
--   super@pulse.dev    / pulse-super-2026   → super admin (sees everything)
--   admin.marina@pulse.dev / pulse-admin-2026 → admin of Marina Bay Tower +
--                                              Desert Rose Mall (all menus)
--   admin.metro@pulse.dev  / pulse-admin-2026 → admin of Sheikh Zayed Metro
--                                              Extension (no Camps / no
--                                              Cancellation menus — gating demo)
--
-- Showcases for the date-effective transfer engine (October 2026 sheet):
--   • Rahul Sharma   — moved Site 1 → Site 3 on Oct 25 at 8 PM with the 25th
--                      already marked 5 PM  → move shows from Oct 26 only
--   • Mohammed Yousuf— Site 2 → Site 4 (Oct 10) → Site 1 (Oct 20): 3 segments
--   • Aung San       — Site 3 → idle (Oct 18): unassigned segment demo
--   • Bilal Akhtar   — idle → Site 4 (Oct 15)
--   • Imran Sheikh   — 3 consecutive absences (Oct 5–7) + auto-warning
-- ============================================================================

create extension if not exists pgcrypto;

do $seed$
declare
  v_super  uuid := '%s';
  v_admin_a uuid := '%s';
  v_admin_b uuid := '%s';
begin
  -- guard 1: schema must exist
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'site') then
    raise exception 'Run supabase/schema.sql first — the schema is missing';
  end if;
  -- guard 2: idempotency marker
  if exists (select 1 from public.site where name = 'Marina Bay Tower') then
    raise notice 'Seed data already present — nothing to do.';
    return;
  end if;
""" % (SUPER, ADMIN_A, ADMIN_B))

# ---- auth users + profiles -----------------------------------------------
w("""
  -- ---------------------------------------------------------------------
  -- 1. LOGIN ACCOUNTS (auth.users + auth.identities + profiles via trigger)
  --    handle_new_user() creates the profile rows automatically; roles are
  --    fixed right after so the demo logins are deterministic.
  -- ---------------------------------------------------------------------""")
users = [
    (SUPER,   'super@pulse.dev',    'pulse-super-2026', 'Sarah Chen',     'super_admin'),
    (ADMIN_A, 'admin.marina@pulse.dev', 'pulse-admin-2026', 'Omar Al-Farsi', 'admin'),
    (ADMIN_B, 'admin.metro@pulse.dev',  'pulse-admin-2026', 'Priya Nair',    'admin'),
]
for uid_, email, pw, name, _role in users:
    w(f"""  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                                 email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                                 created_at, updated_at)
  values ('{uid_}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          '{email}', crypt('{pw}', gen_salt('bf')),
          now(), '{{"provider":"email","providers":["email"]}}'::jsonb,
          '{{"name":"{name}"}}'::jsonb, now(), now());
  insert into auth.identities (provider_id, user_id, identity_data, provider,
                               last_sign_in_at, created_at, updated_at)
  values ('{uid_}', '{uid_}',
          jsonb_build_object('sub', '{uid_}', 'email', '{email}', 'email_verified', true),
          'email', now(), now(), now());""")
w("""
  update public.profiles set role = 'super_admin' where id = v_super;
  update public.profiles set role = 'admin' where id in (v_admin_a, v_admin_b);""")

# ---- menu permissions -----------------------------------------------------
w("""
  -- ---------------------------------------------------------------------
  -- 2. MENU PERMISSIONS for the two site admins
  -- ---------------------------------------------------------------------""")
MENU_KEYS = ['employees', 'sites', 'camps', 'attendance', 'leave_requests',
             'cancellation_requests', 'notifications']
for pid, allowed in ((ADMIN_A, MENU_KEYS), (ADMIN_B, [k for k in MENU_KEYS if k not in ('camps', 'cancellation_requests')])):
    for k in MENU_KEYS:
        flag = 'true' if k in allowed else 'false'
        w(f"  insert into public.menu_permission (profile_id, menu_key, allowed) values ('{pid}', '{k}', {flag});")

# ---- sites & camps --------------------------------------------------------
w("""
  -- ---------------------------------------------------------------------
  -- 3. WORK SITES + ACCOMMODATION CAMPS
  -- ---------------------------------------------------------------------""")
for sid, name, client, project in SITES:
    w(f"  insert into public.site (id, name, client_name, project_name) values ('{sid}', '{name}', '{client}', '{project}');")
for cid, name, loc, cap, notes in CAMPS:
    w(f"  insert into public.camp (id, name, location, capacity, notes) values ('{cid}', '{name}', '{loc}', {cap}, '{notes}');")

# ---- employees ------------------------------------------------------------
w("""
  -- ---------------------------------------------------------------------
  -- 4. EMPLOYEES (22 — ASM-2026-001 … ASM-2026-022)
  -- ---------------------------------------------------------------------""")
for e in E:
    leader_site = e['site'] if e['leader'] else None
    phone = f"+971-5{e['n'] % 10}-{50 + e['n']:03d}-{1000 + e['n'] * 7:04d}"
    pp = f"P{e['n']:06d}{2026 - int(e['join'][:4])}"
    idn = f"784-1990-{e['n']:04d}"
    w(f"""  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('{emp(e['n'])}', '{e['name']}', '{code(e['n'])}', '{e['nat']}',
    '{1990 + (e['n'] * 3) % 15}-{'%02d' % (1 + e['n'] % 12)}-{'%02d' % (1 + e['n'] % 28)}',
    '{phone}', '{e['pos']}', '{e['join']}', 'ASM Contracting LLC',
    '{pp}', '{e['passport']}', '{idn}', '{e['idc']}', {('null' if e['site'] is None else f"'{e['site']}'")},
    '{e['camp']}', '{e['block']}', '{e['room']}', {e['rating']},
    'active', {'true' if e['leader'] else 'false'},
    {('null' if leader_site is None else f"'{leader_site}'")},
    '{e['join']} 09:00:00+04', now());""")

# employee 16 → pending deletion (cancellation request below)
w(f"""  update public.employee set status = 'pending_deletion' where id = '{emp(16)}';""")

# ---- admin site assignments ----------------------------------------------
w("""
  -- ---------------------------------------------------------------------
  -- 5. SITE ACCESS for the admins (admin B = Metro only)
  -- ---------------------------------------------------------------------
  insert into public.admin_site (profile_id, site_id) values
    (v_admin_a, '%s'), (v_admin_a, '%s'),
    (v_admin_b, '%s');""" % (S1, S2, S3))

# ---- site transfers -------------------------------------------------------
w("""
  -- ---------------------------------------------------------------------
  -- 6. SITE TRANSFERS (the date-effective demo rows)
  -- ---------------------------------------------------------------------""")
for n, moves in MOVES.items():
    for (frm, to, eff, at) in moves:
        f = 'null' if frm is None else f"'{frm}'"
        t = 'null' if to is None else f"'{to}'"
        w(f"  insert into public.site_transfer (employee_id, from_site_id, to_site_id, effective_date, created_at) values ('{emp(n)}', {f}, {t}, '{eff}', '{at}');")

# ---- attendance -----------------------------------------------------------
w("""
  -- ---------------------------------------------------------------------
  -- 7. OCTOBER 2026 ATTENDANCE (Sun–Thu work week; 10h default,
  --    sprinkled 8h / 12h overtime, absence streak Oct 5–7, sick leave
  --    Oct 12–13, movers' records timestamped around their transfers)
  -- ---------------------------------------------------------------------""")
att_rows = 0
for e in E:
    n = e['n']
    for d in DAYS:
        if not is_workday(d):
            continue
        s = ymds(d)
        seg = segment_site(n, d) if n in MOVES else e['site']
        # idle days / pre-assignment days have no records
        if seg is None:
            continue
        if n == SICK_LEAVE_EMP and s in ('2026-10-12', '2026-10-13'):
            continue
        if n == STREAK_EMP and s in ('2026-10-05', '2026-10-06', '2026-10-07'):
            w(f"  insert into public.attendance (employee_id, date, status, hours, created_at) values ('{emp(n)}', '{s}', 'absent', null, '{s} 18:10:00+04');")
            att_rows += 1
            continue
        if n in SINGLE_ABSENT and s in SINGLE_ABSENT[n]:
            w(f"  insert into public.attendance (employee_id, date, status, hours, created_at) values ('{emp(n)}', '{s}', 'absent', null, '{s} 18:10:00+04');")
            att_rows += 1
            continue
        hours = 10
        if n not in MOVES:
            m = (n + d.day) % 7
            if m == 0: hours = 8
            elif m == 3: hours = 12
        # the "25th at 5 PM" record — created BEFORE the 8 PM transfer
        created = f"{s} 18:{(n + d.day) % 50:02d}:00+04"
        if n == 19 and s == '2026-10-25':
            created = '2026-10-25 17:00:00+04'
        w(f"  insert into public.attendance (employee_id, date, status, hours, created_at) values ('{emp(n)}', '{s}', 'present', {hours}, '{created}');")
        att_rows += 1

# ---- warnings / fines -----------------------------------------------------
w(f"""
  -- ---------------------------------------------------------------------
  -- 8. WARNINGS + FINES ({att_rows} attendance records above)
  -- ---------------------------------------------------------------------
  insert into public.warning (employee_id, reason, is_auto_generated, absent_dates, created_by, created_at)
  values ('{emp(STREAK_EMP)}',
          'Auto-generated: 3 consecutive absences detected (2026-10-05, 2026-10-06, 2026-10-07)',
          true, '["2026-10-05","2026-10-06","2026-10-07"]'::jsonb, v_super, '2026-10-08 09:05:00+04');
  insert into public.warning (employee_id, reason, is_auto_generated, created_by, created_at)
  values ('{emp(5)}', 'Safety violation — not wearing a harness while working at height on L12', false, v_super, '2026-10-09 14:30:00+04');
  insert into public.warning (employee_id, reason, is_auto_generated, created_by, created_at)
  values ('{emp(9)}', 'Repeated late arrival to site (3 occurrences this month)', false, v_admin_a, '2026-10-16 10:00:00+04');
  insert into public.fine (employee_id, reason, amount, created_by, created_at)
  values ('{emp(4)}', 'Damage to company mixer — negligent operation', 200.00, v_super, '2026-10-11 11:20:00+04');
  insert into public.fine (employee_id, reason, amount, created_by, created_at)
  values ('{emp(14)}', 'Misconduct — altercation with a colleague (per HR report HR-2214)', 100.00, v_super, '2026-10-19 16:45:00+04');""")

# ---- leave + cancellation requests ---------------------------------------
w(f"""
  -- ---------------------------------------------------------------------
  -- 9. LEAVE REQUESTS + CANCELLATION REQUEST
  -- ---------------------------------------------------------------------
  insert into public.leave_request (employee_id, leave_type, other_type_text, start_date, end_date, total_days, reason, status, created_by, reviewed_by, reviewed_at, created_at)
  values ('{emp(3)}', 'sick', null, '2026-10-12', '2026-10-13', 2, 'Flu with fever — medical certificate attached', 'approved', v_super, v_super, '2026-10-12 08:40:00+04', '2026-10-11 20:15:00+04');
  insert into public.leave_request (employee_id, leave_type, other_type_text, start_date, end_date, total_days, reason, status, created_by, reviewed_by, reviewed_at, created_at)
  values ('{emp(2)}', 'casual', null, '2026-11-03', '2026-11-05', 3, 'Family matters — travel to home country', 'pending', v_super, null, null, '2026-10-27 09:30:00+04');
  insert into public.leave_request (employee_id, leave_type, other_type_text, start_date, end_date, total_days, reason, status, created_by, reviewed_by, reviewed_at, created_at)
  values ('{emp(15)}', 'emergency', null, '2026-10-21', '2026-10-22', 2, 'Emergency trip — father hospitalized', 'rejected', v_super, v_super, '2026-10-20 17:10:00+04', '2026-10-20 12:00:00+04');
  insert into public.cancellation_request (employee_id, reason, status, requested_by, created_at)
  values ('{emp(16)}', 'Project demobilization — end of snagging phase, visa cancellation required', 'pending', v_super, '2026-10-26 13:55:00+04');""")

# ---- uniform registry -----------------------------------------------------
w("""
  -- ---------------------------------------------------------------------
  -- 10. UNIFORM REGISTRY (April entry → renewal already due)
  -- ---------------------------------------------------------------------""")
uniforms = [
    (1, 101, 1,  'passport', 'P000042026', ['uniform', 'shoes', 'helmet', 'bottle', 'safetyJacket', 'mattress', 'pillow'], '2026-05-20 08:30:00+04', False, None),
    (2, 102, 2,  'id',       '784-1990-002', ['uniform', 'shoes', 'helmet', 'safetyJacket'], '2026-06-02 09:10:00+04', False, None),
    (3, 103, 5,  'id',       '784-1990-005', ['uniform', 'shoes', 'bottle'], '2026-06-15 10:00:00+04', False, None),
    (4, 104, 8,  'passport', 'P000082026', ['uniform', 'helmet', 'safetyJacket', 'mattress'], '2026-07-01 08:50:00+04', False, None),
    (5, 105, 2,  'id',       '784-1990-002', ['uniform', 'shoes'], '2026-10-18 11:30:00+04', True, 102),
]
for (uid_, tok, en, doctype, docnum, items, created, is_renewal, prev) in uniforms:
    items_json = ', '.join(f'"{i}": true' for i in items)
    emp_name = next(x['name'] for x in E if x['n'] == en)
    site_name = next(s[1] for s in SITES if s[0] == next(x for x in E if x['n'] == en)['site'])
    leader = next((x['name'] for x in E if x['site'] == next(y for y in E if y['n'] == en)['site'] and x['leader']), None)
    w(f"""  insert into public.uniform_registry (uniform_id, token_number, employee_id, employee_name,
    document_type, document_number, items, site_name, team_leader_name, is_renewal,
    previous_token_id, created_at, renewal_date)
  values ({uid_}, {tok}, '{emp(en)}', '{emp_name}', '{doctype}', '{docnum}',
    '{{{items_json}}}'::jsonb, '{site_name}', {f"'{leader}'" if leader else 'null'},
    {'true' if is_renewal else 'false'}, {prev if prev else 'null'},
    '{created}', '{created}'::timestamptz + interval '6 months');""")

# ---- notifications --------------------------------------------------------
w("""
  -- ---------------------------------------------------------------------
  -- 11. NOTIFICATIONS (mirror what the app's RPCs would have fanned out)
  -- ---------------------------------------------------------------------""")
notifs = [
    (SUPER, 'New Leave Request', 'Ramesh Kumar (ASM-2026-002) requested casual leave for 3 day(s)', 'request'),
    (SUPER, 'New Cancellation Request', 'Hassan Jaber (ASM-2026-016) is pending deletion approval — Project demobilization — end of snagging phase, visa cancellation required', 'request'),
    (SUPER, 'Auto-Generated Warning', 'Imran Sheikh (ASM-2026-011) was absent 3+ consecutive days', 'warning'),
    (SUPER, 'Fine Issued', 'Kamal Hossain (ASM-2026-004) was fined AED 200.00 — Damage to company mixer — negligent operation', 'fine'),
    (ADMIN_A, 'New Leave Request', 'Ramesh Kumar (ASM-2026-002) requested casual leave for 3 day(s)', 'request'),
]
for (pid, title, msg, typ) in notifs:
    w(f"  insert into public.notification (profile_id, title, message, type, read) values ('{pid}', '{title}', '{msg}', '{typ}', false);")

w("""
  raise notice 'Seed complete: 4 sites, 3 camps, 22 employees, % attendance records, 3 demo logins.', """ + f"{att_rows}" + """;
end
$seed$;""")

sql = '\n'.join(out) + '\n'
with open('supabase/seed.sql', 'w') as f:
    f.write(sql)
print(f'supabase/seed.sql written: {len(sql):,} bytes, {sql.count(chr(10)):,} lines, {att_rows} attendance rows')
