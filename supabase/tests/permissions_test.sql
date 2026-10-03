-- Compass permission tests. Paste into the Supabase SQL Editor and Run.
-- Creates throwaway test users and data, tries allowed and forbidden actions as each role,
-- then UNDOES EVERYTHING (the block ends by raising an error on purpose so nothing is kept).
-- Read the result in the error message: every line should end in "PASS".
do $$
declare
  owner_id uuid := '00000000-0000-4000-8000-0000000000a1';
  mgr_id   uuid := '00000000-0000-4000-8000-0000000000a2';
  att_id   uuid := '00000000-0000-4000-8000-0000000000a3';
  res text := '';
  n int;
  ok boolean;
  procedure_dummy int;
begin
  -- invites for the test users (owner email is already invited by schema.sql)
  insert into public.invites(email, role) values ('t-mgr@compass.test','manager'), ('t-att@compass.test','attendee')
    on conflict (email) do update set role = excluded.role, expires_at = now() + interval '7 days';
  -- make sure the owner invite exists for this test even if the real owner already signed up
  if not exists (select 1 from public.profiles where is_owner) then
    insert into public.invites(email, role) values ('daniela@zenatech.com','admin') on conflict (email) do nothing;
  end if;

  -- 1. sign-up without an invite is refused
  begin
    insert into auth.users(id, instance_id, aud, role, email, raw_user_meta_data) values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated','authenticated','stranger@compass.test','{}');
    res := res || E'\n1 uninvited sign-up refused: FAIL';
  exception when others then res := res || E'\n1 uninvited sign-up refused: PASS'; end;

  -- invited sign-ups
  if not exists (select 1 from public.profiles where is_owner) then
    insert into auth.users(id, instance_id, aud, role, email, raw_user_meta_data) values (owner_id, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','daniela@zenatech.com','{"name":"Test Owner"}');
  else
    select id into owner_id from public.profiles where is_owner limit 1;
  end if;
  insert into auth.users(id, instance_id, aud, role, email, raw_user_meta_data) values (mgr_id, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-mgr@compass.test','{"name":"Test Manager"}');
  insert into auth.users(id, instance_id, aud, role, email, raw_user_meta_data) values (att_id, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-att@compass.test','{"name":"Test Attendee"}');
  select (select role from public.profiles where id = owner_id) = 'admin' and (select is_owner from public.profiles where id = owner_id)
     and (select role from public.profiles where id = mgr_id) = 'manager' and (select role from public.profiles where id = att_id) = 'attendee'
    into ok;
  res := res || E'\n2 invited sign-ups get the invited role, first is owner: ' || case when ok then 'PASS' else 'FAIL' end;
  res := res || E'\n3 used invites removed: ' || case when not exists (select 1 from public.invites where email in ('t-mgr@compass.test','t-att@compass.test')) then 'PASS' else 'FAIL' end;

  -- seed data as the owner
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into public.roster(id, data) values ('t_p_other', '{"name":"Other Person"}');
  execute 'reset role';

  -- ---------------- as the MANAGER ----------------
  perform set_config('request.jwt.claims', json_build_object('sub', mgr_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin insert into public.events(id, data) values ('t_e1', '{"name":"Test Expo","attendees":["t_p_other"],"maxAttendees":2,"travel":{"t_p_other":{"hotelConfirmed":false}}}');
        res := res || E'\n4 manager creates an event: PASS';
  exception when others then res := res || E'\n4 manager creates an event: FAIL ' || sqlerrm; end;
  begin insert into public.feedback(id, data) values ('t_f_mgr', json_build_object('authorId', mgr_id, 'summary', 'manager report')::jsonb);
  exception when others then null; end;
  begin update public.profiles set role = 'admin' where id = mgr_id; res := res || E'\n5 manager can''t promote self: FAIL';
  exception when others then res := res || E'\n5 manager can''t promote self: PASS'; end;
  execute 'reset role';

  -- ---------------- as the ATTENDEE ----------------
  perform set_config('request.jwt.claims', json_build_object('sub', att_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin update public.profiles set role = 'admin' where id = att_id; res := res || E'\n6 attendee can''t promote self: FAIL';
  exception when others then res := res || E'\n6 attendee can''t promote self: PASS'; end;
  begin insert into public.events(id, data) values ('t_e2', '{"name":"x"}'); res := res || E'\n7 attendee can''t create events: FAIL';
  exception when others then res := res || E'\n7 attendee can''t create events: PASS'; end;
  begin insert into public.roster(id, data) values ('t_p_att', json_build_object('name','Test Attendee','userId', att_id)::jsonb); res := res || E'\n8 attendee creates own roster link: PASS';
  exception when others then res := res || E'\n8 attendee creates own roster link: FAIL ' || sqlerrm; end;
  begin insert into public.roster(id, data) values ('t_p_fake', '{"name":"Fake"}'); res := res || E'\n9 attendee can''t add others to roster: FAIL';
  exception when others then res := res || E'\n9 attendee can''t add others to roster: PASS'; end;
  begin perform public.compass_merge('events','t_e1','{"attendees":["t_p_other","t_p_att"]}'::jsonb); res := res || E'\n10 attendee joins event team: PASS';
  exception when others then res := res || E'\n10 attendee joins event team: FAIL ' || sqlerrm; end;
  begin perform public.compass_merge('events','t_e1','{"name":"Hacked"}'::jsonb); res := res || E'\n11 attendee can''t rename event: FAIL';
  exception when others then res := res || E'\n11 attendee can''t rename event: PASS'; end;
  begin perform public.compass_merge('events','t_e1','{"attendees":["t_p_att"]}'::jsonb); res := res || E'\n12 attendee can''t remove others: FAIL';
  exception when others then res := res || E'\n12 attendee can''t remove others: PASS'; end;
  begin perform public.compass_merge('events','t_e1','{"travel":{"t_p_other":{"hotelConfirmed":false},"t_p_att":{"hotelConfirmed":true}}}'::jsonb); res := res || E'\n13 attendee updates own travel: PASS';
  exception when others then res := res || E'\n13 attendee updates own travel: FAIL ' || sqlerrm; end;
  begin perform public.compass_merge('events','t_e1','{"travel":{"t_p_other":{"hotelConfirmed":true},"t_p_att":{"hotelConfirmed":true}}}'::jsonb); res := res || E'\n14 attendee can''t edit others'' travel: FAIL';
  exception when others then res := res || E'\n14 attendee can''t edit others'' travel: PASS'; end;
  begin insert into public.feedback(id, data) values ('t_f_att', json_build_object('authorId', att_id, 'summary', 'mine')::jsonb); res := res || E'\n15 attendee writes own report: PASS';
  exception when others then res := res || E'\n15 attendee writes own report: FAIL ' || sqlerrm; end;
  begin insert into public.feedback(id, data) values ('t_f_fake', json_build_object('authorId', mgr_id)::jsonb); res := res || E'\n16 attendee can''t write as someone else: FAIL';
  exception when others then res := res || E'\n16 attendee can''t write as someone else: PASS'; end;
  select count(*) into n from public.feedback where id like 't_f_%';
  res := res || E'\n17 attendee sees only own reports: ' || case when n = 1 then 'PASS' else 'FAIL (' || n || ' visible)' end;
  select count(*) into n from public.invites;
  res := res || E'\n18 attendee can''t see invites: ' || case when n = 0 then 'PASS' else 'FAIL' end;
  begin insert into public.activity_log(id, data) values ('t_l1', json_build_object('actorId', mgr_id, 'ts', 1)::jsonb); res := res || E'\n19 attendee can''t log as someone else: FAIL';
  exception when others then res := res || E'\n19 attendee can''t log as someone else: PASS'; end;
  delete from public.events where id = 't_e1'; get diagnostics n = row_count;
  res := res || E'\n20 attendee can''t delete events: ' || case when n = 0 then 'PASS' else 'FAIL' end;
  execute 'reset role';

  -- ---------------- as the OWNER (admin) ----------------
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin update public.profiles set disabled = true where id = owner_id; res := res || E'\n21 owner can''t turn self off: FAIL';
  exception when others then res := res || E'\n21 owner can''t turn self off: PASS'; end;
  begin update public.profiles set disabled = true where id = att_id; res := res || E'\n22 admin turns attendee off: PASS';
  exception when others then res := res || E'\n22 admin turns attendee off: FAIL ' || sqlerrm; end;
  select count(*) into n from public.feedback where id like 't_f_%';
  res := res || E'\n23 admin sees all reports: ' || case when n = 2 then 'PASS' else 'FAIL (' || n || ')' end;
  execute 'reset role';

  -- turned-off attendee sees nothing
  perform set_config('request.jwt.claims', json_build_object('sub', att_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.events;
  res := res || E'\n24 turned-off account sees no data: ' || case when n = 0 then 'PASS' else 'FAIL' end;
  execute 'reset role';

  raise exception 'COMPASS TEST RESULTS (nothing was saved):%', res;
end $$;
