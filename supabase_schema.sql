-- NEON PROTOCOL / Canvas Dodger — cloud schema (Supabase)
-- Run ONCE: Dashboard → your project → SQL Editor → New query → paste → Run
-- anon-safe: RLS on, reads open, inserts open, NO deletes/updates on runs.

create table if not exists public.runs (
  id    bigint generated always as identity primary key,
  mode  text not null check (mode in ('endless','classic','multiplayer','null','daily')),
  name  text not null check (char_length(name) between 1 and 24),
  title text not null default '' check (char_length(title) <= 24),
  score integer not null default 0 check (score >= 0 and score <= 100000000),
  time  double precision not null default 0 check (time >= 0 and time <= 86400),
  rank  text not null default '' check (char_length(rank) <= 4),
  won   boolean not null default false,
  date  text not null default '' check (date = '' or date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  at    bigint not null default 0 check (at >= 0)
);

create index if not exists runs_board on public.runs (mode, score desc, at);

alter table public.runs enable row level security;
drop policy if exists "runs_read" on public.runs;
create policy "runs_read" on public.runs for select using (true);
drop policy if exists "runs_insert" on public.runs;
create policy "runs_insert" on public.runs for insert with check (true);
-- no update, no delete policy => leaderboard rows are immutable once posted

create table if not exists public.passports (
  callsign   text primary key check (char_length(callsign) between 1 and 24),
  payload    jsonb not null,
  updated_at bigint not null default 0
);

alter table public.passports enable row level security;
drop policy if exists "pass_read" on public.passports;
create policy "pass_read" on public.passports for select using (true);
drop policy if exists "pass_insert" on public.passports;
create policy "pass_insert" on public.passports for insert with check (true);
drop policy if exists "pass_update" on public.passports;
create policy "pass_update" on public.passports for update using (true) with check (true);
