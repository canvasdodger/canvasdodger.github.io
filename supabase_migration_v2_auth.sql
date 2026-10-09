-- NEON PROTOCOL / Canvas Dodger — migration v2: accounts + roles + locked board
-- Run AFTER supabase_schema.sql:  Dashboard → SQL Editor → New query → Run
-- Then sign up "Kiphnic" in the game and run the bootstrap line at the bottom.

-- ---------------- profiles ----------------
create table if not exists public.profiles (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  callsign  text not null check (char_length(callsign) between 3 and 14),
  email     text not null default '',
  role      text not null default 'player' check (role in ('player','superior')),
  created_at bigint not null default 0
);
alter table public.profiles enable row level security;
-- callsign uniqueness is case-insensitive
alter table public.profiles drop constraint if exists profiles_callsign_key;
create unique index if not exists profiles_callsign_ci on public.profiles (lower(callsign));

-- helper: server-side role check (security definer = no RLS recursion)
create or replace function public.is_superior()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where user_id = auth.uid() and role = 'superior');
$$;

-- auto-profile on signup; callsign taken from raw_user_meta_data
create or replace function public.handle_new_profile()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cs text;
begin
  cs := left(regexp_replace(coalesce(new.raw_user_meta_data->>'callsign', split_part(new.email,'@',1)),
            '[^A-Za-z0-9 _-]', '', 'g'), 14);
  if char_length(cs) < 3 then cs := left('PILOT' || coalesce(split_part(new.id::text,'-',1), ''), 14); end if;
  insert into public.profiles (user_id, callsign, email, created_at)
  values (new.id, cs, coalesce(new.email,''), (extract(epoch from now()) * 1000)::bigint)
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_profile();

-- profiles RLS: read own (superior reads all), only superior updates (players can never self-promote)
drop policy if exists "prof_read" on public.profiles;
create policy "prof_read" on public.profiles for select using (auth.uid() = user_id or public.is_superior());
drop policy if exists "prof_update" on public.profiles;
create policy "prof_update" on public.profiles for update
  using (public.is_superior()) with check (public.is_superior() and role in ('player','superior'));
-- no insert/delete policies for clients: rows come from the trigger only

-- ---------------- runs: sign-in writes, superior edits ----------------
alter table public.runs add column if not exists owner uuid;
create index if not exists runs_owner on public.runs (owner);

-- stamp owner + force name = caller's callsign (nobody can spoof board names)
create or replace function public.stamp_run()
returns trigger language plpgsql security definer set search_path = public as $$
declare cs text;
begin
  new.owner := auth.uid();
  select callsign into cs from public.profiles where user_id = auth.uid();
  if cs is not null then new.name := cs; end if;
  return new;
end $$;
drop trigger if exists runs_stamp on public.runs;
create trigger runs_stamp before insert on public.runs
  for each row execute function public.stamp_run();

-- drop the v1 open-insert policy: anon can no longer write the board
drop policy if exists "runs_insert" on public.runs;
create policy "runs_insert" on public.runs for insert to authenticated
  with check (auth.uid() is not null and (owner is null or owner = auth.uid()));
drop policy if exists "runs_update" on public.runs;
create policy "runs_update" on public.runs for update
  using (public.is_superior()) with check (public.is_superior());
drop policy if exists "runs_delete" on public.runs;
create policy "runs_delete" on public.runs for delete using (public.is_superior());
-- select stays public (v1 "runs_read")

-- ---------------- passports: own callsign only, superior any ----------------
drop policy if exists "pass_insert" on public.passports;
create policy "pass_insert" on public.passports for insert to authenticated
  with check (public.is_superior()
              or callsign = (select callsign from public.profiles where user_id = auth.uid()));
drop policy if exists "pass_update" on public.passports;
create policy "pass_update" on public.passports for update to authenticated
  using (public.is_superior()
         or callsign = (select callsign from public.profiles where user_id = auth.uid()))
  with check (public.is_superior()
              or callsign = (select callsign from public.profiles where user_id = auth.uid()));
drop policy if exists "pass_delete" on public.passports;
create policy "pass_delete" on public.passports for delete using (public.is_superior());
-- select stays public (v1 "pass_read")

-- ---------------- bootstrap (run this AFTER signing up Kiphnic in the game) ----------------
-- update public.profiles set role = 'superior', email = 'kwoffiekiphnic7@gmail.com' where callsign = 'Kiphnic';
