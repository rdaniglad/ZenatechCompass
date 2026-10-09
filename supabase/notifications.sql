-- =====================================================================================
--  Compass — activity email notifications
--  Run in Supabase → SQL Editor AFTER schema.sql. Safe to run again.
--
--  How it works
--    1. Things that happen in Compass (invites, team changes, status changes, approvals,
--       role changes, accounts turned off/on) add a row to public.notifications ("the outbox").
--    2. A daily job adds reminder rows (travel not booked 7 days out; post-event report due).
--    3. Every new row pings the "send-notifications" Edge Function, which emails it via Resend.
--       A retry job pings it every 10 minutes too, so nothing is lost if sending was down.
--  Nobody gets emailed about their own action, turned-off accounts get nothing (except the
--  "your account was turned off" notice), and people can switch activity emails off.
-- =====================================================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------- settings (not secret)
create table if not exists public.compass_settings (key text primary key, value text not null);
alter table public.compass_settings enable row level security;
drop policy if exists "admins manage settings" on public.compass_settings;
create policy "admins manage settings" on public.compass_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
insert into public.compass_settings (key, value) values
  ('site_url',      'https://rdaniglad.github.io/ZenatechCompass/'),
  ('functions_url', 'https://qjxdfqtzcrsopprcmicr.supabase.co/functions/v1/send-notifications'),
  ('travel_reminder_days', '7')
on conflict (key) do nothing;

create or replace function public.compass_setting(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select value from public.compass_settings where key = p_key
$$;

-- Shared secret between the database and the sender function, kept in Supabase Vault.
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'compass_notify_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'compass_notify_secret', 'Compass: authorises calls to the send-notifications function');
  end if;
end $$;
-- The sender function (service role) checks a caller's secret with this; nobody else can call it.
create or replace function public.compass_notify_secret_ok(p_secret text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'compass_notify_secret' and decrypted_secret = p_secret)
$$;
revoke all on function public.compass_notify_secret_ok(text) from public, anon, authenticated;
grant execute on function public.compass_notify_secret_ok(text) to service_role;

-- ---------------------------------------------------------------- per-person preference
alter table public.profiles add column if not exists email_notifications boolean not null default true;

-- ---------------------------------------------------------------- the outbox
create table if not exists public.notifications (
  id          bigint generated always as identity primary key,
  kind        text not null,
  to_user     uuid references auth.users(id) on delete set null,
  to_email    text not null,
  to_name     text,
  payload     jsonb not null default '{}'::jsonb,
  dedupe_key  text unique,
  status      text not null default 'pending' check (status in ('pending','sending','sent','failed','skipped')),
  attempts    int not null default 0,
  error       text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index if not exists notifications_pending_idx on public.notifications (status, created_at) where status in ('pending','failed');
alter table public.notifications enable row level security;
drop policy if exists "admins read email log" on public.notifications;
drop policy if exists "people read their own emails" on public.notifications;
create policy "admins read email log" on public.notifications for select to authenticated using (public.is_admin());
create policy "people read their own emails" on public.notifications for select to authenticated using (to_user = auth.uid());
grant select on public.notifications to authenticated;
revoke all on public.notifications from anon;

-- Queue one email. Skips: no address, the person who caused it, opted-out / turned-off accounts
-- (account notices ignore the opt-out so people always learn about access changes).
create or replace function public.compass_enqueue(p_kind text, p_user uuid, p_email text, p_name text, p_payload jsonb, p_dedupe text default null)
returns void language plpgsql security definer set search_path = public as $$
declare prof public.profiles;
begin
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return; end if;
  if p_user is not null and p_user = auth.uid() and p_kind not in ('account_disabled','account_enabled') then return; end if;
  if p_user is not null then
    select * into prof from public.profiles where id = p_user;
    if prof.id is not null and p_kind not in ('account_disabled','account_enabled','role_changed') then
      if prof.disabled or not prof.email_notifications then return; end if;
    end if;
  end if;
  insert into public.notifications (kind, to_user, to_email, to_name, payload, dedupe_key)
  values (p_kind, p_user, lower(p_email), p_name, coalesce(p_payload, '{}'::jsonb), p_dedupe)
  on conflict (dedupe_key) do nothing;
end $$;

-- Who is roster entry X? A Compass account if linked, otherwise the email typed on the roster.
create or replace function public.compass_person(p_pid text, out user_id uuid, out email text, out name text)
language plpgsql stable security definer set search_path = public as $$
declare r public.roster; p public.profiles;
begin
  select * into r from public.roster where id = p_pid;
  if r.id is null then return; end if;
  if r.data->>'userId' ~ '^[0-9a-f-]{36}$' then
    select * into p from public.profiles where id = (r.data->>'userId')::uuid;
  end if;
  user_id := p.id;
  email   := coalesce(p.email, nullif(trim(r.data->>'email'), ''));
  name    := coalesce(nullif(r.data->>'name', ''), p.name);
end $$;

create or replace function public.compass_actor_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select name from public.profiles where id = auth.uid()), 'A Compass Admin')
$$;

-- Event details every email about an event can use
create or replace function public.compass_event_payload(e jsonb, p_id text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('eventId', p_id, 'eventName', coalesce(e->>'name','an event'), 'start', e->>'start', 'end', e->>'end',
                            'location', coalesce(nullif(e->>'location',''), nullif(e->>'country',''), ''), 'status', e->>'status')
$$;

-- ---------------------------------------------------------------- triggers: invites
create or replace function public.compass_notify_invite() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.invited_by is null then return new; end if;     -- the owner seed invite from schema.sql
  if tg_op = 'UPDATE' and new.created_at = old.created_at then return new; end if;  -- only fresh (re)invites
  perform public.compass_enqueue('invite', null, new.email, new.name,
    jsonb_build_object('role', new.role, 'invitedBy', public.compass_actor_name(), 'expiresAt', new.expires_at,
                       'link', public.compass_setting('site_url') || 'login.html?invite=' || replace(new.email, '+', '%2B')));
  return new;
end $$;
drop trigger if exists compass_notify_invite on public.invites;
create trigger compass_notify_invite after insert or update on public.invites
  for each row execute function public.compass_notify_invite();

-- ---------------------------------------------------------------- triggers: events
create or replace function public.compass_notify_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  old_att jsonb := case when tg_op = 'UPDATE' then coalesce(old.data->'attendees','[]'::jsonb) else '[]'::jsonb end;
  new_att jsonb := coalesce(new.data->'attendees','[]'::jsonb);
  base jsonb := public.compass_event_payload(new.data, new.id) || jsonb_build_object('actor', public.compass_actor_name());
  pid text; who record; creator uuid;
begin
  -- added to / removed from the team
  for pid in select jsonb_array_elements_text(new_att) except select jsonb_array_elements_text(old_att) loop
    select * into who from public.compass_person(pid);
    perform public.compass_enqueue('assigned', who.user_id, who.email, who.name, base);
  end loop;
  if tg_op = 'UPDATE' then
    for pid in select jsonb_array_elements_text(old_att) except select jsonb_array_elements_text(new_att) loop
      select * into who from public.compass_person(pid);
      perform public.compass_enqueue('unassigned', who.user_id, who.email, who.name, base);
    end loop;
    -- status changed: tell the people still on the team
    if (old.data->>'status') is distinct from (new.data->>'status') and new.data->>'status' is not null then
      for pid in select jsonb_array_elements_text(new_att) intersect select jsonb_array_elements_text(old_att) loop
        select * into who from public.compass_person(pid);
        perform public.compass_enqueue('status', who.user_id, who.email, who.name, base || jsonb_build_object('oldStatus', old.data->>'status'));
      end loop;
    end if;
    -- budget approved: tell whoever created the event
    if coalesce((new.data->>'approved')::boolean, false) and not coalesce((old.data->>'approved')::boolean, false)
       and new.data->>'createdBy' ~ '^[0-9a-f-]{36}$' then
      creator := (new.data->>'createdBy')::uuid;
      perform public.compass_enqueue('approved', p.id, p.email, p.name, base) from public.profiles p where p.id = creator;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists compass_notify_event on public.events;
create trigger compass_notify_event after insert or update on public.events
  for each row execute function public.compass_notify_event();

-- ---------------------------------------------------------------- triggers: people
create or replace function public.compass_notify_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role then
    perform public.compass_enqueue('role_changed', new.id, new.email, new.name,
      jsonb_build_object('role', new.role, 'oldRole', old.role, 'actor', public.compass_actor_name()));
  end if;
  if new.disabled and not old.disabled then
    perform public.compass_enqueue('account_disabled', new.id, new.email, new.name, jsonb_build_object('actor', public.compass_actor_name()));
  elsif old.disabled and not new.disabled then
    perform public.compass_enqueue('account_enabled', new.id, new.email, new.name, jsonb_build_object('actor', public.compass_actor_name()));
  end if;
  return new;
end $$;
drop trigger if exists compass_notify_profile on public.profiles;
create trigger compass_notify_profile after update on public.profiles
  for each row execute function public.compass_notify_profile();

-- ---------------------------------------------------------------- daily reminders
create or replace function public.compass_day(v text) returns date language sql immutable as $$
  select case when v ~ '^\d{4}-\d{2}-\d{2}$' then v::date end
$$;

create or replace function public.compass_enqueue_reminders() returns int
language plpgsql security definer set search_path = public as $$
declare
  days int := coalesce(public.compass_setting('travel_reminder_days')::int, 7);
  ev record; pid text; who record; t jsonb; n int := 0; before int;
begin
  select count(*) into before from public.notifications;
  -- Travel not booked, for confirmed events starting within the next N days
  for ev in
    select id, data from public.events
    where public.compass_day(data->>'start') between current_date and current_date + days
      and lower(coalesce(data->>'status','')) like '%confirm%'
  loop
    for pid in select jsonb_array_elements_text(coalesce(ev.data->'attendees','[]'::jsonb)) loop
      t := coalesce(ev.data->'travel'->pid, '{}'::jsonb);
      if not (coalesce((t->>'hotelConfirmed')::boolean,false) and coalesce((t->>'flightConfirmed')::boolean,false)) then
        select * into who from public.compass_person(pid);
        perform public.compass_enqueue('travel_reminder', who.user_id, who.email, who.name,
          public.compass_event_payload(ev.data, ev.id) || jsonb_build_object(
            'hotelBooked', coalesce((t->>'hotelConfirmed')::boolean,false), 'flightBooked', coalesce((t->>'flightConfirmed')::boolean,false),
            'daysUntil', public.compass_day(ev.data->>'start') - current_date),
          'travel:' || ev.id || ':' || pid);
      end if;
    end loop;
  end loop;
  -- Post-event report: the day after an attended event ends (checks the last 3 days in case a run was missed)
  for ev in
    select id, data from public.events
    where coalesce(public.compass_day(data->>'end'), public.compass_day(data->>'start')) between current_date - 3 and current_date - 1
      and (lower(coalesce(data->>'status','')) like '%confirm%' or lower(coalesce(data->>'status','')) = 'completed')
  loop
    for pid in select jsonb_array_elements_text(coalesce(ev.data->'attendees','[]'::jsonb)) loop
      select * into who from public.compass_person(pid);
      if who.user_id is not null and not exists (
           select 1 from public.feedback f where f.data->>'eventId' = ev.id and f.data->>'authorId' = who.user_id::text) then
        perform public.compass_enqueue('report_reminder', who.user_id, who.email, who.name,
          public.compass_event_payload(ev.data, ev.id), 'report:' || ev.id || ':' || pid);
      end if;
    end loop;
  end loop;
  select count(*) - before into n from public.notifications;
  return n;
end $$;

-- ---------------------------------------------------------------- hand-off to the sender
create or replace function public.compass_kick_sender() returns void
language plpgsql security definer set search_path = public as $$
declare secret text; url text := public.compass_setting('functions_url');
begin
  if url is null then return; end if;
  if not exists (select 1 from public.notifications where status in ('pending','failed') and attempts < 5) then return; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'compass_notify_secret';
  perform net.http_post(url := url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-compass-secret', secret),
    timeout_milliseconds := 20000);
end $$;

create or replace function public.compass_after_enqueue() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform public.compass_kick_sender(); return null; end $$;
drop trigger if exists compass_after_enqueue on public.notifications;
create trigger compass_after_enqueue after insert on public.notifications
  for each statement execute function public.compass_after_enqueue();

-- Schedules (UTC). 13:00 UTC = 9:00 Toronto (EDT).
select cron.schedule('compass-daily-reminders', '0 13 * * *', $$select public.compass_enqueue_reminders()$$);
select cron.schedule('compass-send-retry', '*/10 * * * *', $$select public.compass_kick_sender()$$);

-- ---------------------------------------------------------------- self-check
select item, case when ok then 'ok' else 'MISSING' end as status from (values
  ('outbox table',        exists (select 1 from information_schema.tables where table_schema='public' and table_name='notifications')),
  ('vault secret',        exists (select 1 from vault.secrets where name='compass_notify_secret')),
  ('triggers',            (select count(*) = 4 from pg_trigger where tgname in ('compass_notify_invite','compass_notify_event','compass_notify_profile','compass_after_enqueue'))),
  ('daily reminders job', exists (select 1 from cron.job where jobname='compass-daily-reminders')),
  ('retry job',           exists (select 1 from cron.job where jobname='compass-send-retry')),
  ('email preference',    exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='email_notifications'))
) as checks(item, ok);
