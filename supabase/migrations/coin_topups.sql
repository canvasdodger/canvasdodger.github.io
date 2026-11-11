-- NEON PROTOCOL / Canvas Dodger — migration: coin top-ups (GH₵ via Paystack)
-- Run AFTER supabase_migration_v4_rooms8.sql. Dashboard → SQL Editor → New query → Run.

create table if not exists public.coin_topups (
  id        bigint generated always as identity primary key,
  user_id   uuid not null references auth.users(id) on delete cascade,
  callsign  text not null default '',
  amount_ghs integer not null check (amount_ghs > 0 and amount_ghs <= 10000),
  provider  text not null check (provider in ('mtn','telecel')),
  status    text not null default 'pending' check (status in ('pending','success','failed')),
  reference text not null unique,           -- Paystack reference
  access_code text,                          -- Paystack authorization access code
  coins_awarded integer not null default 0,
  credited boolean not null default false,   -- true once coins added to local wallet
  created_at  bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at  bigint not null default (extract(epoch from now()) * 1000)::bigint
);

alter table public.coin_topups enable row level security;

-- players read their own top-ups; superior reads all
drop policy if exists "ct_read_own" on public.coin_topups;
create policy "ct_read_own" on public.coin_topups for select
  using (auth.uid() = user_id or public.is_superior());

-- players cannot insert directly (server-side only via Edge Function)
drop policy if exists "ct_insert" on public.coin_topups;
create policy "ct_insert" on public.coin_topups for insert
  with check (false);

-- superior can update status (mark success/failed)
drop policy if exists "ct_update_superior" on public.coin_topups;
create policy "ct_update_superior" on public.coin_topups for update
  using (public.is_superior()) with check (public.is_superior());

-- index for webhook lookups by reference
create index if not exists coin_topups_reference on public.coin_topups (reference);
create index if not exists coin_topups_user on public.coin_topups (user_id);

-- helper: award coins to a user's passport (called by Edge Function with service role)
create or replace function public.award_coins_for_topup(p_user_id uuid, p_coins integer)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cs text;
  v_payload jsonb;
begin
  select callsign into v_cs from public.profiles where user_id = p_user_id;
  if v_cs is null then return; end if;

  -- load existing passport
  select payload into v_payload from public.passports where callsign = v_cs;
  if v_payload is null then
    v_payload := jsonb_build_object('coins', p_coins, 'owned', '[]');
  else
    v_payload := v_payload || jsonb_build_object('coins', coalesce((v_payload->>'coins')::int, 0) + p_coins);
  end if;

  insert into public.passports (callsign, payload, updated_at)
  values (v_cs, v_payload, (extract(epoch from now()) * 1000)::bigint)
  on conflict (callsign) do update
    set payload = excluded.payload,
        updated_at = (extract(epoch from now()) * 1000)::bigint;
end $$;

grant execute on function public.award_coins_for_topup(uuid, integer) to authenticated;