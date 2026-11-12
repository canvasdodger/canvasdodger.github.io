-- NEON PROTOCOL / Canvas Dodger — migration: pilot presence (who's online)
-- Run AFTER supabase/migrations/coin_topups.sql. Dashboard → SQL Editor → New query → Run.

create table if not exists public.pilot_presence (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  callsign  text not null default '',
  status    text not null default 'menu' check (status in ('menu','in-game','racing')),
  last_seen bigint not null default (extract(epoch from now()) * 1000)::bigint,
  mode      text not null default ''
);

alter table public.pilot_presence enable row level security;

-- everyone can see who's online
drop policy if exists "pp_read_all" on public.pilot_presence;
create policy "pp_read_all" on public.pilot_presence for select using (true);

-- players can upsert their own presence row
drop policy if exists "pp_upsert_own" on public.pilot_presence;
create policy "pp_upsert_own" on public.pilot_presence for insert
  with check (auth.uid() = user_id);
drop policy if exists "pp_update_own" on public.pilot_presence;
create policy "pp_update_own" on public.pilot_presence for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- index for freshness queries
create index if not exists pilot_presence_last_seen on public.pilot_presence (last_seen desc);

-- helper: mark presence stale for pilots not seen in last 60 seconds
-- (call periodically or on page load to clean up)
create or replace function public.touch_presence(p_callsign text, p_status text, p_mode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.pilot_presence (user_id, callsign, status, last_seen, mode)
  values (auth.uid(), p_callsign, p_status, (extract(epoch from now()) * 1000)::bigint, p_mode)
  on conflict (user_id) do update
    set callsign = excluded.callsign,
        status = excluded.status,
        last_seen = (extract(epoch from now()) * 1000)::bigint,
        mode = excluded.mode;
end $$;

grant execute on function public.touch_presence(text, text, text) to authenticated;