// Canvas renderer. It only draws what the server tells it: the multiplier comes from live ticks and the
// crash is announced after it happened. Hazards and decoys are cosmetic and never influence the outcome.
import { THEMES } from './themes.js';
import { audio } from './audio.js';

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const frac = (m) => 1 - 1 / (1 + Math.log(Math.max(m, 1)) * 0.8); // altitude 0..1 from multiplier
const LEAVES = ['#d9531e', '#e8962e', '#b5382a', '#f0b43c'];

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => {
  const A = rgb(a); const B = rgb(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`;
};

// How each crash cause looks. `hit` = an object that flies into the bird; `fx` = a weather effect.
const CAUSES = {
  lightning: { fx: 'lightning', fall: 'tumble' },
  soaked: { fx: 'rain', fall: 'sink' },
  kite: { hit: 'kite', fall: 'tumble' },
  hawk: { hit: 'hawk', fall: 'tumble' },
  heat: { fx: 'shimmer', fall: 'sink' },
  drone: { hit: 'drone', fall: 'tumble' },
  gust: { fx: 'leaves', fall: 'tumble' },
  leafstorm: { fx: 'leaves', fall: 'tumble' },
  flock: { hit: 'flock', fall: 'tumble' },
  frost: { fx: 'frost', fall: 'freeze' },
  whiteout: { fx: 'whiteout', fall: 'sink' },
  icicle: { hit: 'icicle', fall: 'tumble' },
};

// Intruder shapes, drawn at the origin facing +x.
const SHAPES = {
  hawk(c, s) {
    c.fillStyle = '#2b2118';
    c.beginPath(); c.ellipse(0, 0, 18 * s, 7 * s, 0, 0, TAU); c.fill();
    for (const d of [-1, 1]) {
      c.beginPath(); c.moveTo(-2 * s, 0);
      c.quadraticCurveTo(-6 * s, d * 28 * s, -26 * s, d * 22 * s);
      c.quadraticCurveTo(-10 * s, d * 9 * s, 4 * s, 0); c.fill();
    }
    c.fillStyle = '#e0a030';
    c.beginPath(); c.moveTo(17 * s, -2 * s); c.lineTo(26 * s, s); c.lineTo(17 * s, 4 * s); c.fill();
  },
  drone(c, s) {
    c.fillStyle = '#2d3138'; c.fillRect(-12 * s, -4 * s, 24 * s, 8 * s);
    c.strokeStyle = '#555c66'; c.lineWidth = 2 * s;
    for (const x of [-16, 16]) {
      c.beginPath(); c.moveTo(x * 0.75 * s, 0); c.lineTo(x * s, -7 * s); c.stroke();
      c.beginPath(); c.moveTo((x - 9) * s, -8 * s); c.lineTo((x + 9) * s, -8 * s); c.stroke();
    }
    c.fillStyle = '#e24a4a'; c.beginPath(); c.arc(0, 0, 2.2 * s, 0, TAU); c.fill();
  },
  kite(c, s) {
    c.fillStyle = '#e0405a';
    c.beginPath(); c.moveTo(18 * s, 0); c.lineTo(0, -12 * s); c.lineTo(-18 * s, 0); c.lineTo(0, 12 * s); c.closePath(); c.fill();
    c.strokeStyle = '#7a2a3a'; c.lineWidth = 1.5 * s;
    c.beginPath(); c.moveTo(18 * s, 0); c.lineTo(-18 * s, 0); c.moveTo(0, -12 * s); c.lineTo(0, 12 * s); c.stroke();
    c.beginPath(); c.moveTo(-18 * s, 0); c.quadraticCurveTo(-32 * s, 10 * s, -44 * s, 0); c.stroke();
  },
  flock(c, s) {
    c.strokeStyle = '#33323a'; c.lineWidth = 2.2 * s;
    for (const [x, y] of [[0, 0], [-16, -10], [-16, 10], [-32, -20], [-32, 20]]) {
      c.beginPath(); c.moveTo((x - 7) * s, (y - 6) * s); c.lineTo(x * s, y * s); c.lineTo((x - 7) * s, (y + 6) * s); c.stroke();
    }
  },
  icicle(c, s) {
    c.fillStyle = '#d4edff'; c.strokeStyle = '#8fc4e8'; c.lineWidth = 1.5 * s;
    c.beginPath(); c.moveTo(22 * s, 0); c.lineTo(-14 * s, -7 * s); c.lineTo(-14 * s, 7 * s); c.closePath(); c.fill(); c.stroke();
  },
};

function wing(c, angle, color) {
  c.save();
  c.translate(-2, -4);
  c.rotate(angle);
  c.fillStyle = color;
  c.beginPath(); c.moveTo(0, 0);
  c.quadraticCurveTo(-6, -30, -30, -34);
  c.quadraticCurveTo(-14, -14, 8, -2);
  c.fill();
  c.restore();
}

function drawBird(c, x, y, ang, flap, s, tint) {
  c.save();
  c.translate(x, y); c.rotate(ang); c.scale(s, s);
  wing(c, flap - 0.25, '#2a4268');
  c.fillStyle = '#2a4268';
  c.beginPath(); c.moveTo(-18, 0); c.lineTo(-38, -7); c.lineTo(-35, 0); c.lineTo(-38, 7); c.closePath(); c.fill();
  c.fillStyle = '#3f6aa8'; c.beginPath(); c.ellipse(0, 0, 22, 11, 0, 0, TAU); c.fill();
  c.fillStyle = '#f6efe2'; c.beginPath(); c.ellipse(2, 3, 16, 7, 0, 0, Math.PI); c.fill();
  c.fillStyle = '#3f6aa8'; c.beginPath(); c.arc(21, -5, 8, 0, TAU); c.fill();
  c.fillStyle = '#f2a93b'; c.beginPath(); c.moveTo(28, -7); c.lineTo(38, -4); c.lineTo(28, -2); c.closePath(); c.fill();
  c.fillStyle = '#10131a'; c.beginPath(); c.arc(24, -7, 1.8, 0, TAU); c.fill();
  wing(c, flap, '#33598f');
  if (tint) {
    c.globalAlpha = 0.5; c.fillStyle = tint;
    c.beginPath(); c.ellipse(2, -2, 32, 20, 0, 0, TAU); c.fill();
  }
  c.restore();
}

export class Scene {
  reduced = false;
  onMult = () => {};
  onImpact = () => {};
  onIdle = () => {};

  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.cur = THEMES.spring; this.prev = this.cur; this.fade = 1; this.inited = false; this.pending = null;
    this.cfg = { crashCauses: ['gust'], decoyRate: 0, leadInMs: [300, 600], risk: 0.3 };
    this.mode = 'idle'; // idle | flying | crashing | crashed | cashed
    this.g = 0.1; this.mult = 1; this.base = { m: 1, at: 0 }; this.disp = 1;
    this.dist = 0; this.t = 0; this.flapPhase = 0;
    this.bx = 0; this.by = 0; this.ang = 0;
    this.trail = []; this.trailTimer = 0;
    this.parts = []; this.fx = []; this.hazards = []; this.ghosts = [];
    this.anim = null; this.fall = null; this.shake = 0; this.flash = 0; this.cashAt = 0; this.idleAt = 0;
    this.clouds = Array.from({ length: 7 }, () => ({ x: Math.random(), y: rand(0.06, 0.42), s: rand(0.6, 1.5), v: rand(0.004, 0.012) }));
    this.last = performance.now();
    this.resize();
    this.by = this.H * 0.8;
    addEventListener('resize', () => this.resize());
    requestAnimationFrame(this.loop);
  }

  // ---------- public API ----------
  setReduced(v) { this.reduced = v; this.seedParts(); }

  queueSeason(name, cfg) {
    this.pending = { name, cfg };
    if (this.mode === 'idle') this.applySeason();
  }

  begin(growthRate, elapsedMs = 0) {
    this.applySeason();
    this.g = growthRate; this.mode = 'flying';
    this.anim = null; this.fall = null; this.hazards = []; this.fx = []; this.trail = []; this.flash = 0;
    this.base = { m: Math.exp((growthRate * elapsedMs) / 1000), at: performance.now() };
    this.spawnGhosts();
    audio.windStart();
  }

  sync(mult) {
    if (this.mode !== 'flying') return;
    const now = performance.now();
    this.base = { m: Math.max(mult, this.currentMult(now)), at: now };
  }

  currentMult(now) {
    if (this.mode !== 'flying') return this.mult;
    return Math.max(1, this.base.m * Math.exp((this.g * (now - this.base.at)) / 1000));
  }

  // The server already settled this as a crash; play the (cosmetic) hazard that leads up to it.
  crash(crashMult, cause) {
    const now = performance.now();
    this.mult = crashMult; this.mode = 'crashing';
    audio.windStop();
    const name = cause ?? pick(this.cfg.crashCauses?.length ? this.cfg.crashCauses : ['gust']);
    const cfg = CAUSES[name] ?? CAUSES.gust;
    const [lo, hi] = this.cfg.leadInMs ?? [300, 600];
    const leadIn = this.reduced ? 150 : rand(lo, hi);
    this.anim = { name, cfg, t0: now, leadIn, hitAt: 0, bolt: null };
    if (cfg.hit) this.hazards.push({ kind: cfg.hit, t0: now, dur: leadIn, from: { x: this.W + 60, y: -50 }, to: null, crash: true });
    if (cfg.fx === 'lightning') this.anim.bolt = this.makeBolt(this.bx + rand(-20, 70), -10, this.bx, this.by);
    return name;
  }

  cash(mult, landed = false) {
    this.mult = mult; this.mode = 'cashed'; this.cashAt = performance.now();
    audio.windStop(); audio.chirp();
    for (let i = 0; i < (landed ? 36 : 16); i++) {
      this.fx.push({ kind: 'spark', x: this.bx, y: this.by, vx: rand(-160, 160), vy: rand(-220, 40), life: 1, rot: 0, vr: 0 });
    }
  }

  // ---------- internals ----------
  resize() {
    const r = this.cv.getBoundingClientRect();
    const d = Math.min(window.devicePixelRatio || 1, 2);
    this.W = Math.max(r.width, 320); this.H = Math.max(r.height, 240);
    this.cv.width = Math.round(this.W * d); this.cv.height = Math.round(this.H * d);
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
    this.bx = this.W * 0.3;
    this.seedParts();
  }

  applySeason() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.cfg = p.cfg;
    const th = THEMES[p.name] ?? THEMES.spring;
    if (th !== this.cur) {
      this.prev = this.cur; this.cur = th; this.fade = this.inited ? 0 : 1;
      this.seedParts();
    }
    this.inited = true;
  }

  seedParts() {
    const kind = this.cur.weather;
    const n = Math.round(({ rain: 90, pollen: 36, leaf: 34, snow: 110 }[kind] ?? 40) * (this.reduced ? 0.35 : 1));
    this.parts = Array.from({ length: n }, () => ({
      kind, x: rand(0, this.W), y: rand(0, this.H), r: rand(1.4, 3.4), ph: rand(0, TAU),
      rot: rand(0, TAU), vr: rand(-2, 2), c: pick(LEAVES),
    }));
  }

  spawnGhosts() {
    this.ghosts = Array.from({ length: 5 }, () => ({
      target: clamp(1 / (1 - rand(0, 0.9)), 1.1, 25), dx: -rand(70, 220), dy: rand(-70, 70),
      ph: rand(0, TAU), done: false, fall: 0,
    }));
  }

  makeBolt(x0, y0, x1, y1) {
    const pts = [[x0, y0]];
    for (let i = 1; i < 9; i++) {
      const f = i / 9;
      pts.push([x0 + (x1 - x0) * f + rand(-26, 26), y0 + (y1 - y0) * f]);
    }
    pts.push([x1, y1]);
    return pts;
  }

  spawnDecoy(now) {
    const kinds = (this.cfg.crashCauses ?? []).flatMap((c) => CAUSES[c]?.hit ?? (c === 'lightning' ? ['lightning'] : []));
    if (!kinds.length) return;
    const kind = pick(kinds);
    if (kind === 'lightning') {
      const x = rand(this.W * 0.55, this.W * 0.95);
      this.hazards.push({ kind, t0: now, dur: 320, decoy: true, bolt: this.makeBolt(x, 0, x + rand(-40, 40), this.H * 0.72) });
      this.flash = Math.max(this.flash, this.reduced ? 0.05 : 0.22);
      return;
    }
    const off = (Math.random() < 0.5 ? -1 : 1) * rand(110, 150);
    this.hazards.push({
      kind, t0: now, dur: rand(1400, 1900), decoy: true,
      from: { x: this.W + 90, y: this.by + off + rand(-40, 40) },
      to: { x: -140, y: this.by + off + rand(-40, 40) },
    });
  }

  impact(now) {
    const a = this.anim;
    a.hitAt = now;
    const tumble = a.cfg.fall === 'tumble';
    this.fall = {
      x: this.bx, y: this.by, type: a.cfg.fall,
      vx: rand(-60, 40), vy: a.cfg.fall === 'sink' ? 30 : -120,
      rot: this.ang, vr: tumble ? rand(-8, 8) : 0,
    };
    this.hazards = this.hazards.filter((h) => !h.crash);
    this.shake = this.reduced ? 0 : 14;
    this.flash = this.reduced ? 0.15 : (a.cfg.fx === 'lightning' || a.cfg.hit ? 0.9 : 0.35);
    for (let i = 0; i < 14; i++) {
      this.fx.push({ kind: 'feather', x: this.bx, y: this.by, vx: rand(-200, 200), vy: rand(-240, 60), life: 1, rot: rand(0, TAU), vr: rand(-6, 6) });
    }
    if (a.cfg.fx === 'leaves') {
      for (let i = 0; i < 40; i++) {
        this.fx.push({ kind: 'leaf', x: this.bx, y: this.by, vx: rand(-320, 320), vy: rand(-320, 120), life: 1.4, rot: rand(0, TAU), vr: rand(-8, 8), c: pick(LEAVES) });
      }
    }
    audio.crash(a.cfg.fx === 'lightning');
    this.mode = 'crashed';
    this.idleAt = now + 2600;
    this.onImpact(a.name);
  }

  idle() {
    this.mode = 'idle'; this.mult = 1;
    this.fall = null; this.anim = null; this.hazards = []; this.fx = []; this.ghosts = []; this.trail = [];
    this.flash = 0; this.shake = 0;
    this.applySeason();
    this.onIdle();
  }

  loop = (now) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now; this.t += dt;
    if (this.fade < 1) this.fade = Math.min(1, this.fade + dt / 1.2);
    this.update(dt, now);
    this.draw(now);
    requestAnimationFrame(this.loop);
  };

  update(dt, now) {
    const flying = this.mode === 'flying';
    if (flying) {
      this.mult = this.currentMult(now);
      this.onMult(this.mult);
      audio.windLevel(Math.log(this.mult) / 5);
    }
    if (this.mode === 'cashed' && now - this.cashAt > 1900) this.idle();
    if (this.mode === 'crashing' && now - this.anim.t0 >= this.anim.leadIn) this.impact(now);
    if (this.mode === 'crashed' && now > this.idleAt) this.idle();

    // Camera altitude eases toward the multiplier while flying, back down afterwards.
    const target = flying || this.mode === 'crashing' ? this.mult : 1;
    const rate = flying ? 10 : this.mode === 'cashed' ? 2.2 : this.mode === 'crashing' ? 10 : 3;
    this.disp += (target - this.disp) * Math.min(1, dt * rate);

    const m = Math.max(1, this.disp);
    const moving = flying || this.mode === 'crashing';
    const speed = moving ? 110 + 55 * Math.log(m) : 18;
    this.dist += dt * speed;

    // Bird height: ground when idle, altitude from the multiplier in flight, with risk-scaled wobble.
    const ground = this.H * 0.86 + frac(this.disp) * this.H * 0.3;
    const amp = (this.cfg.risk ?? 0.3) * (1 + Math.log(m) * 2) * (this.reduced ? 0.3 : 1);
    const ty = this.mode === 'idle'
      ? ground - 10 + Math.sin(this.t * 2) * 1.5
      : this.H * 0.8 - frac(this.disp) * this.H * 0.5 + (moving ? Math.sin(this.t * 3.1) * amp : 0);
    const prevY = this.by;
    if (this.mode !== 'crashed') this.by += (ty - this.by) * Math.min(1, dt * 8);
    this.ang = this.mode === 'crashed' ? this.ang : clamp(((this.by - prevY) / Math.max(dt, 0.001)) * 0.002, -0.45, 0.45) + (this.mode === 'cashed' ? 0.25 : 0);
    this.flapPhase += dt * TAU * (moving ? 5 + Math.log(m) * 1.2 : this.mode === 'cashed' ? 2.5 : 1.1);

    // Weather particles.
    const sp = moving ? 0.8 + Math.log(m) * 0.5 : 0.5;
    for (const p of this.parts) {
      if (p.kind === 'rain') { p.y += 520 * dt; p.x -= 140 * dt * sp; }
      else if (p.kind === 'pollen') { p.y -= 14 * dt; p.x -= (40 * sp - Math.sin(this.t + p.ph) * 10) * dt; }
      else if (p.kind === 'leaf') { p.y += 55 * dt; p.x -= (90 * sp - Math.sin(this.t * 1.5 + p.ph) * 30) * dt; p.rot += p.vr * dt; }
      else { p.y += 60 * dt; p.x -= (50 * sp - Math.sin(this.t + p.ph) * 20) * dt; }
      if (p.y > this.H + 10) { p.y = -10; p.x = rand(0, this.W + 40); }
      if (p.y < -10) { p.y = this.H + 10; p.x = rand(0, this.W); }
      if (p.x < -20) p.x = this.W + 20;
    }
    for (const c of this.clouds) {
      c.x -= c.v * dt * (1 + sp);
      if (c.x < -0.3) { c.x = 1.2; c.y = rand(0.06, 0.42); }
    }

    // Trail and ghost flock.
    if (flying) {
      this.trailTimer += dt;
      if (this.trailTimer > 0.03) {
        this.trailTimer = 0;
        this.trail.push({ d: this.dist, y: this.by });
        if (this.trail.length > 70) this.trail.shift();
      }
      if (Math.random() < (this.cfg.decoyRate ?? 0) * dt) this.spawnDecoy(now);
    }
    for (const g of this.ghosts) {
      if (!g.done && flying && this.mult >= g.target) g.done = true;
      if (g.done) g.fall += dt;
    }

    // Fall physics, effects, shake and flash.
    if (this.fall) {
      const f = this.fall;
      if (f.type === 'sink') { f.vy = Math.min(f.vy + 260 * dt, 260); f.rot += (0.9 - f.rot) * dt * 2; }
      else { f.vy += (f.type === 'freeze' ? 700 : 900) * dt; f.rot += f.vr * dt; }
      f.x += f.vx * dt; f.y += f.vy * dt;
    }
    for (const e of this.fx) {
      e.x += e.vx * dt; e.y += e.vy * dt; e.rot += e.vr * dt; e.life -= dt * 0.7;
      e.vy += (e.kind === 'spark' ? 200 : e.kind === 'leaf' ? 40 : 120) * dt;
      if (e.kind === 'leaf') e.vx += Math.sin(this.t * 6 + e.rot) * 400 * dt;
    }
    this.fx = this.fx.filter((e) => e.life > 0);
    this.hazards = this.hazards.filter((h) => h.crash || now - h.t0 < h.dur);
    this.shake = Math.max(0, this.shake - dt * 30);
    this.flash = Math.max(0, this.flash - dt * 2.5);
  }

  // ---------- drawing ----------
  col(key) {
    return this.fade >= 1 ? this.cur[key] : mix(this.prev[key], this.cur[key], this.fade);
  }

  hills(color, base, amp, f, speed, off) {
    const c = this.ctx;
    c.fillStyle = color;
    c.beginPath(); c.moveTo(0, this.H);
    for (let x = 0; x <= this.W + 8; x += 8) {
      const wx = x + this.dist * speed;
      c.lineTo(x, base + Math.sin(wx * f) * amp + Math.sin(wx * f * 2.3 + off) * amp * 0.4);
    }
    c.lineTo(this.W, this.H); c.closePath(); c.fill();
  }

  drawCloud(cl) {
    const c = this.ctx;
    const x = cl.x * (this.W + 300) - 150; const y = cl.y * this.H; const s = cl.s * 34;
    c.globalAlpha = 0.85; c.fillStyle = this.col('cloud');
    c.beginPath();
    c.ellipse(x, y, s * 1.6, s * 0.7, 0, 0, TAU);
    c.ellipse(x - s, y + s * 0.2, s, s * 0.55, 0, 0, TAU);
    c.ellipse(x + s * 1.1, y + s * 0.15, s * 1.1, s * 0.6, 0, 0, TAU);
    c.fill(); c.globalAlpha = 1;
  }

  drawParts() {
    const c = this.ctx;
    for (const p of this.parts) {
      if (p.kind === 'rain') {
        c.strokeStyle = 'rgba(70,110,165,0.45)'; c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x - 3, p.y + 12); c.stroke();
      } else if (p.kind === 'pollen') {
        c.fillStyle = 'rgba(255,240,150,0.85)'; c.beginPath(); c.arc(p.x, p.y, p.r * 0.7, 0, TAU); c.fill();
      } else if (p.kind === 'leaf') {
        c.save(); c.translate(p.x, p.y); c.rotate(p.rot); c.fillStyle = p.c;
        c.beginPath(); c.ellipse(0, 0, p.r * 2.6, p.r * 1.4, 0, 0, TAU); c.fill(); c.restore();
      } else {
        c.fillStyle = 'rgba(255,255,255,0.9)'; c.beginPath(); c.arc(p.x, p.y, p.r, 0, TAU); c.fill();
      }
    }
  }

  drawBolt(pts, alpha) {
    const c = this.ctx;
    c.save();
    c.globalAlpha = clamp(alpha); c.strokeStyle = '#ffffff'; c.lineWidth = 4; c.shadowColor = '#bcd7ff'; c.shadowBlur = 18;
    c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.stroke();
    c.restore();
  }

  drawHazards(now) {
    const c = this.ctx;
    for (const h of this.hazards) {
      const p = clamp((now - h.t0) / h.dur);
      if (h.kind === 'lightning') { this.drawBolt(h.bolt, 1 - p); continue; }
      const to = h.to ?? { x: this.bx, y: this.by };
      const x = h.from.x + (to.x - h.from.x) * p; const y = h.from.y + (to.y - h.from.y) * p;
      const dx = to.x - h.from.x; const dy = to.y - h.from.y;
      c.save();
      c.translate(x, y);
      c.scale(dx < 0 ? -1 : 1, 1);
      c.rotate(Math.atan2(dy, Math.abs(dx)));
      if (h.kind === 'hawk') c.scale(1, 1 + Math.sin(this.t * 14) * 0.15);
      SHAPES[h.kind](c, 1.1);
      c.restore();
    }
  }

  drawFx(now) {
    const c = this.ctx; const a = this.anim;
    if (!a) return;
    const p = clamp((now - a.t0) / a.leadIn);
    const q = a.hitAt ? clamp((now - a.hitAt) / 1600) : 0;
    const k = p * (1 - q);
    c.save();
    switch (a.cfg.fx) {
      case 'whiteout': c.fillStyle = `rgba(255,255,255,${0.92 * k})`; c.fillRect(0, 0, this.W, this.H); break;
      case 'shimmer': c.fillStyle = `rgba(255,150,40,${0.32 * k})`; c.fillRect(0, 0, this.W, this.H); break;
      case 'rain':
        c.fillStyle = `rgba(30,50,90,${0.35 * k})`; c.fillRect(0, 0, this.W, this.H);
        c.strokeStyle = `rgba(190,215,255,${0.6 * k})`; c.lineWidth = 1.4;
        for (let i = 0; i < 70; i++) { const x = Math.random() * this.W; const y = Math.random() * this.H; c.beginPath(); c.moveTo(x, y); c.lineTo(x - 4, y + 16); c.stroke(); }
        break;
      case 'frost': {
        const g = c.createRadialGradient(this.W / 2, this.H / 2, this.H * 0.15, this.W / 2, this.H / 2, this.H * 0.85);
        g.addColorStop(0, 'rgba(200,235,255,0)'); g.addColorStop(1, `rgba(200,235,255,${0.95 * k})`);
        c.fillStyle = g; c.fillRect(0, 0, this.W, this.H);
        break;
      }
      case 'lightning': if (a.bolt && (p > 0.7 || a.hitAt)) this.drawBolt(a.bolt, a.hitAt ? 1 - q * 2 : 1); break;
      default: break;
    }
    c.restore();
  }

  drawGhosts() {
    const c = this.ctx;
    for (const g of this.ghosts) {
      const x = this.bx + g.dx; const y = this.by + g.dy + Math.sin(this.t * 2 + g.ph) * 6 + (g.done ? g.fall * g.fall * 160 : 0);
      const alpha = g.done ? Math.max(0, 1 - g.fall * 0.9) : 0.32;
      if (alpha <= 0) continue;
      c.globalAlpha = alpha;
      drawBird(c, x, y, 0.1, -0.3 + (Math.sin(this.flapPhase + g.ph) * 0.5 + 0.5) * 1.5, 0.42, null);
      if (g.done) {
        c.fillStyle = '#10131a'; c.font = '600 11px system-ui, sans-serif'; c.textAlign = 'center';
        c.fillText(`${g.target.toFixed(2)}x`, x, y - 16);
      }
      c.globalAlpha = 1;
    }
  }

  drawFxParticles() {
    const c = this.ctx;
    for (const e of this.fx) {
      c.globalAlpha = clamp(e.life);
      c.save(); c.translate(e.x, e.y); c.rotate(e.rot);
      if (e.kind === 'feather') { c.fillStyle = '#f4f1ea'; c.beginPath(); c.ellipse(0, 0, 7, 2.6, 0, 0, TAU); c.fill(); }
      else if (e.kind === 'leaf') { c.fillStyle = e.c; c.beginPath(); c.ellipse(0, 0, 8, 4, 0, 0, TAU); c.fill(); }
      else { c.fillStyle = '#ffd34d'; c.beginPath(); c.arc(0, 0, 3, 0, TAU); c.fill(); }
      c.restore();
    }
    c.globalAlpha = 1;
  }

  draw(now) {
    const c = this.ctx; const { W, H } = this;
    c.save();
    if (this.shake > 0) c.translate(rand(-this.shake, this.shake), rand(-this.shake, this.shake));

    const sky = c.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, this.col('skyTop')); sky.addColorStop(1, this.col('skyBottom'));
    c.fillStyle = sky; c.fillRect(-20, -20, W + 40, H + 40);

    if (this.cur.weather === 'pollen') {
      const g = c.createRadialGradient(W * 0.82, H * 0.16, 4, W * 0.82, H * 0.16, 150);
      g.addColorStop(0, 'rgba(255,246,196,0.95)'); g.addColorStop(1, 'rgba(255,246,196,0)');
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    }
    for (const cl of this.clouds) this.drawCloud(cl);

    const shift = frac(this.disp) * H * 0.3;
    this.hills(this.col('far'), H * 0.74 + shift * 0.4, 26, 0.004, 0.12, 1);
    this.drawGhosts();
    this.hills(this.col('mid'), H * 0.8 + shift * 0.7, 22, 0.006, 0.3, 2);

    if (this.trail.length > 1 && this.mode !== 'idle') {
      c.lineCap = 'round'; c.lineWidth = 3;
      for (let i = 1; i < this.trail.length; i++) {
        const a = this.trail[i - 1]; const b = this.trail[i];
        const x0 = this.bx - (this.dist - a.d); const x1 = this.bx - (this.dist - b.d);
        if (x1 < -10) continue;
        c.strokeStyle = `rgba(255,255,255,${(i / this.trail.length) * 0.55})`;
        c.beginPath(); c.moveTo(x0, a.y); c.lineTo(x1, b.y); c.stroke();
      }
    }

    this.drawHazards(now);
    const flap = this.mode === 'idle' ? -0.1 + (Math.sin(this.flapPhase) * 0.5 + 0.5) * 0.2 : -0.3 + (Math.sin(this.flapPhase) * 0.5 + 0.5) * 1.5;
    if (this.fall) {
      if (this.fall.y < H + 120) drawBird(c, this.fall.x, this.fall.y, this.fall.rot, 0.6, 1, this.fall.type === 'freeze' ? '#bfe6ff' : null);
    } else {
      drawBird(c, this.bx, this.by, this.ang, flap, 1, null);
    }

    this.hills(this.col('near'), H * 0.88 + shift, 14, 0.01, 0.7, 3);
    this.drawParts();
    this.drawFxParticles();
    this.drawFx(now);
    c.restore();

    if (this.flash > 0) { c.fillStyle = `rgba(255,255,255,${this.flash})`; c.fillRect(0, 0, W, H); }
  }
}
