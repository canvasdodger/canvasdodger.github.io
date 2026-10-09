# Canvas Dodger // NEON PROTOCOL — Project Checkpoint

Last updated: 2026-10-09 · HEAD `ed364b8` · branch `main` (in sync with `origin/main`)

## Where it lives
- **Live site:** https://canvasdodger.github.io/ (short: https://tinyurl.com/canvasdodger)
- **Repo (origin):** https://github.com/canvasdodger/canvasdodger.github.io.git — GitHub Pages, branch-source deploy (push to `main` → auto-deploys in ~10-20s). No Actions workflow (PAT lacks `workflow` scope; not needed).
- **kwoffie.github.io** = frozen meta-refresh redirect stub → canvasdodger site (old bookmarks / tinyurl.com/neon-protocol still work).
- Local workspace: `/mnt/storage/project power/first project` — files `index.html` + `style.css` + `game.js` (all in one IIFE, lines 4→end).

## Backend (Supabase project ref `rfefjcdxlfcodhwflwrs`)
- **Tables:** `runs` (cloud leaderboard, immutable except superior), `passports` (per-callsign pilot save), `profiles` (user_id, callsign UNIQUE, email, role), `rooms` (online matches).
- **RLS:** runs SELECT public; INSERT logged-in w/ `owner=auth.uid()` (anon 401); UPDATE/DELETE superior-only. rooms member-only reads; identity stamped server-side via `create_room`/`join_room`/`rematch_room` RPCs.
- **Migrations (run in order, SQL Editor):** `supabase_schema.sql` → `supabase_migration_v2_auth.sql` → `supabase_migration_v3_rooms.sql`.
- **Config** in `game.js`: `CLOUD` (url + public anon key — NEVER service_role). `Auth` module = direct fetch to `/auth/v1` (no SDK).
- **Master account:** callsign `Kiphnic` (stored lowercase `kiphnic`), role `superior`, email `kwoffiekiphnic7@gmail.com`. Password lives only in user's head + Supabase bcrypt (never in repo). Promote a new account: `update public.profiles set role='superior' where lower(callsign)='<name>';`

## Feature status — ALL DONE
- **Accounts/mandatory login:** `gateMode()` gates DAILY / FLIGHT SCHOOL / MULTIPLAYER / HANGAR / ONLINE. Guests: classic/endless/board-view only. Cloud board writes require session JWT.
- **Cheat auras (6 sealed words):** login-only, `CHEAT_SECS=90` silent fuse, `G.ghostScore=true` at ignite → never rank. Deep-hidden (no visible names). Mobile: ⚡ bolt → blind `#auraType` field → type → Enter fires. Arrows-only movement (`a`/`d` removed).
- **Superior console:** ◈ badge, WIPE TAB, per-row ✕, PROMOTE/DEMOTE, HIDDEN WORDS, ✦ spawn pickup, $ SET SCORE, CLOSE ROOM.
- **Leaderboard:** RANK/PILOT/SCORE header, competition ranking (ties share 1,1,3), ordinals, comma scores, YOU highlight.
- **Online PvP:** dedicated `#screen-online` (home card or `O` key). CREATE/JOIN 6-char room code over polled REST (no SDK/Realtime toggle). Shared `seed` → identical storms; ghost rival; 3s disconnect → "RIVAL LOST"; REMATCH (fresh seed, same room). Back button → home.
- **UI:** ship-hull LOGIN button, 👤 header glyph, passport hint cleared, EXPORT clipping fixed, ambient home gameplay (attract mode), bottom-bar signed-in status chip.

## Known caveats (by design)
- Login gates are UX locks; DevTools can call `startMode` locally, but runs can't reach the cloud board without a JWT (RLS 401). Competitive surface is secure.
- Online uses deterministic ghost racing (collisions local) — not server-authoritative PvP. Fine for the current scope.
- Free Supabase project pauses after ~1 week of no requests — occasional play keeps it awake; offline → game falls back to `SOURCE: THIS DEVICE`.

## Test harnesses (in /tmp — wiped on env restart, regenerate if needed)
Extract slices from game.js + simulate in Node. Cover: gateMode blocking, 90s fuse, ghost flag, arrows-only, NetRival create/join/tick/rematch/seed-determinism, RLS probes (anon 401 / player / superior). Plus `node --check game.js`.

## Next-step menu (not started)
- Pre-race countdown (3…2…1…GO)
- Lobby "who's online" global presence (beyond current per-room roster)
- Server-authoritative PvP (needs a dedicated relay — larger scope)
- gitignore the tracked junk (.bak / stage*.txt / h1-3.txt) currently shipped to Pages
