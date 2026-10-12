-- NEON PROTOCOL / Canvas Dodger — migration v4: wipe 1v1 rooms, add 2-8 player rooms
-- Run AFTER v3.  Dashboard → SQL Editor → New query → paste → Run.
-- Wipes old host_*/guest_* single-rival rooms. Replaces with roster-based rooms:
-- one row per room + one row per player. Ghost race unchanged (shared `seed`).

-- ---- wipe v3 rooms (breaks old 1v1 codes on purpose) ----
drop trigger if exists rooms_guard on public.rooms;
drop function if exists public.room_guard();
drop function if exists public.create_room(text, integer);
drop function if exists public.join_room(text);
drop function if exists public.rematch_room(text);
drop function if exists public.room_member(text);
drop table if exists public.rooms;

-- ---- new rooms table ----
create table if not exists public.rooms (
  code        text primary key check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  seed        integer not null,
  status      text not null default 'waiting' check (status in ('waiting','racing','done')),
  max_players integer not null default 2 check (max_players between 2 and 8),
  host_id     uuid not null references auth.users(id) on delete cascade,
  winner      uuid,                                  -- user_id of last survivor
  starts_at   bigint not null default 0,             -- epoch ms; countdown anchor
  created_at  bigint not null default (extract(epoch from now()) * 1000)::bigint
);
alter table public.rooms enable row level security;

-- ---- one row per player in a room ----
create table if not exists public.room_members (
  room_code text not null references public.rooms(code) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  callsign  text not null default '',
  paint     text not null default 'cyan',            -- ship paint id
  color     text not null default '#00f0ff',         -- assigned distinct hex
  slot      integer not null default 0 check (slot between 0 and 7),
  ready     boolean not null default false,
  x         real not null default 453,
  alive     boolean not null default true,
  elapsed   real not null default 0,
  seen      bigint not null default 0,
  left_at   bigint not null default 0,               -- set when they leave/disconnect
  joined_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  primary key (room_code, user_id)
);
alter table public.room_members enable row level security;

-- ---- room chat (login-only, 140 chars, polled ~2s) ----
create table if not exists public.room_chats (
  id        bigint generated always as identity primary key,
  room_code text not null references public.rooms(code) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  callsign  text not null default '',
  msg       text not null check (char_length(msg) between 1 and 140),
  at        bigint not null default (extract(epoch from now()) * 1000)::bigint
);
alter table public.room_chats enable row level security;
create index if not exists room_chats_tail on public.room_chats (room_code, at);

-- ---- player feedback / comments (forwarded to owner via Edge Function) ----
create table if not exists public.feedback (
  id        bigint generated always as identity primary key,
  user_id   uuid references auth.users(id) on delete set null,
  callsign  text not null default '',
  kind      text not null default 'other' check (kind in ('bug','idea','other')),
  msg       text not null check (char_length(msg) between 1 and 1000),
  forwarded boolean not null default false,          -- Edge Function sets true once mailed
  read      boolean not null default false,          -- superior marks read in-game
  at        bigint not null default (extract(epoch from now()) * 1000)::bigint
);
alter table public.feedback enable row level security;

-- ---- email notifications opt-in (updates/patch-note/chat mails) ----
-- Default ON. Players toggle only THEIR OWN flag via set_email_notify() RPC
-- (never a blanket UPDATE, so they still can't touch `role`).
alter table public.profiles add column if not exists email_notify boolean not null default true;
create or replace function public.set_email_notify(p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set email_notify = coalesce(p_on, true) where user_id = auth.uid();
end $$;
grant execute on function public.set_email_notify(boolean) to authenticated;

-- ---- RLS ----
-- rooms: read members only (code is the secret); insert = create; update members; delete host/superior
drop policy if exists "rooms_read" on public.rooms;
create policy "rooms_read" on public.rooms for select using (
  exists (select 1 from public.room_members m where m.room_code = rooms.code and m.user_id = auth.uid())
  or public.is_superior()
);
drop policy if exists "rooms_insert" on public.rooms;
create policy "rooms_insert" on public.rooms for insert to authenticated with check (auth.uid() = host_id);
drop policy if exists "rooms_update" on public.rooms;
create policy "rooms_update" on public.rooms for update to authenticated
  using (auth.uid() = host_id or exists (select 1 from public.room_members m where m.room_code = rooms.code and m.user_id = auth.uid()))
  with check (auth.uid() = host_id or exists (select 1 from public.room_members m where m.room_code = rooms.code and m.user_id = auth.uid()));
drop policy if exists "rooms_delete" on public.rooms;
create policy "rooms_delete" on public.rooms for delete to authenticated
  using (auth.uid() = host_id or public.is_superior());

-- room_members: members read all roster rows; each player writes only their OWN row
drop policy if exists "members_read" on public.room_members;
create policy "members_read" on public.room_members for select using (
  exists (select 1 from public.room_members m where m.room_code = room_members.room_code and m.user_id = auth.uid())
  or public.is_superior()
);
drop policy if exists "members_insert" on public.room_members;
create policy "members_insert" on public.room_members for insert to authenticated
  with check (auth.uid() = user_id);
drop policy if exists "members_update" on public.room_members;
create policy "members_update" on public.room_members for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "members_delete" on public.room_members;
create policy "members_delete" on public.room_members for delete to authenticated
  using (auth.uid() = user_id or public.is_superior());

-- room_chats: members read; any member writes their own (callsign stamped by trigger)
drop policy if exists "chats_read" on public.room_chats;
create policy "chats_read" on public.room_chats for select using (
  exists (select 1 from public.room_members m where m.room_code = room_chats.room_code and m.user_id = auth.uid())
  or public.is_superior()
);
drop policy if exists "chats_insert" on public.room_chats;
create policy "chats_insert" on public.room_chats for insert to authenticated
  with check (auth.uid() = user_id);
drop policy if exists "chats_delete" on public.room_chats;
create policy "chats_delete" on public.room_chats for delete to authenticated
  using (auth.uid() = user_id or public.is_superior());

-- feedback: anyone logged-in may insert; only superior reads (Edge Function uses service role)
drop policy if exists "fb_insert" on public.feedback;
create policy "fb_insert" on public.feedback for insert to authenticated
  with check (auth.uid() is not null and (user_id is null or user_id = auth.uid()));
drop policy if exists "fb_read" on public.feedback;
create policy "fb_read" on public.feedback for select to authenticated using (public.is_superior());
drop policy if exists "fb_update" on public.feedback;
create policy "fb_update" on public.feedback for update to authenticated

-- stamp callsign server-side on chat + feedback (nobody spoofs names)
create or replace function public.stamp_chat_callsign()
returns trigger language plpgsql security definer set search_path = public as $$
declare cs text;
begin
  select callsign into cs from public.profiles where user_id = auth.uid();
  new.callsign := coalesce(cs, '');
  return new;
end $$;
drop trigger if exists chats_stamp on public.room_chats;
create trigger chats_stamp before insert on public.room_chats
  for each row execute function public.stamp_chat_callsign();

create or replace function public.stamp_fb_callsign()
returns trigger language plpgsql security definer set search_path = public as $$
declare cs text;
begin
  select callsign into cs from public.profiles where user_id = auth.uid();
  new.callsign := coalesce(cs, 'GUEST');
  new.user_id := auth.uid();
  return new;
end $$;
drop trigger if exists fb_stamp on public.feedback;
create trigger fb_stamp before insert on public.feedback
  for each row execute function public.stamp_fb_callsign();

-- ---- RPCs (SECURITY DEFINER so pre-membership acts bypass RLS) ----

-- create_room: host inserts room + their own member row (slot 0), stamps callsign.
create or replace function public.create_room(p_code text, p_seed integer, p_max integer)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare cs text; row public.rooms; n integer;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = 'P0001'; end if;
  n := least(8, greatest(2, coalesce(p_max, 2)));
  select callsign into cs from public.profiles where user_id = auth.uid();
  insert into public.rooms (code, seed, max_players, host_id)
  values (p_code, p_seed, n, auth.uid())
  on conflict (code) do nothing
  returning * into row;
  if row.code is null then raise exception 'ROOM EXISTS' using errcode = 'P0001'; end if;
  insert into public.room_members (room_code, user_id, callsign, slot, ready, seen)
  values (p_code, auth.uid(), coalesce(cs, 'HOST'), 0, false,
          (extract(epoch from now()) * 1000)::bigint)
  on conflict do nothing;
  return row;
end $$;

-- join_room: claim next free slot if room is waiting and not full. RLS would block
-- the pre-membership insert; the definer function performs it and returns the row.
create or replace function public.join_room(p_code text)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare cs text; row public.rooms; n integer; taken integer[]; s integer; i integer;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = 'P0001'; end if;
  select * into row from public.rooms where code = p_code;
  if row.code is null then raise exception 'ROOM NOT FOUND' using errcode = 'P0001'; end if;
  if row.status <> 'waiting' then raise exception 'RACE ALREADY STARTED' using errcode = 'P0001'; end if;
  select count(*) into n from public.room_members where room_code = p_code and left_at = 0;
  if n >= row.max_players then raise exception 'ROOM FULL' using errcode = 'P0001'; end if;
  -- already in this room? (rejoin after refresh) — just hand back the row
  if exists (select 1 from public.room_members where room_code = p_code and user_id = auth.uid()) then
    return row;
  end if;
  select callsign into cs from public.profiles where user_id = auth.uid();
  select coalesce(array_agg(slot), '{}') into taken from public.room_members
    where room_code = p_code and left_at = 0;
  s := 0;
  for i in 0..7 loop
    if not (i = any(taken)) then s := i; exit; end if;
  end loop;
  insert into public.room_members (room_code, user_id, callsign, slot, ready, seen)
  values (p_code, auth.uid(), coalesce(cs, 'PILOT'), s, false,
          (extract(epoch from now()) * 1000)::bigint);
  return row;
end $$;

-- set_ready: flip my ready flag in a waiting room.
create or replace function public.set_ready(p_code text, p_ready boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.room_members set ready = coalesce(p_ready, false),
    seen = (extract(epoch from now()) * 1000)::bigint
  where room_code = p_code and user_id = auth.uid();

-- start_race: host-only. Marks room racing, stamps starts_at = now + 3s (countdown),
-- and resets every member's race state. Returns the fresh row.
create or replace function public.start_race(p_code text)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare row public.rooms; n integer;
begin
  select * into row from public.rooms where code = p_code and host_id = auth.uid() and status = 'waiting';
  if row.code is null then raise exception 'NOT HOST OR NOT WAITING' using errcode = 'P0001'; end if;
  select count(*) into n from public.room_members where room_code = p_code and left_at = 0;
  if n < 2 then raise exception 'NEED 2+ PILOTS' using errcode = 'P0001'; end if;
  update public.rooms set
    status = 'racing',
    starts_at = (extract(epoch from now()) * 1000)::bigint + 3000,
    winner = null
  where code = p_code
  returning * into row;
  update public.room_members set x = 453, alive = true, elapsed = 0, ready = false,
    seen = (extract(epoch from now()) * 1000)::bigint
  where room_code = p_code;
  return row;
end $$;

-- push_state: write my own x/alive/elapsed + seen (RLS limits to own row anyway).
create or replace function public.push_state(p_code text, p_x real, p_alive boolean, p_elapsed real)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.room_members
    set x = coalesce(p_x, x), alive = coalesce(p_alive, alive),
        elapsed = coalesce(p_elapsed, elapsed),
        seen = (extract(epoch from now()) * 1000)::bigint
  where room_code = p_code and user_id = auth.uid();
end $$;

-- mark_left: graceful LEAVE — flag my row so others see me gone without a delete.
create or replace function public.mark_left(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.room_members set left_at = (extract(epoch from now()) * 1000)::bigint, alive = false
  where room_code = p_code and user_id = auth.uid();
end $$;

-- rematch: host-only. Fresh seed, status back to racing with a new countdown.
create or replace function public.rematch_room(p_code text)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare row public.rooms;
begin
  select * into row from public.rooms where code = p_code and host_id = auth.uid() and status = 'done';
  if row.code is null then raise exception 'NOT HOST OR NOT DONE' using errcode = 'P0001'; end if;
  update public.rooms set
    seed = (floor(random() * 2147483647))::integer,
    status = 'racing',
    starts_at = (extract(epoch from now()) * 1000)::bigint + 3000,
    winner = null
  where code = p_code
  returning * into row;
  update public.room_members set x = 453, alive = true, elapsed = 0, ready = false,
    left_at = 0, seen = (extract(epoch from now()) * 1000)::bigint
  where room_code = p_code;
  return row;
end $$;

-- finish_round: mark the room done + stamp winner (last survivor's user_id).
create or replace function public.finish_round(p_code text, p_winner uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.rooms set status = 'done', winner = p_winner where code = p_code;
end $$;

grant execute on function public.create_room(text, integer, integer) to authenticated;
grant execute on function public.join_room(text) to authenticated;
grant execute on function public.set_ready(text, boolean) to authenticated;
grant execute on function public.start_race(text) to authenticated;
grant execute on function public.push_state(text, real, boolean, real) to authenticated;
grant execute on function public.mark_left(text) to authenticated;
grant execute on function public.rematch_room(text) to authenticated;
grant execute on function public.finish_round(text, uuid) to authenticated;

-- ---- feedback forwarder (Edge Function — see supabase/functions/forward-feedback) ----
-- Once deployed with a RESEND_API_KEY secret, wire a cron or DB webhook to call it.
-- Until then feedback still lands in the `feedback` table and the superior reads
-- it in-game via the INBOX panel.

end $$;
