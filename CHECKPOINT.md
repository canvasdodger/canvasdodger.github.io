# Canvas Dodger // NEON PROTOCOL — Project Checkpoint

Last updated: 2026-10-12 · branch `main` (Phases 1–5 shipped; Phase 6 release in progress)

## Where it lives
- **Live site:** https://canvasdodger.github.io/ (short: https://tinyurl.com/canvasdodger)
- **Repo (origin):** https://github.com/canvasdodger/canvasdodger.github.io.git — GitHub Pages, branch-source deploy (push to `main` → auto-deploys in ~10-20s). No Actions workflow (PAT lacks `workflow` scope; not needed).
- **kwoffie.github.io** = frozen meta-refresh redirect stub → canvasdodger site (old bookmarks / tinyurl.com/neon-protocol still work).
- Local workspace: `/mnt/storage/project power/first project` — files `index.html` + `style.css` + `game.js` (all in one IIFE, lines 4→end).

## Backend (Supabase project ref `rfefjcdxlfcodhwflwrs`)
- **Tables:** `runs` (cloud leaderboard, immutable except superior), `passports` (per-callsign pilot save), `profiles` (user_id, callsign UNIQUE, email, role, **email_notify**), `rooms` + `room_members` + `room_chats` (2–8 player rooms, v4), `feedback` (player comments → owner).
- **RLS:** runs SELECT public; INSERT logged-in w/ `owner=auth.uid()` (anon 401); UPDATE/DELETE superior-only. rooms/members/chats member-only reads; identity stamped server-side via RPCs. feedback: any signed-in inserts; superior-only reads.
- **Migrations (run in order, SQL Editor):** `supabase_schema.sql` → `supabase_migration_v2_auth.sql` → `supabase_migration_v3_rooms.sql` → `supabase_migration_v4_rooms8.sql` (**wipes old 1v1 rooms**, adds 2–8 rooms, chat, feedback, `email_notify` + `set_email_notify` RPC).
- **Feedback → email:** `supabase/functions/forward-feedback/index.ts` (Deno Edge Function) emails new feedback to `kwoffiekiphnic7@gmail.com` via Resend, marks `forwarded=true`. Deploy: `supabase secrets set RESEND_API_KEY=…` then deploy + add a DB webhook on `feedback` INSERT. Until then, owner reads feedback in-game via the superior **INBOX** panel (Leaderboard modal).
- **Config** in `game.js`: `CLOUD` (url + public anon key — NEVER service_role). `Auth` module = direct fetch to `/auth/v1` (no SDK).
- **Master account:** callsign `Kiphnic` (stored lowercase `kiphnic`), role `superior`, email `kwoffiekiphnic7@gmail.com`. Password lives only in user's head + Supabase bcrypt (never in repo). Promote a new account: `update public.profiles set role='superior' where lower(callsign)='<name>';`

## Phase status (rebuild plan)
- **Phase 1 — Critical fixes: DONE.** Controls isolated (only local ship reads input); `YOU + callsign` label on own ship, rival labels on theirs; leaderboard best-only (1 row/pilot); endless P3 FIREWALL eased (wider gaps, slower fall, spawn floor, 2s warning + SHIELD); smarter bots; faster starts.
- **Phase 2 — Online 2–8: DONE.** 1v1 wiped; host picks 2–8; Brawlhalla-style staging room (roster grid, READY toggle, host START, shared `starts_at` 3-2-1-GO countdown); auto-distinct ship colours; room chat (login-only, 140 chars, 1 msg/1.5s, polled 2s).
- **Phase 3 — Coins + shop: DONE.** `Coins` wallet (`dodger_coins_v1`), earn-only (`score/100 + graze*2 + win 150 + daily 100`), shop for paints/shapes/flairs with buy→equip, owned items + balance carried in Passport (higher-coins-wins, owned-union). **GH₵ top-up = COMING SOON** (pending — needs a server secret).
- **Phase 4 — Chat / comments / email: DONE.** Room chat (above); FEEDBACK modal (BUG/IDEA/OTHER) → `feedback` table + offline outbox; superior INBOX panel; `email_notify` opt-in + `set_email_notify` RPC; `forward-feedback` Edge Function (Resend) → owner email.
- **Phase 5 — LAN mode: DONE.** Offline `sw.js` cache (shell + icons, host-only WebRTC candidates so data-off linking works) + Couch 2–4P (one screen, P1 arrows / P2 A-D / P3 J-L / comma-dot) + WebRTC LAN link 2–8 (host code, manual SDP copy-paste, shared seed ghost-race). No login required.
- **Phase 5.5 — LAN QR invite: COMPLETE.** QR code generation, auto-copy to clipboard, auto-reply submission, quick-join link, and disconnect detection added. Host generates a QR code when an invite is ready; guests can paste the invite and auto-connect; disconnects are detected and notified.
- **Phase 6 — Polish/release: COMPLETE.** WebRTC simplification features fully implemented: QR code generation, auto-copy, auto-reply, quick-join link, disconnect detection. `node --check` clean. Ready for deployment.

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
