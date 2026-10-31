-- ============================================================================
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
  v_super  uuid := 'a0000000-0000-4000-8000-000000000001';
  v_admin_a uuid := 'a0000000-0000-4000-8000-000000000002';
  v_admin_b uuid := 'a0000000-0000-4000-8000-000000000003';
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


  -- ---------------------------------------------------------------------
  -- 1. LOGIN ACCOUNTS (auth.users + auth.identities + profiles via trigger)
  --    handle_new_user() creates the profile rows automatically; roles are
  --    fixed right after so the demo logins are deterministic.
  -- ---------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                                 email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                                 created_at, updated_at)
  values ('a0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'super@pulse.dev', crypt('pulse-super-2026', gen_salt('bf')),
          now(), '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"Sarah Chen"}'::jsonb, now(), now());
  insert into auth.identities (provider_id, user_id, identity_data, provider,
                               last_sign_in_at, created_at, updated_at)
  values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
          jsonb_build_object('sub', 'a0000000-0000-4000-8000-000000000001', 'email', 'super@pulse.dev', 'email_verified', true),
          'email', now(), now(), now());
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                                 email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                                 created_at, updated_at)
  values ('a0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'admin.marina@pulse.dev', crypt('pulse-admin-2026', gen_salt('bf')),
          now(), '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"Omar Al-Farsi"}'::jsonb, now(), now());
  insert into auth.identities (provider_id, user_id, identity_data, provider,
                               last_sign_in_at, created_at, updated_at)
  values ('a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002',
          jsonb_build_object('sub', 'a0000000-0000-4000-8000-000000000002', 'email', 'admin.marina@pulse.dev', 'email_verified', true),
          'email', now(), now(), now());
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                                 email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                                 created_at, updated_at)
  values ('a0000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'admin.metro@pulse.dev', crypt('pulse-admin-2026', gen_salt('bf')),
          now(), '{"provider":"email","providers":["email"]}'::jsonb,
          '{"name":"Priya Nair"}'::jsonb, now(), now());
  insert into auth.identities (provider_id, user_id, identity_data, provider,
                               last_sign_in_at, created_at, updated_at)
  values ('a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003',
          jsonb_build_object('sub', 'a0000000-0000-4000-8000-000000000003', 'email', 'admin.metro@pulse.dev', 'email_verified', true),
          'email', now(), now(), now());

  update public.profiles set role = 'super_admin' where id = v_super;
  update public.profiles set role = 'admin' where id in (v_admin_a, v_admin_b);

  -- ---------------------------------------------------------------------
  -- 2. MENU PERMISSIONS for the two site admins
  -- ---------------------------------------------------------------------
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000002', 'employees', true);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000002', 'sites', true);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000002', 'camps', true);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000002', 'attendance', true);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000002', 'leave_requests', true);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000002', 'cancellation_requests', true);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000002', 'notifications', true);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000003', 'employees', true);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000003', 'sites', true);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000003', 'camps', false);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000003', 'attendance', true);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000003', 'leave_requests', true);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000003', 'cancellation_requests', false);
  insert into public.menu_permission (profile_id, menu_key, allowed) values ('a0000000-0000-4000-8000-000000000003', 'notifications', true);

  -- ---------------------------------------------------------------------
  -- 3. WORK SITES + ACCOMMODATION CAMPS
  -- ---------------------------------------------------------------------
  insert into public.site (id, name, client_name, project_name) values ('b0000000-0000-4000-8000-000000000001', 'Marina Bay Tower', 'Emaar Properties', 'Marina Bay Tower — Core & Shell');
  insert into public.site (id, name, client_name, project_name) values ('b0000000-0000-4000-8000-000000000002', 'Desert Rose Mall', 'Al-Futtaim Group', 'Desert Rose Mall — Fit-Out Phase 2');
  insert into public.site (id, name, client_name, project_name) values ('b0000000-0000-4000-8000-000000000003', 'Sheikh Zayed Metro Extension', 'RTA Dubai', 'SZR Metro Line — Station Civil Works');
  insert into public.site (id, name, client_name, project_name) values ('b0000000-0000-4000-8000-000000000004', 'Palm Jumeirah Villas', 'Nakheel', 'Villa Handover — Phase 3 Snagging');
  insert into public.camp (id, name, location, capacity, notes) values ('c0000000-0000-4000-8000-000000000001', 'Al Quoz Labour Camp', 'Al Quoz Industrial 3, Dubai', 250, 'Blocks A–C; bus pickup 05:15');
  insert into public.camp (id, name, location, capacity, notes) values ('c0000000-0000-4000-8000-000000000002', 'Jebel Ali Workers Village', 'Jebel Ali Industrial 1, Dubai', 400, 'Near Gate 2 canteen');
  insert into public.camp (id, name, location, capacity, notes) values ('c0000000-0000-4000-8000-000000000003', 'Sonapur Accommodation Camp', 'Sonapur, Dubai', 180, 'Quiet hours 22:00–05:00');

  -- ---------------------------------------------------------------------
  -- 4. EMPLOYEES (22 — ASM-2026-001 … ASM-2026-022)
  -- ---------------------------------------------------------------------
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000001', 'Ahmed Al Mansoori', 'ASM-2026-001', 'UAE',
    '1993-02-02',
    '+971-51-051-1007', 'Site Foreman', '2024-03-11', 'ASM Contracting LLC',
    'P0000012', 'Valid', '784-1990-0001', 'Valid', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001', 'B', '204', 4.8,
    'active', true,
    'b0000000-0000-4000-8000-000000000001',
    '2024-03-11 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000002', 'Ramesh Kumar', 'ASM-2026-002', 'India',
    '1996-03-03',
    '+971-52-052-1014', 'Steel Fixer', '2024-06-02', 'ASM Contracting LLC',
    'P0000022', 'Valid', '784-1990-0002', 'Valid', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001', 'B', '108', 4.6,
    'active', false,
    null,
    '2024-06-02 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000003', 'Joseph Santos', 'ASM-2026-003', 'Philippines',
    '1999-04-04',
    '+971-53-053-1021', 'HVAC Technician', '2025-01-20', 'ASM Contracting LLC',
    'P0000031', 'Valid', '784-1990-0003', 'Valid', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001', 'A', '112', 4.9,
    'active', false,
    null,
    '2025-01-20 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000004', 'Kamal Hossain', 'ASM-2026-004', 'Bangladesh',
    '2002-05-05',
    '+971-54-054-1028', 'Mason', '2024-09-15', 'ASM Contracting LLC',
    'P0000042', 'Valid', '784-1990-0004', 'Valid', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000002', 'D', '311', 4.3,
    'active', false,
    null,
    '2024-09-15 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000005', 'Tika Bahadur Gurung', 'ASM-2026-005', 'Nepal',
    '1990-06-06',
    '+971-55-055-1035', 'Scaffolder', '2025-04-07', 'ASM Contracting LLC',
    'P0000051', 'Valid', '784-1990-0005', 'Valid', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001', 'B', '222', 4.5,
    'active', false,
    null,
    '2025-04-07 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000006', 'Grace Wanjiru', 'ASM-2026-006', 'Kenya',
    '1993-07-07',
    '+971-56-056-1042', 'Site Nurse', '2025-08-01', 'ASM Contracting LLC',
    'P0000061', 'Valid', '784-1990-0006', 'Valid', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000003', 'A', '005', 5.0,
    'active', false,
    null,
    '2025-08-01 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000007', 'Mohd Rafiq', 'ASM-2026-007', 'Pakistan',
    '1996-08-08',
    '+971-57-057-1049', 'Site Foreman', '2024-02-19', 'ASM Contracting LLC',
    'P0000072', 'Valid', '784-1990-0007', 'Valid', 'b0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000002', 'D', '305', 4.7,
    'active', true,
    'b0000000-0000-4000-8000-000000000002',
    '2024-02-19 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000008', 'Deepak Thapa', 'ASM-2026-008', 'Nepal',
    '1999-09-09',
    '+971-58-058-1056', 'Electrician', '2024-11-05', 'ASM Contracting LLC',
    'P0000082', 'Valid', '784-1990-0008', 'Valid', 'b0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000002', 'C', '218', 4.4,
    'active', false,
    null,
    '2024-11-05 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000009', 'Nguyen Van Minh', 'ASM-2026-009', 'Vietnam',
    '2002-10-10',
    '+971-59-059-1063', 'Painter', '2025-03-17', 'ASM Contracting LLC',
    'P0000091', 'Valid', '784-1990-0009', 'Valid', 'b0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000002', 'D', '402', 4.2,
    'active', false,
    null,
    '2025-03-17 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000010', 'Samuel Osei', 'ASM-2026-010', 'Ghana',
    '1990-11-11',
    '+971-50-060-1070', 'Carpenter', '2025-06-09', 'ASM Contracting LLC',
    'P0000101', 'Valid', '784-1990-0010', 'Valid', 'b0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000003', 'B', '117', 4.1,
    'active', false,
    null,
    '2025-06-09 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000011', 'Imran Sheikh', 'ASM-2026-011', 'Pakistan',
    '1993-12-12',
    '+971-51-061-1077', 'Helper', '2026-01-12', 'ASM Contracting LLC',
    'P0000110', 'Expired', '784-1990-0011', 'Valid', 'b0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000003', 'B', '119', 3.9,
    'active', false,
    null,
    '2026-01-12 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000012', 'Wong Kei', 'ASM-2026-012', 'Hong Kong',
    '1996-01-13',
    '+971-52-062-1084', 'Site Supervisor', '2024-05-23', 'ASM Contracting LLC',
    'P0000122', 'Valid', '784-1990-0012', 'Valid', 'b0000000-0000-4000-8000-000000000003',
    'c0000000-0000-4000-8000-000000000001', 'A', '303', 4.9,
    'active', true,
    'b0000000-0000-4000-8000-000000000003',
    '2024-05-23 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000013', 'Dilip Chaudhary', 'ASM-2026-013', 'India',
    '1999-02-14',
    '+971-53-063-1091', 'Welder', '2025-02-14', 'ASM Contracting LLC',
    'P0000131', 'Valid', '784-1990-0013', 'Valid', 'b0000000-0000-4000-8000-000000000003',
    'c0000000-0000-4000-8000-000000000001', 'A', '308', 4.6,
    'active', false,
    null,
    '2025-02-14 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000014', 'Abdelrahman Fadl', 'ASM-2026-014', 'Sudan',
    '2002-03-15',
    '+971-54-064-1098', 'Steel Fixer', '2025-07-30', 'ASM Contracting LLC',
    'P0000141', 'Valid', '784-1990-0014', 'Valid', 'b0000000-0000-4000-8000-000000000003',
    'c0000000-0000-4000-8000-000000000001', 'C', '126', 4.0,
    'active', false,
    null,
    '2025-07-30 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000015', 'Ravi Perera', 'ASM-2026-015', 'Sri Lanka',
    '1990-04-16',
    '+971-55-065-1105', 'Surveyor', '2026-02-02', 'ASM Contracting LLC',
    'P0000150', 'Valid', '784-1990-0015', 'Valid', 'b0000000-0000-4000-8000-000000000003',
    'c0000000-0000-4000-8000-000000000003', 'C', '204', 4.8,
    'active', false,
    null,
    '2026-02-02 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000016', 'Hassan Jaber', 'ASM-2026-016', 'Lebanon',
    '1993-05-17',
    '+971-56-066-1112', 'Site Supervisor', '2025-05-05', 'ASM Contracting LLC',
    'P0000161', 'Valid', '784-1990-0016', 'Valid', 'b0000000-0000-4000-8000-000000000004',
    'c0000000-0000-4000-8000-000000000002', 'A', '101', 4.5,
    'active', true,
    'b0000000-0000-4000-8000-000000000004',
    '2025-05-05 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000017', 'Mario Dizon', 'ASM-2026-017', 'Philippines',
    '1996-06-18',
    '+971-57-067-1119', 'Cleaner', '2026-03-16', 'ASM Contracting LLC',
    'P0000170', 'Valid', '784-1990-0017', 'Valid', 'b0000000-0000-4000-8000-000000000004',
    'c0000000-0000-4000-8000-000000000002', 'A', '104', 4.2,
    'active', false,
    null,
    '2026-03-16 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000018', 'Faisal Al Zarooni', 'ASM-2026-018', 'UAE',
    '1999-07-19',
    '+971-58-068-1126', 'Driver', '2026-04-20', 'ASM Contracting LLC',
    'P0000180', 'Valid', '784-1990-0018', 'Valid', null,
    'c0000000-0000-4000-8000-000000000003', 'A', '010', 4.4,
    'active', false,
    null,
    '2026-04-20 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000019', 'Rahul Sharma', 'ASM-2026-019', 'India',
    '2002-08-20',
    '+971-59-069-1133', 'Steel Fixer', '2024-08-18', 'ASM Contracting LLC',
    'P0000192', 'Valid', '784-1990-0019', 'Valid', 'b0000000-0000-4000-8000-000000000003',
    'c0000000-0000-4000-8000-000000000001', 'B', '205', 4.7,
    'active', false,
    null,
    '2024-08-18 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000020', 'Mohammed Yousuf', 'ASM-2026-020', 'Egypt',
    '1990-09-21',
    '+971-50-070-1140', 'Carpenter', '2025-09-01', 'ASM Contracting LLC',
    'P0000201', 'Valid', '784-1990-0020', 'Valid', 'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000002', 'D', '310', 4.3,
    'active', false,
    null,
    '2025-09-01 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000021', 'Aung San', 'ASM-2026-021', 'Myanmar',
    '1993-10-22',
    '+971-51-071-1147', 'Helper', '2025-10-11', 'ASM Contracting LLC',
    'P0000211', 'Valid', '784-1990-0021', 'Valid', null,
    'c0000000-0000-4000-8000-000000000003', 'C', '215', 4.1,
    'active', false,
    null,
    '2025-10-11 09:00:00+04', now());
  insert into public.employee (id, full_name, employee_code, nationality, date_of_birth,
    phone, position, join_date, company_name, passport_number, passport_status,
    id_number, id_status, current_site_id, camp_id, camp_block, camp_room, rating,
    status, is_team_leader, team_leader_site_id, created_at, updated_at)
  values ('d0000000-0000-4000-8000-000000000022', 'Bilal Akhtar', 'ASM-2026-022', 'Pakistan',
    '1996-11-23',
    '+971-52-072-1154', 'Plumber', '2025-12-15', 'ASM Contracting LLC',
    'P0000221', 'Valid', '784-1990-0022', 'Valid', 'b0000000-0000-4000-8000-000000000004',
    'c0000000-0000-4000-8000-000000000002', 'C', '221', 4.5,
    'active', false,
    null,
    '2025-12-15 09:00:00+04', now());
  update public.employee set status = 'pending_deletion' where id = 'd0000000-0000-4000-8000-000000000016';

  -- ---------------------------------------------------------------------
  -- 5. SITE ACCESS for the admins (admin B = Metro only)
  -- ---------------------------------------------------------------------
  insert into public.admin_site (profile_id, site_id) values
    (v_admin_a, 'b0000000-0000-4000-8000-000000000001'), (v_admin_a, 'b0000000-0000-4000-8000-000000000002'),
    (v_admin_b, 'b0000000-0000-4000-8000-000000000003');

  -- ---------------------------------------------------------------------
  -- 6. SITE TRANSFERS (the date-effective demo rows)
  -- ---------------------------------------------------------------------
  insert into public.site_transfer (employee_id, from_site_id, to_site_id, effective_date, created_at) values ('d0000000-0000-4000-8000-000000000019', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000003', '2026-10-25', '2026-10-25 20:00:00+04');
  insert into public.site_transfer (employee_id, from_site_id, to_site_id, effective_date, created_at) values ('d0000000-0000-4000-8000-000000000020', 'b0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000004', '2026-10-10', '2026-10-10 08:00:00+04');
  insert into public.site_transfer (employee_id, from_site_id, to_site_id, effective_date, created_at) values ('d0000000-0000-4000-8000-000000000020', 'b0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001', '2026-10-20', '2026-10-20 08:00:00+04');
  insert into public.site_transfer (employee_id, from_site_id, to_site_id, effective_date, created_at) values ('d0000000-0000-4000-8000-000000000021', 'b0000000-0000-4000-8000-000000000003', null, '2026-10-18', '2026-10-18 09:00:00+04');
  insert into public.site_transfer (employee_id, from_site_id, to_site_id, effective_date, created_at) values ('d0000000-0000-4000-8000-000000000022', null, 'b0000000-0000-4000-8000-000000000004', '2026-10-15', '2026-10-15 10:00:00+04');

  -- ---------------------------------------------------------------------
  -- 7. OCTOBER 2026 ATTENDANCE (Sun–Thu work week; 10h default,
  --    sprinkled 8h / 12h overtime, absence streak Oct 5–7, sick leave
  --    Oct 12–13, movers' records timestamped around their transfers)
  -- ---------------------------------------------------------------------
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-01', 'present', 10, '2026-10-01 18:02:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-04', 'present', 10, '2026-10-04 18:05:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-05', 'present', 10, '2026-10-05 18:06:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-06', 'present', 8, '2026-10-06 18:07:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-07', 'present', 10, '2026-10-07 18:08:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-08', 'present', 10, '2026-10-08 18:09:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-11', 'present', 10, '2026-10-11 18:12:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-12', 'present', 10, '2026-10-12 18:13:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-13', 'present', 8, '2026-10-13 18:14:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-14', 'present', 10, '2026-10-14 18:15:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-15', 'present', 10, '2026-10-15 18:16:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-18', 'present', 10, '2026-10-18 18:19:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-19', 'present', 10, '2026-10-19 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-20', 'present', 8, '2026-10-20 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-21', 'present', 10, '2026-10-21 18:22:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-22', 'present', 10, '2026-10-22 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-25', 'present', 10, '2026-10-25 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-26', 'present', 10, '2026-10-26 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-27', 'present', 8, '2026-10-27 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-28', 'present', 10, '2026-10-28 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000001', '2026-10-29', 'present', 10, '2026-10-29 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-01', 'present', 12, '2026-10-01 18:03:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-04', 'present', 10, '2026-10-04 18:06:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-05', 'present', 8, '2026-10-05 18:07:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-06', 'present', 10, '2026-10-06 18:08:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-07', 'present', 10, '2026-10-07 18:09:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-08', 'present', 12, '2026-10-08 18:10:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-11', 'present', 10, '2026-10-11 18:13:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-12', 'present', 8, '2026-10-12 18:14:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-13', 'present', 10, '2026-10-13 18:15:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-14', 'present', 10, '2026-10-14 18:16:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-15', 'present', 12, '2026-10-15 18:17:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-18', 'present', 10, '2026-10-18 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-19', 'present', 8, '2026-10-19 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-20', 'present', 10, '2026-10-20 18:22:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-21', 'present', 10, '2026-10-21 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-22', 'present', 12, '2026-10-22 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-25', 'present', 10, '2026-10-25 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-26', 'present', 8, '2026-10-26 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-27', 'present', 10, '2026-10-27 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-28', 'present', 10, '2026-10-28 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000002', '2026-10-29', 'present', 12, '2026-10-29 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-01', 'present', 10, '2026-10-01 18:04:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-04', 'present', 8, '2026-10-04 18:07:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-05', 'present', 10, '2026-10-05 18:08:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-06', 'present', 10, '2026-10-06 18:09:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-07', 'present', 12, '2026-10-07 18:10:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-08', 'present', 10, '2026-10-08 18:11:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-11', 'present', 8, '2026-10-11 18:14:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-14', 'present', 12, '2026-10-14 18:17:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-15', 'present', 10, '2026-10-15 18:18:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-18', 'present', 8, '2026-10-18 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-19', 'present', 10, '2026-10-19 18:22:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-20', 'present', 10, '2026-10-20 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-21', 'present', 12, '2026-10-21 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-22', 'present', 10, '2026-10-22 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-25', 'present', 8, '2026-10-25 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-26', 'present', 10, '2026-10-26 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-27', 'present', 10, '2026-10-27 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-28', 'present', 12, '2026-10-28 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000003', '2026-10-29', 'present', 10, '2026-10-29 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-01', 'present', 10, '2026-10-01 18:05:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-04', 'present', 10, '2026-10-04 18:08:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-05', 'present', 10, '2026-10-05 18:09:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-06', 'present', 12, '2026-10-06 18:10:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-07', 'present', 10, '2026-10-07 18:11:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-08', 'present', 10, '2026-10-08 18:12:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-11', 'present', 10, '2026-10-11 18:15:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-12', 'present', 10, '2026-10-12 18:16:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-13', 'present', 12, '2026-10-13 18:17:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-14', 'present', 10, '2026-10-14 18:18:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-15', 'present', 10, '2026-10-15 18:19:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-18', 'present', 10, '2026-10-18 18:22:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-19', 'present', 10, '2026-10-19 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-20', 'present', 12, '2026-10-20 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-21', 'present', 10, '2026-10-21 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-22', 'present', 10, '2026-10-22 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-25', 'present', 10, '2026-10-25 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-26', 'present', 10, '2026-10-26 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-27', 'present', 12, '2026-10-27 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-28', 'present', 10, '2026-10-28 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000004', '2026-10-29', 'present', 10, '2026-10-29 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-01', 'present', 10, '2026-10-01 18:06:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-04', 'present', 10, '2026-10-04 18:09:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-05', 'present', 12, '2026-10-05 18:10:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-06', 'present', 10, '2026-10-06 18:11:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-07', 'present', 10, '2026-10-07 18:12:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-08', 'present', 10, '2026-10-08 18:13:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-11', 'present', 10, '2026-10-11 18:16:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-12', 'present', 12, '2026-10-12 18:17:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-13', 'present', 10, '2026-10-13 18:18:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-14', 'present', 10, '2026-10-14 18:19:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-15', 'present', 10, '2026-10-15 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-18', 'present', 10, '2026-10-18 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-19', 'present', 12, '2026-10-19 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-20', 'present', 10, '2026-10-20 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-21', 'present', 10, '2026-10-21 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-22', 'present', 10, '2026-10-22 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-25', 'present', 10, '2026-10-25 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-26', 'present', 12, '2026-10-26 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-27', 'present', 10, '2026-10-27 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-28', 'present', 10, '2026-10-28 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000005', '2026-10-29', 'present', 10, '2026-10-29 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-01', 'present', 8, '2026-10-01 18:07:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-04', 'present', 12, '2026-10-04 18:10:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-05', 'present', 10, '2026-10-05 18:11:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-06', 'present', 10, '2026-10-06 18:12:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-07', 'present', 10, '2026-10-07 18:13:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-08', 'present', 8, '2026-10-08 18:14:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-11', 'present', 12, '2026-10-11 18:17:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-12', 'present', 10, '2026-10-12 18:18:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-13', 'present', 10, '2026-10-13 18:19:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-14', 'present', 10, '2026-10-14 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-15', 'present', 8, '2026-10-15 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-18', 'present', 12, '2026-10-18 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-19', 'present', 10, '2026-10-19 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-20', 'present', 10, '2026-10-20 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-21', 'present', 10, '2026-10-21 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-22', 'present', 8, '2026-10-22 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-25', 'present', 12, '2026-10-25 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-26', 'present', 10, '2026-10-26 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-27', 'present', 10, '2026-10-27 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-28', 'present', 10, '2026-10-28 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000006', '2026-10-29', 'present', 8, '2026-10-29 18:35:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-01', 'present', 10, '2026-10-01 18:08:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-04', 'present', 10, '2026-10-04 18:11:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-05', 'present', 10, '2026-10-05 18:12:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-06', 'present', 10, '2026-10-06 18:13:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-07', 'present', 8, '2026-10-07 18:14:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-08', 'present', 10, '2026-10-08 18:15:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-11', 'present', 10, '2026-10-11 18:18:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-12', 'present', 10, '2026-10-12 18:19:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-13', 'present', 10, '2026-10-13 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-14', 'present', 8, '2026-10-14 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-15', 'present', 10, '2026-10-15 18:22:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-18', 'present', 10, '2026-10-18 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-19', 'present', 10, '2026-10-19 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-20', 'present', 10, '2026-10-20 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-21', 'present', 8, '2026-10-21 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-22', 'present', 10, '2026-10-22 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-25', 'present', 10, '2026-10-25 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-26', 'present', 10, '2026-10-26 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-27', 'present', 10, '2026-10-27 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-28', 'present', 8, '2026-10-28 18:35:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000007', '2026-10-29', 'present', 10, '2026-10-29 18:36:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-01', 'present', 10, '2026-10-01 18:09:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-04', 'present', 10, '2026-10-04 18:12:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-05', 'present', 10, '2026-10-05 18:13:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-06', 'present', 8, '2026-10-06 18:14:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-07', 'present', 10, '2026-10-07 18:15:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-08', 'present', 10, '2026-10-08 18:16:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-11', 'present', 10, '2026-10-11 18:19:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-12', 'present', 10, '2026-10-12 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-13', 'present', 8, '2026-10-13 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-14', 'absent', null, '2026-10-14 18:10:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-15', 'present', 10, '2026-10-15 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-18', 'present', 10, '2026-10-18 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-19', 'present', 10, '2026-10-19 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-20', 'present', 8, '2026-10-20 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-21', 'present', 10, '2026-10-21 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-22', 'present', 10, '2026-10-22 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-25', 'present', 10, '2026-10-25 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-26', 'present', 10, '2026-10-26 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-27', 'present', 8, '2026-10-27 18:35:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-28', 'present', 10, '2026-10-28 18:36:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000008', '2026-10-29', 'present', 10, '2026-10-29 18:37:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-01', 'present', 12, '2026-10-01 18:10:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-04', 'present', 10, '2026-10-04 18:13:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-05', 'present', 8, '2026-10-05 18:14:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-06', 'present', 10, '2026-10-06 18:15:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-07', 'present', 10, '2026-10-07 18:16:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-08', 'present', 12, '2026-10-08 18:17:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-11', 'present', 10, '2026-10-11 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-12', 'present', 8, '2026-10-12 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-13', 'present', 10, '2026-10-13 18:22:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-14', 'present', 10, '2026-10-14 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-15', 'present', 12, '2026-10-15 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-18', 'present', 10, '2026-10-18 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-19', 'present', 8, '2026-10-19 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-20', 'present', 10, '2026-10-20 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-21', 'present', 10, '2026-10-21 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-22', 'present', 12, '2026-10-22 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-25', 'present', 10, '2026-10-25 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-26', 'present', 8, '2026-10-26 18:35:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-27', 'present', 10, '2026-10-27 18:36:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-28', 'present', 10, '2026-10-28 18:37:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000009', '2026-10-29', 'present', 12, '2026-10-29 18:38:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-01', 'present', 10, '2026-10-01 18:11:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-04', 'present', 8, '2026-10-04 18:14:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-05', 'present', 10, '2026-10-05 18:15:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-06', 'present', 10, '2026-10-06 18:16:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-07', 'present', 12, '2026-10-07 18:17:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-08', 'present', 10, '2026-10-08 18:18:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-11', 'present', 8, '2026-10-11 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-12', 'present', 10, '2026-10-12 18:22:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-13', 'present', 10, '2026-10-13 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-14', 'present', 12, '2026-10-14 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-15', 'present', 10, '2026-10-15 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-18', 'present', 8, '2026-10-18 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-19', 'present', 10, '2026-10-19 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-20', 'present', 10, '2026-10-20 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-21', 'present', 12, '2026-10-21 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-22', 'present', 10, '2026-10-22 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-25', 'present', 8, '2026-10-25 18:35:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-26', 'present', 10, '2026-10-26 18:36:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-27', 'present', 10, '2026-10-27 18:37:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-28', 'present', 12, '2026-10-28 18:38:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000010', '2026-10-29', 'present', 10, '2026-10-29 18:39:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-01', 'present', 10, '2026-10-01 18:12:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-04', 'present', 10, '2026-10-04 18:15:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-05', 'absent', null, '2026-10-05 18:10:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-06', 'absent', null, '2026-10-06 18:10:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-07', 'absent', null, '2026-10-07 18:10:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-08', 'present', 10, '2026-10-08 18:19:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-11', 'present', 10, '2026-10-11 18:22:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-12', 'present', 10, '2026-10-12 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-13', 'present', 12, '2026-10-13 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-14', 'present', 10, '2026-10-14 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-15', 'present', 10, '2026-10-15 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-18', 'present', 10, '2026-10-18 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-19', 'present', 10, '2026-10-19 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-20', 'present', 12, '2026-10-20 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-21', 'present', 10, '2026-10-21 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-22', 'present', 10, '2026-10-22 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-25', 'present', 10, '2026-10-25 18:36:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-26', 'present', 10, '2026-10-26 18:37:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-27', 'present', 12, '2026-10-27 18:38:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-28', 'present', 10, '2026-10-28 18:39:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000011', '2026-10-29', 'present', 10, '2026-10-29 18:40:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-01', 'present', 10, '2026-10-01 18:13:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-04', 'present', 10, '2026-10-04 18:16:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-05', 'present', 12, '2026-10-05 18:17:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-06', 'present', 10, '2026-10-06 18:18:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-07', 'present', 10, '2026-10-07 18:19:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-08', 'present', 10, '2026-10-08 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-11', 'present', 10, '2026-10-11 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-12', 'present', 12, '2026-10-12 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-13', 'present', 10, '2026-10-13 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-14', 'present', 10, '2026-10-14 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-15', 'present', 10, '2026-10-15 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-18', 'present', 10, '2026-10-18 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-19', 'present', 12, '2026-10-19 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-20', 'present', 10, '2026-10-20 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-21', 'present', 10, '2026-10-21 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-22', 'present', 10, '2026-10-22 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-25', 'present', 10, '2026-10-25 18:37:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-26', 'present', 12, '2026-10-26 18:38:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-27', 'present', 10, '2026-10-27 18:39:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-28', 'present', 10, '2026-10-28 18:40:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000012', '2026-10-29', 'present', 10, '2026-10-29 18:41:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-01', 'present', 8, '2026-10-01 18:14:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-04', 'present', 12, '2026-10-04 18:17:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-05', 'present', 10, '2026-10-05 18:18:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-06', 'present', 10, '2026-10-06 18:19:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-07', 'present', 10, '2026-10-07 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-08', 'present', 8, '2026-10-08 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-11', 'present', 12, '2026-10-11 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-12', 'present', 10, '2026-10-12 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-13', 'present', 10, '2026-10-13 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-14', 'present', 10, '2026-10-14 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-15', 'present', 8, '2026-10-15 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-18', 'present', 12, '2026-10-18 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-19', 'present', 10, '2026-10-19 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-20', 'present', 10, '2026-10-20 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-21', 'present', 10, '2026-10-21 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-22', 'present', 8, '2026-10-22 18:35:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-25', 'present', 12, '2026-10-25 18:38:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-26', 'present', 10, '2026-10-26 18:39:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-27', 'present', 10, '2026-10-27 18:40:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-28', 'present', 10, '2026-10-28 18:41:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000013', '2026-10-29', 'present', 8, '2026-10-29 18:42:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-01', 'present', 10, '2026-10-01 18:15:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-04', 'present', 10, '2026-10-04 18:18:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-05', 'present', 10, '2026-10-05 18:19:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-06', 'present', 10, '2026-10-06 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-07', 'present', 8, '2026-10-07 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-08', 'present', 10, '2026-10-08 18:22:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-11', 'present', 10, '2026-10-11 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-12', 'present', 10, '2026-10-12 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-13', 'present', 10, '2026-10-13 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-14', 'present', 8, '2026-10-14 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-15', 'present', 10, '2026-10-15 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-18', 'present', 10, '2026-10-18 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-19', 'present', 10, '2026-10-19 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-20', 'present', 10, '2026-10-20 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-21', 'present', 8, '2026-10-21 18:35:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-22', 'present', 10, '2026-10-22 18:36:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-25', 'present', 10, '2026-10-25 18:39:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-26', 'present', 10, '2026-10-26 18:40:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-27', 'present', 10, '2026-10-27 18:41:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-28', 'present', 8, '2026-10-28 18:42:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000014', '2026-10-29', 'present', 10, '2026-10-29 18:43:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-01', 'present', 10, '2026-10-01 18:16:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-04', 'present', 10, '2026-10-04 18:19:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-05', 'present', 10, '2026-10-05 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-06', 'present', 8, '2026-10-06 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-07', 'present', 10, '2026-10-07 18:22:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-08', 'present', 10, '2026-10-08 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-11', 'present', 10, '2026-10-11 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-12', 'present', 10, '2026-10-12 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-13', 'present', 8, '2026-10-13 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-14', 'present', 10, '2026-10-14 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-15', 'present', 10, '2026-10-15 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-18', 'present', 10, '2026-10-18 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-19', 'present', 10, '2026-10-19 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-20', 'present', 8, '2026-10-20 18:35:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-21', 'present', 10, '2026-10-21 18:36:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-22', 'present', 10, '2026-10-22 18:37:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-25', 'present', 10, '2026-10-25 18:40:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-26', 'present', 10, '2026-10-26 18:41:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-27', 'present', 8, '2026-10-27 18:42:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-28', 'present', 10, '2026-10-28 18:43:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000015', '2026-10-29', 'present', 10, '2026-10-29 18:44:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-01', 'present', 12, '2026-10-01 18:17:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-04', 'present', 10, '2026-10-04 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-05', 'present', 8, '2026-10-05 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-06', 'present', 10, '2026-10-06 18:22:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-07', 'present', 10, '2026-10-07 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-08', 'present', 12, '2026-10-08 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-11', 'present', 10, '2026-10-11 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-12', 'present', 8, '2026-10-12 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-13', 'present', 10, '2026-10-13 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-14', 'present', 10, '2026-10-14 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-15', 'present', 12, '2026-10-15 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-18', 'present', 10, '2026-10-18 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-19', 'present', 8, '2026-10-19 18:35:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-20', 'present', 10, '2026-10-20 18:36:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-21', 'present', 10, '2026-10-21 18:37:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-22', 'present', 12, '2026-10-22 18:38:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-25', 'present', 10, '2026-10-25 18:41:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-26', 'present', 8, '2026-10-26 18:42:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-27', 'present', 10, '2026-10-27 18:43:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-28', 'present', 10, '2026-10-28 18:44:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000016', '2026-10-29', 'present', 12, '2026-10-29 18:45:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-01', 'present', 10, '2026-10-01 18:18:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-04', 'present', 8, '2026-10-04 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-05', 'present', 10, '2026-10-05 18:22:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-06', 'present', 10, '2026-10-06 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-07', 'present', 12, '2026-10-07 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-08', 'present', 10, '2026-10-08 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-11', 'present', 8, '2026-10-11 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-12', 'present', 10, '2026-10-12 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-13', 'present', 10, '2026-10-13 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-14', 'present', 12, '2026-10-14 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-15', 'present', 10, '2026-10-15 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-18', 'present', 8, '2026-10-18 18:35:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-19', 'present', 10, '2026-10-19 18:36:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-20', 'present', 10, '2026-10-20 18:37:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-21', 'present', 12, '2026-10-21 18:38:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-22', 'present', 10, '2026-10-22 18:39:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-25', 'present', 8, '2026-10-25 18:42:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-26', 'present', 10, '2026-10-26 18:43:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-27', 'present', 10, '2026-10-27 18:44:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-28', 'present', 12, '2026-10-28 18:45:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000017', '2026-10-29', 'present', 10, '2026-10-29 18:46:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-01', 'present', 10, '2026-10-01 18:20:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-04', 'present', 10, '2026-10-04 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-05', 'present', 10, '2026-10-05 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-06', 'present', 10, '2026-10-06 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-07', 'present', 10, '2026-10-07 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-08', 'present', 10, '2026-10-08 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-11', 'present', 10, '2026-10-11 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-12', 'present', 10, '2026-10-12 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-13', 'present', 10, '2026-10-13 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-14', 'present', 10, '2026-10-14 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-15', 'present', 10, '2026-10-15 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-18', 'present', 10, '2026-10-18 18:37:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-19', 'present', 10, '2026-10-19 18:38:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-20', 'present', 10, '2026-10-20 18:39:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-21', 'present', 10, '2026-10-21 18:40:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-22', 'present', 10, '2026-10-22 18:41:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-25', 'present', 10, '2026-10-25 17:00:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-26', 'present', 10, '2026-10-26 18:45:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-27', 'present', 10, '2026-10-27 18:46:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-28', 'present', 10, '2026-10-28 18:47:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000019', '2026-10-29', 'present', 10, '2026-10-29 18:48:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-01', 'present', 10, '2026-10-01 18:21:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-04', 'present', 10, '2026-10-04 18:24:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-05', 'present', 10, '2026-10-05 18:25:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-06', 'present', 10, '2026-10-06 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-07', 'present', 10, '2026-10-07 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-08', 'present', 10, '2026-10-08 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-11', 'present', 10, '2026-10-11 18:31:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-12', 'present', 10, '2026-10-12 18:32:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-13', 'present', 10, '2026-10-13 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-14', 'present', 10, '2026-10-14 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-15', 'present', 10, '2026-10-15 18:35:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-18', 'present', 10, '2026-10-18 18:38:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-19', 'present', 10, '2026-10-19 18:39:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-20', 'present', 10, '2026-10-20 18:40:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-21', 'present', 10, '2026-10-21 18:41:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-22', 'present', 10, '2026-10-22 18:42:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-25', 'present', 10, '2026-10-25 18:45:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-26', 'present', 10, '2026-10-26 18:46:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-27', 'present', 10, '2026-10-27 18:47:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-28', 'present', 10, '2026-10-28 18:48:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000020', '2026-10-29', 'present', 10, '2026-10-29 18:49:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-01', 'present', 10, '2026-10-01 18:23:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-04', 'present', 10, '2026-10-04 18:26:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-05', 'present', 10, '2026-10-05 18:27:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-06', 'present', 10, '2026-10-06 18:28:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-07', 'present', 10, '2026-10-07 18:29:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-08', 'present', 10, '2026-10-08 18:30:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-11', 'present', 10, '2026-10-11 18:33:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-12', 'present', 10, '2026-10-12 18:34:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-13', 'present', 10, '2026-10-13 18:35:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-14', 'present', 10, '2026-10-14 18:36:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-15', 'present', 10, '2026-10-15 18:37:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-18', 'present', 10, '2026-10-18 18:40:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-19', 'present', 10, '2026-10-19 18:41:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-20', 'present', 10, '2026-10-20 18:42:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-21', 'present', 10, '2026-10-21 18:43:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-22', 'present', 10, '2026-10-22 18:44:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-25', 'present', 10, '2026-10-25 18:47:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-26', 'present', 10, '2026-10-26 18:48:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-27', 'present', 10, '2026-10-27 18:49:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-28', 'present', 10, '2026-10-28 18:00:00+04');
  insert into public.attendance (employee_id, date, status, hours, created_at) values ('d0000000-0000-4000-8000-000000000022', '2026-10-29', 'present', 10, '2026-10-29 18:01:00+04');

  -- ---------------------------------------------------------------------
  -- 8. WARNINGS + FINES (418 attendance records above)
  -- ---------------------------------------------------------------------
  insert into public.warning (employee_id, reason, is_auto_generated, absent_dates, created_by, created_at)
  values ('d0000000-0000-4000-8000-000000000011',
          'Auto-generated: 3 consecutive absences detected (2026-10-05, 2026-10-06, 2026-10-07)',
          true, '["2026-10-05","2026-10-06","2026-10-07"]'::jsonb, v_super, '2026-10-08 09:05:00+04');
  insert into public.warning (employee_id, reason, is_auto_generated, created_by, created_at)
  values ('d0000000-0000-4000-8000-000000000005', 'Safety violation — not wearing a harness while working at height on L12', false, v_super, '2026-10-09 14:30:00+04');
  insert into public.warning (employee_id, reason, is_auto_generated, created_by, created_at)
  values ('d0000000-0000-4000-8000-000000000009', 'Repeated late arrival to site (3 occurrences this month)', false, v_admin_a, '2026-10-16 10:00:00+04');
  insert into public.fine (employee_id, reason, amount, created_by, created_at)
  values ('d0000000-0000-4000-8000-000000000004', 'Damage to company mixer — negligent operation', 200.00, v_super, '2026-10-11 11:20:00+04');
  insert into public.fine (employee_id, reason, amount, created_by, created_at)
  values ('d0000000-0000-4000-8000-000000000014', 'Misconduct — altercation with a colleague (per HR report HR-2214)', 100.00, v_super, '2026-10-19 16:45:00+04');

  -- ---------------------------------------------------------------------
  -- 9. LEAVE REQUESTS + CANCELLATION REQUEST
  -- ---------------------------------------------------------------------
  insert into public.leave_request (employee_id, leave_type, other_type_text, start_date, end_date, total_days, reason, status, created_by, reviewed_by, reviewed_at, created_at)
  values ('d0000000-0000-4000-8000-000000000003', 'sick', null, '2026-10-12', '2026-10-13', 2, 'Flu with fever — medical certificate attached', 'approved', v_super, v_super, '2026-10-12 08:40:00+04', '2026-10-11 20:15:00+04');
  insert into public.leave_request (employee_id, leave_type, other_type_text, start_date, end_date, total_days, reason, status, created_by, reviewed_by, reviewed_at, created_at)
  values ('d0000000-0000-4000-8000-000000000002', 'casual', null, '2026-11-03', '2026-11-05', 3, 'Family matters — travel to home country', 'pending', v_super, null, null, '2026-10-27 09:30:00+04');
  insert into public.leave_request (employee_id, leave_type, other_type_text, start_date, end_date, total_days, reason, status, created_by, reviewed_by, reviewed_at, created_at)
  values ('d0000000-0000-4000-8000-000000000015', 'emergency', null, '2026-10-21', '2026-10-22', 2, 'Emergency trip — father hospitalized', 'rejected', v_super, v_super, '2026-10-20 17:10:00+04', '2026-10-20 12:00:00+04');
  insert into public.cancellation_request (employee_id, reason, status, requested_by, created_at)
  values ('d0000000-0000-4000-8000-000000000016', 'Project demobilization — end of snagging phase, visa cancellation required', 'pending', v_super, '2026-10-26 13:55:00+04');

  -- ---------------------------------------------------------------------
  -- 10. UNIFORM REGISTRY (April entry → renewal already due)
  -- ---------------------------------------------------------------------
  insert into public.uniform_registry (uniform_id, token_number, employee_id, employee_name,
    document_type, document_number, items, site_name, team_leader_name, is_renewal,
    previous_token_id, created_at, renewal_date)
  values (1, 101, 'd0000000-0000-4000-8000-000000000001', 'Ahmed Al Mansoori', 'passport', 'P000042026',
    '{"uniform": true, "shoes": true, "helmet": true, "bottle": true, "safetyJacket": true, "mattress": true, "pillow": true}'::jsonb, 'Marina Bay Tower', 'Ahmed Al Mansoori',
    false, null,
    '2026-05-20 08:30:00+04', '2026-05-20 08:30:00+04'::timestamptz + interval '6 months');
  insert into public.uniform_registry (uniform_id, token_number, employee_id, employee_name,
    document_type, document_number, items, site_name, team_leader_name, is_renewal,
    previous_token_id, created_at, renewal_date)
  values (2, 102, 'd0000000-0000-4000-8000-000000000002', 'Ramesh Kumar', 'id', '784-1990-002',
    '{"uniform": true, "shoes": true, "helmet": true, "safetyJacket": true}'::jsonb, 'Marina Bay Tower', 'Ahmed Al Mansoori',
    false, null,
    '2026-06-02 09:10:00+04', '2026-06-02 09:10:00+04'::timestamptz + interval '6 months');
  insert into public.uniform_registry (uniform_id, token_number, employee_id, employee_name,
    document_type, document_number, items, site_name, team_leader_name, is_renewal,
    previous_token_id, created_at, renewal_date)
  values (3, 103, 'd0000000-0000-4000-8000-000000000005', 'Tika Bahadur Gurung', 'id', '784-1990-005',
    '{"uniform": true, "shoes": true, "bottle": true}'::jsonb, 'Marina Bay Tower', 'Ahmed Al Mansoori',
    false, null,
    '2026-06-15 10:00:00+04', '2026-06-15 10:00:00+04'::timestamptz + interval '6 months');
  insert into public.uniform_registry (uniform_id, token_number, employee_id, employee_name,
    document_type, document_number, items, site_name, team_leader_name, is_renewal,
    previous_token_id, created_at, renewal_date)
  values (4, 104, 'd0000000-0000-4000-8000-000000000008', 'Deepak Thapa', 'passport', 'P000082026',
    '{"uniform": true, "helmet": true, "safetyJacket": true, "mattress": true}'::jsonb, 'Desert Rose Mall', 'Mohd Rafiq',
    false, null,
    '2026-07-01 08:50:00+04', '2026-07-01 08:50:00+04'::timestamptz + interval '6 months');
  insert into public.uniform_registry (uniform_id, token_number, employee_id, employee_name,
    document_type, document_number, items, site_name, team_leader_name, is_renewal,
    previous_token_id, created_at, renewal_date)
  values (5, 105, 'd0000000-0000-4000-8000-000000000002', 'Ramesh Kumar', 'id', '784-1990-002',
    '{"uniform": true, "shoes": true}'::jsonb, 'Marina Bay Tower', 'Ahmed Al Mansoori',
    true, 102,
    '2026-10-18 11:30:00+04', '2026-10-18 11:30:00+04'::timestamptz + interval '6 months');

  -- ---------------------------------------------------------------------
  -- 11. NOTIFICATIONS (mirror what the app's RPCs would have fanned out)
  -- ---------------------------------------------------------------------
  insert into public.notification (profile_id, title, message, type, read) values ('a0000000-0000-4000-8000-000000000001', 'New Leave Request', 'Ramesh Kumar (ASM-2026-002) requested casual leave for 3 day(s)', 'request', false);
  insert into public.notification (profile_id, title, message, type, read) values ('a0000000-0000-4000-8000-000000000001', 'New Cancellation Request', 'Hassan Jaber (ASM-2026-016) is pending deletion approval — Project demobilization — end of snagging phase, visa cancellation required', 'request', false);
  insert into public.notification (profile_id, title, message, type, read) values ('a0000000-0000-4000-8000-000000000001', 'Auto-Generated Warning', 'Imran Sheikh (ASM-2026-011) was absent 3+ consecutive days', 'warning', false);
  insert into public.notification (profile_id, title, message, type, read) values ('a0000000-0000-4000-8000-000000000001', 'Fine Issued', 'Kamal Hossain (ASM-2026-004) was fined AED 200.00 — Damage to company mixer — negligent operation', 'fine', false);
  insert into public.notification (profile_id, title, message, type, read) values ('a0000000-0000-4000-8000-000000000002', 'New Leave Request', 'Ramesh Kumar (ASM-2026-002) requested casual leave for 3 day(s)', 'request', false);

  raise notice 'Seed complete: 4 sites, 3 camps, 22 employees, % attendance records, 3 demo logins.', 418;
end
$seed$;
