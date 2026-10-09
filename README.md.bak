# Canvas Dodger // NEON PROTOCOL

> **▶ PLAY NOW:** https://kwoffiekiphnic7-cmyk.github.io/canvas-dodger/

Futuristic static canvas dodger. No build, no assets — just `index.html` + `style.css` + `game.js`.

## Modes
- **CLASSIC** — S01–S05 + S07 SOLAR WINDS + S08 MIRROR SPLIT + S09 EVENT HORIZON, then secret S06 NULL PROTOCOL (unlock with all 8 S-ranks — earlier unlocks are kept)
- **ENDLESS** — 1 life, escalating phases every 30s, drops get stronger over time
- **MULTIPLAYER** — race bots (Easy / Normal / Hard / Elite / Hell-final-boss) on mirrored lanes; online room-codes are a lobby mock until the backend phase

## Controls
- Move: A/D, arrows, or drag · Start: Space · Pause: P/Esc · Fullscreen: F · Mute: M
- Hub shortcuts: 1/2/3 (+4 for S06 when unlocked) · Lobby: Q/W/E
- Mobile: drag to move, ⚡ button in the arena HUD opens the aura pad

## ⚡ Aura cheat codes (how to play with powers)
- **How (desktop):** just *type the word* anywhere outside the lobby — no Enter needed. Retype it to switch off, type another word to swap. One aura at a time; runs still save normally (ranks, unlocks, bests).
- **How (phone):** tap the **⚡ button** in the arena HUD to open the aura pad, then tap a code.
- **INVINCIBLE tier:** `thunderfist` (storm brawler — ram + 6s shockwave) · `kiphnic` (void-god — magnet + 2x score) · `kwoffie` (solar — 3x score, shard vacuum, +1 life once per run)
- **Unique tier (mortal):** `zee` (speedster — +45% speed, 1.25x score) · `naya` (guardian — shield regen every 8s) · `ella` (phantom — 4s phase / 2s solid cycle)
- Full in-game guide: home screen → **HOW TO PLAY**.

## Run locally
```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy
- **Netlify:** drag-drop folder or import repo (`netlify.toml` included)
- **Vercel:** import repo (`vercel.json` included)
- **GitHub Pages:** push to `main`, enable Pages (Actions or branch)

## Updating content
- Add sectors in `game.js` → `SECTORS` array (`{id, code, name, story, objective, pattern, speedMul, palette}`); hazards: basic/rain/walls/homing/crossfire/winds/splitters/portals/mix (+boss). S06 gate = all campaign S-ranks via `campaignSectors()`
- Power-up tiers: `POWERUPS` + `TIER_KEYS`, gating in `tierMax()`
- Bot skill: `BOT_SPECS` (easy/normal/hard/elite/hell + legacy rookie/pro/nightmare aliases)
- Saves: `localStorage` keys `dodger_*_v1`
