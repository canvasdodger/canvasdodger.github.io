# Canvas Dodger // NEON PROTOCOL

> **▶ PLAY NOW:** https://canvasdodger.github.io/ · short: https://tinyurl.com/canvasdodger

Futuristic static canvas dodger. No build, no assets — just `index.html` + `style.css` + `game.js`.

## Modes
- **CLASSIC** — S01–S05 + S07 SOLAR WINDS + S08 MIRROR SPLIT + S09 EVENT HORIZON, then secret S06 NULL PROTOCOL (unlock with all 8 S-ranks — earlier unlocks are kept)
- **ENDLESS** — 1 life, escalating phases every 30s, drops get stronger over time
- **MULTIPLAYER** — race bots (Easy / Normal / Hard / Elite / Hell-final-boss) on mirrored lanes; online room-codes are a lobby mock until the backend phase

## Controls
- Move: **arrow keys** or drag · Start: Space · Pause: P/Esc · Fullscreen: F · Mute: M
- Hub shortcuts: 1/2/3 (+4 for S06 when unlocked) · Lobby: Q/W/E
- Mobile: drag to move · the ⚡ bolt summons a blind keyboard; type, then Enter fires and returns to the game

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
- Sign-in required for **DAILY RUN, FLIGHT SCHOOL, MULTIPLAYER, HANGAR** and all cloud board writes
- Identity = callsign (3–14 chars — one account per callsign) + a unique password; auth email is synthetic per callsign
- Roles in `profiles`: `player` (default) / `superior` — superior console: WIPE TAB, per-row ✕, promote/demote, hidden-word list, dev drops

## Updating content
- Add sectors in `game.js` → `SECTORS` array (`{id, code, name, story, objective, pattern, speedMul, palette}`); hazards: basic/rain/walls/homing/crossfire/winds/splitters/portals/mix (+boss). S06 gate = all campaign S-ranks via `campaignSectors()`
- Power-up tiers: `POWERUPS` + `TIER_KEYS`, gating in `tierMax()`
- Bot skill: `BOT_SPECS` (easy/normal/hard/elite/hell + legacy rookie/pro/nightmare aliases)
- Saves: `localStorage` keys `dodger_*_v1`
