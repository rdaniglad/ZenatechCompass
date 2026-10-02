-- =====================================================================================
--  Compass — Supabase setup
--  Run this whole file once in your Supabase project: Dashboard → SQL Editor → New query
--  → paste → Run. It is safe to run again (it updates things in place).
--
--  BEFORE RUNNING: change the owner email on the line marked  >>> OWNER EMAIL <<<  below
--  if it isn't yours. That person is invited as the first Admin and becomes the owner.
--
--  What this creates
--    profiles        one row per person (name, role, owner flag, turned-off flag)
--    invites         who may create an account, and with which role (Compass is invite-only)
--    events, roster, collateral_library, feedback, activity_log
--                    the app's data, stored as JSON documents (id + data)
--    photos bucket   feedback photos
--  and the security rules (Row Level Security) that decide who can read and change what.
-- =====================================================================================

-- ---------------------------------------------------------------- people
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  name        text,
  role        text not null default 'attendee' check (role in ('attendee','manager','admin')),
  is_owner    boolean not null default false,
  disabled    boolean not null default false,
  joined_at   timestamptz not null default now(),
  last_seen   timestamptz
);

create table if not exists public.invites (
  email       text primary key check (email = lower(email)),
  name        text,
  role        text not null default 'attendee' check (role in ('attendee','manager','admin')),
  invited_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days'
);

-- ---------------------------------------------------------------- app data (JSON documents)
create table if not exists public.events             (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.roster             (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.collateral_library (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.feedback           (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.activity_log       (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());

create index if not exists roster_user_idx    on public.roster ((data->>'userId'));
create index if not exists feedback_author_idx on public.feedback ((data->>'authorId'));
create index if not exists activity_ts_idx    on public.activity_log (((data->>'ts')::bigint));

-- ---------------------------------------------------------------- role helpers
-- SECURITY DEFINER so they can read profiles without tripping profiles' own rules.
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select case when p.disabled then null else p.role end from public.profiles p where p.id = auth.uid()
$$;
create or replace function public.is_active()  returns boolean language sql stable security definer set search_path = public as $$ select public.my_role() is not null $$;
create or replace function public.is_manager() returns boolean language sql stable security definer set search_path = public as $$ select coalesce(public.my_role() in ('admin','manager'), false) $$;
create or replace function public.is_admin()   returns boolean language sql stable security definer set search_path = public as $$ select coalesce(public.my_role() = 'admin', false) $$;
grant execute on function public.my_role(), public.is_active(), public.is_manager(), public.is_admin() to authenticated;

-- ---------------------------------------------------------------- invite-only sign-up
-- Lets the sign-in page give a clear message before trying to create an account.
create or replace function public.invite_status(p_email text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.profiles where email = lower(trim(p_email))) then 'has_account'
    when exists (select 1 from public.invites where email = lower(trim(p_email)) and expires_at > now()) then 'invited'
    when exists (select 1 from public.invites where email = lower(trim(p_email))) then 'expired'
    else 'none' end
$$;
grant execute on function public.invite_status(text) to anon, authenticated;

-- Runs when Supabase Auth creates a user. No valid invite → the sign-up is refused.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  inv public.invites;
  first_user boolean;
begin
  select * into inv from public.invites where email = lower(new.email);
  if inv.email is null or inv.expires_at < now() then
    raise exception 'Compass is invite-only. Ask a Compass Admin to invite %.', new.email;
  end if;
  first_user := not exists (select 1 from public.profiles);
  insert into public.profiles (id, email, name, role, is_owner)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), inv.name, split_part(new.email, '@', 1)),
    case when first_user then 'admin' else inv.role end,
    first_user
  );
  delete from public.invites where email = lower(new.email);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only Admins may change roles / turn accounts off; nobody changes the owner flag or email here.
create or replace function public.guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;          -- dashboard / service role
  new.is_owner := old.is_owner;
  new.email := old.email;
  if not public.is_admin() then
    if new.role is distinct from old.role then raise exception 'Only Admins can change roles.'; end if;
    if new.disabled is distinct from old.disabled then raise exception 'Only Admins can turn accounts on or off.'; end if;
  end if;
  if old.is_owner and (new.role <> 'admin' or new.disabled) then
    raise exception 'The owner is always an Admin and can''t be turned off.';
  end if;
  if new.id = auth.uid() and new.disabled and not old.disabled then
    raise exception 'You can''t turn off your own account.';
  end if;
  return new;
end $$;
drop trigger if exists guard_profile on public.profiles;
create trigger guard_profile before update on public.profiles
  for each row execute function public.guard_profile();

-- ---------------------------------------------------------------- attendee limits on events
-- Admins and Managers can change anything on an event. Attendees can only add/remove
-- THEMSELVES from the team (within the attendee limit) and update THEIR OWN travel entry.
create or replace function public.guard_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  pid text;
  x text;
  old_att jsonb := coalesce(old.data->'attendees', '[]'::jsonb);
  new_att jsonb := coalesce(new.data->'attendees', '[]'::jsonb);
begin
  new.updated_at := now();
  if auth.uid() is null or public.is_manager() then return new; end if;
  select r.id into pid from public.roster r where r.data->>'userId' = auth.uid()::text limit 1;
  if pid is null then raise exception 'You can only add or remove yourself and update your own travel.'; end if;
  if (old.data - 'attendees' - 'travel') is distinct from (new.data - 'attendees' - 'travel') then
    raise exception 'You can only add or remove yourself and update your own travel.';
  end if;
  for x in
    select v from (select jsonb_array_elements_text(old_att) as v except select jsonb_array_elements_text(new_att)) removed
    union
    select v from (select jsonb_array_elements_text(new_att) as v except select jsonb_array_elements_text(old_att)) added
  loop
    if x <> pid then raise exception 'You can only add or remove yourself from an event team.'; end if;
  end loop;
  if (new_att ? pid) and not (old_att ? pid)
     and jsonb_array_length(new_att) > coalesce((new.data->>'maxAttendees')::int, 6) then
    raise exception 'This event is at its attendee limit.';
  end if;
  if (coalesce(old.data->'travel', '{}'::jsonb) - pid) is distinct from (coalesce(new.data->'travel', '{}'::jsonb) - pid) then
    raise exception 'You can only update your own travel.';
  end if;
  return new;
end $$;
drop trigger if exists guard_event on public.events;
create trigger guard_event before update on public.events
  for each row execute function public.guard_event();

-- Keep updated_at fresh on the other document tables
create or replace function public.touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists touch on public.roster;             create trigger touch before update on public.roster             for each row execute function public.touch();
drop trigger if exists touch on public.collateral_library; create trigger touch before update on public.collateral_library for each row execute function public.touch();
drop trigger if exists touch on public.feedback;           create trigger touch before update on public.feedback           for each row execute function public.touch();

-- Activity log keeps the newest 1,000 entries
create or replace function public.trim_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.activity_log where id in (
    select id from public.activity_log order by coalesce((data->>'ts')::bigint, 0) desc offset 1000
  );
  return null;
end $$;
drop trigger if exists trim_activity on public.activity_log;
create trigger trim_activity after insert on public.activity_log
  for each statement execute function public.trim_activity();

-- ---------------------------------------------------------------- atomic partial updates
-- The app's "update these fields" call. Merges top-level fields in one statement, so two people
-- saving different fields of the same event at the same moment don't overwrite each other.
-- SECURITY INVOKER: all the row-level rules and guards above still apply.
create or replace function public.compass_merge(p_table text, p_id text, p_patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  if p_table not in ('events','roster','collateral_library','feedback','activity_log') then
    raise exception 'Unknown collection %', p_table;
  end if;
  execute format('update public.%I set data = data || $1 where id = $2', p_table) using p_patch, p_id;
  get diagnostics n = row_count;
  if n = 0 then
    execute format('insert into public.%I (id, data) values ($2, $1)', p_table) using p_patch, p_id;
  end if;
end $$;
grant execute on function public.compass_merge(text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------- row level security
alter table public.profiles           enable row level security;
alter table public.invites            enable row level security;
alter table public.events             enable row level security;
alter table public.roster             enable row level security;
alter table public.collateral_library enable row level security;
alter table public.feedback           enable row level security;
alter table public.activity_log       enable row level security;

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
           and tablename in ('profiles','invites','events','roster','collateral_library','feedback','activity_log')
  loop execute format('drop policy %I on public.%I', r.policyname, r.tablename); end loop;
end $$;

-- profiles: everyone on the team sees names and roles; you edit yourself, Admins edit anyone
create policy "team can read profiles" on public.profiles for select to authenticated using (public.is_active() or id = auth.uid());
create policy "self or admin can update" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

-- invites: Admins only
create policy "admins manage invites" on public.invites for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- events
create policy "team reads events"      on public.events for select to authenticated using (public.is_active());
create policy "managers create events" on public.events for insert to authenticated with check (public.is_manager());
create policy "team updates events"    on public.events for update to authenticated using (public.is_active()) with check (public.is_active());
create policy "admins delete events"   on public.events for delete to authenticated using (public.is_admin());

-- roster: Admins manage it; each person can create/update their own link
create policy "team reads roster"   on public.roster for select to authenticated using (public.is_active());
create policy "admin or own link (insert)" on public.roster for insert to authenticated
  with check (public.is_admin() or (public.is_active() and data->>'userId' = auth.uid()::text));
create policy "admin or own link (update)" on public.roster for update to authenticated
  using (public.is_admin() or data->>'userId' = auth.uid()::text)
  with check (public.is_admin() or (public.is_active() and data->>'userId' = auth.uid()::text));
create policy "admins delete roster" on public.roster for delete to authenticated using (public.is_admin());

-- collateral library: Admins and Managers
create policy "team reads library"     on public.collateral_library for select to authenticated using (public.is_active());
create policy "managers write library" on public.collateral_library for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- feedback: Admins/Managers see all; everyone else only their own reports
create policy "read own or all (managers)" on public.feedback for select to authenticated
  using (public.is_manager() or (public.is_active() and data->>'authorId' = auth.uid()::text));
create policy "write own or any (managers)" on public.feedback for insert to authenticated
  with check (public.is_manager() or (public.is_active() and data->>'authorId' = auth.uid()::text));
create policy "update own or any (managers)" on public.feedback for update to authenticated
  using (public.is_manager() or data->>'authorId' = auth.uid()::text)
  with check (public.is_manager() or (public.is_active() and data->>'authorId' = auth.uid()::text));
create policy "delete own or any (managers)" on public.feedback for delete to authenticated
  using (public.is_manager() or (public.is_active() and data->>'authorId' = auth.uid()::text));

-- activity log: everyone reads; you can only add entries as yourself; Admins can delete
create policy "team reads log"     on public.activity_log for select to authenticated using (public.is_active());
create policy "log as yourself"    on public.activity_log for insert to authenticated
  with check (public.is_active() and data->>'actorId' = auth.uid()::text);
create policy "admins delete log"  on public.activity_log for delete to authenticated using (public.is_admin());

-- Signed-in people can use the tables (the policies above decide which rows); nothing without signing in
grant select, insert, update, delete on public.profiles, public.invites, public.events, public.roster,
      public.collateral_library, public.feedback, public.activity_log to authenticated;
revoke all on public.profiles, public.invites, public.events, public.roster,
              public.collateral_library, public.feedback, public.activity_log from anon;

-- ---------------------------------------------------------------- photos (Storage)
-- Public bucket with unguessable file names, so photos work as normal <img> links.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 15728640, array['image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "compass: team uploads photos" on storage.objects;
drop policy if exists "compass: managers delete photos" on storage.objects;
create policy "compass: team uploads photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_active());
create policy "compass: managers delete photos" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_manager());

-- ---------------------------------------------------------------- live updates
do $$ declare t text; begin
  foreach t in array array['events','roster','collateral_library','feedback','activity_log','profiles'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- first owner
-- >>> OWNER EMAIL <<<  The first person to create an account becomes the owner (always Admin).
insert into public.invites (email, name, role, expires_at)
select 'daniela@zenatech.com', 'Daniela', 'admin', now() + interval '30 days'
where not exists (select 1 from public.profiles where email = 'daniela@zenatech.com')
on conflict (email) do update set role = 'admin', expires_at = now() + interval '30 days';

-- ---------------------------------------------------------------- self-check
-- The result grid should show every line as "ok".
select item, case when ok then 'ok' else 'MISSING' end as status from (values
  ('tables',            (select count(*) = 7 from information_schema.tables where table_schema='public' and table_name in ('profiles','invites','events','roster','collateral_library','feedback','activity_log'))),
  ('row level security',(select bool_and(relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relname in ('profiles','invites','events','roster','collateral_library','feedback','activity_log'))),
  ('sign-up trigger',   exists (select 1 from pg_trigger where tgname = 'on_auth_user_created')),
  ('photos bucket',     exists (select 1 from storage.buckets where id = 'photos')),
  ('live updates',      (select count(*) = 6 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('events','roster','collateral_library','feedback','activity_log','profiles'))),
  ('owner invite',      exists (select 1 from public.invites where role = 'admin') or exists (select 1 from public.profiles where is_owner))
) as checks(item, ok);
