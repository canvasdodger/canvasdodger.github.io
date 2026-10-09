-- NEON PROTOCOL / Canvas Dodger — migration v3: online rooms (ghost race)
-- Run AFTER v2.  Dashboard → SQL Editor → New query → paste → Run.
-- Transport = polled REST (no SDK, no Realtime toggle): each player owns a
-- column namespace (host_* vs guest_*) and reads the opponent's at ~10Hz.
-- Deterministic ghost race: both clients share `seed`, simulate identical storms
-- locally (makeRng), and only exchange x / alive / seen.

create table if not exists public.rooms (
  code        text primary key,
  seed        integer not null,
  status      text not null default 'waiting' check (status in ('waiting','racing','done')),
  host_id     uuid not null references auth.users(id) on delete cascade,
  guest_id    uuid,
  host_cs     text not null default '',
  guest_cs    text not null default '',
  host_x      real not null default 200,
  host_alive  boolean not null default true,
  host_seen   bigint not null default 0,
  host_elapsed real not null default 0,
  guest_x     real not null default 700,
  guest_alive boolean not null default true,
  guest_seen  bigint not null default 0,
  guest_elapsed real not null default 1,
  winner      text,                          -- callsign of winner, set when status='done'
  created_at  bigint not null default (extract(epoch from now()) * 1000)::bigint
);
alter table public.rooms enable row level security;

-- membership helper: am I host or guest of this room? (definer = no recursion)
create or replace function public.room_member(code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.rooms r
    where r.code = code and auth.uid() in (r.host_id, r.guest_id)
  );
$$;

-- read: only members may see a room (code is a shared secret)
drop policy if exists "rooms_read" on public.rooms;
create policy "rooms_read" on public.rooms for select
  using (auth.uid() = host_id or auth.uid() = guest_id);

-- insert: authenticated players create rooms as host
drop policy if exists "rooms_insert" on public.rooms;
create policy "rooms_insert" on public.rooms for insert to authenticated
  with check (auth.uid() = host_id);

-- update: members only; each side may only write its OWN columns (enforced by
-- host-checking via the trigger below, which stamps owner fields server-side).
drop policy if exists "rooms_update" on public.rooms;
create policy "rooms_update" on public.rooms for update to authenticated
  using (auth.uid() = host_id or auth.uid() = guest_id)
  with check (auth.uid() = host_id or auth.uid() = guest_id);

-- delete: members can close/abandon a room; superiors can wipe any
drop policy if exists "rooms_delete" on public.rooms;
create policy "rooms_delete" on public.rooms for delete
  using (auth.uid() = host_id or auth.uid() = guest_id or public.is_superior());

-- server-side guard: a client can only mutate the columns it owns. The guest
-- claims the slot once (fills guest_id + guest_cs); after that neither side can
-- overwrite the other's identity or fields.
create or replace function public.room_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare cs text;
begin
  select callsign into cs from public.profiles where user_id = auth.uid();

  if auth.uid() = old.host_id then
    -- host may not edit guest_* identity
    if new.guest_id <> old.guest_id or new.guest_cs <> old.guest_cs then
      new.guest_id := old.guest_id; new.guest_cs := old.guest_cs;
    end if;
    if old.host_cs = '' and cs is not null then new.host_cs := cs; end if;

  elsif auth.uid() = old.guest_id or (old.guest_id is null and auth.uid() <> old.host_id) then
    -- guest claims its slot exactly once, then only owns guest_* progress
    if old.guest_id is null then
      new.guest_id := auth.uid();
      if cs is not null then new.guest_cs := cs; end if;
    end if;
    -- guest may not edit host identity
    if new.host_id <> old.host_id or new.host_cs <> old.host_cs then
      new.host_id := old.host_id; new.host_cs := old.host_cs;
    end if;
    if new.seed <> old.seed then new.seed := old.seed; end if;  -- seed is host's
  else
    raise exception 'not a room member';
  end if;

  return new;
end $$;
drop trigger if exists rooms_guard on public.rooms;
create trigger rooms_guard before update on public.rooms
  for each row execute function public.room_guard();

-- 6-char room codes come from the client (uppercase A–Z0–9, no look-alikes);
-- keep them tidy here too.
alter table public.rooms drop constraint if exists rooms_code_fmt;
alter table public.rooms add constraint rooms_code_fmt
  check (code ~ '^[A-HJ-NP-Z2-9]{6}$');

-- ---- RPCs (SECURITY DEFINER: bypass RLS for the two pre-membership acts) ----
-- create_room: insert as host (definer stamps host identity server-side).
create or replace function public.create_room(p_code text, p_seed integer)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare cs text; row public.rooms;
begin
  select callsign into cs from public.profiles where user_id = auth.uid();
  insert into public.rooms (code, seed, host_id, host_cs, host_seen)
  values (p_code, p_seed, auth.uid(), coalesce(cs, ''), (extract(epoch from now()) * 1000)::bigint)
  on conflict (code) do nothing
  returning * into row;
  return row;
end $$;

-- join_room: claim the guest slot once. Guest isn't a member yet, so RLS would
-- block a normal UPDATE; the definer function performs the claim and hands back
-- the full row (seed + host_cs) so the guest can start the shared race.
create or replace function public.join_room(p_code text)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare cs text; row public.rooms;
begin
  select callsign into cs from public.profiles where user_id = auth.uid();
  update public.rooms r
    set guest_id = auth.uid(),
        guest_cs = coalesce(cs, r.guest_cs),
        guest_seen = (extract(epoch from now()) * 1000)::bigint
    where r.code = p_code and r.guest_id is null and r.host_id <> auth.uid()
    returning r.* into row;
  if row.code is null then
    raise exception 'ROOM FULL OR NOT FOUND' using errcode = 'P0001';
  end if;
  return row;
end $$;

-- rematch_room: a fresh seed on the SAME room (no new code). Idempotent, so if
-- both players tap REMATCH at once the last write simply wins and both sides
-- detect the changed seed on their next poll and drop into the new race.
create or replace function public.rematch_room(p_code text)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare row public.rooms;
begin
  if auth.uid() is null then
    raise exception 'sign in to rematch' using errcode = 'P0001';
  end if;
  update public.rooms r set
    seed = (floor(random() * 2147483647))::integer,
    status = 'racing',
    winner = null,
    host_x = null, host_alive = null, host_elapsed = null,
    guest_x = null, guest_alive = null, guest_elapsed = null,
    host_seen = (extract(epoch from now()) * 1000)::bigint,
    guest_seen = (extract(epoch from now()) * 1000)::bigint
  where r.code = p_code
    and r.status = 'done'
    and (r.host_id = auth.uid() or r.guest_id = auth.uid())
  returning r.* into row;
  return row;
end $$;

grant execute on function public.create_room(text, integer) to authenticated;
grant execute on function public.join_room(text) to authenticated;
grant execute on function public.rematch_room(text) to authenticated;

