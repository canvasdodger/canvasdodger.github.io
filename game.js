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

  // daily challenge: local-date string + FNV-1a seed so every pilot flies
  // the same storm on the same day
  var DAILY_SECS = 120;
  function dailyDate(d) {
    d = d || new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }
  function dailySeed(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
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
    mute: "dodger_mute_v1",
    tutorial: "dodger_tutorial_v1",
    shipCustom: "dodger_ship_v1",
    dailyBest: "dodger_daily_best_v1"
  };

  // per-bot win keys (v2); legacy single counter migrates to easy
  var BOT_IDS = ["easy", "normal", "hard", "elite", "hell"];
  var BOT_ALIAS = { rookie: "easy", pro: "hard", nightmare: "hell" };
  function botWinsKey(id) { return "dodger_bot_wins_" + id + "_v2"; }
  function normalizeBot(id) {
    if (!id) return "easy";
    id = String(id).toLowerCase();
    if (BOT_ALIAS[id]) return BOT_ALIAS[id];
    return BOT_IDS.indexOf(id) >= 0 ? id : "easy";
  }
  function migrateBotWins() {
    try {
      var legacy = localStorage.getItem(K.botWins);
      if (legacy != null && localStorage.getItem(botWinsKey("easy")) == null) {
        localStorage.setItem(botWinsKey("easy"), legacy);
      }
    } catch (e) {}
  }
  migrateBotWins();
  function getBotWins(id) {
    var total = 0, per = {};
    BOT_IDS.forEach(function (b) {
      var v = Store.get(botWinsKey(b), 0) | 0;
      per[b] = v; total += v;
    });
    if (id) return per[normalizeBot(id)] || 0;
    return { total: total, per: per };
  }

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
    pickup: function () { this.tone(560 * cheatPitch(), 0.12, "triangle", 0.05, 1120 * cheatPitch()); },
    graze: function () { this.tone(980 * cheatPitch(), 0.05, "sine", 0.025); },
    hit: function () { this.tone(180, 0.28, "sawtooth", 0.06, 60); },
    phaseSfx: function () { this.tone(300, 0.3, "triangle", 0.05, 900); },
    banner: function () { this.tone(440, 0.16, "square", 0.04, 660); },
    win: function () { this.tone(520, 0.5, "triangle", 0.05, 1040); },
    lose: function () { this.tone(240, 0.6, "sawtooth", 0.05, 70); },
    // chord/arpeggio scheduler: notes = [freq, dur, type, gain, slideTo, delayMs]
    jingle: function (notes) {
      var self = this;
      (notes || []).forEach(function (n) {
        var delay = n[5] || 0;
        setTimeout(function () { self.tone(n[0], n[1], n[2], n[3], n[4]); }, delay);
      });
    },
    click: function () {
      // UI click: same as blip (alias kept for customizer/pilot handlers)
      Sfx.blip();
    },
    hover: function () { this.tone(1180, 0.04, "sine", 0.012); },
    // signature fanfare per cheat aura id (null = power-down)
    cheat: function (id) {
      var J = CHEAT_JINGLES[id];
      if (!id || !J) { this.tone(700, 0.08, "sine", 0.025, 420); return; }
      this.jingle(J);
    },
    shock: function () {
      this.tone(150, 0.25, "sawtooth", 0.06, 50);
      this.tone(1200, 0.15, "square", 0.035, 2400);
    },
    shieldRegen: function () { this.tone(660, 0.22, "sine", 0.04, 990); },
    phaseShift: function () { this.tone(500, 0.12, "sine", 0.018, 1000); },
    lifeGift: function () { this.tone(520, 0.3, "triangle", 0.05, 1040); },
    // tiered combo stinger: tier 0 = silent, 1 = tick, 2 = fifth, 3 = octave + shimmer
    comboSting: function (tier, base) {
      if (tier <= 0) return;
      var b = base || 660;
      if (tier === 1) this.tone(b, 0.07, "square", 0.028, b * 1.5);
      else if (tier === 2) {
        this.tone(b, 0.08, "square", 0.03, b * 1.5);
        this.tone(b * 1.5, 0.1, "triangle", 0.03, b * 2);
      } else {
        this.tone(b, 0.09, "square", 0.032, b * 2);
        this.tone(b * 2, 0.14, "triangle", 0.032, b * 3);
        this.tone(b * 3, 0.16, "sine", 0.02, b * 4);
      }
    },
    // ---- ambient aura drone: one soft looping voice per cheat, started/stopped with the aura
    drone: null, // { osc, osc2, gain, id }
    droneStart: function (id) {
      this.droneStop();
      var D = CHEAT_DRONES[id];
      if (!D) return;
      var c = this.ensure(); if (!c) return;
      try {
        var o1 = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain();
        o1.type = D.wave || "sine"; o2.type = D.wave || "sine";
        o1.frequency.setValueAtTime(D.f1, c.currentTime);
        o2.frequency.setValueAtTime(D.f2, c.currentTime);
        g.gain.setValueAtTime(0.0001, c.currentTime);
        g.gain.exponentialRampToValueAtTime(D.gain || 0.014, c.currentTime + 1.2);
        o1.connect(g); o2.connect(g); g.connect(c.destination);
        o1.start(); o2.start();
        this.drone = { osc: o1, osc2: o2, gain: g, id: id };
      } catch (e) { this.drone = null; }
    },
    droneStop: function () {
      var d = this.drone; this.drone = null;
      if (!d) return;
      try {
        var c = this.ctx, t = c ? c.currentTime : 0;
        d.gain.gain.cancelScheduledValues(t);
        d.gain.gain.setValueAtTime(Math.max(0.0001, d.gain.gain.value), t);
        d.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        var o1 = d.osc, o2 = d.osc2;
        setTimeout(function () { try { o1.stop(); o2.stop(); } catch (e2) {} }, 450);
      } catch (e) {}
    },
    // pause keeps the aura but ducks the hum; resume brings it back
    droneDuck: function (ducked) {
      var d = this.drone;
      if (!d || !this.ctx) return;
      try {
        var t = this.ctx.currentTime;
        var full = 0.014;
        try { if (CHEAT_DRONES[d.id] && CHEAT_DRONES[d.id].gain) full = CHEAT_DRONES[d.id].gain; } catch (e2) {}
        d.gain.gain.cancelScheduledValues(t);
        d.gain.gain.setValueAtTime(Math.max(0.0001, d.gain.gain.value), t);
        d.gain.gain.exponentialRampToValueAtTime(ducked ? 0.0001 : full, t + 0.3);
      } catch (e) {}
    },
    toggle: function () {
      this.muted = !this.muted;
      Store.set(K.mute, this.muted);
      if (this.muted) this.droneStop();
      else { this.blip(); if (activeCheat) this.droneStart(activeCheat); }
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

  // ================= cheat-code arsenal =================
  // Keystroke-stream words; never stored or logged. One aura active at a time.
  // Top tier (invincible): thunderfist / kiphnic / kwoffie. Unique tier: zee / naya / ella.
  var CHEATS = {
    thunderfist: { tag: "THUNDERFIST", color: "#ffd75d", glow: "#7c5dff",
      ship: "#ffd75d", trail: "255,215,93",
      env: { bg1: "#1a1040", bg2: "#05020f", grid: "rgba(124,93,255,0.20)", accent: "#ffd75d", enemy: "#7c5dff", shard: "#ffe9a8" },
      invuln: true, ram: true, shockT: 6, title: "THUNDERFIST AWAKENS" },
    kiphnic: { tag: "KIPHNIC", color: "#ffffff", glow: "#7cf7ff",
      ship: "#ffffff", trail: "124,247,255",
      env: { bg1: "#020208", bg2: "#000000", grid: "rgba(255,255,255,0.16)", accent: "#7cf7ff", enemy: "#5d6bff", shard: "#7cf7ff" },
      invuln: true, magnet: true, scoreMul: 2, title: "KIPHNIC ASCENDANT" },
    kwoffie: { tag: "KWOFFIE", color: "#ff9a3c", glow: "#ff3c00",
      ship: "#ff9a3c", trail: "255,120,40",
      env: { bg1: "#2a0e02", bg2: "#0a0200", grid: "rgba(255,120,40,0.20)", accent: "#ff9a3c", enemy: "#ff3c5d", shard: "#ffd75d" },
      invuln: true, vacuum: 340, scoreMul: 3, bonusLife: true, title: "KWOFFIE IGNITES" },
    zee: { tag: "ZEE", color: "#5dff9a", glow: "#00ff88",
      ship: "#5dff9a", trail: "93,255,154",
      env: { bg1: "#021a0e", bg2: "#000804", grid: "rgba(0,255,136,0.18)", accent: "#5dff9a", enemy: "#ff8a3c", shard: "#d2ffe2" },
      invuln: false, speedMul: 1.45, scoreMul: 1.25, title: "ZEE UNLEASHED" },
    naya: { tag: "NAYA", color: "#5dd7ff", glow: "#2b7fff",
      ship: "#5dd7ff", trail: "93,215,255",
      env: { bg1: "#041a24", bg2: "#010a10", grid: "rgba(43,127,255,0.20)", accent: "#5dd7ff", enemy: "#b18cff", shard: "#c8f1ff" },
      invuln: false, regenShield: 8, title: "NAYA WATCHES OVER YOU" },
    ella: { tag: "ELLA", color: "#c99aff", glow: "#7c2bff",
      ship: "#c99aff", trail: "201,154,255",
      env: { bg1: "#150826", bg2: "#060210", grid: "rgba(124,43,255,0.22)", accent: "#c99aff", enemy: "#ff5d8a", shard: "#ecd9ff" },
      invuln: false, phaseCycle: true, title: "ELLA SLIPS THE VEIL" }
  };
  var CHEAT_WORDS = ["thunderfist", "kiphnic", "kwoffie", "zee", "naya", "ella"];
  var activeCheat = null;      // id string or null
  var cheatShockT = 0;         // thunderfist shockwave timer
  var cheatShieldT = 0;        // naya regen timer
  var cheatPhaseT = 0;         // ella phase clock
  var cheatPhaseWasDodge = false; // ella veil edge (sound only on shift)
  var cheatLifeGiven = false;  // kwoffie +1 life, once per run (no farm)
  var ghostDotT = 0;

  // signature fanfares: [freq, dur, type, gain, slideTo, delayMs]
  // thunderfist = storm strike, kiphnic = void-god rise, kwoffie = solar bloom,
  // zee = speedster zip, naya = guardian swell, ella = phantom shimmer
  var CHEAT_JINGLES = {
    thunderfist: [
      [110, 0.3, "sawtooth", 0.06, 55, 0],
      [880, 0.12, "square", 0.05, 1760, 60],
      [1320, 0.2, "square", 0.05, 660, 180]
    ],
    kiphnic: [
      [220, 0.25, "sine", 0.05, 440, 0],
      [440, 0.25, "sine", 0.05, 880, 120],
      [880, 0.35, "triangle", 0.055, 1760, 240]
    ],
    kwoffie: [
      [330, 0.18, "triangle", 0.05, 495, 0],
      [495, 0.18, "triangle", 0.05, 660, 110],
      [660, 0.3, "triangle", 0.055, 1320, 220]
    ],
    zee: [
      [500, 0.08, "square", 0.04, 1000, 0],
      [750, 0.08, "square", 0.04, 1500, 70],
      [1000, 0.14, "square", 0.045, 2000, 140]
    ],
    naya: [
      [392, 0.22, "sine", 0.05, 392, 0],
      [523, 0.22, "sine", 0.05, 523, 130],
      [784, 0.3, "triangle", 0.05, 784, 260]
    ],
    ella: [
      [700, 0.16, "sine", 0.04, 350, 0],
      [500, 0.16, "sine", 0.04, 1000, 110],
      [900, 0.24, "triangle", 0.04, 450, 220]
    ]
  };

  function cheatDef() { return activeCheat ? CHEATS[activeCheat] : null; }

  // ambient drone voices (dual detuned oscillators) + possessed pickup/graze pitch per aura
  var CHEAT_DRONES = {
    thunderfist: { f1: 55, f2: 82.5, wave: "sawtooth", gain: 0.008 },
    kiphnic:     { f1: 110, f2: 165, wave: "sine", gain: 0.016 },
    kwoffie:     { f1: 130.8, f2: 196, wave: "triangle", gain: 0.014 },
    zee:         { f1: 220, f2: 330, wave: "square", gain: 0.006 },
    naya:        { f1: 196, f2: 261.6, wave: "sine", gain: 0.015 },
    ella:        { f1: 174.6, f2: 261.6, wave: "sine", gain: 0.012 }
  };
  // combo-stinger voice per aura: base freq + combo thresholds for tier1/2/3
  var CHEAT_STING = {
    thunderfist: { base: 520, t1: 3, t2: 5, t3: 8 },
    kiphnic:     { base: 660, t1: 3, t2: 5, t3: 8 },
    kwoffie:     { base: 590, t1: 3, t2: 5, t3: 8 },
    zee:         { base: 880, t1: 2, t2: 4, t3: 6 },
    naya:        { base: 440, t1: 3, t2: 6, t3: 8 },
    ella:        { base: 740, t1: 3, t2: 5, t3: 8 }
  };
  function comboTier(combo) {
    var S = CHEAT_STING[activeCheat];
    if (!S) return 0;
    if (combo >= S.t3) return 3;
    if (combo >= S.t2) return 2;
    if (combo >= S.t1) return 1;
    return 0;
  }
  var CHEAT_PITCH = {
    thunderfist: 0.85,
    kiphnic: 1.3,
    kwoffie: 1.15,
    zee: 1.5,
    naya: 1.0,
    ella: 0.7
  };
  function cheatPitch() {
    if (!activeCheat) return 1;
    return CHEAT_PITCH[activeCheat] || 1;
  }

  // unified score multiplier: pickup x2 * cheat aura (kiphnic 2x, kwoffie 3x, zee 1.25x)
  function scoreMult() {
    var m = (G.x2T > 0 || G.overT > 0) ? 2 : 1;
    var cd = cheatDef();
    if (cd && cd.scoreMul) m *= cd.scoreMul;
    return m;
  }

  function noteKey(ch) {
    if (!ch || !/[a-z]/i.test(ch)) return;
    if (activeScreen() === "lobby") return;   // lobby bot keys (q/w/e/r/t) win there
    Input.seq = (Input.seq + ch.toLowerCase()).slice(-14);
    for (var i = 0; i < CHEAT_WORDS.length; i++) {
      var w = CHEAT_WORDS[i];
      if (Input.seq.slice(-w.length) === w) {
        Input.seq = "";
        toggleCheat(w);
        return;
      }
    }
  }

  // swallow p/m/f only when that key continues a cheat word (kiphnic, kwoffie, thunderfist)
  function cheatSwallow(keyName) {
    if (activeScreen() === "lobby") return false;
    if (keyName !== "p" && keyName !== "m" && keyName !== "f") return false;
    var tail = (Input.seq + keyName).slice(-14);
    for (var i = 0; i < CHEAT_WORDS.length; i++) {
      var w = CHEAT_WORDS[i];
      if (w.indexOf(keyName) < 0) continue;
      for (var n = 1; n <= w.length; n++) {
        if (tail.slice(-n) === w.slice(0, n)) return true;
      }
      if (tail.slice(-w.length) === w) return true;
    }
    return false;
  }

  function toggleCheat(id) {
    activeCheat = (activeCheat === id) ? null : id;
    var def = cheatDef();
    cheatShockT = (def && def.shockT) || 0;
    cheatShieldT = 0;
    cheatPhaseT = 0;
    cheatPhaseWasDodge = !!(def && def.phaseCycle); // start in dodge so first shift plays
    if (player) {
      if (def) {
        player.color = def.ship;
        if (def.bonusLife && G.state === "playing" && !cheatLifeGiven) {
          cheatLifeGiven = true;
          G.lives = Math.min(5, G.lives + 1);
          Sfx.lifeGift();
        }
      } else {
        // aura off: restore the ship's own paint job
        player.color = paintById(player.paint || HANGAR.paint).hex;
      }
    }
    flashCheatDot();
    cheatFanfare(def);
    syncAuraChip();
    if (def) Sfx.droneStart(activeCheat);
    else Sfx.droneStop();
  }

  function cheatFanfare(def) {
    if (!def) { Sfx.cheat(null); return; }
    G.flash = 0.5;
    G.shake = 14;
    if (player) {
      burst(player.x + player.w / 2, player.y + player.h / 2, def.color, 40);
      addPopup(player.x + player.w / 2, player.y - 16, def.title, def.color);
    }
    showBanner("⚡ " + def.title + " ⚡", 2.0);
    Sfx.cheat(activeCheat);
  }

  function flashCheatDot() {
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
  var auraCell = $("#auraCell");
  var auraChip = $("#auraChip");
  var bannerEl = $("#banner");
  var overlay = $("#overlay");
  var overlayPanel = $("#overlayPanel");

  // aura HUD chip: shows active cheat tag in its color, hidden when no aura
  function syncAuraChip() {
    if (!auraCell || !auraChip) return;
    var def = cheatDef();
    if (!def) { auraCell.hidden = true; }
    else {
      auraCell.hidden = false;
      auraCell.style.borderColor = def.color;
      auraCell.style.boxShadow = "0 0 18px " + def.glow;
      auraChip.style.color = def.color;
      auraChip.style.textShadow = "0 0 12px " + def.glow;
      auraChip.innerHTML = "";
      var dot = document.createElement("span");
      dot.className = "aura-dot";
      auraChip.appendChild(dot);
      auraChip.appendChild(document.createTextNode("⚡" + def.tag));
    }
    syncAuraPad();
  }

  // aura pad (mobile/mouse cheat entry): one tap = one toggleCheat, same path as typing
  var AURA_BLURB = {
    thunderfist: "INVINCIBLE · ram + 6s shock",
    kiphnic: "INVINCIBLE · magnet + 2x",
    kwoffie: "INVINCIBLE · 3x + vacuum + life",
    zee: "+45% speed · 1.25x",
    naya: "shield every 8s",
    ella: "4s phase / 2s solid"
  };
  function buildAuraPad() {
    var grid = $("#auraGrid");
    if (!grid || grid.children.length) return;
    CHEAT_WORDS.forEach(function (w) {
      var def = CHEATS[w];
      var b = document.createElement("button");
      b.className = "aura-btn";
      b.type = "button";
      b.setAttribute("data-aura", w);
      b.style.borderColor = def.color;
      b.style.color = def.color;
      b.innerHTML = "⚡" + def.tag + "<small>" + (AURA_BLURB[w] || "") + "</small>";
      b.addEventListener("click", function () {
        if (activeScreen() === "lobby") return;
        Sfx.ensure();
        toggleCheat(w);
      });
      grid.appendChild(b);
    });
  }
  function syncAuraPad() {
    var grid = $("#auraGrid");
    if (!grid) return;
    Array.prototype.forEach.call(grid.children, function (b) {
      b.classList.toggle("on", b.getAttribute("data-aura") === activeCheat);
    });
  }
  function openAuraPad() {
    if (activeScreen() === "lobby") return;
    buildAuraPad();
    syncAuraPad();
    var pad = $("#auraPad");
    if (!pad || !pad.hidden) return;
    if (G.state === "playing") togglePause(true);
    pad.hidden = false;
  }
  function closeAuraPad() {
    var pad = $("#auraPad");
    if (pad) pad.hidden = true;
  }

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
    syncAuraChip();
  }
  // ================= ship customizer data =================
  var SHIP_SHAPES = [
    { id: "arrow", label: "ARROW", icon: "▶" },
    { id: "dart",  label: "DART",  icon: "◄" },
    { id: "wasp",  label: "WASP",  icon: "⚡" },
    { id: "orb",   label: "ORB",   icon: "◎" },
    { id: "fang",  label: "FANG",  icon: "⚔" },
    { id: "veil",  label: "VEIL",  icon: "⌘" }
  ];
  var PAINTS = [
    { id: "cyan",   name: "CYAN",   hex: "#00f0ff" },
    { id: "lime",   name: "LIME",   hex: "#5dff9a" },
    { id: "magenta",name: "MAGENTA",hex: "#ff2bd6" },
    { id: "amber",  name: "AMBER",  hex: "#ffb454" },
    { id: "violet", name: "VIOLET", hex: "#b18cff" },
    { id: "rose",   name: "ROSE",   hex: "#ff5d8a" },
    { id: "ice",    name: "ICE",    hex: "#eaf6ff" },
    { id: "slate",  name: "SLATE",  hex: "#8d9bff" }
  ];
  var TRAILS = ["full", "short", "wisp"];
  var FLAIR = ["trim only", "rings", "wings", "crown"];
  var DEFAULT_SHIP = { shape: "arrow", paint: "cyan", trail: "full", flair: 0 };
  function paintById(id) {
    for (var i = 0; i < PAINTS.length; i++) if (PAINTS[i].id === id) return PAINTS[i];
    return PAINTS[0];
  }
  function shapeLabel(id) {
    for (var i = 0; i < SHIP_SHAPES.length; i++) if (SHIP_SHAPES[i].id === id) return SHIP_SHAPES[i].label;
    return "ARROW";
  }
  function hexRgba(hex, a) {
    var h = String(hex || "#00f0ff").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) n = 0x00f0ff;
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }
  function hangarColor(fallback) {
    return paintById(HANGAR && HANGAR.paint).hex || fallback || "#00f0ff";
  }

// ================= ship customizer (HANGAR) =================
var HANGAR = Store.get(K.shipCustom, { shape: "arrow", paint: "cyan", trail: "full", flair: 0 });
if (typeof HANGAR !== "object" || !HANGAR.shape) { HANGAR = DEFAULT_SHIP; Store.set(K.shipCustom, HANGAR); }

function openShipModal() {
  buildPaintChips();
  buildShapeRow();
  buildThumbRow();
  var sc = { shape: HANGAR.shape, paint: HANGAR.paint, trail: HANGAR.trail, flair: HANGAR.flair };
  setShipControls(sc);
  $$("input[name=flair]").forEach(function (r) { r.checked = (Number(r.value) === (HANGAR.flair || 0)); });
  $("#modalShip").hidden = false;
  try { document.querySelector("#modalShip").scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
}

function closeShipModal() {
  $("#modalShip").hidden = true;
  if (location.hash === "#/customize") location.hash = "";
}

function buildPaintChips() {
  var c = $("#paintChips");
  c.innerHTML = "";
  for (var i = 0; i < PAINTS.length; i++) {
    var b = document.createElement("button");
    b.className = "paint-chip";
    b.style.background = PAINTS[i].hex;
    b.style.color = PAINTS[i].hex;
    b.dataset.id = PAINTS[i].id;
    b.textContent = PAINTS[i].name;
    b.addEventListener("click", function () { pickPaint(this.dataset.id); });
    c.appendChild(b);
  }
}
function buildShapeRow() {
  var r = $("#shapeRow");
  r.innerHTML = "";
  for (var i = 0; i < SHIP_SHAPES.length; i++) {
    var d = document.createElement("div");
    d.className = "shape-cell";
    d.dataset.id = SHIP_SHAPES[i].id;
    d.innerHTML = '<div class="sd">' + SHIP_SHAPES[i].icon + '</div><div class="sn">' + SHIP_SHAPES[i].label + '</div>';
    d.title = "Select for your ship";
    d.addEventListener("click", function () { pickShape(this.dataset.id); });
    r.appendChild(d);
  }
}

function buildThumbRow() {
  var r = $("#thumbRow");
  r.innerHTML = "";
  for (var i = 0; i < PAINTS.length; i++) {
    var t = document.createElement("button");
    t.className = "thumb";
    t.style.background = PAINTS[i].hex;
    t.style.color = PAINTS[i].hex;
    t.dataset.id = PAINTS[i].id;
    t.innerHTML = '<span class="t-label">' + PAINTS[i].name + '</span>';
    t.addEventListener("click", function () { pickPaint(this.dataset.id); });
    r.appendChild(t);
  }
}

function pickPaint(id) {
  var css = ".paint-chip[data-id='" + id + "'], .thumb[data-id='" + id + "']";
  $(css).classList.remove("on");
  $(css).classList.add("on");
  HANGAR.paint = id;
  if (HANGAR.shape) { HANGAR.trail = HANGAR.trail || "full"; HANGAR.flair = HANGAR.flair || 0; }
  setShipControls({ shape: HANGAR.shape, paint: id, trail: HANGAR.trail, flair: HANGAR.flair });
}

function pickShape(id) {
  var shapes = SHIP_SHAPES;
  for (var i = 0; i < shapes.length; i++) {
    var el = $(".shape-cell[data-id='" + shapes[i].id + "']");
    el.classList.toggle("on", shapes[i].id === id);
  }
  HANGAR.shape = id;
  if (!HANGAR.paint) { pickPaint(HANGAR.paint); }
}

function setShipControls(sc) {
  HANGAR = sc;
  var sh = sc.shape || "arrow";
  var pt = sc.paint || "cyan";
  $$(".shape-cell.on").forEach(function (el) { el.classList.remove("on"); });
  $$(".paint-chip.on, .thumb.on").forEach(function (el) { el.classList.remove("on"); });
  var se = $(".shape-cell[data-id='" + sh + "']"); if (se) se.classList.add("on");
  $$(".paint-chip[data-id='" + pt + "'], .thumb[data-id='" + pt + "']").forEach(function (el) { el.classList.add("on"); });
}
function saveShip() {
  var fl = $("input[name=flair]:checked");
  HANGAR.flair = parseInt((fl && fl.value) || "0", 10) || 0;
  Store.set(K.shipCustom, HANGAR);
  closeShipModal();
  refreshHome();
  Sfx.click();
}

// ================= ship customizer wiring =================
var bs = $("#btnShipDone");
if (bs) bs.addEventListener("click", saveShip);
var bc = $("#btnShipClose");
if (bc) bc.addEventListener("click", closeShipModal);
window.addEventListener("keydown", function (e) { if (e.key === "6" && activeScreen() === "home") location.hash = "#/customize"; });

  function campaignSectors() {
    return SECTORS.filter(function (s) { return !s.secret; });
  }

  function rankSummary() {
    var s = 0, n = 0;
    campaignSectors().forEach(function (sec) {
      if (prog.ranks[sec.id]) { n++; if (prog.ranks[sec.id] === "S") s++; }
    });
    return s + "/" + n + " S-RANKS";
  }

  function sRankCount() {
    var s = 0;
    campaignSectors().forEach(function (sec) { if (prog.ranks[sec.id] === "S") s++; });
    return s;
  }

  function refreshHome() {
    var camp = campaignSectors();
    var maxId = camp.length ? camp[camp.length - 1].id : 5;
    var next = Math.min(prog.unlocked, maxId);
    $("#metaClassic").textContent = prog.unlocked > maxId
      ? "ALL SECTORS CLEARED — " + rankSummary()
      : "NEXT — SECTOR 0" + next;
    $("#metaEndless").textContent = "BEST — " + Store.get(K.bestEndless, 0);
    var md = $("#metaDaily");
    if (md) {
      var db = Store.get(K.dailyBest, {});
      md.textContent = "BEST TODAY — " + ((db && db[dailyDate()]) | 0);
    }
    var wins = getBotWins().total;
    $("#metaBot").textContent = "VS BOT — " + wins + " WIN" + (wins === 1 ? "" : "S");
    var ms = $("#metaShip");
    if (ms) ms.textContent = shapeLabel(HANGAR.shape) + " // " + paintById(HANGAR.paint).name
      + " // " + (FLAIR[HANGAR.flair] || "trim only");
    var per = getBotWins().per;
    $$("[data-botwins]").forEach(function (el) {
      var bid = el.getAttribute("data-botwins");
      var v = (per && per[bid]) || 0;
      el.textContent = v + " WIN" + (v === 1 ? "" : "S");
    });
    $("#metaNull").textContent = "BEST — " + Store.get(K.bestNull, 0);
    var nullCard = $("#cardNull");
    if (nullCard) nullCard.hidden = !prog.nullUnlocked;
    var tut = Store.get(K.tutorial, { done: false });
    var tutMeta = $("#metaTutorial");
    if (tutMeta) tutMeta.textContent = (tut && tut.done) ? "GRADUATED ✓" : "NOT GRADUATED";
  }

  function route() {
    var h = (location.hash || "").replace(/^#\/?/, "");
    if (h === "classic") { showScreen("game"); startMode("classic"); }
    else if (h === "tutorial") { showScreen("game"); startTutorial(); }
    else if (h === "endless") { showScreen("game"); startMode("endless"); }
    else if (h === "daily") { showScreen("game"); startMode("endless", { daily: dailyDate() }); }
    else if (h === "multiplayer") { stopLoop(); G.state = "idle"; hideOverlay(); bannerEl.hidden = true; showScreen("lobby"); refreshHome(); }
    else if (h === "null") {
      if (prog.nullUnlocked) { showScreen("game"); startMode("null"); }
      else location.hash = "";
    }
    else if (h === "customize") { showScreen("home"); refreshHome(); openShipModal(); }
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
    { id: 7, code: "S07", name: "SOLAR WINDS",
      story: "Stellar gales tear across the lane. Gust fronts shove your ship sideways — read the arrows, lean into the calm, survive the storm.",
      objective: { type: "survive", time: 50 },
      pattern: "winds", speedMul: 1.3,
      palette: { bg1: "#0a1a33", bg2: "#02060f", grid: "rgba(0,200,255,0.14)", accent: "#4dd8ff", enemy: "#9adcff", shard: "#ffd75d" } },
    { id: 8, code: "S08", name: "MIRROR SPLIT",
      story: "Prism shards incoming — big blocks fracture into twin seekers when grazed or blasted. Collect 8 shards in the hall of mirrors.",
      objective: { type: "shards", need: 8, time: 55 },
      pattern: "splitters", speedMul: 1.25,
      palette: { bg1: "#1c0f33", bg2: "#070313", grid: "rgba(255,124,231,0.14)", accent: "#ff7ce7", enemy: "#c9a7ff", shard: "#7ce7ff" } },
    { id: 9, code: "S09", name: "EVENT HORIZON",
      story: "The void has teeth. Rift portals blink open in pairs — fly through to teleport, but beware the singularity pull at the center. Graze 15 to collapse the horizon.",
      objective: { type: "graze", need: 15, time: 60 },
      pattern: "portals", speedMul: 1.35,
      palette: { bg1: "#050014", bg2: "#000000", grid: "rgba(120,80,255,0.16)", accent: "#8a5dff", enemy: "#ff5d8a", shard: "#ffd75d" } },
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

  // 5-bot ladder: easy < normal < hard < elite < hell (hell = final boss).
  // mistakeEvery: forced misread interval so even top bots stay beatable.
  var BOT_SPECS = {
    easy:      { maxSpeed: 180, error: 70, react: 0.42, mistakeEvery: 4.0, label: "EASY" },
    normal:    { maxSpeed: 300, error: 35, react: 0.26, mistakeEvery: 5.5, label: "NORMAL" },
    hard:      { maxSpeed: 380, error: 20, react: 0.18, mistakeEvery: 6.5, label: "HARD" },
    elite:     { maxSpeed: 600, error: 3,  react: 0.06, mistakeEvery: 7.0, label: "ELITE" },
    hell:      { maxSpeed: 560, error: 8,  react: 0.09, mistakeEvery: 6.0, label: "HELL" },
    // legacy aliases (old saves / keys keep working)
    rookie:    { maxSpeed: 180, error: 70, react: 0.42, mistakeEvery: 4.0, label: "EASY" },
    pro:       { maxSpeed: 380, error: 20, react: 0.18, mistakeEvery: 6.5, label: "HARD" },
    nightmare: { maxSpeed: 560, error: 8,  react: 0.09, mistakeEvery: 6.0, label: "HELL" }
  };

  // ================= game state =================
  var G = {
    mode: null, state: "idle", sector: null, difficulty: "easy",
    score: 0, lives: 3, elapsed: 0, timeLeft: 0,
    spawnT: 0, spawnGap: 0.8, phaseIdx: 0, phaseClock: 0, pkTmr: 4, shardTmr: 0,
    bannerT: 0,
    slowT: 0, freezeT: 0, magnetT: 0, phaseUpT: 0, x2T: 0, overT: 0,
    shield: 0, hasRevive: false,
    shake: 0, flash: 0,
    graze: 0, shards: 0, combo: 0, comboT: 0,
    ghostScore: false, won: false,
    bot: null, seed: 0, rng: null, daily: null
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

  function sectorById(id) {
    for (var i = 0; i < SECTORS.length; i++) if (SECTORS[i].id === id) return SECTORS[i];
    return SECTORS[0];
  }
  function nullSector() {
    for (var i = 0; i < SECTORS.length; i++) if (SECTORS[i].secret) return SECTORS[i];
    return SECTORS[SECTORS.length - 1];
  }

  function cheatShipColor(fallback) {
    var cd = cheatDef();
    return cd ? cd.ship : fallback;
  }

  function makeShip(x, color, opts) {
    opts = opts || {};
    return {
      x: x, y: 470, w: 54, h: 26, speed: 560,
      color: color, invuln: 0, trail: [],
      shape: opts.shape || "arrow",
      paint: opts.paint || "cyan",
      trailKind: opts.trailKind || "full",
      flair: opts.flair || 0
    };
  }
  function makePlayer(x, color) {
    return makeShip(x, color, {
      shape: HANGAR.shape, paint: HANGAR.paint,
      trailKind: HANGAR.trail, flair: HANGAR.flair
    });
  }

  function tierMax() {
    if (G.mode === "classic" || G.mode === "null") {
      var sid = G.sector ? G.sector.id : 1;
      if (sid === 6 || sid >= 7) return 3;   // null + S07+ get full arsenal
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
    G.daily = opts.daily || null;
    G.difficulty = normalizeBot(opts.difficulty || G.difficulty);
    G.score = 0;
    G.elapsed = 0;
    G.graze = 0;
    G.shards = 0;
    G.combo = 0;
    G.slowT = G.freezeT = G.magnetT = G.phaseUpT = G.x2T = G.overT = 0;
    G.shield = 0;
    G.hasRevive = false;
    G.shake = G.flash = 0;
    G.ghostScore = false;   // cheat runs persist normally
    cheatShockT = (activeCheat && CHEATS[activeCheat].shockT) || 0;
    cheatShieldT = 0;
    cheatPhaseT = 0;
    cheatPhaseWasDodge = !!(activeCheat && CHEATS[activeCheat].phaseCycle);
    cheatLifeGiven = false;
    if (activeCheat) Sfx.droneStart(activeCheat); else Sfx.droneStop();
    G.won = false;
    G.seed = G.daily ? dailySeed(G.daily) : (Math.random() * 0xffffffff) >>> 0;
    G.rng = makeRng(G.seed);
    G.pkTmr = 4;
    G.shardTmr = 0;
    obstacles = []; pickups = []; shardItems = []; bullets = []; particles = []; popups = [];
    boss = null;
    G.bot = null;

    if (mode === "classic" || mode === "null") {
      if (mode === "null") {
        G.sector = nullSector();
      } else {
        var campIds = campaignSectors().map(function (s) { return s.id; });
        var maxUnlock = campIds.length ? campIds[campIds.length - 1] : 5;
        var sid = opts.sector || Math.min(prog.unlocked, maxUnlock);
        if (campIds.indexOf(sid) < 0) sid = campIds[0];
        G.sector = sectorById(sid);
      }
      G.lives = 3;
      G.timeLeft = G.sector.objective.time;
      G.spawnGap = G.sector.pattern === "boss" ? 9 : 0.85;
      G.phaseIdx = 0;
      player = makePlayer(453, cheatShipColor(paintById(HANGAR.paint).hex));
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
      player = makePlayer(453, cheatShipColor(paintById(HANGAR.paint).hex));
      beginPlay();
      return;
    }

    if (mode === "tutorial") {
      // flight school: safe sandbox, scripted steps drive the lesson
      G.sector = null;
      G.lives = 99;
      G.timeLeft = 0;
      G.spawnGap = 1.1;
      G.phaseIdx = 0;
      G.phaseClock = 0;
      G.ghostScore = true;   // tutorial never touches ranks/bests
      player = makePlayer(453, cheatShipColor(paintById(HANGAR.paint).hex));
      showScreen("game");
      startTutorialSteps();
      beginPlay();
      return;
    }

    if (mode === "multiplayer") {
      G.sector = null;
      G.lives = 1;
      G.timeLeft = 0;
      G.spawnGap = 0.75;
      G.phaseIdx = 0;
      var spec = BOT_SPECS[G.difficulty] || BOT_SPECS.easy;
      player = makePlayer(200, cheatShipColor(paintById(HANGAR.paint).hex));
      player.laneMax = 440;
      G.bot = {
        ship: makeShip(700, "#ff2bd6"),
        spec: spec,
        botId: G.difficulty,
        alive: true,
        thinkT: 0,
        targetX: 700,
        mistakeT: (spec.mistakeEvery || 6) * 0.7,
        laneMin: 520,
        laneMax: 930
      };
      showScreen("game");
      beginPlay();
    }
  }

  // ================= tutorial (flight school) =================
  // 5 hands-on steps in a safe sandbox: move → dodge → graze → shard → shield.
  // No lives lost (damage is absorbed), nothing persists (ghost run).
  var TUT = { idx: 0, active: false, moveX0: 0, trackMove: 0, t0: 0, shardSpawned: 0, shieldSpawned: false };
  var TUT_STEPS = [
    { id: "move",   title: "MOVE",   text: "Move your ship: A/D, arrow keys, or drag. Travel across the arena to pass." },
    { id: "dodge",  title: "DODGE",  text: "Hazards are falling! Slip between them — touching one here only rattles you." },
    { id: "graze",  title: "GRAZE",  text: "Skim a block's edge without touching it. Grazes build combo + score!" },
    { id: "shard",  title: "SHARD",  text: "Golden shards incoming — fly into one to collect it." },
    { id: "shield", title: "SHIELD", text: "Green SHIELD pickup drops! Grab it — it absorbs one real hit out there." }
  ];
  function startTutorial() { startMode("tutorial"); }
  function startTutorialSteps() {
    TUT.idx = 0; TUT.active = true;
    TUT.moveX0 = player ? player.x : 453;
    TUT.trackMove = 0; TUT.t0 = G.elapsed;
    TUT.shardSpawned = 0; TUT.shieldSpawned = false;
    showCoach();
    coachSay(0);
    showBanner("FLIGHT SCHOOL — LESSON 1/5", 1.8);
  }
  function coachSay(i) {
    var bar = $("#coachbar");
    if (!bar) return;
    bar.hidden = false;
    var s = TUT_STEPS[i];
    $("#coachStep").textContent = "STEP " + (i + 1) + "/" + TUT_STEPS.length + " · " + s.title;
    $("#coachText").textContent = s.text;
    $("#coachFill").style.width = Math.round((i / TUT_STEPS.length) * 100) + "%";
  }
  function showCoach() { var b = $("#coachbar"); if (b) b.hidden = false; }
  function hideCoach() { var b = $("#coachbar"); if (b) b.hidden = true; }
  function tutStep() { return TUT_STEPS[TUT.idx] ? TUT_STEPS[TUT.idx].id : "done"; }
  function tutAdvance() {
    if (!TUT.active) return;
    Sfx.blip();
    if (player) burst(player.x + player.w / 2, player.y, "#5dff9a", 14);
    TUT.idx++;
    if (TUT.idx >= TUT_STEPS.length) { tutGraduate(); return; }
    TUT.t0 = G.elapsed;
    if (tutStep() === "shard") { TUT.shardSpawned = 0; }
    if (tutStep() === "shield") { TUT.shieldSpawned = false; }
    coachSay(TUT.idx);
    showBanner("LESSON " + (TUT.idx + 1) + "/" + TUT_STEPS.length + " — " + TUT_STEPS[TUT.idx].title, 1.6);
    $("#coachFill").style.width = Math.round((TUT.idx / TUT_STEPS.length) * 100) + "%";
  }
  function tutGraduate() {
    TUT.active = false;
    hideCoach();
    Store.set(K.tutorial, { done: true, at: Date.now() });
    showBanner("GRADUATED! ✈", 2.0);
    Sfx.win();
    $("#coachFill").style.width = "100%";
    showOverlay(
      '<h2 class="win">FLIGHT SCHOOL CLEARED</h2>' +
      '<div class="stats"><span>GRAZES ' + G.graze + "</span><span>SHARDS " + G.shards + "</span></div>" +
      '<p class="story">You can move, dodge, graze, collect, and shield. The real sectors await, pilot.</p>' +
      '<div class="btn-row">' +
      '<button class="ghost-btn primary" data-act="tut-classic">FLY SECTOR 01</button>' +
      '<button class="ghost-btn" data-act="retry">REPLAY</button>' +
      '<button class="ghost-btn" data-act="home">HOME</button></div>'
    );
    hudStatus.textContent = "GRADUATE";
  }
  function tutSkip() {
    if (G.mode !== "tutorial") return;
    TUT.active = false;
    hideCoach();
    goHome();
  }
  // scripted spawns per step (called from updatePlay while in tutorial mode)
  function tutScript(dt) {
    if (!TUT.active || G.state !== "playing") return;
    var step = tutStep();
    if (step === "shard") {
      TUT.shardSpawned += dt;
      if (TUT.shardSpawned >= 0.6 && shardItems.length === 0 && G.shards < 1) {
        TUT.shardSpawned = -2.5;   // cadence: a shard every ~3s until collected
        shardItems.push({ x: clamp(player.x + rand(-160, 160), 30, 912), y: -16, w: 18, h: 18, vy: 130 });
      }
    }
    if (step === "shield") {
      if (!TUT.shieldSpawned && pickups.length === 0 && G.shield < 1) {
        TUT.shieldSpawned = true;
        pickups.push({ x: clamp(player.x, 60, 880), y: -20, w: 24, h: 24, vy: 110, kind: "shield", color: POWERUPS.shield.color });
      }
    }
    // step completion checks
    if (step === "move" && TUT.trackMove > 260) tutAdvance();
    else if (step === "dodge" && G.elapsed - TUT.t0 > 10) tutAdvance();
    else if (step === "graze" && G.graze >= 1) tutAdvance();
    else if (step === "shard" && G.shards >= 1) tutAdvance();
    else if (step === "shield" && G.shield >= 1) tutAdvance();
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
    if (G.daily) showBanner("DAILY — " + G.daily, 1.6);
    else if (G.mode === "endless") showBanner(PHASES[0].name, 1.4);
    if (G.mode === "multiplayer") showBanner("RACE — LAST ALIVE WINS", 1.6);
    if (G.mode === "null") showBanner("NULL PROTOCOL", 1.6);
    startLoop();
  }

  function togglePause(force) {
    if (G.state !== "playing" && G.state !== "paused") return;
    var pause = force != null ? force : G.state === "playing";
    if (pause) {
      G.state = "paused";
      Sfx.droneDuck(true);
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
      Sfx.droneDuck(false);
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
    var cd = cheatDef();
    if (cd) return cd.env;   // cheat aura re-skins the whole environment
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
    } else if (pattern === "winds") {
      // S07 SOLAR WINDS: falling shards + telegraphed gust fronts that shove the ship
      var wc = 1 + ((r() * 2) | 0);
      for (var wi = 0; wi < wc; wi++) {
        var wsize = 24 + r() * 30;
        addBlock(r() * (960 - wsize), -wsize - r() * 60, wsize, wsize, blockSpeed(), pal.enemy);
      }
      var dir = r() < 0.5 ? -1 : 1;
      var strength = 240 + r() * 160;
      var bandY = -30;
      obstacles.push({ x: 0, y: bandY, w: 960, h: 46, vy: blockSpeed() * 0.85, vx: 0,
        type: "gust", color: pal.accent, grazed: true,
        gustDir: dir, gustForce: strength });
    } else if (pattern === "splitters") {
      // S08 MIRROR SPLIT: big prisms fall; when split they fracture into twin seekers
      var sc3 = 1 + ((r() * 2) | 0);
      for (var si = 0; si < sc3; si++) {
        var big = 44 + r() * 22;
        addBlock(r() * (960 - big), -big - r() * 50, big, big, blockSpeed() * 0.9, pal.enemy,
          { type: "splitter", splitDone: false });
      }
      if (r() < 0.4) {
        var sz2 = 26 + r() * 20;
        addBlock(r() * (960 - sz2), -sz2 - r() * 40, sz2, sz2, blockSpeed(), pal.enemy);
      }
    } else if (pattern === "portals") {
      // S09 EVENT HORIZON: rain + portal pairs (fly through to teleport) + center pull handled in update
      var pc = 1 + ((r() * 2) | 0);
      for (var qi = 0; qi < pc; qi++) {
        var psize = 26 + r() * 30;
        addBlock(r() * (960 - psize), -psize - r() * 50, psize, psize, blockSpeed(), pal.enemy);
      }
      if (G.portalT == null) G.portalT = 0;
      G.portalT -= 1;
      if (G.portalT <= 0) {
        G.portalT = 3;
        var px1 = 80 + r() * 320, px2 = 560 + r() * 320;
        var py = -30;
        var pair = (r() * 0xffffff) | 0;
        obstacles.push({ x: px1, y: py, w: 54, h: 54, vy: blockSpeed() * 0.55, vx: 0,
          type: "portal", color: pal.accent, grazed: true, portalPair: pair });
        obstacles.push({ x: px2, y: py - 130, w: 54, h: 54, vy: blockSpeed() * 0.55, vx: 0,
          type: "portal", color: pal.accent, grazed: true, portalPair: pair });
      }
    } else if (pattern === "mix") {
      var which = (r() * 7) | 0;
      spawnPattern(["rain", "walls", "homing", "crossfire", "winds", "splitters", "portals"][which], r);
    }
  }

  function spawnPickup() {
    var tm = tierMax();
    var keys = [];
    for (var t = 1; t <= tm; t++) keys = keys.concat(TIER_KEYS[t]);
    var weighted = keys.slice();
    if (tm >= 2) weighted = weighted.concat(TIER_KEYS[2]);
    if (tm >= 3) weighted = weighted.concat(TIER_KEYS[3]);
    var r = G.rng;   // schedule-critical draws stay on the seeded stream (daily fairness)
    var kind = weighted[(r() * weighted.length) | 0];
    var spec = POWERUPS[kind];
    var px = 30 + r() * 900;
    if (G.mode === "multiplayer") px = 30 + r() * 370;   // player lane only — bot doesn't use power-ups
    pickups.push({ x: px, y: -20, w: 24, h: 24, vy: 130, kind: kind, color: spec.color });
  }

  function spawnShard() {
    shardItems.push({ x: rand(30, 930), y: -16, w: 18, h: 18, vy: 150 });
  }

  // ================= special hazards: S07 winds / S08 split / S09 portals =================
  function splitBlock(ob) {
    if (ob.splitDone) return;
    ob.splitDone = true;
    var cx = ob.x + ob.w / 2, cy = ob.y + ob.h / 2;
    var pal = paletteNow();
    for (var sk = -1; sk <= 1; sk += 2) {
      obstacles.push({ x: clamp(cx - 15 + sk * 26, 4, 920), y: cy - 14, w: 30, h: 30,
        vy: ob.vy * 1.15, vx: sk * 70, type: "homing", color: pal.enemy, grazed: false,
        homeT: 1.4, seeker: true });
    }
    burst(cx, cy, pal.accent, 14);
    Sfx.tone(880, 0.12, "triangle", 0.04, 440);
    addPopup(cx, cy - 12, "SPLIT!", pal.accent);
  }

  function portalMate(ob) {
    for (var mi = 0; mi < obstacles.length; mi++) {
      var mo = obstacles[mi];
      if (mo !== ob && mo.type === "portal" && mo.portalPair === ob.portalPair) return mo;
    }
    return null;
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
        if (obstacles[i].type === "splitter" && !obstacles[i].splitDone) splitBlock(obstacles[i]);
      }
      // keep seekers from a blast-fracture; clear everything else
      obstacles = obstacles.filter(function (o) { return o.seeker && o.homeT > 0; });
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
    var cd = cheatDef();
    if (cd && cd.invuln) return;                    // top-tier auras never die
    if (G.state !== "playing") return;
    if (player.invuln > 0 || G.phaseUpT > 0) return;
    if (G.mode === "tutorial") {
      // flight school: hits rattle but never cost lives
      player.invuln = 1.1;
      G.shake = Math.max(G.shake, 8);
      burst(player.x + player.w / 2, player.y + player.h / 2, "#5dff9a", 10);
      addPopup(player.x + player.w / 2, player.y - 6, "OOPS — KEEP DODGING!", "#5dff9a");
      Sfx.blip();
      return;
    }
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
  function thunderShock(cheat) {
    if (!player || G.state !== "playing") return;
    var cx = player.x + player.w / 2, cy = player.y + player.h / 2;
    var kills = 0;
    for (var i = obstacles.length - 1; i >= 0; i--) {
      var o = obstacles[i];
      var ox = o.x + o.w / 2, oy = o.y + o.h / 2;
      var dx = ox - cx, dy = oy - cy;
      if (dx * dx + dy * dy < 200 * 200) {
        if (o.type === "splitter" && !o.splitDone) splitBlock(o);
        burst(ox, oy, cheat.color, 8);
        obstacles.splice(i, 1);
        kills++;
      }
    }
    burst(cx, cy, cheat.glow, 26);
    G.shake = Math.max(G.shake, 10);
    G.score += kills * 50 * scoreMult();
    Sfx.shock();
    if (kills > 0) {
      addPopup(cx, cy - 30, "SHOCKWAVE x" + kills, cheat.color);
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
    submitRun(true);
    Sfx.droneStop();
    Sfx.win();
    G.flash = 0.5;

    if (G.mode === "classic") {
      var s = G.sector;
      var rank = computeRank();
      var prev = prog.ranks[s.id];
      if (!G.ghostScore && (!prev || rankBetter(rank, prev))) prog.ranks[s.id] = rank;
      var campList = campaignSectors();
      var lastCampId = campList.length ? campList[campList.length - 1].id : 5;
      if (!G.ghostScore && s.id === prog.unlocked && s.id < lastCampId) prog.unlocked = s.id + 1;
      if (!G.ghostScore && s.id === lastCampId && prog.unlocked <= lastCampId) prog.unlocked = lastCampId + 1;
      var allS = campList.length > 0;
      for (var ci = 0; ci < campList.length; ci++) {
        if (prog.ranks[campList[ci].id] !== "S") { allS = false; break; }
      }
      var wasNull = prog.nullUnlocked;
      if (allS && !G.ghostScore) prog.nullUnlocked = true;
      if (!G.ghostScore) saveProgress();
      var nextReady = (s.id + 1 <= prog.unlocked) && (s.id < lastCampId);
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
      if (G.daily) {
        showOverlay(
          '<h2 class="win">DAILY CLEARED</h2><div class="stats"><span>SCORE ' + sc2 + "</span><span>" + G.daily + "</span></div>" +
          '<div class="btn-row"><button class="ghost-btn primary" data-act="retry">RUN AGAIN</button>' +
          '<button class="ghost-btn" data-act="home">HOME</button></div>'
        );
        hudStatus.textContent = "CLEARED";
        return;
      }
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
    submitRun(false);
    Sfx.droneStop();
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
      var sc = Math.floor(G.score);
      if (G.daily) {
        showOverlay(
          '<h2 class="lose">STORM WINS</h2><div class="stats"><span>SCORE ' + sc + "</span><span>" + G.daily + "</span></div>" +
          '<div class="btn-row"><button class="ghost-btn primary" data-act="retry">RUN AGAIN</button>' +
          '<button class="ghost-btn" data-act="home">HOME</button></div>'
        );
        return;
      }
      var bestE = Store.get(K.bestEndless, 0);
      if (!G.ghostScore && sc > bestE) Store.set(K.bestEndless, sc);
      showOverlay('<h2 class="lose">STORM WINS</h2><div class="stats"><span>SCORE ' + sc + "</span><span>PHASE " + (G.phaseIdx + 1) + "</span></div>" +
        '<div class="btn-row"><button class="ghost-btn primary" data-act="retry">RUN AGAIN</button>' +
        '<button class="ghost-btn" data-act="home">HOME</button></div>');
      return;
    }
    if (G.mode === "multiplayer") {
      var botDead = G.bot && !G.bot.alive;
      botWinFlow(botDead);
    }
  }

  function botWinFlow(playerWon) {
    var bid = normalizeBot(G.bot ? G.bot.botId : G.difficulty);
    var key = botWinsKey(bid);
    var wins = Store.get(key, 0) | 0;
    if (playerWon) {
      wins += 1;
      if (!G.ghostScore) Store.set(key, wins);
    }
    var label = (BOT_SPECS[bid] && BOT_SPECS[bid].label) || bid.toUpperCase();
    var total = getBotWins().total;
    showOverlay(
      '<h2 class="' + (playerWon ? "win" : "lose") + '">' + (playerWon ? "YOU OUTLASTED " + label : label + " OUTLASTED YOU") + "</h2>" +
      '<div class="stats"><span>SURVIVED ' + G.elapsed.toFixed(1) + "s</span><span>VS " + label + ": " + wins + "</span><span>TOTAL " + total + "</span></div>" +
      '<div class="btn-row"><button class="ghost-btn primary" data-act="retry">REMATCH</button>' +
      '<button class="ghost-btn" data-act="lobby">LOBBY</button>' +
      '<button class="ghost-btn" data-act="home">HOME</button></div>'
    );
    hudStatus.textContent = playerWon ? "VICTORY" : "DEFEAT";
  }

  // ================= update helpers =================
  function updatePlayer(dt) {
    var x = player.x;
    var spdCheat = cheatDef();
    var spd = player.speed * ((spdCheat && spdCheat.speedMul) || 1);
    if (Input.pointerDown) {
      x = (Input.pointerX - view.ox) / (view.scale || 1) - player.w / 2;
    } else {
      if (Input.keys.ArrowLeft || Input.keys.a) x -= spd * dt;
      if (Input.keys.ArrowRight || Input.keys.d) x += spd * dt;
    }
    var maxX = player.laneMax || 960;
    player.x = clamp(x, 8, Math.min(960, maxX) - player.w - 8);
    // tutorial step 1 tracks total travel distance (keyboard + drag + touch)
    if (TUT.active && tutStep() === "move" && G.state === "playing") {
      TUT.trackMove += Math.abs(player.x - (TUT.lastX != null ? TUT.lastX : player.x));
      TUT.lastX = player.x;
    }
    player.trail.push({ x: player.x + player.w / 2, y: player.y + player.h, t: 0.35 });
    if (player.trail.length > 26) player.trail.shift();
    player.invuln = Math.max(0, player.invuln - dt);
  }

  function updateBot(dt) {
    var b = G.bot;
    if (!b || !b.alive) return;
    var s = b.ship;
    // forced misread pulse: even hell/elite must stay beatable
    b.mistakeT -= dt;
    var mistakeNow = false;
    if (b.mistakeT <= 0) {
      b.mistakeT = (b.spec.mistakeEvery || 6) * rand(0.85, 1.2);
      mistakeNow = true;
    }
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
        // hell/elite look one extra threat ahead so they feel inhuman
        var hard = (b.botId === "hell" || b.botId === "elite");
        var dodgeBias = hard ? 26 : 14;
        var cand = [];
        if (best.x - s.w - dodgeBias >= b.laneMin) cand.push(best.x - s.w - dodgeBias);
        if (best.x + best.w + dodgeBias + s.w <= b.laneMax) cand.push(best.x + best.w + dodgeBias);
        var tx;
        if (!cand.length) tx = b.laneMin;
        else if (cand.length === 1) tx = cand[0];
        else tx = Math.abs(cand[0] - s.x) < Math.abs(cand[1] - s.x) ? cand[0] : cand[1];
        var err = mistakeNow ? b.spec.error * 3.2 : b.spec.error;
        b.targetX = tx + rand(-err, err);
      } else {
        b.targetX = b.laneMin + (b.laneMax - b.laneMin) / 2 - s.w / 2;
        if (mistakeNow) b.targetX += rand(-80, 80);
      }
      b.targetX = clamp(b.targetX, b.laneMin, b.laneMax - s.w);
    }
    // rubber-band: top bots can't outrun the player by pure speed
    var cap = b.spec.maxSpeed;
    if ((b.botId === "hell" || b.botId === "elite") && player && G.elapsed > 45) {
      cap = Math.min(cap, 420 + G.elapsed * 1.1);
    }
    s.x += clamp(b.targetX - s.x, -cap * dt, cap * dt);
    s.x = clamp(s.x, b.laneMin, b.laneMax - s.w);
    s.trail.push({ x: s.x + s.w / 2, y: s.y + s.h, t: 0.35 });
    if (s.trail.length > 26) s.trail.shift();
    s.invuln = Math.max(0, s.invuln - dt);
  }

  function currentPattern() {
    if (G.mode === "classic" || G.mode === "null") return G.sector.pattern;
    if (G.mode === "tutorial") {
      var ts = tutStep();
      if (ts === "move") return "basic";
      if (ts === "dodge" || ts === "graze") return "rain";
      return "basic";   // shard/shield steps stay gentle
    }
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
    if (G.daily && G.elapsed >= DAILY_SECS) {
      G.elapsed = DAILY_SECS;
      winRun();
      return;
    }

    var tkeys = ["slowT", "freezeT", "magnetT", "phaseUpT", "x2T", "overT"];
    for (var ti = 0; ti < tkeys.length; ti++) {
      if (G[tkeys[ti]] > 0) G[tkeys[ti]] = Math.max(0, G[tkeys[ti]] - dt);
    }
    G.comboT = Math.max(0, G.comboT - dt);
    if (G.comboT <= 0) G.combo = 0;
    G.shake = Math.max(0, G.shake - dt * 40);
    G.flash = Math.max(0, G.flash - dt);
    // cheat-aura timers + persistent effects
    var cheat = cheatDef();
    if (cheat && G.state === "playing") {
      if (cheat.shockT) {
        cheatShockT -= dt;
        if (cheatShockT <= 0) {
          cheatShockT = cheat.shockT;
          thunderShock(cheat);
        }
      }
      if (cheat.regenShield) {
        if (G.shield <= 0) {
          cheatShieldT += dt;
          if (cheatShieldT >= cheat.regenShield) {
            cheatShieldT = 0;
            G.shield = 1;
            if (player) {
              addPopup(player.x + player.w / 2, player.y - 10, "NAYA SHIELD", cheat.color);
              burst(player.x + player.w / 2, player.y + player.h / 2, cheat.color, 12);
            }
            Sfx.shieldRegen();
          }
        } else cheatShieldT = 0;
      }
      if (cheat.phaseCycle) {
        cheatPhaseT += dt;
        var dodgeNow = (cheatPhaseT % 6 < 4);
        if (dodgeNow !== cheatPhaseWasDodge) {
          cheatPhaseWasDodge = dodgeNow;
          Sfx.phaseShift();
        }
      }
      if (cheat.magnet) G.magnetT = Math.max(G.magnetT, 0.2);
    }
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
          Sfx.phaseSfx();
          Sfx.droneDuck(true);
          setTimeout(function () { if (G.state === "playing") Sfx.droneDuck(false); }, 400);
        }
      }
    }

    G.spawnT += dt;
    var gap = 0.8;
    if (G.mode === "endless") gap = Math.max(0.26, 0.8 - G.elapsed * 0.006);
    else if (G.mode === "multiplayer") gap = Math.max(0.3, 0.75 - G.elapsed * 0.004);
    else if (G.mode === "tutorial") gap = G.spawnGap;
    else if (G.mode === "null") gap = 0.6;
    else if (G.sector) gap = G.sector.pattern === "boss" ? 9 : G.spawnGap;
    if (G.spawnT >= gap) {
      G.spawnT = 0;
      var pat = currentPattern();
      if (pat !== "boss") spawnPattern(pat, G.rng);
    }
    if (G.mode === "tutorial") {
      tutScript(dt);   // scripted shards/shield + step checks
      if (!TUT.active && G.state === "playing") return; // graduated overlay up — freeze the arena
    }

    if (G.sector && G.sector.objective.type === "shards") {
      G.shardTmr += dt;
      if (G.shardTmr >= 2.2) { G.shardTmr = 0; spawnShard(); }
    }

    G.pkTmr -= dt;
    if (G.pkTmr <= 0) { G.pkTmr = 6 + G.rng() * 3; spawnPickup(); }

    var speedScale = 1;
    if (G.slowT > 0) speedScale *= 0.45;
    if (G.freezeT > 0) speedScale *= 0.02;
    if (G.mode === "multiplayer" && G.elapsed > 90) {
      speedScale *= 1 + Math.floor((G.elapsed - 90) / 10) * 0.5;   // sudden death
    }

    // S09 singularity: gentle center pull in EVENT HORIZON
    var singularity = (G.sector && G.sector.pattern === "portals");
    if (singularity && player && G.state === "playing") {
      var pullX = 480 - (player.x + player.w / 2);
      player.x += clamp(pullX * 0.35 * dt, -60 * dt, 60 * dt);
      player.x = clamp(player.x, 8, 960 - player.w - 8);
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
      if (ob.y > 560 + ob.h) {
        // splitters that fall off-screen still fracture (keeps S08 pressure on)
        if (ob.type === "splitter" && !ob.splitDone && ob.y < 640 + ob.h) splitBlock(ob);
        obstacles.splice(i, 1); continue;
      }
      if (ob.type === "warn") continue;

      // S07 gust fronts: shove the ship sideways while overlapping (no damage)
      if (ob.type === "gust") {
        if (player && player.invuln <= 0) {
          var pover = player.x + player.w > ob.x && player.x < ob.x + ob.w &&
            player.y + player.h > ob.y && player.y < ob.y + ob.h;
          if (pover) {
            player.x += ob.gustDir * ob.gustForce * dt;
            player.x = clamp(player.x, 8, 960 - player.w - 8);
            if (!ob.gustFx || performance.now() - ob.gustFx > 240) {
              ob.gustFx = performance.now();
              burst(player.x + player.w / 2, player.y, paletteNow().accent, 3);
            }
          }
        }
        continue;
      }

      // S09 portals: overlapping teleports the ship to the mate (brief invuln, no damage)
      if (ob.type === "portal") {
        if (player && player.invuln <= 0 && G.phaseUpT <= 0) {
          var qover = player.x + player.w > ob.x && player.x < ob.x + ob.w &&
            player.y + player.h > ob.y && player.y < ob.y + ob.h;
          if (qover) {
            var mate = portalMate(ob);
            if (mate) {
              player.x = clamp(mate.x + mate.w / 2 - player.w / 2, 8, 960 - player.w - 8);
              player.y = clamp(mate.y - player.h - 6, 60, 500);
              player.invuln = Math.max(player.invuln, 0.9);
              burst(player.x + player.w / 2, player.y, paletteNow().accent, 16);
              addPopup(player.x + player.w / 2, player.y - 10, "RIFT!", paletteNow().accent);
              Sfx.phaseSfx();
              obstacles.splice(i, 1);
              continue;
            }
          }
        }
        continue;
      }

      var ellaPhase = (activeCheat === "ella" && cheatPhaseT % 6 < 4);
      if (!ellaPhase && G.phaseUpT <= 0 && player.invuln <= 0 && aabb({ x: player.x, y: player.y, w: player.w, h: player.h }, ob)) {
        if (ob.type === "splitter" && !ob.splitDone) {
          splitBlock(ob);
          obstacles.splice(i, 1);
          player.invuln = Math.max(player.invuln, 0.6);
          continue;
        }
        var ramCheat = cheatDef();
        if (ramCheat && ramCheat.ram) {
          // thunderfist rams straight through hazards for score
          burst(ob.x + ob.w / 2, ob.y + ob.h / 2, ramCheat.color, 10);
          obstacles.splice(i, 1);
          G.score += 50 * scoreMult();
          addPopup(ob.x + ob.w / 2, ob.y, "SMASH +50", ramCheat.color);
          continue;
        }
        damagePlayer();
        if (G.state === "over") return;
      }
      // graze detection
      if (!ob.grazed && player && G.phaseUpT <= 0) {
        var overlapX = player.x + player.w > ob.x && player.x < ob.x + ob.w;
        var nearY = ob.y + ob.h > player.y - 26 && ob.y < player.y + player.h + 26;
        var noHit = !(overlapX && ob.y < player.y + player.h && ob.y + ob.h > player.y);
        if (overlapX && nearY && noHit) {
          if (ob.type === "splitter" && !ob.splitDone) splitBlock(ob);
          ob.grazed = true;
          G.graze++;
          G.combo++;
          G.comboT = 2.2;
          var bonus = 25 * Math.max(1, Math.min(G.combo, 8));
          G.score += bonus * scoreMult();
          addPopup(player.x + player.w / 2, player.y - 10, "GRAZE +" + bonus, "#7ce7ff");
          Sfx.graze();
          if (activeCheat && CHEAT_STING[activeCheat]) {
            Sfx.comboSting(comboTier(G.combo), CHEAT_STING[activeCheat].base);
          }
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
      var vacCheat = cheatDef();
      if (vacCheat && vacCheat.vacuum && player) {
        // kwoffie solar vacuum: long-range shard pull
        var vdx = (player.x + player.w / 2) - sh.x, vdy = player.y - sh.y;
        if (vdx * vdx + vdy * vdy < vacCheat.vacuum * vacCheat.vacuum) {
          sh.x += clamp(vdx, -340 * dt, 340 * dt);
          sh.y += clamp(vdy, -340 * dt, 340 * dt);
        }
      }
      sh.y += sh.vy * dt * speedScale;
      if (sh.y > 560) { shardItems.splice(j, 1); continue; }
      if (aabb({ x: player.x, y: player.y, w: player.w, h: player.h }, sh)) {
        shardItems.splice(j, 1);
        G.shards++;
        G.score += 100 * scoreMult();
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
        var ellaDodge = (activeCheat === "ella" && cheatPhaseT % 6 < 4);
        if (!ellaDodge && player.invuln <= 0 && G.phaseUpT <= 0) {
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
    var mult = scoreMult();
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
    } else if (G.mode === "tutorial") {
      mid = "FLIGHT SCHOOL · STEP " + Math.min(TUT.idx + 1, TUT_STEPS.length) + "/" + TUT_STEPS.length +
        (G.shield ? " · SHIELD" : "");
    } else mid = "—";
    var hudCheat = cheatDef();
    if (hudCheat && mid !== "—") mid = "⚡" + hudCheat.tag + " · " + mid;
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
    var cheatTrail = (s === player) ? cheatDef() : null;
    for (var i = 0; i < s.trail.length; i++) {
      var t = s.trail[i];
      t.t -= 0.016;
      var a = t.t < 0 ? 0 : t.t;
      ctx.fillStyle = cheatTrail ? "rgba(" + cheatTrail.trail + "," + (a * 0.5) + ")"
        : hexRgba(s.color || "#00f0ff", a * 0.5);
      ctx.fillRect(t.x - 3, t.y, 6, 8);
    }
    if (s.invuln > 0 && Math.floor(performance.now() / 90) % 2 === 0) return;

    ctx.save();
    if (G.phaseUpT > 0) ctx.globalAlpha = 0.45;
    else if (activeCheat === "ella" && s === player && cheatPhaseT % 6 < 4) ctx.globalAlpha = 0.45;
    if (cheatTrail && s === player) { ctx.shadowColor = cheatTrail.glow; ctx.shadowBlur = 26; }
    else if (cheatTrail) { ctx.shadowColor = s.color; ctx.shadowBlur = 18; }
    else { ctx.shadowColor = s.color; ctx.shadowBlur = 18; }


    // ---- ship shape ----
    var sh = s.shape || "arrow";
    var px = s.x, py = s.y, pw = s.w, ph = s.h;
    ctx.fillStyle = s.color;
    if (sh === "arrow") {
      roundRect(px, py, pw, ph, 9);
      ctx.fillStyle = "rgba(2,10,24,0.85)";
      ctx.fillRect(px + pw / 2 - 7, py + 5, 14, ph - 10);
      ctx.fillStyle = "#ffb454";
      var flick = 6 + Math.random() * 8;
      ctx.beginPath();
      ctx.moveTo(px + 10, py + ph);
      ctx.lineTo(px + 16, py + ph + flick);
      ctx.lineTo(px + 22, py + ph);
      ctx.moveTo(px + pw - 22, py + ph);
      ctx.lineTo(px + pw - 16, py + ph + flick);
      ctx.lineTo(px + pw - 10, py + ph);
      ctx.fill();
    } else if (sh === "dart") {
      ctx.beginPath();
      ctx.moveTo(px + pw / 2, py);
      ctx.lineTo(px + pw - 18, py + ph);
      ctx.lineTo(px + 18, py + ph);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(2,10,24,0.85)";
      ctx.fillRect(px + 10, py + ph / 2 - 5, pw - 20, 10);
      ctx.fillStyle = "#ffb454";
      ctx.fillRect(px + 14, py + ph - 6, pw - 28, 6);
    } else if (sh === "wasp") {
      ctx.beginPath();
      ctx.moveTo(px + 30, py + 4);
      ctx.lineTo(px + pw - 38, py + ph - 6);
      ctx.lineTo(px + pw - 42, py + ph + 4);
      ctx.lineTo(px + pw / 2, py + ph + 6);
      ctx.lineTo(px + 42, py + ph + 4);
      ctx.lineTo(px + 38, py + ph - 6);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(2,10,24,0.85)";
      ctx.fillRect(px + 6, py + ph / 2 - 5, pw - 12, 10);
      ctx.fillStyle = "#ffb454";
      ctx.fillRect(px + 12, py + ph - 7, pw - 24, 5);
    } else if (sh === "orb") {
      ctx.beginPath();
      ctx.arc(px + pw / 2, py + ph / 2, pw / 2 - 3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(2,10,24,0.85)";
      ctx.fillRect(px + 8, py + 8, pw - 16, ph - 16);
      ctx.fillStyle = "#ffb454";
      ctx.beginPath();
      ctx.arc(px + pw / 2, py + ph / 2, pw / 2 - 9, 0, TAU);
      ctx.strokeStyle = "#ffb454";
      ctx.lineWidth = 3;
      ctx.stroke();
    } else if (sh === "fang") {
      ctx.beginPath();
      ctx.moveTo(px + pw / 2, py);
      ctx.lineTo(px + pw - 22, py + ph);
      ctx.lineTo(px + pw - 12, py + ph - 6);
      ctx.lineTo(px + pw - 20, py + ph - 4);
      ctx.lineTo(px + 12, py + ph);
      ctx.lineTo(px + 20, py + ph - 6);
      ctx.lineTo(px + 10, py + ph - 4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(2,10,24,0.85)";
      ctx.fillRect(px + 10, py + 8, pw - 20, ph - 16);
      ctx.fillStyle = "#ffb454";
      ctx.fillRect(px + 14, py + ph - 7, pw - 28, 5);
    } else if (sh === "veil") {
      ctx.beginPath();
      ctx.arc(px + pw / 2, py + ph / 2, pw / 2 - 3, Math.PI * 0.05, Math.PI * 0.95);
      ctx.arc(px + pw / 2, py + ph / 2, 5, Math.PI * 0.05, Math.PI * 0.95);
      ctx.fill();
      ctx.fillStyle = "rgba(2,10,24,0.85)";
      ctx.fillRect(px + 6, py + ph / 2 - 4, pw - 12, ph - 8);
      ctx.fillStyle = "#ffb454";
      ctx.fillRect(px + 12, py + ph - 7, pw - 24, 5);
    }
    // ---- flair decorations ----
    var fl = s.flair || 0;
    if (fl >= 1) {
      var rr = pw / 2 - 2;
      for (var r = 1; r <= 2; r++) {
        ctx.beginPath();
        ctx.arc(px + pw / 2, py + ph / 2, rr * r, 0, TAU);
        ctx.strokeStyle = "rgba(255,180,84,0.22)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    if (fl >= 2) {
      ctx.fillStyle = "rgba(255,180,84,0.35)";
      ctx.beginPath();
      ctx.moveTo(px + pw / 2 - 9, py + 8);
      ctx.lineTo(px + pw / 2 - 18, py + ph - 6);
      ctx.lineTo(px + pw / 2 - 8, py + ph - 4);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(px + pw / 2 + 9, py + 8);
      ctx.lineTo(px + pw / 2 + 18, py + ph - 6);
      ctx.lineTo(px + pw / 2 + 8, py + ph - 4);
      ctx.closePath();
      ctx.fill();
    }
    if (fl >= 3) {
      var cx = px + pw / 2;
      ctx.fillStyle = "#ffd75d";
      var spikes = 5;
      var hi = ph * 0.35;
      for (var k = 0; k < spikes; k++) {
        var ang = -Math.PI / 2 + (k / spikes) * Math.PI * 2;
        var ex = cx + Math.cos(ang) * (pw / 4 + 2);
        var ey = py + 6 + Math.sin(ang) * hi;
        ctx.beginPath();
        ctx.moveTo(cx, py + 6);
        ctx.lineTo(ex - 3, ey);
        ctx.lineTo(ex + 3, ey);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();

    if (label) {
      ctx.fillStyle = s.color;
      ctx.font = "700 12px Orbitron, sans-serif";
      ctx.fillText(label, s.x, s.y - 8);
    }
  }

  function drawObstacles(time) {
    var now = time || 0;
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
      if (o.type === "gust") {
        // S07: translucent wind band with animated chevrons pointing the shove direction
        ctx.save();
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = o.color;
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = o.color;
        ctx.lineWidth = 3;
        ctx.shadowColor = o.color;
        ctx.shadowBlur = 12;
        var step = 64;
        var slide = (now * 0.25 * o.gustDir) % step;
        for (var gx = -step + slide; gx < 960 + step; gx += step) {
          var gy = o.y + o.h / 2;
          ctx.beginPath();
          if (o.gustDir > 0) {
            ctx.moveTo(gx - 12, gy - 12); ctx.lineTo(gx + 4, gy); ctx.lineTo(gx - 12, gy + 12);
          } else {
            ctx.moveTo(gx + 12, gy - 12); ctx.lineTo(gx - 4, gy); ctx.lineTo(gx + 12, gy + 12);
          }
          ctx.stroke();
        }
        ctx.restore();
        continue;
      }
      if (o.type === "portal") {
        // S09: swirling rift ring
        ctx.save();
        var pcx = o.x + o.w / 2, pcy = o.y + o.h / 2;
        ctx.strokeStyle = o.color;
        ctx.shadowColor = o.color;
        ctx.shadowBlur = 22;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(pcx, pcy, 22 + Math.sin(now * 0.008) * 3, 0, TAU);
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.arc(pcx, pcy, 12, now * 0.004, now * 0.004 + TAU * 0.8);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      ctx.save();
      ctx.shadowColor = o.color;
      ctx.shadowBlur = o.type === "splitter" ? 18 : 10;
      ctx.fillStyle = o.color;
      if (o.type === "splitter") {
        // S08: prism — diamond outline hinting it fractures
        ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
        ctx.rotate(Math.PI / 4);
        var half = o.w / 2;
        ctx.fillRect(-half * 0.72, -half * 0.72, half * 1.44, half * 1.44);
        ctx.rotate(-Math.PI / 4);
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-half * 0.5, 0); ctx.lineTo(half * 0.5, 0);
        ctx.stroke();
      } else {
        roundRect(o.x, o.y, o.w, o.h, o.type === "wall" ? 4 : 8);
      }
      if (o.type === "homing") {
        ctx.fillStyle = o.seeker ? "#ff7ce7" : "#fff";
        ctx.beginPath();
        ctx.arc(o.x + o.w / 2, o.y + o.h / 2, 5, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    // S09 singularity marker at lane center
    if (G.sector && G.sector.pattern === "portals" && (G.state === "playing" || G.state === "briefing")) {
      ctx.save();
      ctx.globalAlpha = 0.5 + Math.sin(now * 0.005) * 0.15;
      ctx.fillStyle = "#0a0618";
      ctx.strokeStyle = "#8a5dff";
      ctx.shadowColor = "#8a5dff";
      ctx.shadowBlur = 18;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(480, 120, 14, 0, TAU);
      ctx.fill();
      ctx.stroke();
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
    drawObstacles(time);
    drawBoss(time);
    drawShip(player, null);
    if (G.bot && G.bot.alive) {
      var botLabel = (G.bot.spec && G.bot.spec.label) || (G.bot.botId || G.difficulty || "").toUpperCase();
      drawShip(G.bot.ship, botLabel);
    }
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
    var cdFrame = cheatDef();
    if (cdFrame) {
      ctx.strokeStyle = cdFrame.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 4;
      ctx.strokeRect(4, 4, 952, 532);
      ctx.globalAlpha = 1;
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
    var swallow = (k.length === 1) && cheatSwallow(keyName);
    noteKey(k.length === 1 ? k : "");

    if (k === " " || k === "Spacebar") {
      if (G.state === "briefing") beginPlay();
      else if (G.state === "paused") togglePause(false);
      return;
    }
    if (swallow) return;   // mid cheat-word: don't pause/mute/fullscreen (kiphnic, kwoffie)
    if (k === "p" || k === "P" || k === "Escape") { togglePause(); return; }
    if (k === "m" || k === "M") { Sfx.toggle(); return; }
    if (k === "f" || k === "F") { toggleFullscreen(); return; }
    if (activeScreen() === "home") {
      if (k === "0") location.hash = "#/tutorial";
      if (k === "1") location.hash = "#/classic";
      if (k === "2") location.hash = "#/endless";
      if (k === "3") location.hash = "#/multiplayer";
      if (k === "4" && prog.nullUnlocked) location.hash = "#/null";
      if (k === "5") location.hash = "#/daily";
    }
    if (activeScreen() === "lobby") {
      if (k === "q" || k === "Q") startBot("easy");
      if (k === "w" || k === "W") startBot("normal");
      if (k === "e" || k === "E") startBot("hard");
      if (k === "r" || k === "R") startBot("elite");
      if (k === "t" || k === "T") startBot("hell");
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
    Sfx.droneStop();
    TUT.active = false;
    hideCoach();
    G.state = "idle";
    hideOverlay();
    bannerEl.hidden = true;
    if (location.hash) location.hash = "";
    showScreen("home");
  }

  function goLobby() {
    stopLoop();
    Sfx.droneStop();
    G.state = "idle";
    hideOverlay();
    bannerEl.hidden = true;
    if (location.hash !== "#/multiplayer") location.hash = "#/multiplayer";
    showScreen("lobby");
  }

  function startBot(difficulty) {
    Sfx.ensure();
    difficulty = normalizeBot(difficulty);
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
      if (G.daily) opts.daily = G.daily;
      startMode(mode, opts);
    } else if (act === "next") {
      hideOverlay();
      var campNext = campaignSectors();
      var curId = G.sector ? G.sector.id : 1;
      var nextSid = curId + 1;
      var ok = false;
      for (var ni = 0; ni < campNext.length; ni++) {
        if (campNext[ni].id === nextSid) { ok = true; break; }
      }
      if (!ok && campNext.length) nextSid = campNext[campNext.length - 1].id;
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
    var lastHover = 0;
    card.addEventListener("pointerenter", function () {
      var now = performance.now();
      if (now - lastHover < 180) return;
      lastHover = now;
      Sfx.hover();
    });
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
  var btnAura = $("#btnAura");
  if (btnAura) btnAura.addEventListener("click", function () {
    var pad = $("#auraPad");
    if (pad && !pad.hidden) closeAuraPad();
    else openAuraPad();
  });
  var btnAuraClose = $("#btnAuraClose");
  if (btnAuraClose) btnAuraClose.addEventListener("click", closeAuraPad);
  var auraPad = $("#auraPad");
  if (auraPad) auraPad.addEventListener("click", function (e) { if (e.target === auraPad) closeAuraPad(); });
  buildAuraPad();

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
// ================= pilot profile (Phase 4) =================
var K2 = K; K2.pilot = "dodger_pilot_v1";
var pilot = Store.get(K2.pilot, { name: "LUMEN", title: "PIONEER", avatar: "" });
if (!pilot || typeof pilot !== "object") pilot = { name: "LUMEN", title: "PIONEER", avatar: "" };
if (!pilot.name) pilot.name = "LUMEN";
if (!pilot.title) pilot.title = "PIONEER";
function savePilot() { Store.set(K2.pilot, pilot); }

function paintAvatar(el, big) {
  if (!el) return;
  if (pilot.avatar) {
    el.style.backgroundImage = "url(" + pilot.avatar + ")";
    el.textContent = "";
  } else {
    el.style.backgroundImage = "none";
    el.textContent = (pilot.name || "L").charAt(0).toUpperCase();
  }
  if (big) el.title = pilot.name + " // " + pilot.title;
}

function renderPilot() {
  var n = $("#pilotName"), t = $("#pilotTitle");
  if (n) n.textContent = pilot.name;
  if (t) t.textContent = pilot.title;
  paintAvatar($("#pilotAvatar"));
  paintAvatar($("#pilotAvatarBig"), true);
}

function openPilotPanel() {
  $("#pilotNameInput").value = pilot.name;
  $("#pilotTitleInput").value = pilot.title;
  paintAvatar($("#pilotAvatarBig"), true);
  $("#pilotPanel").hidden = false;
}

function closePilotPanel() { $("#pilotPanel").hidden = true; }

function savePilotPanel() {
  var v = $("#pilotNameInput").value.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 14);
  pilot.name = v || "LUMEN";
  pilot.title = $("#pilotTitleInput").value || "PIONEER";
  savePilot();
  renderPilot();
  closePilotPanel();
  Sfx.click();
}

function loadAvatarFile(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  if (!/^image\//.test(f.type)) return;
  var fr = new FileReader();
  fr.onload = function () {
    var img = new Image();
    img.onload = function () {
      var c = document.createElement("canvas");
      var S = 96; c.width = S; c.height = S;
      var cx = c.getContext("2d");
      var s = Math.min(img.width, img.height);
      cx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, S, S);
      pilot.avatar = c.toDataURL("image/jpeg", 0.82);
      savePilot();
      renderPilot();
      paintAvatar($("#pilotAvatarBig"), true);
      Sfx.click();
    };
    img.src = fr.result;
  };
  fr.readAsDataURL(f);
  input.value = "";
}

(function wirePilot() {
  renderPilot();
  var e = $("#btnPilotEdit"); if (e) e.addEventListener("click", openPilotPanel);
  var hp = $("#btnPilot"); if (hp) hp.addEventListener("click", openPilotPanel);
  var a = $("#pilotAvatar"); if (a) a.addEventListener("click", openPilotPanel);
  var s = $("#btnPilotPanelSave"); if (s) s.addEventListener("click", savePilotPanel);
  var c = $("#btnPilotPanelClose"); if (c) c.addEventListener("click", closePilotPanel);
  var f1 = $("#pilotFile"); if (f1) f1.addEventListener("change", function () { loadAvatarFile(this); });
  var f2 = $("#pilotFile2"); if (f2) f2.addEventListener("change", function () { loadAvatarFile(this); });
  var av2 = $("#pilotAvatarBig"); if (av2) av2.addEventListener("click", function () { var fi = $("#pilotFile2"); if (fi) fi.click(); });
})();

// ================= leaderboard (Phase 5: local-first seam) =================
// Interface: LB.submit(entry) / LB.top(mode, n) -> entries. Backends:
//   - "local": localStorage (always on, works offline/static hosting)
//   - LB.remote: optional { submit(entry), top(mode, n) } — a Firebase/
//     Supabase adapter plugs in here without touching game code.
K.lb = "dodger_lb_v1";
var LB = {
  remote: null,   // set to { submit: fn, top: fn } when a cloud backend lands
  LIMIT: 25,
  _all: function () {
    var v = Store.get(K.lb, []);
    return Array.isArray(v) ? v : [];
  },
  _save: function (list) { Store.set(K.lb, list); },
  submit: function (entry) {
    if (!entry || G.ghostScore) return;   // cheat/tutorial runs never rank
    var row = {
      mode: entry.mode || G.mode,
      name: (pilot && pilot.name) || "LUMEN",
      title: (pilot && pilot.title) || "PIONEER",
      score: Math.max(0, Math.floor(entry.score || 0)),
      time: Math.round((entry.time || 0) * 10) / 10,
      rank: entry.rank || "",
      won: !!entry.won,
      date: entry.date || "",
      at: Date.now()
    };
    var list = this._all();
    list.push(row);
    list.sort(function (a, b) { return b.score - a.score || a.at - b.at; });
    if (list.length > this.LIMIT) list = list.slice(0, this.LIMIT);
    this._save(list);
    if (this.remote && typeof this.remote.submit === "function") {
      try { this.remote.submit(row); } catch (e) {}   // cloud push is fire-and-forget
    }
    return row;
  },
  top: function (mode, n) {
    n = n || 10;
    var rows = this._all().filter(function (r) { return !mode || r.mode === mode; });
    var cloud = (this._cloud && mode) ? this._cloud[mode] : null;
    if (cloud && cloud.length) rows = rows.concat(cloud);
    rows.sort(function (a, b) { return b.score - a.score || a.at - b.at; });
    var seen = {}, out = [];
    for (var i = 0; i < rows.length; i++) {
      var rr = rows[i];
      var key = rr.mode + "|" + rr.name + "|" + rr.score + "|" + rr.at;
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(rr);
      if (out.length >= n) break;
    }
    return out;
  },
  clear: function () { this._save([]); }
};

function submitRun(won) {
  if (G.mode === "tutorial") return;
  if (G.daily && activeCheat) return;   // cheat runs never score on the daily board
  if (G.daily && !G.ghostScore) {
    var db = Store.get(K.dailyBest, {});
    if (!db || typeof db !== "object") db = {};
    var dsc = Math.floor(G.score);
    if (dsc > (db[G.daily] | 0)) { db[G.daily] = dsc; Store.set(K.dailyBest, db); }
  }
  LB.submit({
    mode: G.daily ? "daily" : G.mode,
    date: G.daily || "",
    score: G.score,
    time: G.elapsed,
    won: won,
    rank: (G.mode === "classic" && won) ? computeRank() : ""
  });
}

var lbMode = "endless";
function renderBoard() {
  var rows = LB.top(lbMode, 10);
  var box = $("#lbRows");
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = "<p class='lb-empty'>NO RUNS LOGGED — FLY ONE.</p>";
  } else {
    box.innerHTML = rows.map(function (r, i) {
      var medal = i === 0 ? "★" : (i === 1 ? "☆" : (i + 1));
      var detail = (r.date ? r.date + " · " : "") + (r.rank ? r.rank + " · " : (r.time ? r.time + "s · " : ""));
      return "<div class='lb-row'>" +
        "<span class='lb-pos'>" + medal + "</span>" +
        "<span class='lb-name'>" + String(r.name).slice(0, 14) + "</span>" +
        "<span class='lb-title'>" + String(r.title || "").slice(0, 12) + "</span>" +
        "<span class='lb-score'>" + r.score + "</span>" +
        "<span class='lb-detail'>" + detail + (r.won ? "CLEARED" : "") + "</span>" +
        "</div>";
    }).join("");
  }
  var tabs = $("#lbTabs");
  if (tabs) Array.prototype.forEach.call(tabs.children, function (b) {
    b.classList.toggle("on", b.dataset.mode === lbMode);
  });
  var src = $("#lbSource");
  if (src) src.textContent = !CLOUD.on ? "SOURCE: THIS DEVICE"
    : (LB.cloudOK === true ? "SOURCE: CLOUD + DEVICE"
    : (LB.cloudOK === false ? "SOURCE: THIS DEVICE (CLOUD OFFLINE)" : "SOURCE: THIS DEVICE"));
}
function openBoard() {
  renderBoard();
  refreshCloudBoard();
  $("#modalBoard").hidden = false;
}
function closeBoard() { $("#modalBoard").hidden = true; }

(function wireBoard() {
  var btn = $("#btnBoard"); if (btn) btn.addEventListener("click", openBoard);
  var close = $("#btnBoardClose"); if (close) close.addEventListener("click", closeBoard);
  var clear = $("#btnBoardClear");
  if (clear) clear.addEventListener("click", function () { LB.clear(); renderBoard(); Sfx.click(); });
  var mb = $("#modalBoard");
  if (mb) mb.addEventListener("click", function (e) { if (e.target === mb) closeBoard(); });
  var tabs = $("#lbTabs");
  if (tabs) tabs.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-mode]");
    if (!b) return;
    lbMode = b.dataset.mode;
    renderBoard();
    Sfx.click();
  });
})();


// ================= pilot passport (Phase 5: local-first account seam) =================
// Portable identity: export your pilot + progress as one code, import it on
// another device. No server needed — fully static. Passport.remote is the
// seam a cloud backend (Firebase anon auth, etc.) plugs into later:
//   { push: function(payload) {}, pull: function() -> payload|null }
K.passport = "dodger_passport_v1";
var Passport = {
  VERSION: 1,
  remote: null,
  // ---- collect everything portable (avatar stays device-local: photo is
  // deliberately excluded so codes stay short enough to paste) ----
  dump: function () {
    var per = getBotWins().per;
    return {
      v: this.VERSION,
      at: Date.now(),
      pilot: { name: pilot.name, title: pilot.title },
      prog: {
        unlocked: prog.unlocked,
        ranks: Object.assign({}, prog.ranks),
        nullUnlocked: !!prog.nullUnlocked
      },
      ship: { shape: HANGAR.shape, paint: HANGAR.paint, trail: HANGAR.trail, flair: HANGAR.flair },
      bests: { endless: Store.get(K.bestEndless, 0), null: Store.get(K.bestNull, 0) },
      botWins: per,
      tutorial: !!Store.get(K.tutorial, {}).done,
      lb: LB._all(),
      dailyBest: Store.get(K.dailyBest, {})
    };
  },
  encode: function (payload) {
    var json = JSON.stringify(payload);
    var b64 = btoa(unescape(encodeURIComponent(json)));
    return "DODGER1." + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  exportCode: function () { return this.encode(this.dump()); },
  // ---- decode + validate; returns payload or null ----
  decode: function (code) {
    if (typeof code !== "string") return null;
    var s = code.trim().replace(/\s+/g, "");
    if (s.slice(0, 8) !== "DODGER1.") return null;
    s = s.slice(8).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    try {
      var json = decodeURIComponent(escape(atob(s)));
      var p = JSON.parse(json);
      if (!p || typeof p !== "object" || p.v !== this.VERSION) return null;
      if (!p.pilot || typeof p.pilot !== "object") return null;
      return p;
    } catch (e) { return null; }
  },
  // ---- merge imported payload into local state (best-of wins, identity taken) ----
  merge: function (p) {
    var summary = { ranks: 0, sectors: 0, scores: 0, botWins: 0, scoresLB: 0 };
    // identity: callsign/title come from the passport; local avatar kept
    pilot.name = String(p.pilot.name || "LUMEN").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 14) || "LUMEN";
    pilot.title = String(p.pilot.title || "PIONEER").slice(0, 14);
    // campaign: max unlocked, better rank per sector
    if (p.prog && typeof p.prog === "object") {
      var inc = p.prog.unlocked | 0;
      if (inc > prog.unlocked) { prog.unlocked = inc; summary.sectors++; }
      if (p.prog.nullUnlocked && !prog.nullUnlocked) { prog.nullUnlocked = true; summary.sectors++; }
      var ranks = p.prog.ranks || {};
      for (var id in ranks) {
        if (!Object.prototype.hasOwnProperty.call(ranks, id)) continue;
        var r = ranks[id];
        if ((r === "S" || r === "A" || r === "B" || r === "C") && (!prog.ranks[id] || rankBetter(r, prog.ranks[id]))) {
          prog.ranks[id] = r; summary.ranks++;
        }
      }
    }
    // bests: max
    if (p.bests) {
      [K.bestEndless, K.bestNull].forEach(function (key, i) {
        var inc2 = (p.bests[i === 0 ? "endless" : "null"]) | 0;
        var loc = Store.get(key, 0) | 0;
        if (inc2 > loc) { Store.set(key, inc2); summary.scores++; }
      });
    }
    // bot wins: per-bot max
    if (p.botWins && typeof p.botWins === "object") {
      BOT_IDS.forEach(function (b) {
        var inc3 = p.botWins[b] | 0;
        var key = botWinsKey(b);
        var loc2 = Store.get(key, 0) | 0;
        if (inc3 > loc2) { Store.set(key, inc3); summary.botWins++; }
      });
    }
    // tutorial: OR
    if (p.tutorial && !Store.get(K.tutorial, {}).done) Store.set(K.tutorial, { done: true, at: Date.now() });
    // ship: passport wins (it is the pilot's loadout)
    if (p.ship && p.ship.shape) {
      // shapeLabel/paintById return fallbacks, so validate against the raw tables
      var shapeOk = SHIP_SHAPES.some(function (sh) { return sh.id === p.ship.shape; });
      var paintOk = PAINTS.some(function (pt) { return pt.id === p.ship.paint; });
      if (shapeOk) {
        HANGAR.shape = p.ship.shape;
        if (paintOk) HANGAR.paint = p.ship.paint;
        if (p.ship.trail) HANGAR.trail = p.ship.trail;
        HANGAR.flair = p.ship.flair | 0;
        Store.set(K.shipCustom, HANGAR);
      }
    }
    // leaderboard: merge, dedupe, cap
    if (Array.isArray(p.lb)) {
      var seen = {}, before = LB._all().length;
      var merged = LB._all().concat(p.lb.filter(function (r) {
        if (!r || typeof r !== "object") return false;
        var k = [r.mode, r.score, r.at, r.name].join("|");
        if (seen[k]) return false;
        seen[k] = 1; return true;
      }));
      merged.sort(function (a, b) { return (b.score | 0) - (a.score | 0) || (a.at | 0) - (b.at | 0); });
      if (merged.length > LB.LIMIT) merged = merged.slice(0, LB.LIMIT);
      LB._save(merged);
      summary.scoresLB = Math.max(0, merged.length - before);
    }
    if (p.dailyBest && typeof p.dailyBest === "object") {
      var dbp = Store.get(K.dailyBest, {}) || {};
      var dbc = false;
      for (var ddate in p.dailyBest) {
        if (!Object.prototype.hasOwnProperty.call(p.dailyBest, ddate)) continue;
        var dv = p.dailyBest[ddate] | 0;
        if (dv > (dbp[ddate] | 0)) { dbp[ddate] = dv; dbc = true; }
      }
      if (dbc) Store.set(K.dailyBest, dbp);
    }
    saveProgress();
    savePilot();
    return summary;
  },
  importCode: function (code) {
    var p = this.decode(code);
    if (!p) return { ok: false, error: "BAD CODE — COPY THE WHOLE THING." };
    var s = this.merge(p);
    refreshHome();
    renderPilot();
    if (typeof renderBoard === "function" && $("#modalBoard") && !$("#modalBoard").hidden) renderBoard();
    return { ok: true, summary: s };
  }
};

var PASSPORT_LIMIT = 6000; // chars — warn if the code gets unwieldy
function passportExport() {
  var code = Passport.exportCode();
  var box = $("#passportBox");
  var status = $("#passportStatus");
  if (box) { box.value = code; box.focus(); box.select(); }
  if (status) status.textContent = code.length > PASSPORT_LIMIT
    ? "CODE READY (" + code.length + " CHARS — SLOW TO PASTE)"
    : "CODE READY (" + code.length + " CHARS) — COPY IT.";
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code);
  } catch (e) {}
  Sfx.win();
  return code;
}
function passportImport() {
  var box = $("#passportBox");
  var status = $("#passportStatus");
  var res = Passport.importCode(box ? box.value : "");
  if (!res.ok) {
    if (status) status.textContent = res.error;
    Sfx.lose();
    return res;
  }
  var s = res.summary;
  var bits = [];
  if (s.sectors) bits.push(s.sectors + " SECTOR" + (s.sectors === 1 ? "" : "S"));
  if (s.ranks) bits.push(s.ranks + " RANK" + (s.ranks === 1 ? "" : "S"));
  if (s.scores) bits.push(s.scores + " BEST" + (s.scores === 1 ? "" : "S"));
  if (s.botWins) bits.push(s.botWins + " BOT WINS");
  if (s.scoresLB) bits.push(s.scoresLB + " BOARD ENTRIES");
  if (status) status.textContent = "PASSPORT MERGED: " + (bits.length ? bits.join(" + ") : "NOTHING NEW — YOU WERE AHEAD.");
  if (box) box.value = "";
  Sfx.win();
  return res;
}

(function wirePassport() {
  var ex = $("#btnPassExport"); if (ex) ex.addEventListener("click", passportExport);
  var im = $("#btnPassImport"); if (im) im.addEventListener("click", passportImport);
})();



// ================= cloud (Supabase) =================
// The anon key is a PUBLIC credential (safe in client code); abuse is limited
// by the RLS policies in supabase_schema.sql (no deletes, bounded columns).
// CLOUD.on=false or any network failure falls back to the local backend.
var CLOUD = {
  url: "https://rfefjcdxlfcodhwflwrs.supabase.co",
  anon: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmZWZqY2R4bGZjb2Rod2Zsd3JzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1NDY5OTEsImV4cCI6MjEwNzEyMjk5MX0.ZSH-tpOGLF_bjP75Fi-konKwyH40ni2zEJ1i496E5Sk",
  on: true,
  hdrs: function (extra) {
    var h = { "Content-Type": "application/json", "apikey": this.anon, "Authorization": "Bearer " + this.anon };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }
};

LB.remote = {
  submit: function (row) {   // fire-and-forget: local save already happened
    if (!CLOUD.on || !row) return;
    try {
      fetch(CLOUD.url + "/rest/v1/runs", {
        method: "POST",
        headers: CLOUD.hdrs({ "Prefer": "return=minimal" }),
        body: JSON.stringify([{
          mode: row.mode, name: row.name, title: row.title, score: row.score,
          time: row.time, rank: row.rank, won: !!row.won, date: row.date || "", at: row.at | 0
        }])
      }).then(function (r) { if (!r.ok) throw new Error("http " + r.status); }).catch(function () {});
    } catch (e) {}
  },
  top: function (mode, n) {   // async: resolves rows, rejects -> caller keeps local
    if (!CLOUD.on) return Promise.reject(new Error("cloud off"));
    var q = "select=mode,name,title,score,time,rank,won,date,at&order=score.desc,at.asc&limit=" + (n || 10);
    if (mode) q += "&mode=eq." + encodeURIComponent(mode);
    return fetch(CLOUD.url + "/rest/v1/runs?" + q, { headers: CLOUD.hdrs() }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    }).then(function (rows) { return Array.isArray(rows) ? rows : []; });
  }
};

LB._cloud = {};
LB.cloudOK = null;   // null = not tried yet, true = fresh, false = failed/off
function refreshCloudBoard() {
  if (!LB.remote || !CLOUD.on) { LB.cloudOK = false; return; }
  LB.remote.top(lbMode, 10).then(function (rows) {
    LB._cloud[lbMode] = rows;
    LB.cloudOK = true;
    renderBoard();
  }).catch(function () { LB.cloudOK = false; renderBoard(); });
}

Passport.remote = {
  push: function (payload) {
    if (!CLOUD.on || !payload) return Promise.reject(new Error("cloud off"));
    var cs = String((payload.pilot && payload.pilot.name) || (pilot && pilot.name) || "").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 14);
    if (!cs) return Promise.reject(new Error("no callsign"));
    return fetch(CLOUD.url + "/rest/v1/passports?on_conflict=callsign", {
      method: "POST",
      headers: CLOUD.hdrs({ "Prefer": "resolution=merge-duplicates" }),
      body: JSON.stringify([{ callsign: cs, payload: payload, updated_at: Date.now() }])
    }).then(function (r) { if (!r.ok) throw new Error("http " + r.status); return true; });
  },
  pull: function (cs) {
    if (!CLOUD.on) return Promise.reject(new Error("cloud off"));
    cs = String(cs || (pilot && pilot.name) || "").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 14);
    if (!cs) return Promise.reject(new Error("no callsign"));
    return fetch(CLOUD.url + "/rest/v1/passports?callsign=eq." + encodeURIComponent(cs) + "&select=payload",
      { headers: CLOUD.hdrs() }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    }).then(function (rows) { return (rows && rows[0] && rows[0].payload) || null; });
  }
};

(function wireCloudPassport() {
  var sv = $("#btnPassSave"), ld = $("#btnPassLoad"), st = $("#passportStatus");
  if (sv) sv.addEventListener("click", function () {
    if (!Passport.remote) return;
    if (st) st.textContent = "PUSHING PILOT TO CLOUD…";
    Passport.remote.push(Passport.dump()).then(function () {
      if (st) st.textContent = "PILOT SAVED TO CLOUD AS '" + pilot.name + "'.";
      Sfx.win();
    }).catch(function () {
      if (st) st.textContent = "CLOUD UNAVAILABLE — USE EXPORT CODE INSTEAD.";
      Sfx.lose();
    });
  });
  if (ld) ld.addEventListener("click", function () {
    if (!Passport.remote) return;
    if (st) st.textContent = "PULLING PILOT FROM CLOUD…";
    Passport.remote.pull(pilot.name).then(function (p) {
      if (!p) {
        if (st) st.textContent = "NO CLOUD PILOT NAMED '" + pilot.name + "'.";
        Sfx.lose();
        return;
      }
      Passport.merge(p);
      refreshHome();
      renderPilot();
      if (st) st.textContent = "CLOUD PILOT '" + pilot.name + "' MERGED INTO THIS DEVICE.";
      Sfx.win();
    }).catch(function () {
      if (st) st.textContent = "CLOUD UNAVAILABLE — USE IMPORT CODE INSTEAD.";
      Sfx.lose();
    });
  });
})();

  route();
  window.addEventListener("load", fitCanvas);
  // ================= tutorial coach / buttons =================
  var bs = $("#btnCoachSkip");
  if (bs) bs.addEventListener("click", tutSkip);
  bs.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") tutSkip(); });
  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    if (act === "tut-classic") { tutSkip(); startMode("classic"); }
    else if (act === "tut-retry") { tutSkip(); startTutorial(); }
    else if (act === "tut-home") { tutSkip(); goHome(); }
  });
})();



