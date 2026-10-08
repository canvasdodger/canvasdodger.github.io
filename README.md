# Canvas Dodger // NEON PROTOCOL

> **▶ PLAY NOW:** https://kwoffiekiphnic7-cmyk.github.io/canvas-dodger/

Futuristic static canvas dodger. No build, no assets — just `index.html` + `style.css` + `game.js`.

## Modes
- **CLASSIC** — S01–S05 sector campaign + secret S06 NULL PROTOCOL (unlock with all S-ranks)
- **ENDLESS** — 1 life, escalating phases every 30s, drops get stronger over time
- **MULTIPLAYER** — race bots (Easy / Normal / Hard / Elite / Hell-final-boss) on mirrored lanes; online room-codes are a lobby mock until the backend phase

## Controls
- Move: A/D, arrows, or drag · Start: Space · Pause: P/Esc · Fullscreen: F · Mute: M
- Hub shortcuts: 1/2/3 (+4 for S06 when unlocked) · Lobby: Q/W/E

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
- Add sectors in `game.js` → `SECTORS` array (`{id, code, name, story, objective, pattern, speedMul, palette}`)
- Power-up tiers: `POWERUPS` + `TIER_KEYS`, gating in `tierMax()`
- Bot skill: `BOT_SPECS` (easy/normal/hard/elite/hell + legacy rookie/pro/nightmare aliases)
- Saves: `localStorage` keys `dodger_*_v1`
