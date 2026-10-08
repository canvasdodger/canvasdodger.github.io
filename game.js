/* NEON PROTOCOL — Canvas Dodger engine
   Modes: classic / endless / multiplayer(bot) + secret sector
   No external assets. Static-host ready. */
(function () {
  "use strict";

  // ================= utils =================
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var pick = function (arr) { return arr[(Math.random() * arr.length) | 0]; };
  var TAU = Math.PI * 2;

  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ================= storage =================
  var K = {
    prog: "dodger_progress_v1",
    bestEndless: "dodger_best_endless_v1",
    botWins: "dodger_bot_wins_v1",
    bestNull: "dodger_best_null_v1",
    mute: "dodger_mute_v1"
  };

  var Store = {
    get: function (key, fb) {
      try { var v = localStorage.getItem(key); return v == null ? fb : JSON.parse(v); }
      catch (e) { return fb; }
    },
    set: function (key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
    }
  };

  var prog = Store.get(K.prog, { unlocked: 1, ranks: {}, nullUnlocked: false });
  if (!prog || typeof prog !== "object") prog = { unlocked: 1, ranks: {}, nullUnlocked: false };
  if (!prog.unlocked) prog.unlocked = 1;
  if (!prog.ranks) prog.ranks = {};
  function saveProgress() { Store.set(K.prog, prog); }

  // ================= audio =================
  var Sfx = {
    ctx: null,
    muted: Store.get(K.mute, false),
    ensure: function () {
      if (this.muted) return null;
      try {
        if (!this.ctx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          this.ctx = new AC();
        }
        if (this.ctx.state === "suspended") this.ctx.resume();
        return this.ctx;
      } catch (e) { return null; }
    },
    tone: function (freq, dur, type, gain, slideTo) {
      var c = this.ensure(); if (!c) return;
      var t = c.currentTime;
      var o = c.createOscillator();
      var g = c.createGain();
      o.type = type || "square";
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
      g.gain.setValueAtTime(gain || 0.035, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + dur + 0.02);
    },
    blip: function () { this.tone(720, 0.07, "square", 0.03); },
    pickup: function () { this.tone(560, 0.12, "triangle", 0.05, 1120); },
    graze: function () { this.tone(980, 0.05, "sine", 0.025); },
    hit: function () { this.tone(180, 0.28, "sawtooth", 0.06, 60); },
    phaseSfx: function () { this.tone(300, 0.3, "triangle", 0.05, 900); },
    banner: function () { this.tone(440, 0.16, "square", 0.04, 660); },
    win: function () { this.tone(520, 0.5, "triangle", 0.05, 1040); },
    lose: function () { this.tone(240, 0.6, "sawtooth", 0.05, 70); },
    toggle: function () {
      this.muted = !this.muted;
      Store.set(K.mute, this.muted);
      if (!this.muted) this.blip();
      syncMuteBtns();
    }
  };

  function syncMuteBtns() {
    $$(".btn-mute").forEach(function (b) {
      b.classList.toggle("off", Sfx.muted);
      b.textContent = Sfx.muted ? "✕" : "♪";
    });
  }

  // ================= input =================
  var Input = {
    keys: Object.create(null),
    seq: "",
    pointerDown: false,
    pointerX: 0
  };

  // owner-only inert (sequence tracked as keystroke stream; never stored or logged)
  var secretFlag = false;
  var secretSeq = "adadws";
  var ghostDotT = 0;

  function noteKey(ch) {
    if (!ch || !/[a-z]/i.test(ch)) return;
    Input.seq = (Input.seq + ch.toLowerCase()).slice(-14);
    if (Input.seq.slice(-secretSeq.length) === secretSeq) {
      Input.seq = "";
      secretFlag = !secretFlag;
      flashSecretDot();
      Sfx.tone(secretFlag ? 1200 : 700, 0.06, "sine", 0.02);
    }
  }

  function flashSecretDot() {
    var dot = $("#ghostDot");
    if (!dot) return;
    dot.classList.add("on");
    clearTimeout(ghostDotT);
    ghostDotT = setTimeout(function () { dot.classList.remove("on"); }, 500);
  }

  // ================= dom refs =================
  var canvas = $("#gameCanvas");
  var ctx = canvas.getContext("2d");
  var stage = $("#stage");
  var hudScore = $("#hudScore");
  var hudMidVal = $("#hudMidVal");
  var hudStatus = $("#hudStatus");
  var bannerEl = $("#banner");
  var overlay = $("#overlay");
  var overlayPanel = $("#overlayPanel");

  var WORLD = { w: 960, h: 540 };
  var view = { dpr: 1, scale: 1, ox: 0, oy: 0 };

  function fitCanvas() {
    if (!stage) return;
    var rect = stage.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cw = Math.max(1, Math.round(rect.width * dpr));
    var ch = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    var s = Math.min(cw / WORLD.w, ch / WORLD.h);
    view = { dpr: dpr, scale: s, ox: (cw - WORLD.w * s) / 2, oy: (ch - WORLD.h * s) / 2 };
  }

  // ================= screens / router =================
  function showScreen(name) {
    $$(".screen").forEach(function (s) { s.classList.remove("active"); });
    var el = $("#screen-" + name);
    if (el) el.classList.add("active");
    if (name === "game") fitCanvas();
    if (name === "home") refreshHome();
  }

  function rankSummary() {
    var s = 0, n = 0;
    for (var i = 1; i <= 5; i++) { if (prog.ranks[i]) { n++; if (prog.ranks[i] === "S") s++; } }
    return s + "/" + n + " S-RANKS";
  }

  function refreshHome() {
    var next = Math.min(prog.unlocked, 5);
    $("#metaClassic").textContent = prog.unlocked > 5
      ? "ALL SECTORS CLEARED — " + rankSummary()
      : "NEXT — SECTOR 0" + next;
    $("#metaEndless").textContent = "BEST — " + Store.get(K.bestEndless, 0);
    var wins = Store.get(K.botWins, 0);
    $("#metaBot").textContent = "VS BOT — " + wins + " WIN" + (wins === 1 ? "" : "S");
    $("#metaNull").textContent = "BEST — " + Store.get(K.bestNull, 0);
    var nullCard = $("#cardNull");
    if (nullCard) nullCard.hidden = !prog.nullUnlocked;
  }

  function route() {
    var h = (location.hash || "").replace(/^#\/?/, "");
    if (h === "classic") { showScreen("game"); startMode("classic"); }
    else if (h === "endless") { showScreen("game"); startMode("endless"); }
    else if (h === "multiplayer") { stopLoop(); G.state = "idle"; hideOverlay(); bannerEl.hidden = true; showScreen("lobby"); }
    else if (h === "null") {
      if (prog.nullUnlocked) { showScreen("game"); startMode("null"); }
      else location.hash = "";
    }
    else showScreen("home");
  }
  window.addEventListener("hashchange", route);

  // ================= data: power-ups =================
  var POWERUPS = {
    shield:    { tier: 1, name: "SHIELD",     color: "#5dff9a", dur: 0,  desc: "absorbs 1 hit" },
    slow:      { tier: 1, name: "SLOW-TIME",  color: "#7ce7ff", dur: 3,  desc: "hazards slowed 3s" },
    magnet:    { tier: 1, name: "MAGNET",     color: "#ff7ce7", dur: 5,  desc: "pulls shards 5s" },
    phase:     { tier: 2, name: "PHASE",      color: "#b18cff", dur: 4,  desc: "pass through 4s" },
    blast:     { tier: 2, name: "BLAST",      color: "#ff9a5d", dur: 0,  desc: "clears screen" },
    x2:        { tier: 2, name: "2X SCORE",   color: "#ffd75d", dur: 10, desc: "double score 10s" },
    overdrive: { tier: 3, name: "OVERDRIVE",  color: "#ff2bd6", dur: 8,  desc: "magnet + 2x + haste" },
    revive:    { tier: 3, name: "REVIVE",     color: "#ffffff", dur: 0,  desc: "+1 life" },
    freeze:    { tier: 3, name: "FREEZE",     color: "#7cf7ff", dur: 5,  desc: "hazards stop 5s" }
  };
  var TIER_KEYS = {
    1: ["shield", "slow", "magnet"],
    2: ["phase", "blast", "x2"],
    3: ["overdrive", "revive", "freeze"]
  };

  // ================= data: sectors =================
  var SECTORS = [
    { id: 1, code: "S01", name: "IGNITION",
      story: "Systems waking up. Learn the ropes: collect 5 data shards before the gate powers down.",
      objective: { type: "shards", need: 5, time: 45 },
      pattern: "basic", speedMul: 0.9,
      palette: { bg1: "#081229", bg2: "#010615", grid: "rgba(0,240,255,0.10)", accent: "#00f0ff", enemy: "#ffa87d", shard: "#ffd75d" } },
    { id: 2, code: "S02", name: "NEON RAIN",
      story: "Dive into the neon storm city. Graze blocks without dying — 10 grazes breach the shield ceiling.",
      objective: { type: "graze", need: 10, time: 50 },
      pattern: "rain", speedMul: 1.1,
      palette: { bg1: "#150a2c", bg2: "#05010f", grid: "rgba(255,43,214,0.12)", accent: "#ff2bd6", enemy: "#ff8ad4", shard: "#7ce7ff" } },
    { id: 3, code: "S03", name: "PULSE GRID",
      story: "Firewall ahead. Laser walls sweep down with a single telegraphed gap. Phase or blast your way through.",
      objective: { type: "survive", time: 45 },
      pattern: "walls", speedMul: 1.15,
      palette: { bg1: "#041b17", bg2: "#010a08", grid: "rgba(93,255,154,0.12)", accent: "#5dff9a", enemy: "#ffb454", shard: "#00f0ff" } },
    { id: 4, code: "S04", name: "VOID STORM",
      story: "Gravity is wrong here. Stalkers hunt you. Bait them into open lanes and hold the line.",
      objective: { type: "survive", time: 45 },
      pattern: "homing", speedMul: 1.25,
      palette: { bg1: "#120733", bg2: "#03011a", grid: "rgba(177,140,255,0.13)", accent: "#b18cff", enemy: "#ff5d8a", shard: "#ffd75d" } },
    { id: 5, code: "S05", name: "CORE BREACH",
      story: "The reactor fights back. Overload 3 nodes while the core is vulnerable — dodge the spiral otherwise.",
      objective: { type: "boss", need: 3, time: 70 },
      pattern: "boss", speedMul: 1.2,
      palette: { bg1: "#2a0a06", bg2: "#0d0201", grid: "rgba(255,100,60,0.12)", accent: "#ff643c", enemy: "#ffb454", shard: "#ffd75d" } },
    { id: 6, code: "S06", name: "NULL PROTOCOL",
      story: "Classified. Everything at once. Survive 90 seconds in the void.",
      objective: { type: "survive", time: 90 },
      pattern: "mix", speedMul: 1.3, secret: true,
      palette: { bg1: "#0a0a0a", bg2: "#000000", grid: "rgba(255,255,255,0.10)", accent: "#ffffff", enemy: "#ff2bd6", shard: "#00f0ff" } }
  ];

  var PHASES = [
    { name: "PHASE 01 — DRIZZLE",        pattern: "basic" },
    { name: "PHASE 02 — OVERDRIVE",      pattern: "rain" },
    { name: "PHASE 03 — FIREWALL",       pattern: "walls" },
    { name: "PHASE 04 — HUNT",           pattern: "homing" },
    { name: "PHASE 05 — CROSSFIRE",      pattern: "crossfire" },
    { name: "PHASE 06 — TOTAL COLLAPSE", pattern: "mix" }
  ];

  var BOT_SPECS = {
    rookie:     { maxSpeed: 230, error: 55, react: 0.34 },
    pro:        { maxSpeed: 360, error: 22, react: 0.20 },
    nightmare:  { maxSpeed: 520, error: 7,  react: 0.10 }
  };

  // ================= game state =================
  var G = {
    mode: null, state: "idle", sector: null, difficulty: "rookie",
    score: 0, lives: 3, elapsed: 0, timeLeft: 0,
    spawnT: 0, spawnGap: 0.8, phaseIdx: 0, phaseClock: 0, pkTmr: 4, shardTmr: 0,
    bannerT: 0,
    slowT: 0, freezeT: 0, magnetT: 0, phaseUpT: 0, x2T: 0, overT: 0,
    shield: 0, hasRevive: false,
    shake: 0, flash: 0,
    graze: 0, shards: 0, combo: 0, comboT: 0,
    ghostScore: false, won: false,
    bot: null, seed: 0, rng: null
  };

  var player = null;
  var obstacles = [];
  var pickups = [];
  var shardItems = [];
  var bullets = [];
  var particles = [];
  var popups = [];
  var boss = null;
  var stars = [];
  (function () {
    for (var i = 0; i < 70; i++) {
      stars.push({ x: Math.random() * 960, y: Math.random() * 540, z: Math.random() * 0.8 + 0.2, s: Math.random() * 2 + 0.6 });
    }
  })();

  function makeShip(x, color) {
    return { x: x, y: 470, w: 54, h: 26, speed: 560, color: color, invuln: 0, trail: [] };
  }

  function tierMax() {
    if (G.mode === "classic" || G.mode === "null") {
      var sid = G.sector ? G.sector.id : 1;
      if (sid >= 5) return 3;
      if (sid >= 3) return 2;
      return 1;
    }
    if (G.mode === "endless") {
      if (G.elapsed >= 180) return 3;
      if (G.elapsed >= 60) return 2;
      return 1;
    }
    if (G.mode === "multiplayer") {
      if (G.elapsed >= 90) return 3;
      if (G.elapsed >= 45) return 2;
      return 1;
    }
    return 3;
  }

  function startMode(mode, opts) {
    opts = opts || {};
    G.mode = mode;
    G.difficulty = opts.difficulty || G.difficulty;
    G.score = 0;
    G.elapsed = 0;
    G.graze = 0;
    G.shards = 0;
    G.combo = 0;
    G.slowT = G.freezeT = G.magnetT = G.phaseUpT = G.x2T = G.overT = 0;
    G.shield = 0;
    G.hasRevive = false;
    G.shake = G.flash = 0;
    G.ghostScore = secretFlag;   // ghost runs never persist
    G.won = false;
    G.seed = (Math.random() * 0xffffffff) >>> 0;
    G.rng = makeRng(G.seed);
    G.pkTmr = 4;
    G.shardTmr = 0;
    obstacles = []; pickups = []; shardItems = []; bullets = []; particles = []; popups = [];
    boss = null;
    G.bot = null;

    if (mode === "classic" || mode === "null") {
      if (mode === "null") {
        G.sector = SECTORS[5];
      } else {
        var sid = opts.sector || Math.min(prog.unlocked, 5);
        G.sector = SECTORS[sid - 1];
      }
      G.lives = 3;
      G.timeLeft = G.sector.objective.time;
      G.spawnGap = G.sector.pattern === "boss" ? 9 : 0.85;
      G.phaseIdx = 0;
      player = makeShip(453, G.sector.palette.accent);
      showScreen("game");
      briefing();
      return;
    }

    if (mode === "endless") {
      G.sector = null;
      G.lives = 1;
      G.timeLeft = 0;
      G.spawnGap = 0.8;
      G.phaseIdx = 0;
      G.phaseClock = 0;
      player = makeShip(453, "#00f0ff");
      beginPlay();
      return;
    }

    if (mode === "multiplayer") {
      G.sector = null;
      G.lives = 1;
      G.timeLeft = 0;
      G.spawnGap = 0.75;
      G.phaseIdx = 0;
      var spec = BOT_SPECS[G.difficulty] || BOT_SPECS.rookie;
      player = makeShip(200, "#00f0ff");
      player.laneMax = 440;
      G.bot = {
        ship: makeShip(700, "#ff2bd6"),
        spec: spec,
        alive: true,
        thinkT: 0,
        targetX: 700,
        laneMin: 520,
        laneMax: 930
      };
      showScreen("game");
      beginPlay();
    }
  }

  // ================= overlays / flow =================
  function showOverlay(html) {
    overlayPanel.innerHTML = html;
    overlay.hidden = false;
  }
  function hideOverlay() { overlay.hidden = true; overlayPanel.innerHTML = ""; }

  function showBanner(text, seconds) {
    bannerEl.textContent = text;
    bannerEl.hidden = false;
    G.bannerT = seconds || 1.6;
    Sfx.banner();
  }

  function briefing() {
    G.state = "briefing";
    var s = G.sector;
    var obj = s.objective;
    var goal =
      obj.type === "shards" ? "Collect " + obj.need + " data shards in " + obj.time + "s"
      : obj.type === "graze" ? "Land " + obj.need + " grazes in " + obj.time + "s"
      : obj.type === "boss" ? "Overload " + obj.need + " nodes in " + obj.time + "s"
      : "Survive " + obj.time + "s";
    showOverlay(
      '<h2>' + s.code + " — " + s.name + '</h2>' +
      '<p class="story">' + s.story + "</p>" +
      '<div class="stats"><span>OBJECTIVE: ' + goal + "</span><span>LIVES: " + G.lives + "</span></div>" +
      '<p class="story">Power-ups up to tier ' + tierMax() + " in this sector.</p>" +
      '<div class="btn-row">' +
      '<button class="ghost-btn primary" data-act="start">START [SPACE]</button>' +
      '<button class="ghost-btn" data-act="home">HOME</button></div>'
    );
    hudStatus.textContent = "BRIEFING";
    hudMidVal.textContent = s.code + " " + s.name;
    hudScore.textContent = "0";
    draw();
  }

  function beginPlay() {
    hideOverlay();
    G.state = "playing";
    G.spawnT = 0;
    G.elapsed = 0;
    lastT = performance.now();
    hudStatus.textContent = "LIVE";
    Sfx.blip();
    if (G.mode === "endless") showBanner(PHASES[0].name, 1.4);
    if (G.mode === "multiplayer") showBanner("RACE — LAST ALIVE WINS", 1.6);
    if (G.mode === "null") showBanner("NULL PROTOCOL", 1.6);
    startLoop();
  }

  function togglePause(force) {
    if (G.state !== "playing" && G.state !== "paused") return;
    var pause = force != null ? force : G.state === "playing";
    if (pause) {
      G.state = "paused";
      hudStatus.textContent = "PAUSED";
      showOverlay(
        '<h2>PAUSED</h2><div class="btn-row">' +
        '<button class="ghost-btn primary" data-act="resume">RESUME [P]</button>' +
        '<button class="ghost-btn" data-act="restart">RESTART</button>' +
        '<button class="ghost-btn" data-act="home">HOME</button></div>'
      );
    } else {
      G.state = "playing";
      hudStatus.textContent = "LIVE";
      hideOverlay();
      lastT = performance.now();
    }
  }

  // ================= spawning =================
  function addBlock(x, y, w, h, speed, color, extra) {
    var o = { x: x, y: y, w: w, h: h, vy: speed, vx: 0, type: "block", color: color, grazed: false };
    if (extra) for (var k in extra) o[k] = extra[k];
    obstacles.push(o);
    return o;
  }

  function paletteNow() {
    if (G.sector) return G.sector.palette;
    var pals = [
      { bg1: "#081229", bg2: "#010615", grid: "rgba(0,240,255,0.10)", accent: "#00f0ff", enemy: "#ffa87d", shard: "#ffd75d" },
      { bg1: "#150a2c", bg2: "#05010f", grid: "rgba(255,43,214,0.12)", accent: "#ff2bd6", enemy: "#ff8ad4", shard: "#7ce7ff" },
      { bg1: "#041b17", bg2: "#010a08", grid: "rgba(93,255,154,0.12)", accent: "#5dff9a", enemy: "#ffb454", shard: "#00f0ff" },
      { bg1: "#120733", bg2: "#03011a", grid: "rgba(177,140,255,0.13)", accent: "#b18cff", enemy: "#ff5d8a", shard: "#ffd75d" },
      { bg1: "#2a0a06", bg2: "#0d0201", grid: "rgba(255,100,60,0.12)", accent: "#ff643c", enemy: "#ffb454", shard: "#ffd75d" },
      { bg1: "#0a0a0a", bg2: "#000000", grid: "rgba(255,255,255,0.10)", accent: "#ffffff", enemy: "#ff2bd6", shard: "#00f0ff" }
    ];
    return pals[Math.min(G.phaseIdx, pals.length - 1)];
  }

  function spawnPattern(pattern, rng) {
    var r = rng || Math.random;
    var pal = paletteNow();
    var base = (G.mode === "endless" ? 150 + G.elapsed * 1.6 : 170) * (G.sector ? G.sector.speedMul : 1);
    function blockSpeed() { return base + r() * 90; }
    // multiplayer: keep hazards fair — spawn one per lane so both racers face the same pressure
    var lane = null;
    if (G.mode === "multiplayer") {
      lane = (r() < 0.5) ? { min: 8, max: 440 } : { min: 520, max: 952 };
    }

    if (pattern === "basic" || pattern === "rain") {
      var count = pattern === "rain" ? 1 + ((r() * 2) | 0) : 1;
      for (var i = 0; i < count; i++) {
        var size = 26 + r() * 34;
        if (lane) {
          addBlock(lane.min + r() * Math.max(10, lane.max - lane.min - size), -size - r() * 40, size, size, blockSpeed(), pal.enemy);
          lane = (lane.min < 500) ? { min: 520, max: 952 } : { min: 8, max: 440 };
        } else {
          addBlock(r() * (960 - size), -size - r() * 40, size, size, blockSpeed(), pal.enemy);
        }
      }
    } else if (pattern === "walls") {
      var spd = blockSpeed() * 0.9;
      if (G.mode === "multiplayer") {
        // one wall-with-gap per lane: both racers dodge the same beat
        [{ min: 0, max: 480 }, { min: 480, max: 960 }].forEach(function (L) {
          var gapW = 130 + r() * 50;
          var gapX = L.min + 16 + r() * Math.max(10, (L.max - L.min) - gapW - 32);
          addBlock(L.min, -26, Math.max(0, gapX - L.min), 26, spd, pal.enemy, { type: "wall", grazed: true });
          addBlock(gapX + gapW, -26, Math.max(0, L.max - (gapX + gapW)), 26, spd, pal.enemy, { type: "wall", grazed: true });
          obstacles.push({ x: gapX, y: -46, w: gapW, h: 20, vy: spd, vx: 0, type: "warn", color: pal.accent, grazed: true });
        });
      } else {
        var gapW0 = 150 + r() * 70;
        var gapX0 = 30 + r() * (960 - gapW0 - 60);
        addBlock(0, -26, gapX0, 26, spd, pal.enemy, { type: "wall", grazed: true });
        addBlock(gapX0 + gapW0, -26, 960 - (gapX0 + gapW0), 26, spd, pal.enemy, { type: "wall", grazed: true });
        obstacles.push({ x: gapX0, y: -46, w: gapW0, h: 20, vy: spd, vx: 0, type: "warn", color: pal.accent, grazed: true });
      }
    } else if (pattern === "homing") {
      if (G.mode === "multiplayer") {
        [{ min: 8, max: 440 }, { min: 520, max: 952 }].forEach(function (L) {
          var s2 = 30 + r() * 14;
          addBlock(L.min + r() * Math.max(10, L.max - L.min - s2), -s2, s2, s2, 140 + r() * 60, pal.enemy, { type: "homing", homeT: 2.0, laneMin: L.min, laneMax: L.max });
        });
      } else {
        var hs = 34 + r() * 16;
        addBlock(r() * (960 - hs), -hs, hs, hs, 140 + r() * 60, pal.enemy, { type: "homing", homeT: 2.0 });
      }
    } else if (pattern === "crossfire") {
      var fromLeft = r() > 0.5;
      var sz = 30 + r() * 20;
      addBlock(fromLeft ? -sz : 960, 60 + r() * 260, sz, sz, 60, pal.enemy, {
        type: "block", vx: (fromLeft ? 1 : -1) * (140 + r() * 90), vy: 40 + r() * 60
      });
    } else if (pattern === "mix") {
      var which = (r() * 4) | 0;
      spawnPattern(["rain", "walls", "homing", "crossfire"][which], r);
    }
  }

  function spawnPickup() {
    var tm = tierMax();
    var keys = [];
    for (var t = 1; t <= tm; t++) keys = keys.concat(TIER_KEYS[t]);
    var weighted = keys.slice();
    if (tm >= 2) weighted = weighted.concat(TIER_KEYS[2]);
    if (tm >= 3) weighted = weighted.concat(TIER_KEYS[3]);
    var kind = pick(weighted);
    var spec = POWERUPS[kind];
    var px = rand(30, 930);
    if (G.mode === "multiplayer") px = rand(30, 400);   // player lane only — bot doesn't use power-ups
    pickups.push({ x: px, y: -20, w: 24, h: 24, vy: 130, kind: kind, color: spec.color });
  }

  function spawnShard() {
    shardItems.push({ x: rand(30, 930), y: -16, w: 18, h: 18, vy: 150 });
  }

  // ================= boss (S05) =================
  function initBoss() {
    boss = {
      x: 480, y: 110, r: 64, hp: 3, maxHp: 3,
      fireT: 1.2, rot: 0,
      nodeIdx: 0, nodeT: 1.5, nodeOpen: false,
      hitFlash: 0
    };
    showBanner("CORE BREACH — OVERLOAD 3 NODES", 2);
  }

  function bossNodePos(i) {
    var a = (i / 3) * TAU + boss.rot * 0.4 + Math.PI / 2;
    return { x: boss.x + Math.cos(a) * (boss.r + 34), y: boss.y + Math.sin(a) * (boss.r + 34), r: 17 };
  }

  function updateBoss(dt) {
    if (!boss) initBoss();
    var b = boss;
    b.rot += dt * 0.6;
    b.hitFlash = Math.max(0, b.hitFlash - dt);

    b.nodeT -= dt;
    if (b.nodeT <= 0) {
      b.nodeOpen = !b.nodeOpen;
      if (b.nodeOpen) b.nodeT = 2.4;
      else { b.nodeT = 1.2; b.nodeIdx = (b.nodeIdx + 1) % 3; }
    }

    b.fireT -= dt;
    if (b.fireT <= 0) {
      b.fireT = 0.42;
      for (var k = 0; k < 5; k++) {
        var a = b.rot + (k / 5) * TAU;
        bullets.push({ x: b.x, y: b.y, vx: Math.cos(a) * 165, vy: Math.sin(a) * 165, r: 7 });
      }
    }

    if (b.nodeOpen && player.invuln <= 0) {
      var np = bossNodePos(b.nodeIdx);
      var pcx = player.x + player.w / 2, pcy = player.y + player.h / 2;
      var d = Math.hypot(pcx - np.x, pcy - np.y);
      if (d < np.r + 16) {
        b.hp--;
        b.hitFlash = 0.3;
        player.invuln = 1.0;
        G.score += 500;
        addPopup(np.x, np.y, "NODE " + b.hp + " DOWN!", "#ffd75d");
        burst(np.x, np.y, "#ffd75d", 26);
        G.shake = 12;
        Sfx.hit();
        if (b.hp <= 0) {
          boss = null;
          bullets = [];
          winRun();
          return;
        }
        b.nodeOpen = false;
        b.nodeT = 1.2;
        b.nodeIdx = (b.nodeIdx + 1) % 3;
      }
    }
  }

  // ================= power-ups =================
  function applyPickup(kind) {
    var spec = POWERUPS[kind];
    if (!spec) return;
    Sfx.pickup();
    addPopup(player.x + player.w / 2, player.y - 8, spec.name, spec.color);
    if (kind === "shield") G.shield = Math.max(G.shield, 1);
    else if (kind === "slow") G.slowT = spec.dur;
    else if (kind === "magnet") G.magnetT = spec.dur;
    else if (kind === "phase") { G.phaseUpT = spec.dur; Sfx.phaseSfx(); }
    else if (kind === "blast") {
      for (var i = 0; i < obstacles.length; i++) {
        burst(obstacles[i].x + obstacles[i].w / 2, obstacles[i].y + obstacles[i].h / 2, "#ff9a5d", 6);
      }
      obstacles = [];
      G.shake = 10;
      Sfx.phaseSfx();
    }
    else if (kind === "x2") G.x2T = spec.dur;
    else if (kind === "overdrive") { G.overT = spec.dur; G.magnetT = Math.max(G.magnetT, spec.dur); G.x2T = Math.max(G.x2T, spec.dur); }
    else if (kind === "revive") { G.lives++; G.hasRevive = true; }
    else if (kind === "freeze") G.freezeT = spec.dur;
  }

  // ================= damage =================
  function damagePlayer() {
    if (secretFlag) return;                    // owner inert
    if (G.state !== "playing") return;
    if (player.invuln > 0 || G.phaseUpT > 0) return;
    if (G.shield > 0) {
      G.shield--;
      player.invuln = 1.1;
      addPopup(player.x + player.w / 2, player.y - 6, "SHIELD!", "#5dff9a");
      burst(player.x + player.w / 2, player.y + player.h / 2, "#5dff9a", 14);
      Sfx.blip();
      return;
    }
    G.lives--;
    player.invuln = 1.5;
    G.shake = 14;
    G.flash = 0.25;
    G.combo = 0;
    burst(player.x + player.w / 2, player.y + player.h / 2, "#ff5d8a", 22);
    Sfx.hit();
    if (G.lives <= 0) {
      if (G.hasRevive) {
        G.hasRevive = false;
        G.lives = 1;
        player.invuln = 2.4;
        addPopup(player.x + player.w / 2, player.y - 6, "REVIVED", "#ffffff");
        Sfx.phaseSfx();
        return;
      }
      loseRun();
    }
  }

  // ================= particles / popups =================
  function burst(x, y, color, n) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * TAU, sp = rand(40, 260);
      particles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.3, 0.8), t: 0, color: color, s: rand(1.5, 4) });
    }
  }
  function addPopup(x, y, text, color) {
    popups.push({ x: x, y: y, text: text, color: color, t: 0, life: 0.9 });
  }

  // ================= win / lose / rank =================
  function computeRank() {
    var total = Math.floor(G.score + G.timeLeft * 12 + G.lives * 600 + G.graze * 30);
    if (total >= 3000) return "S";
    if (total >= 2100) return "A";
    if (total >= 1300) return "B";
    return "C";
  }

  function rankBetter(a, b) {
    var order = { C: 0, B: 1, A: 2, S: 3 };
    return order[a] > order[b];
  }

  function winRun() {
    G.state = "over";
    G.won = true;
    Sfx.win();
    G.flash = 0.5;

    if (G.mode === "classic") {
      var s = G.sector;
      var rank = computeRank();
      var prev = prog.ranks[s.id];
      if (!G.ghostScore && (!prev || rankBetter(rank, prev))) prog.ranks[s.id] = rank;
      if (!G.ghostScore && s.id === prog.unlocked && s.id < 6) prog.unlocked = s.id + 1;
      var allS = true;
      for (var i = 1; i <= 5; i++) if (prog.ranks[i] !== "S") { allS = false; break; }
      var wasNull = prog.nullUnlocked;
      if (allS && !G.ghostScore) prog.nullUnlocked = true;
      if (!G.ghostScore) saveProgress();
      var nextReady = s.id + 1 <= prog.unlocked && s.id < 5;
      showOverlay(
        '<h2 class="win">' + s.code + " CLEARED</h2>" +
        '<div class="rank">' + (G.ghostScore ? "—" : rank) + "</div>" +
        '<div class="stats"><span>SCORE ' + Math.floor(G.score) + "</span><span>TIME LEFT " + Math.ceil(G.timeLeft) + "s</span><span>GRAZES " + G.graze + "</span></div>" +
        (allS && !wasNull && !G.ghostScore ? '<p class="story">&#8961; CLASSIFIED UPLINK DETECTED — S06 NULL PROTOCOL UNLOCKED &#8961;</p>' : "") +
        '<div class="btn-row">' +
        (nextReady ? '<button class="ghost-btn primary" data-act="next">NEXT SECTOR</button>' : "") +
        '<button class="ghost-btn" data-act="retry">RETRY</button>' +
        '<button class="ghost-btn" data-act="home">HOME</button></div>'
      );
      hudStatus.textContent = "CLEARED";
      return;
    }

    if (G.mode === "null") {
      var bestN = Store.get(K.bestNull, 0);
      var sc = Math.floor(G.score);
      if (!G.ghostScore && sc > bestN) Store.set(K.bestNull, sc);
      showOverlay(
        '<h2 class="win">NULL BREACHED</h2><div class="stats"><span>SCORE ' + sc + "</span></div>" +
        '<p class="story">VOIDBORN skin secured.</p>' +
        '<div class="btn-row"><button class="ghost-btn primary" data-act="retry">AGAIN</button>' +
        '<button class="ghost-btn" data-act="home">HOME</button></div>'
      );
      hudStatus.textContent = "BREACHED";
      return;
    }

    if (G.mode === "endless") {
      var sc2 = Math.floor(G.score);
      var bestE = Store.get(K.bestEndless, 0);
      if (!G.ghostScore && sc2 > bestE) Store.set(K.bestEndless, sc2);
      showOverlay(
        '<h2 class="win">SURVIVED</h2><div class="stats"><span>SCORE ' + sc2 + "</span><span>PHASE " + (G.phaseIdx + 1) + "</span></div>" +
        '<div class="btn-row"><button class="ghost-btn primary" data-act="retry">RUN AGAIN</button>' +
        '<button class="ghost-btn" data-act="home">HOME</button></div>'
      );
      return;
    }

    if (G.mode === "multiplayer") botWinFlow(true);
  }

  function loseRun() {
    G.state = "over";
    Sfx.lose();
    var sc = Math.floor(G.score);

    if (G.mode === "classic") {
      showOverlay(
        '<h2 class="lose">SIGNAL LOST</h2>' +
        '<div class="stats"><span>' + G.sector.code + "</span><span>SCORE " + sc + "</span></div>" +
        '<div class="btn-row"><button class="ghost-btn primary" data-act="retry">RETRY</button>' +
        '<button class="ghost-btn" data-act="home">HOME</button></div>'
      );
      hudStatus.textContent = "DOWN";
      return;
    }
    if (G.mode === "null") {
      var bestN = Store.get(K.bestNull, 0);
      if (!G.ghostScore && sc > bestN) Store.set(K.bestNull, sc);
      showOverlay('<h2 class="lose">NULL COLLAPSE</h2><div class="stats"><span>SCORE ' + sc + "</span></div>" +
        '<div class="btn-row"><button class="ghost-btn primary" data-act="retry">RETRY</button>' +
        '<button class="ghost-btn" data-act="home">HOME</button></div>');
      hudStatus.textContent = "DOWN";
      return;
    }
    if (G.mode === "endless") {
      var bestE = Store.get(K.bestEndless, 0);
      if (!G.ghostScore && sc > bestE) Store.set(K.bestEndless, sc);
      showOverlay('<h2 class="lose">STORM WINS</h2><div class="stats"><span>SCORE ' + sc + "</span><span>PHASE " + (G.phaseIdx + 1) + "</span></div>" +
        '<div class="btn-row"><button class="ghost-btn primary" data-act="retry">RETRY</button>' +
        '<button class="ghost-btn" data-act="home">HOME</button></div>');
      hudStatus.textContent = "DOWN";
      return;
    }
    if (G.mode === "multiplayer") {
      var botDead = G.bot && !G.bot.alive;
      botWinFlow(botDead);
    }
  }

  function botWinFlow(playerWon) {
    var wins = Store.get(K.botWins, 0);
    if (playerWon) {
      if (!G.ghostScore) { wins += 1; Store.set(K.botWins, wins); }
      else wins += 1;
    }
    showOverlay(
      '<h2 class="' + (playerWon ? "win" : "lose") + '">' + (playerWon ? "YOU OUTLASTED THE BOT" : "BOT OUTLASTED YOU") + "</h2>" +
      '<div class="stats"><span>SURVIVED ' + G.elapsed.toFixed(1) + "s</span><span>WINS " + wins + "</span></div>" +
      '<div class="btn-row"><button class="ghost-btn primary" data-act="retry">REMATCH</button>' +
      '<button class="ghost-btn" data-act="lobby">LOBBY</button>' +
      '<button class="ghost-btn" data-act="home">HOME</button></div>'
    );
    hudStatus.textContent = playerWon ? "VICTORY" : "DEFEAT";
  }

  // ================= update helpers =================
  function updatePlayer(dt) {
    var x = player.x;
    if (Input.pointerDown) {
      x = (Input.pointerX - view.ox) / (view.scale || 1) - player.w / 2;
    } else {
      if (Input.keys.ArrowLeft || Input.keys.a) x -= player.speed * dt;
      if (Input.keys.ArrowRight || Input.keys.d) x += player.speed * dt;
    }
    var maxX = player.laneMax || 960;
    player.x = clamp(x, 8, Math.min(960, maxX) - player.w - 8);
    player.trail.push({ x: player.x + player.w / 2, y: player.y + player.h, t: 0.35 });
    if (player.trail.length > 26) player.trail.shift();
    player.invuln = Math.max(0, player.invuln - dt);
  }

  function updateBot(dt) {
    var b = G.bot;
    if (!b || !b.alive) return;
    var s = b.ship;
    b.thinkT -= dt;
    if (b.thinkT <= 0) {
      b.thinkT = b.spec.react;
      var best = null, bestD = 1e9;
      for (var i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        if (o.x + o.w < b.laneMin || o.x > b.laneMax) continue;
        if (o.type === "warn") continue;
        if (o.y > s.y + s.h) continue;                 // already passed the ship
        var d = s.y - (o.y + o.h);                     // gap to closest edge; smaller = more urgent
        if (d >= -30 && d < bestD) { bestD = d; best = o; }
      }
      if (best) {
        var cand = [];
        if (best.x - s.w - 14 >= b.laneMin) cand.push(best.x - s.w - 14);
        if (best.x + best.w + 14 + s.w <= b.laneMax) cand.push(best.x + best.w + 14);
        var tx;
        if (!cand.length) tx = b.laneMin;
        else if (cand.length === 1) tx = cand[0];
        else tx = Math.abs(cand[0] - s.x) < Math.abs(cand[1] - s.x) ? cand[0] : cand[1];
        b.targetX = tx + rand(-b.spec.error, b.spec.error);
      } else {
        b.targetX = b.laneMin + (b.laneMax - b.laneMin) / 2 - s.w / 2;
      }
      b.targetX = clamp(b.targetX, b.laneMin, b.laneMax - s.w);
    }
    s.x += clamp(b.targetX - s.x, -b.spec.maxSpeed * dt, b.spec.maxSpeed * dt);
    s.x = clamp(s.x, b.laneMin, b.laneMax - s.w);
    s.trail.push({ x: s.x + s.w / 2, y: s.y + s.h, t: 0.35 });
    if (s.trail.length > 26) s.trail.shift();
    s.invuln = Math.max(0, s.invuln - dt);
  }

  function currentPattern() {
    if (G.mode === "classic" || G.mode === "null") return G.sector.pattern;
    if (G.mode === "endless") return PHASES[Math.min(G.phaseIdx, PHASES.length - 1)].pattern;
    if (G.mode === "multiplayer") {
      if (G.elapsed < 25) return "basic";
      if (G.elapsed < 50) return "rain";
      if (G.elapsed < 75) return "walls";
      if (G.elapsed < 100) return "homing";
      return "mix";
    }
    return "basic";
  }

  function objReady() {
    var obj = G.sector && G.sector.objective;
    if (!obj) return false;
    if (obj.type === "shards") return G.shards >= obj.need;
    if (obj.type === "graze") return G.graze >= obj.need;
    return false;
  }

  // ================= update =================
  function updatePlay(dt) {
    G.elapsed += dt;

    var tkeys = ["slowT", "freezeT", "magnetT", "phaseUpT", "x2T", "overT"];
    for (var ti = 0; ti < tkeys.length; ti++) {
      if (G[tkeys[ti]] > 0) G[tkeys[ti]] = Math.max(0, G[tkeys[ti]] - dt);
    }
    G.comboT = Math.max(0, G.comboT - dt);
    if (G.comboT <= 0) G.combo = 0;
    G.shake = Math.max(0, G.shake - dt * 40);
    G.flash = Math.max(0, G.flash - dt);
    if (G.bannerT > 0) {
      G.bannerT -= dt;
      if (G.bannerT <= 0) bannerEl.hidden = true;
    }

    if (G.sector) {
      G.timeLeft -= dt;
      if (G.timeLeft <= 0) {
        G.timeLeft = 0;
        if (G.sector.objective.type === "survive") winRun();
        else loseRun();
        return;
      }
      if (objReady()) { winRun(); return; }
    }

    updatePlayer(dt);
    if (G.mode === "multiplayer") updateBot(dt);

    if (G.mode === "endless") {
      G.phaseClock += dt;
      if (G.phaseClock >= 30) {
        G.phaseClock = 0;
        if (G.phaseIdx < PHASES.length - 1) {
          G.phaseIdx++;
          showBanner(PHASES[G.phaseIdx].name, 1.6);
        }
      }
    }

    G.spawnT += dt;
    var gap = 0.8;
    if (G.mode === "endless") gap = Math.max(0.26, 0.8 - G.elapsed * 0.006);
    else if (G.mode === "multiplayer") gap = Math.max(0.3, 0.75 - G.elapsed * 0.004);
    else if (G.mode === "null") gap = 0.6;
    else if (G.sector) gap = G.sector.pattern === "boss" ? 9 : G.spawnGap;
    if (G.spawnT >= gap) {
      G.spawnT = 0;
      var pat = currentPattern();
      if (pat !== "boss") spawnPattern(pat);
    }

    if (G.sector && G.sector.objective.type === "shards") {
      G.shardTmr += dt;
      if (G.shardTmr >= 2.2) { G.shardTmr = 0; spawnShard(); }
    }

    G.pkTmr -= dt;
    if (G.pkTmr <= 0) { G.pkTmr = rand(6, 9); spawnPickup(); }

    var speedScale = 1;
    if (G.slowT > 0) speedScale *= 0.45;
    if (G.freezeT > 0) speedScale *= 0.02;
    if (G.mode === "multiplayer" && G.elapsed > 90) {
      speedScale *= 1 + Math.floor((G.elapsed - 90) / 10) * 0.5;   // sudden death
    }

    // obstacles
    for (var i = obstacles.length - 1; i >= 0; i--) {
      var ob = obstacles[i];
      if (ob.type === "homing" && ob.homeT > 0 && player) {
        ob.homeT -= dt;
        // multiplayer: homing drones stay in their own lane (fair race)
        var tgt = (G.bot && ob.laneMin != null && (player.x + player.w / 2) > 480 !== (ob.laneMin > 480))
          ? G.bot.ship : player;
        var tAlive = (tgt === player) || (G.bot && G.bot.alive);
        var pc = (tgt.x + tgt.w / 2);
        if (tAlive) ob.x += clamp(pc - (ob.x + ob.w / 2), -120 * dt, 120 * dt);
        if (ob.laneMin != null) ob.x = clamp(ob.x, ob.laneMin, Math.max(ob.laneMin, ob.laneMax - ob.w));
      }
      ob.y += ob.vy * dt * speedScale;
      ob.x += (ob.vx || 0) * dt;
      if (ob.x < 0 && ob.vx) { ob.x = 0; ob.vx *= -1; }
      if (ob.x + ob.w > 960 && ob.vx) { ob.x = 960 - ob.w; ob.vx *= -1; }
      if (ob.y > 560 + ob.h) { obstacles.splice(i, 1); continue; }
      if (ob.type === "warn") continue;

      if (G.phaseUpT <= 0 && player.invuln <= 0 && aabb({ x: player.x, y: player.y, w: player.w, h: player.h }, ob)) {
        damagePlayer();
        if (G.state === "over") return;
      }
      // graze detection
      if (!ob.grazed && player && G.phaseUpT <= 0) {
        var overlapX = player.x + player.w > ob.x && player.x < ob.x + ob.w;
        var nearY = ob.y + ob.h > player.y - 26 && ob.y < player.y + player.h + 26;
        var noHit = !(overlapX && ob.y < player.y + player.h && ob.y + ob.h > player.y);
        if (overlapX && nearY && noHit) {
          ob.grazed = true;
          G.graze++;
          G.combo++;
          G.comboT = 2.2;
          var bonus = 25 * Math.max(1, Math.min(G.combo, 8));
          G.score += bonus * (G.x2T > 0 ? 2 : 1);
          addPopup(player.x + player.w / 2, player.y - 10, "GRAZE +" + bonus, "#7ce7ff");
          Sfx.graze();
        }
      }
      // bot collision
      if (G.bot && G.bot.alive && G.bot.ship.invuln <= 0 && G.phaseUpT <= 0) {
        var bs = G.bot.ship;
        if (aabb({ x: bs.x, y: bs.y, w: bs.w, h: bs.h }, ob)) {
          G.bot.alive = false;
          burst(bs.x + bs.w / 2, bs.y + bs.h / 2, "#ff2bd6", 20);
          Sfx.hit();
        }
      }
    }

    if (G.mode === "multiplayer") {
      if (!G.bot.alive) { winRun(); return; }
    }

    // shards
    for (var j = shardItems.length - 1; j >= 0; j--) {
      var sh = shardItems[j];
      if (G.magnetT > 0 || G.overT > 0) {
        sh.x += clamp((player.x + player.w / 2 - sh.x), -260 * dt, 260 * dt);
        sh.y += clamp((player.y - sh.y), -260 * dt, 260 * dt);
      }
      sh.y += sh.vy * dt * speedScale;
      if (sh.y > 560) { shardItems.splice(j, 1); continue; }
      if (aabb({ x: player.x, y: player.y, w: player.w, h: player.h }, sh)) {
        shardItems.splice(j, 1);
        G.shards++;
        G.score += 100 * (G.x2T > 0 ? 2 : 1);
        addPopup(sh.x, sh.y, "SHARD " + G.shards, "#ffd75d");
        burst(sh.x, sh.y, "#ffd75d", 8);
        Sfx.pickup();
      }
    }

    // power-up pickups
    for (var p = pickups.length - 1; p >= 0; p--) {
      var pk = pickups[p];
      pk.y += pk.vy * dt * speedScale;
      if (pk.y > 560) { pickups.splice(p, 1); continue; }
      if (aabb({ x: player.x, y: player.y, w: player.w, h: player.h }, pk)) {
        pickups.splice(p, 1);
        applyPickup(pk.kind);
      }
    }

    // boss + bullets
    if (G.sector && G.sector.pattern === "boss" && G.state === "playing") {
      updateBoss(dt);
      if (G.state === "over") return;
      for (var bi = bullets.length - 1; bi >= 0; bi--) {
        var bl = bullets[bi];
        bl.x += bl.vx * dt * speedScale;
        bl.y += bl.vy * dt * speedScale;
        if (bl.x < -20 || bl.x > 980 || bl.y < -20 || bl.y > 560) { bullets.splice(bi, 1); continue; }
        if (player.invuln <= 0 && G.phaseUpT <= 0) {
          var dx = (player.x + player.w / 2) - bl.x;
          var dy = (player.y + player.h / 2) - bl.y;
          if (dx * dx + dy * dy < (bl.r + 14) * (bl.r + 14)) {
            damagePlayer();
            bullets.splice(bi, 1);
            if (G.state === "over") return;
          }
        }
      }
    }

    // score tick
    var mult = (G.x2T > 0 || G.overT > 0) ? 2 : 1;
    G.score += dt * 30 * mult;

    // particles / popups
    var pi;
    for (pi = particles.length - 1; pi >= 0; pi--) {
      var pa = particles[pi];
      pa.t += dt;
      if (pa.t >= pa.life) { particles.splice(pi, 1); continue; }
      pa.x += pa.vx * dt;
      pa.y += pa.vy * dt;
      pa.vx *= 0.96;
      pa.vy *= 0.96;
    }
    for (pi = popups.length - 1; pi >= 0; pi--) {
      var pp = popups[pi];
      pp.t += dt;
      if (pp.t >= pp.life) { popups.splice(pi, 1); continue; }
      pp.y -= 34 * dt;
    }

    // HUD
    var mid;
    if (G.sector) {
      var ot = G.sector.objective.type;
      var need = G.sector.objective.need || 0;
      var goalV =
        ot === "shards" ? "SHARDS " + G.shards + "/" + need
        : ot === "graze" ? "GRAZES " + G.graze + "/" + need
        : ot === "boss" ? "NODES " + (boss ? need - boss.hp : 0) + "/" + need
        : "SURVIVE";
      mid = G.sector.code + " · " + goalV + " · " + Math.ceil(G.timeLeft) + "s · LIVES " + G.lives;
    } else if (G.mode === "endless") {
      mid = "PHASE " + (G.phaseIdx + 1) + " · TIER " + tierMax() + (G.shield ? " · SHIELD" : "");
    } else if (G.mode === "multiplayer") {
      mid = "RACE · " + G.elapsed.toFixed(1) + "s" + (G.elapsed > 90 ? " · SUDDEN DEATH" : "");
    } else mid = "—";
    hudMidVal.textContent = mid;
    hudScore.textContent = Math.floor(G.score);
  }

  // ================= draw =================
  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  }

  function drawBackground(time, pal) {
    var g = ctx.createLinearGradient(0, 0, 0, 540);
    g.addColorStop(0, pal.bg1);
    g.addColorStop(1, pal.bg2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 960, 540);

    for (var i = 0; i < stars.length; i++) {
      var st = stars[i];
      var y = (st.y + time * 0.02 * st.z * 60) % 540;
      ctx.fillStyle = "rgba(255,255,255," + (0.10 + st.z * 0.35) + ")";
      ctx.fillRect(st.x, y, st.s, st.s);
    }

    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1;
    var off = (time * 0.03) % 45;
    ctx.beginPath();
    for (var gy = -45 + off; gy < 540; gy += 45) { ctx.moveTo(0, gy); ctx.lineTo(960, gy); }
    for (var gx = 0; gx < 960; gx += 60) { ctx.moveTo(gx, 0); ctx.lineTo(gx, 540); }
    ctx.stroke();

    if (G.mode === "multiplayer") {
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.setLineDash([10, 12]);
      ctx.beginPath();
      ctx.moveTo(480, 0); ctx.lineTo(480, 540);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = "600 14px Rajdhani, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("YOU", 240, 500);
      ctx.fillText("BOT", 720, 500);
      ctx.textAlign = "left";
    }
  }

  function drawShip(s, label) {
    for (var i = 0; i < s.trail.length; i++) {
      var t = s.trail[i];
      t.t -= 0.016;
      var a = t.t < 0 ? 0 : t.t;
      ctx.fillStyle = "rgba(0,240,255," + (a * 0.5) + ")";
      ctx.fillRect(t.x - 3, t.y, 6, 8);
    }
    if (s.invuln > 0 && Math.floor(performance.now() / 90) % 2 === 0) return;

    ctx.save();
    if (G.phaseUpT > 0) ctx.globalAlpha = 0.45;
    if (secretFlag) { ctx.shadowColor = "#7cf7ff"; ctx.shadowBlur = 24; }
    else { ctx.shadowColor = s.color; ctx.shadowBlur = 18; }
    ctx.fillStyle = s.color;
    roundRect(s.x, s.y, s.w, s.h, 9);
    ctx.fillStyle = "rgba(2,10,24,0.85)";
    ctx.fillRect(s.x + s.w / 2 - 7, s.y + 5, 14, s.h - 10);
    ctx.fillStyle = "#ffb454";
    var flick = 6 + Math.random() * 8;
    ctx.beginPath();
    ctx.moveTo(s.x + 10, s.y + s.h);
    ctx.lineTo(s.x + 16, s.y + s.h + flick);
    ctx.lineTo(s.x + 22, s.y + s.h);
    ctx.moveTo(s.x + s.w - 22, s.y + s.h);
    ctx.lineTo(s.x + s.w - 16, s.y + s.h + flick);
    ctx.lineTo(s.x + s.w - 10, s.y + s.h);
    ctx.fill();
    ctx.restore();

    if (label) {
      ctx.fillStyle = s.color;
      ctx.font = "700 12px Orbitron, sans-serif";
      ctx.fillText(label, s.x, s.y - 8);
    }
  }

  function drawObstacles() {
    for (var i = 0; i < obstacles.length; i++) {
      var o = obstacles[i];
      if (o.type === "warn") {
        ctx.strokeStyle = "rgba(0,240,255,0.7)";
        ctx.setLineDash([8, 8]);
        ctx.lineWidth = 2;
        ctx.strokeRect(o.x, o.y, o.w, o.h);
        ctx.setLineDash([]);
        continue;
      }
      ctx.save();
      ctx.shadowColor = o.color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = o.color;
      roundRect(o.x, o.y, o.w, o.h, o.type === "wall" ? 4 : 8);
      if (o.type === "homing") {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(o.x + o.w / 2, o.y + o.h / 2, 5, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawPickups(time) {
    var i, p;
    for (i = 0; i < pickups.length; i++) {
      p = pickups[i];
      ctx.save();
      ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
      ctx.rotate(time * 0.003);
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 16;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 3;
      ctx.strokeRect(-10, -10, 20, 20);
      ctx.fillStyle = p.color;
      ctx.font = "700 10px Orbitron, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(POWERUPS[p.kind].name[0], 0, 4);
      ctx.restore();
      ctx.textAlign = "left";
    }
    for (i = 0; i < shardItems.length; i++) {
      p = shardItems[i];
      ctx.save();
      ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
      ctx.rotate(time * 0.004);
      ctx.shadowColor = "#ffd75d";
      ctx.shadowBlur = 14;
      ctx.fillStyle = "#ffd75d";
      ctx.beginPath();
      ctx.moveTo(0, -9); ctx.lineTo(7, 0); ctx.lineTo(0, 9); ctx.lineTo(-7, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawBoss(time) {
    if (!boss) return;
    var b = boss;
    ctx.save();
    var pulse = 1 + Math.sin(time * 0.006) * 0.06;
    ctx.strokeStyle = "rgba(255,100,60,0.5)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(b.x, b.y, (b.r + 18) * pulse, 0, TAU);
    ctx.stroke();
    ctx.shadowColor = b.hitFlash > 0 ? "#ffffff" : "#ff643c";
    ctx.shadowBlur = 30;
    ctx.fillStyle = b.hitFlash > 0 ? "#ffffff" : "#ff643c";
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r + 30, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = "#ffd75d";
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r + 30, -Math.PI / 2, -Math.PI / 2 + TAU * (b.hp / b.maxHp));
    ctx.stroke();
    for (var n = 0; n < 3; n++) {
      var np = bossNodePos(n);
      var open = b.nodeOpen && n === b.nodeIdx;
      ctx.fillStyle = open ? "#00f0ff" : "rgba(255,255,255,0.25)";
      ctx.shadowColor = open ? "#00f0ff" : "transparent";
      ctx.shadowBlur = open ? 22 : 0;
      ctx.beginPath();
      ctx.arc(np.x, np.y, open ? np.r : np.r - 5, 0, TAU);
      ctx.fill();
      if (open) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(np.x, np.y, np.r + 7, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.restore();

    ctx.shadowColor = "#ff9a5d";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "#ffb454";
    for (var i = 0; i < bullets.length; i++) {
      var bl = bullets[i];
      ctx.beginPath();
      ctx.arc(bl.x, bl.y, bl.r, 0, TAU);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  function drawFx() {
    var i;
    for (i = 0; i < particles.length; i++) {
      var p = particles[i];
      ctx.globalAlpha = 1 - p.t / p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.s, p.s);
    }
    ctx.globalAlpha = 1;
    for (i = 0; i < popups.length; i++) {
      var pp = popups[i];
      ctx.globalAlpha = 1 - pp.t / pp.life;
      ctx.fillStyle = pp.color;
      ctx.font = "700 15px Orbitron, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(pp.text, pp.x, pp.y);
    }
    ctx.textAlign = "left";
    ctx.globalAlpha = 1;
  }

  function draw(time) {
    if (!player) return;
    time = time || performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#010615";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);

    var pal = paletteNow();
    var shx = G.shake > 0 ? rand(-G.shake, G.shake) * 0.4 : 0;
    var shy = G.shake > 0 ? rand(-G.shake, G.shake) * 0.4 : 0;
    ctx.save();
    ctx.translate(shx, shy);

    drawBackground(time, pal);
    drawPickups(time);
    drawObstacles();
    drawBoss(time);
    drawShip(player, null);
    if (G.bot && G.bot.alive) drawShip(G.bot.ship, G.difficulty.toUpperCase());
    drawFx();

    if (G.shield > 0) {
      ctx.strokeStyle = "rgba(93,255,154,0.8)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(player.x + player.w / 2, player.y + player.h / 2, 42, 0, TAU);
      ctx.stroke();
    }
    if (G.magnetT > 0 || G.overT > 0) {
      ctx.strokeStyle = "rgba(255,124,231,0.35)";
      ctx.setLineDash([6, 10]);
      ctx.beginPath();
      ctx.arc(player.x + player.w / 2, player.y + player.h / 2, 120, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();

    if (G.flash > 0) {
      ctx.fillStyle = "rgba(255,43,214," + (G.flash * 0.7) + ")";
      ctx.fillRect(0, 0, 960, 540);
    }
    if (secretFlag) {
      ctx.strokeStyle = "rgba(124,247,255,0.55)";
      ctx.lineWidth = 4;
      ctx.strokeRect(4, 4, 952, 532);
    }
  }

  // ================= loop =================
  var rafId = null;
  var lastT = 0;

  function startLoop() {
    if (rafId) return;
    lastT = performance.now();
    rafId = requestAnimationFrame(loop);
  }
  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    var dt = Math.min(0.05, (ts - lastT) / 1000);
    lastT = ts;
    if (G.state === "playing") updatePlay(dt);
    draw(ts);
  }

  // ================= events =================
  function activeScreen() {
    var el = null;
    try { el = document.querySelector(".screen.active"); } catch (e) { el = null; }
    if (!el || !el.id) return "home";
    return String(el.id).replace("screen-", "");
  }

  window.addEventListener("keydown", function (e) {
    var k = (e && e.key != null) ? String(e.key) : "";
    if (!k) return;
    if (k === " " || k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
      e.preventDefault();
    }
    var keyName = k.length === 1 ? k.toLowerCase() : k;
    Input.keys[keyName] = true;
    noteKey(k.length === 1 ? k : "");

    if (k === " " || k === "Spacebar") {
      if (G.state === "briefing") beginPlay();
      else if (G.state === "paused") togglePause(false);
      return;
    }
    if (k === "p" || k === "P" || k === "Escape") { togglePause(); return; }
    if (k === "m" || k === "M") { Sfx.toggle(); return; }
    if (k === "f" || k === "F") { toggleFullscreen(); return; }
    if (activeScreen() === "home") {
      if (k === "1") location.hash = "#/classic";
      if (k === "2") location.hash = "#/endless";
      if (k === "3") location.hash = "#/multiplayer";
      if (k === "4" && prog.nullUnlocked) location.hash = "#/null";
    }
    if (activeScreen() === "lobby") {
      if (k === "q" || k === "Q") startBot("rookie");
      if (k === "w" || k === "W") startBot("pro");
      if (k === "e" || k === "E") startBot("nightmare");
    }
  });

  window.addEventListener("keyup", function (e) {
    var keyName = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    Input.keys[keyName] = false;
  });

  function pointerPos(e) {
    var rect = canvas.getBoundingClientRect();
    return (e.clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
  }
  canvas.addEventListener("pointerdown", function (e) {
    Input.pointerDown = true;
    Input.pointerX = pointerPos(e);
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", function (e) {
    if (Input.pointerDown) Input.pointerX = pointerPos(e);
  });
  window.addEventListener("pointerup", function () { Input.pointerDown = false; });
  window.addEventListener("pointercancel", function () { Input.pointerDown = false; });

  function toggleFullscreen() {
    var doc = document;
    if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
      var el = doc.documentElement;
      if (el.requestFullscreen) el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } else {
      if (doc.exitFullscreen) doc.exitFullscreen();
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
    }
    setTimeout(fitCanvas, 120);
  }
  $$(".btn-full").forEach(function (b) { b.addEventListener("click", toggleFullscreen); });
  $$(".btn-mute").forEach(function (b) { b.addEventListener("click", function () { Sfx.toggle(); }); });

  document.addEventListener("fullscreenchange", function () { setTimeout(fitCanvas, 80); });
  if (window.ResizeObserver) new ResizeObserver(fitCanvas).observe(stage);
  window.addEventListener("resize", fitCanvas);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", fitCanvas);

  document.addEventListener("visibilitychange", function () {
    if (document.hidden && G.state === "playing") togglePause(true);
  });
  window.addEventListener("blur", function () {
    if (G.state === "playing") togglePause(true);
  });

  // ================= navigation / buttons =================
  function goHome() {
    stopLoop();
    G.state = "idle";
    hideOverlay();
    bannerEl.hidden = true;
    if (location.hash) location.hash = "";
    showScreen("home");
  }

  function goLobby() {
    stopLoop();
    G.state = "idle";
    hideOverlay();
    bannerEl.hidden = true;
    if (location.hash !== "#/multiplayer") location.hash = "#/multiplayer";
    showScreen("lobby");
  }

  function startBot(difficulty) {
    Sfx.ensure();
    if (location.hash) location.hash = "#/multiplayer";
    startMode("multiplayer", { difficulty: difficulty });
  }

  overlay.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    if (act === "start") beginPlay();
    else if (act === "resume") togglePause(false);
    else if (act === "home") goHome();
    else if (act === "lobby") goLobby();
    else if (act === "restart" || act === "retry") {
      hideOverlay();
      var mode = G.mode;
      var opts = { difficulty: G.difficulty };
      if (mode === "classic" && G.sector) opts.sector = G.sector.id;
      startMode(mode, opts);
    } else if (act === "next") {
      hideOverlay();
      var nextSid = Math.min((G.sector ? G.sector.id : 1) + 1, 5);
      startMode("classic", { sector: nextSid });
    }
  });

  $$(".mode-card[data-goto]").forEach(function (card) {
    function go() {
      var to = card.getAttribute("data-goto");
      Sfx.ensure();
      Sfx.blip();
      location.hash = to === "null" ? "#/null" : "#/" + to;
    }
    card.addEventListener("click", go);
    card.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  });
  $$(".mode-card[data-bot]").forEach(function (card) {
    function go() {
      Sfx.ensure();
      startBot(card.getAttribute("data-bot"));
    }
    card.addEventListener("click", go);
    card.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  });

  $("#btnLobbyHome").addEventListener("click", goHome);
  $("#btnPause").addEventListener("click", function () { togglePause(); });

  $("#btnRoom").addEventListener("click", function () {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    var code = "";
    for (var i = 0; i < 6; i++) code += chars[(Math.random() * chars.length) | 0];
    $("#roomCode").value = code;
    Sfx.blip();
    setTimeout(function () { $("#roomCode").value = ""; }, 2600);
  });

  var howto = $("#howto");
  $("#btnHowto").addEventListener("click", function () { howto.hidden = false; });
  $("#btnHowtoClose").addEventListener("click", function () { howto.hidden = true; });
  howto.addEventListener("click", function (e) { if (e.target === howto) howto.hidden = true; });

  // ================= init =================
  syncMuteBtns();
  fitCanvas();
  refreshHome();
  route();
  window.addEventListener("load", fitCanvas);
})();
