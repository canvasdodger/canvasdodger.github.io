# Canvas Dodger // NEON PROTOCOL

> **▶ PLAY NOW:** https://canvasdodger.github.io/ · short: https://tinyurl.com/canvasdodger

Futuristic static canvas dodger. No build, no assets — just `index.html` + `style.css` + `game.js`.

## Modes
- **CLASSIC** — S01–S05 + S07 SOLAR WINDS + S08 MIRROR SPLIT + S09 EVENT HORIZON, then secret S06 NULL PROTOCOL (unlock with all 8 S-ranks — earlier unlocks are kept)
- **ENDLESS** — 1 life, escalating phases every 30s, drops get stronger over time (P3 FIREWALL eased: wider gaps, slower fall)
- **MULTIPLAYER** — race bots (Easy / Normal / Hard / Elite / Hell-final-boss) on a shared arena; your ship is solid with a `YOU` label, rivals are translucent ghosts with their own callsigns + colours
- **VS PLAYERS — ONLINE** — 2–8 player room-code races (host picks size); staging room with roster grid, READY toggle, host START, shared 3-2-1-GO countdown; shared-seed ghost races; in-room chat (login-only)
- **LAN PARTY — NO INTERNET** — home card or `L`: **Couch 2–4P** on one screen (P1 arrows, P2 A/D, P3 J/L, P4 ,/.) or **Link 2–8** device-to-device over WebRTC (host NEW INVITE → guest MAKE REPLY → CONNECT). Same WiFi/hotspot, data off is fine. Fully offline-capable via `sw.js` cache + installable PWA (`manifest.webmanifest` + icons).

## Controls
- Move: **arrow keys** or drag · Start: Space · Pause: P/Esc · Fullscreen: F · Mute: M
- Hub shortcuts: 1/2/3 (+4 for S06 when unlocked) · Lobby: Q/W/E · Online: O · LAN: L
- Couch: P1 ←/→ · P2 A/D · P3 J/L · P4 ,/. · Mobile: drag to move · the ⚡ bolt summons a blind keyboard; type, then Enter fires and returns to the game

## Coins + Hangar shop
- Earn-only wallet (`◈`, stored `dodger_coins_v1`): `floor(score/100) + graze×2 + win 150 + daily 100`. Cheat/tutorial/ghost runs never earn.
- Spend on paints / shapes / flairs in the Hangar — BUY → auto-EQUIP. Balance + owned skins ride along in Passport export/import/cloud (higher-coins-wins, owned-union).
- **◈ TOP UP GH₵ (COMING SOON)** — greyed out; real MoMo/card top-up needs a server secret (pending, not in this static build).

## Feedback → owner email
- Home **FEEDBACK** button → BUG/IDEA/OTHER modal → `feedback` table (offline outbox if cloud down). Owner (`kwoffiekiphnic7@gmail.com`) reads in-game via the superior **INBOX** panel, and via email once deployed: `supabase secrets set RESEND_API_KEY=…` → deploy `supabase/functions/forward-feedback` → DB webhook on `feedback` INSERT.
- `profiles.email_notify` (default ON) + `set_email_notify()` RPC lets pilots opt into update/reply emails. Chat/update bulk mailer still pending.

## ⚡ Rumor: sealed words
- Six sealed words exist. Nothing in the game ever prints one — not in a list, not even while it's active.
- **Desktop:** just type the word anywhere outside the lobby. **Phone:** tap ⚡, type blind, press Enter.
- Auras require a **signed-in account**, last **90 seconds**, then burn out silently. Retype to re-arm.
- Aura runs are ghosted — they never appear on any leaderboard.

## Run locally
```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy
- **Netlify:** drag-drop folder or import repo (`netlify.toml` included)
- **Vercel:** import repo (`vercel.json` included)
- **GitHub Pages:** push to `main`, enable Pages (Actions or branch)

## Cloud (optional, Supabase)
- Schema: `supabase_schema.sql` → run once in the Supabase SQL Editor (creates `runs` + `passports`, RLS on, no deletes)
- Accounts: `supabase_migration_v2_auth.sql` → run after the schema (profiles, roles, sign-in-locked board writes)
- Config lives in `game.js` → `CLOUD` (`url` + public **anon** key — never the service_role key)
- Leaderboard board pulls cloud rows on open (`SOURCE: CLOUD + DEVICE`), merges with local; passes `CLOUD.on = false` or any failure → falls back to `SOURCE: THIS DEVICE`
- Pilot passport: `CLOUD SAVE` / `CLOUD LOAD` in the pilot panel (keyed by callsign)

## Accounts (Supabase Auth)
- Sign-in required for **DAILY RUN, FLIGHT SCHOOL, MULTIPLAYER, HANGAR, ONLINE** and all cloud board writes
- Identity = callsign (3–14 chars — one account per callsign) + a unique password; auth email is synthetic per callsign
- Roles in `profiles`: `player` (default) / `superior` — superior console: WIPE TAB, per-row ✕, promote/demote, hidden-word list, dev drops, CLOSE ROOM

## Online rooms (Supabase)
- Migrations (SQL Editor, in order): `supabase_schema.sql` → `supabase_migration_v2_auth.sql` → `supabase_migration_v3_rooms.sql` → **`supabase_migration_v4_rooms8.sql`** (wipes legacy 1v1 rooms; adds 2–8 rooms + `room_members` + `room_chats` + `feedback` + `email_notify`/`set_email_notify`)
- Tables: `rooms(code, seed, status, host_id, max_players 2–8, starts_at, winner)` + `room_members(room_code, user_id, callsign, paint, shape, ready, x, alive, elapsed, seen, slot)`; identity stamped server-side, member-only RLS. Host picks 2–8 at CREATE; JOIN rejects when full.
- No SDK / no Realtime toggle: polled REST at ~10Hz. Storm is **deterministic** — all clients share the room `seed`, so `makeRng()` spawns an identical hazard schedule; collisions stay local → no host advantage, no lag disputes
- Staging first (Brawlhalla-style): JOIN loads the waiting room (roster grid, READY, LEAVE); host START sets shared `starts_at` → 3-2-1-GO → race. 3s heartbeat timeout → rival marked left; REMATCH = fresh seed, same room.
- LAN Link mirrors the same flow peer-to-peer (WebRTC DataChannel, host-only candidates — no STUN needed on `192.168.x.x`). If school/hotel WiFi blocks P2P, use a phone hotspot or Couch mode.

## Updating content
- Add sectors in `game.js` → `SECTORS` array (`{id, code, name, story, objective, pattern, speedMul, palette}`); hazards: basic/rain/walls/homing/crossfire/winds/splitters/portals/mix (+boss). S06 gate = all campaign S-ranks via `campaignSectors()`
- Power-up tiers: `POWERUPS` + `TIER_KEYS`, gating in `tierMax()`
- Bot skill: `BOT_SPECS` (easy/normal/hard/elite/hell + legacy rookie/pro/nightmare aliases)
- Saves: `localStorage` keys `dodger_*_v1`
