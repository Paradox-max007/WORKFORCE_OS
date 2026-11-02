-- Seed: a super admin session user + a plain admin (no menu permissions).
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';

insert into auth.users (id, email, name, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000aa', 'root@pulse.test', 'Root Superadmin',
   jsonb_build_object('name', 'Root Superadmin')),
  ('00000000-0000-0000-0000-0000000000bb', 'plain@pulse.test', 'Plain Admin',
   jsonb_build_object('name', 'Plain Admin'))
on conflict (id) do nothing;

-- handle_new_user made the FIRST user super_admin and the second 'pending'
-- → promote the second to a plain admin (no menu_permission rows anywhere)
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000bb';

select role, email from public.profiles order by email;
