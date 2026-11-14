import shutil
shutil.copy("game.js", "game.js.bak2")
s = open("game.js", encoding="utf-8").read()

anchor = "// ================= cloud (Supabase) ================="
assert s.count(anchor) == 1, "cloud anchor not found/unique"
assert "var Music" not in s, "Music already added"

block = r'''// ================= music + engine hum =================
var Music = {
  VOL: 0.5,                       // master music level (0..1)
  on: false, step: 0, nextT: 0, bus: null, hum: null, lastX: null, spd: 0, noise: null,
  roots: [110, 123.47, 98, 130.81, 116.54, 103.83, 123.47, 87.31],
  scale: [0, 3, 5, 7, 10, 12, 15, 17],
  arp: [0, 2, 4, 2, 5, 4, 2, 1],
  start: function () {
    var c = Sfx.ensure(); if (!c || this.on) return;
    this.on = true; this.step = 0; this.nextT = c.currentTime + 0.1; this.lastX = null;
    this.bus = c.createGain();
    this.bus.gain.setValueAtTime(0.0001, c.currentTime);
    this.bus.gain.exponentialRampToValueAtTime(this.VOL, c.currentTime + 1.5);
    this.bus.connect(c.destination);
    var o = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter();
    o.type = "sawtooth"; o.frequency.value = 70; f.type = "lowpass"; f.frequency.value = 320;
    g.gain.value = 0.0001; o.connect(f); f.connect(g); g.connect(this.bus); o.start();
    this.hum = { o: o, g: g };
    if (!this.noise) {
      var n = c.createBuffer(1, c.sampleRate * 0.1, c.sampleRate), d = n.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = n;
    }
  },
  stop: function () {
    if (!this.on) return;
    this.on = false;
    var c = Sfx.ctx, bus = this.bus, hum = this.hum;
    this.bus = null; this.hum = null; this.lastX = null;
    if (!c || !bus) return;
    try {
      bus.gain.cancelScheduledValues(c.currentTime);
      bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), c.currentTime);
      bus.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.5);
      setTimeout(function () {
        try { if (hum) hum.o.stop(); bus.disconnect(); } catch (e) {}
      }, 700);
    } catch (e) {}
  },
  note: function (f, t, dur, type, gain) {
    var c = Sfx.ctx; if (!c || !this.bus) return;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.bus); o.start(t); o.stop(t + dur + 0.02);
  },
  hat: function (t, gain) {
    var c = Sfx.ctx; if (!c || !this.bus || !this.noise) return;
    var s = c.createBufferSource(), g = c.createGain(), f = c.createBiquadFilter();
    s.buffer = this.noise; f.type = "highpass"; f.frequency.value = 7000;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    s.connect(f); f.connect(g); g.connect(this.bus); s.start(t); s.stop(t + 0.06);
  },
  tick: function () {
    var playing = typeof G !== "undefined" && G.state === "playing" && !Sfx.muted && player;
    if (!playing) { this.stop(); return; }
    if (!this.on) this.start();
    var c = Sfx.ctx; if (!c || !this.on) return;
    var inten = Math.min(1, (G.elapsed || 0) / 180 + (G.combo || 0) / 60);
    var sid = (G.sector && G.sector.id | 0) || 1;
    var root = this.roots[(sid - 1) % this.roots.length];
    var stepDur = 60 / (110 + inten * 50) / 2;
    while (this.nextT < c.currentTime + 0.4) {
      var st = this.step, t = this.nextT, m = st % 8;
      if (m === 0) {
        this.note(root, t, stepDur * 3.6, "sawtooth", 0.05);
        this.note(110, t, 0.12, "sine", 0.07);            // kick thump
      }
      if (m === 4) this.note(root * 1.5, t, stepDur * 3, "sawtooth", 0.035);
      var semi = this.scale[this.arp[m]];
      this.note(root * 4 * Math.pow(2, semi / 12), t, stepDur * 0.9, "square", 0.018 + inten * 0.012);
      if (inten > 0.35 && (st % 2 === 1)) this.hat(t, 0.02 + inten * 0.02);
      this.nextT += stepDur; this.step++;
    }
    // engine hum follows ship speed
    var x = player.x;
    if (this.lastX != null) {
      var v = Math.min(1, Math.abs(x - this.lastX) / 0.1 / 560);
      this.spd += (v - this.spd) * 0.4;
    }
    this.lastX = x;
    if (this.hum) {
      this.hum.o.frequency.setTargetAtTime(62 + this.spd * 70, c.currentTime, 0.08);
      this.hum.g.gain.setTargetAtTime(0.012 + this.spd * 0.03, c.currentTime, 0.08);
    }
  }
};
setInterval(function () { try { Music.tick(); } catch (e) {} }, 100);

'''
s = s.replace(anchor, block + anchor)
open("game.js", "w", encoding="utf-8").write(s)
print("added", len(block), "chars")
