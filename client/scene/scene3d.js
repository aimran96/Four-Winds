// Realistic 3D scene (three.js). Same public API as the 2D Scene in scene.js, so main.js can use either.
// Everything here is cosmetic: the server decides when the bird crashes, this only plays it back.
import * as THREE from '../vendor/three.module.js';
import { Sky } from '../vendor/Sky.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { audio } from './audio.js';

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------- how each crash cause plays out ----------
// hit: an object that strikes the bird. fx: an environmental effect. fall: how the bird dies.
const CAUSES = {
  lightning: { fx: 'lightning', fall: 'tumble' },
  soaked: { fx: 'rain', fall: 'sink' },
  kite: { hit: 'kite', fall: 'tumble' },
  hawk: { hit: 'hawk', fall: 'tumble' },
  heat: { fx: 'heat', fall: 'sink' },
  drone: { hit: 'drone', fall: 'tumble' },
  gust: { fx: 'gust', fall: 'tumble' },
  leafstorm: { fx: 'gust', fall: 'tumble' },
  flock: { hit: 'flock', fall: 'tumble' },
  frost: { fx: 'frost', fall: 'freeze' },
  whiteout: { fx: 'whiteout', fall: 'sink' },
  icicle: { hit: 'icicle', fall: 'freeze' },
};

// ---------- season looks ----------
const SEASONS = {
  spring: { sun: [26, 205], turb: 1.5, ray: 2.8, mie: 0.002, fog: 0xc4dcec, fogD: 0.00014, ground: [0x4f9a3c, 0x86c35a, 0xa8cf6a], accent: 0xf2b8cf, tree: 0x3c7a3a, blob: 0xf0b8cf, clouds: 0.5, cloudC: 0xffffff, exp: 0.8, sunI: 2.6, sunC: 0xfff3dc, lake: 0x2a7fa0, rough: 0.06, weather: 'rain' },
  summer: { sun: [55, 165], turb: 1.8, ray: 2.6, mie: 0.002, fog: 0xd2e6f2, fogD: 0.0001, ground: [0x3d7a28, 0x6f9a2e, 0xc2b04a], accent: 0xdcc058, tree: 0x2c6228, blob: 0x3f8a2e, clouds: 0.32, cloudC: 0xffffff, exp: 0.74, sunI: 3.2, sunC: 0xfff0d2, lake: 0x1b78a8, rough: 0.05, weather: 'pollen' },
  autumn: { sun: [9, 238], turb: 4, ray: 2.8, mie: 0.004, fog: 0xe9bf98, fogD: 0.00018, ground: [0xa5501c, 0xc9782c, 0x8c3d1c], accent: 0xe3b030, tree: 0x5a5a28, blob: 0xe0661c, clouds: 0.5, cloudC: 0xffd8b0, exp: 0.74, sunI: 3, sunC: 0xffc080, lake: 0x3a7a94, rough: 0.07, weather: 'leaf' },
  winter: { sun: [6, 215], turb: 7, ray: 1.3, mie: 0.006, fog: 0xd9e2ec, fogD: 0.00032, ground: [0xe3ecf4, 0xffffff, 0xc3d1de], accent: 0xb9cbdc, tree: 0x7f968a, blob: 0xe6eef4, clouds: 0.8, cloudC: 0xdfe6ee, exp: 0.66, sunI: 1.6, sunC: 0xfff0e0, lake: 0xb9d6e6, rough: 0.35, weather: 'snow' },
};
const LEAVES = [0xd9531e, 0xe8962e, 0xb5382a, 0xf0b43c];

// ---------- world geometry ----------
const TILE = 4000; // terrain repeats every TILE along z so it can scroll forever
const WIDTH = 9000;
const BASE = -230; // terrain y offset
const LAKE = -430;
const periodic = (f) => (Math.max(1, Math.round((f * TILE) / (2 * Math.PI))) * 2 * Math.PI) / TILE;
const height = (x, z) => {
  let a = 0; let f = 0.0008; let m = 330;
  for (let i = 0; i < 6; i++) {
    const fz = periodic(f); const fz2 = periodic(f * 0.9);
    a += Math.sin(x * f + i * 1.7 + Math.cos(z * fz + i)) * Math.cos(z * fz2 - i * 2.1 + Math.sin(x * f * 0.7)) * m;
    f *= 2.03; m *= 0.48;
  }
  return Math.max(a - 200, -260);
};
const hash = (i) => { const s = Math.sin(i * 127.1) * 43758.5453; return s - Math.floor(s); };

function softTexture(inner = 0.65) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'); const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, `rgba(255,255,255,${inner})`); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
function featherTexture() {
  const c = document.createElement('canvas'); c.width = 32; c.height = 96;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.beginPath(); x.ellipse(16, 48, 9, 44, 0, 0, Math.PI * 2); x.fill();
  x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 2; x.beginPath(); x.moveTo(16, 4); x.lineTo(16, 92); x.stroke();
  return new THREE.CanvasTexture(c);
}
function cloudTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  for (let i = 0; i < 60; i++) {
    const px = 128 + rand(-65, 65); const py = 128 + rand(-30, 30); const r = rand(24, 74);
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, 'rgba(255,255,255,.65)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  }
  return new THREE.CanvasTexture(c);
}

// A small bird made of primitives, facing +z. Used for the hawk and the flock.
function miniBird(color, scale) {
  const g = new THREE.Group(); const inner = new THREE.Group(); g.add(inner);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), mat); body.scale.set(1.9, 0.8, 0.8); inner.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 8), mat); head.position.set(1.9, 0.15, 0); inner.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.8, 6), new THREE.MeshStandardMaterial({ color: 0xe0a030 })); beak.rotation.z = -Math.PI / 2; beak.position.set(2.6, 0.1, 0); inner.add(beak);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 1.1), mat); tail.position.set(-2.2, 0, 0); inner.add(tail);
  const wings = [-1, 1].map((s) => {
    const w = new THREE.Group(); const f = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 3.4), mat); f.position.z = s * 1.8; w.add(f); w.position.y = 0.2; inner.add(w); return w;
  });
  inner.rotation.y = -Math.PI / 2; g.scale.setScalar(scale); g.userData.wings = wings;
  return g;
}
const flap = (g, t, speed = 14) => { const a = Math.sin(t * speed) * 0.9; g.userData.wings[0].rotation.x = a; g.userData.wings[1].rotation.x = -a; };

function makeHazard(kind) {
  const g = new THREE.Group(); const data = {};
  if (kind === 'hawk') { const b = miniBird(0x4a3424, 9); g.add(b); data.mb = [b]; }
  if (kind === 'flock') {
    data.mb = [];
    for (let i = 0; i < 9; i++) {
      const b = miniBird(0x2c2f36, 5); const row = Math.ceil(i / 2); b.position.set((i % 2 ? 1 : -1) * row * 16, rand(-5, 5), row * 16); g.add(b); data.mb.push(b);
    }
  }
  if (kind === 'drone') {
    const m = new THREE.MeshStandardMaterial({ color: 0x2b2e35, roughness: 0.5, metalness: 0.6 });
    g.add(new THREE.Mesh(new THREE.BoxGeometry(2, 0.8, 2.6), m));
    data.rotors = [];
    for (const [x, z] of [[1.6, 1.6], [-1.6, 1.6], [1.6, -1.6], [-1.6, -1.6]]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), m); arm.position.set(x, 0.3, z); g.add(arm);
      const r = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.05, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 }));
      r.position.set(x, 0.5, z); g.add(r); data.rotors.push(r);
    }
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff2222 })); led.position.set(0, -0.2, 1.3); g.add(led);
    g.scale.setScalar(9);
  }
  if (kind === 'kite') {
    const shape = new THREE.Shape(); shape.moveTo(0, 2); shape.lineTo(1.2, 0); shape.lineTo(0, -1.8); shape.lineTo(-1.2, 0); shape.closePath();
    g.add(new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: 0xe5383b, side: THREE.DoubleSide, roughness: 0.7 })));
    for (let i = 0; i < 6; i++) { const bow = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.25), new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffd23f : 0xffffff, side: THREE.DoubleSide })); bow.position.set(Math.sin(i * 1.2) * 0.3, -2.4 - i * 0.6, 0); g.add(bow); }
    g.scale.setScalar(15);
  }
  if (kind === 'icicle') {
    const c = new THREE.Mesh(new THREE.ConeGeometry(1.1, 9, 7), new THREE.MeshStandardMaterial({ color: 0xcfeeff, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.92, emissive: 0x335577, emissiveIntensity: 0.4 }));
    c.rotation.x = Math.PI; g.add(c); g.scale.setScalar(5);
  }
  g.userData = { ...data, kind };
  return g;
}

export class Scene {
  reduced = false;
  onMult = () => {};
  onImpact = () => {};
  onIdle = () => {};

  constructor(canvas) {
    this.cv = canvas;
    this.r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.r.toneMapping = THREE.ACESFilmicToneMapping;
    this.r.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(52, 1, 1, 20000);
    this.scene.add(this.cam);

    this.curName = null; this.pending = null; this.cfg = { crashCauses: ['gust'], leadInMs: [300, 600] };
    this.mode = 'idle'; this.g = 0.1; this.mult = 1; this.base = { m: 1, at: 0 }; this.t = 0;
    this.off = 0; this.speed = 90; this.fxs = []; this.hazard = null; this.anim = null; this.fall = null;
    this.shake = 0; this.flash = 0; this.slow = 1; this.cashAt = 0; this.idleAt = 0; this.wingSpeed = 1;
    this.alt = 150; this.enter = 0; this.uMix = { value: 0 }; this.blending = false; this.wAlpha = 1; this.envT = 0; this.boltLight = 0; this.cashPulse = 0; this.windX = 0; this.weatherBoost = 1;
    this.last = performance.now();
    this.textures = { soft: softTexture(), feather: featherTexture() };

    this.buildSky(); this.buildWorld(); this.buildClouds(); this.buildWeather(); this.buildBird(); this.buildOverlay();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.setSeason('spring', true);
    this.bird.position.set(0, this.alt, -120);
    requestAnimationFrame(this.loop);
  }

  // ---------- public API (same as 2D Scene) ----------
  setReduced(v) { this.reduced = v; }

  queueSeason(name, cfg) {
    this.cfg = cfg ?? this.cfg;
    if (!SEASONS[name]) name = 'spring';
    if (name === this.curName) { this.pending = null; return; }
    // a flight finishes in the season it started in; the world blends to the new one right after
    if (this.mode === 'idle') this.setSeason(name); else this.pending = name;
  }

  begin(growthRate, elapsedMs = 0) {
    if (this.pending) { this.setSeason(this.pending); this.pending = null; }
    this.resetBird();
    this.g = growthRate; this.mode = 'flying';
    this.base = { m: Math.exp((growthRate * elapsedMs) / 1000), at: performance.now() };
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

  // The server already settled this as a crash; play the cosmetic cause that leads up to it.
  crash(crashMult, cause) {
    const now = performance.now();
    this.mult = crashMult; this.mode = 'crashing';
    audio.windStop();
    const name = cause ?? pick(this.cfg.crashCauses?.length ? this.cfg.crashCauses : ['gust']);
    const cfg = CAUSES[name] ?? CAUSES.gust;
    const [lo, hi] = this.cfg.leadInMs ?? [300, 600];
    const leadIn = this.reduced ? 200 : rand(lo, hi);
    this.anim = { name, cfg, t0: now, leadIn };
    if (cfg.hit) this.spawnHazard(cfg.hit, leadIn);
    return name;
  }

  cash(mult, landed = false) {
    this.mult = mult; this.mode = 'cashed'; this.cashAt = performance.now();
    audio.windStop(); audio.chirp();
    const n = landed ? 90 : 50;
    for (let i = 0; i < n; i++) {
      this.addFx('soft', this.bird.position, { color: pick([0xffd23f, 0xfff2a8, 0xffb347]), size: rand(6, 14), vel: new THREE.Vector3(rand(-120, 120), rand(-40, 140), rand(-120, 120)), life: rand(0.8, 1.6), grav: -60, glow: true });
    }
    this.cashPulse = 1;
  }

  // ---------- setup ----------
  buildSky() {
    this.sky = new Sky(); this.sky.scale.setScalar(10000); this.scene.add(this.sky);
    this.sun = new THREE.Vector3();
    this.dl = new THREE.DirectionalLight(0xffffff, 2.5); this.scene.add(this.dl);
    this.hemi = new THREE.HemisphereLight(0xbfd9ff, 0x4f8a35, 0.5); this.scene.add(this.hemi);
    this.pm = new THREE.PMREMGenerator(this.r);
    this.scene.fog = new THREE.FogExp2(0xbcd6e6, 0.0005);
  }

  buildWorld() {
    const geo = new THREE.PlaneGeometry(WIDTH, TILE, 160, 100); geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, height(pos.getX(i), pos.getZ(i)));
    geo.computeVertexNormals();
    // both ends of a tile show the same terrain, so give them the same shading normals
    const nrm = geo.attributes.normal; const cols = 161; const rows = 101; const v = new THREE.Vector3();
    for (let ix = 0; ix < cols; ix++) {
      const a = ix; const b = (rows - 1) * cols + ix;
      v.set(nrm.getX(a) + nrm.getX(b), nrm.getY(a) + nrm.getY(b), nrm.getZ(a) + nrm.getZ(b)).normalize();
      nrm.setXYZ(a, v.x, v.y, v.z); nrm.setXYZ(b, v.x, v.y, v.z);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
    geo.setAttribute('colorB', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
    this.terrainGeo = geo;
    this.seasonColors = {}; for (const n of Object.keys(SEASONS)) this.seasonColors[n] = this.colorize(n);
    // every vertex carries two season colours; the shader mixes them, so seasons blend on the GPU
    const tmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    tmat.onBeforeCompile = (sh) => {
      sh.uniforms.uMix = this.uMix;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 colorB;\nuniform float uMix;')
        .replace('#include <color_vertex>', '#include <color_vertex>\n#ifdef USE_COLOR\nvColor = mix(color, colorB, uMix);\n#endif');
    };
    this.tiles = [];
    // trees: positions chosen once, shared by every tile
    const coneGeo = new THREE.ConeGeometry(7, 28, 6); const blobGeo = new THREE.IcosahedronGeometry(10, 1);
    this.coneMat = new THREE.MeshStandardMaterial({ color: 0x2f6a35, roughness: 1 });
    this.blobMat = new THREE.MeshStandardMaterial({ color: 0x7fb85a, roughness: 1 });
    const cones = []; const blobs = [];
    for (let i = 0; i < 12000 && cones.length + blobs.length < 3400; i++) {
      const x = (hash(i * 3 + 1) - 0.5) * WIDTH * 0.95; const z = (hash(i * 3 + 2) - 0.5) * TILE; const y = BASE + height(x, z);
      if (y < LAKE + 18 || y > BASE + 90) continue;
      const s = 0.8 + hash(i * 3 + 3) * 1.3;
      (hash(i * 7) > 0.45 ? cones : blobs).push({ x, y, z, s, k: 0.75 + hash(i * 11) * 0.5 });
    }
    for (let k = 0; k < 3; k++) {
      const grp = new THREE.Group();
      const mesh = new THREE.Mesh(geo, tmat); mesh.position.y = BASE; grp.add(mesh);
      const mk = (list, g2, mat, lift, sy) => {
        const im = new THREE.InstancedMesh(g2, mat, list.length); const m = new THREE.Matrix4(); const col = new THREE.Color();
        list.forEach((t, i) => { m.compose(new THREE.Vector3(t.x, t.y + lift * t.s, t.z), new THREE.Quaternion(), new THREE.Vector3(t.s, t.s * sy, t.s)); im.setMatrixAt(i, m); col.setScalar(t.k); im.setColorAt(i, col); });
        im.frustumCulled = false; grp.add(im); return im;
      };
      grp.userData.blobs = mk(blobs, blobGeo, this.blobMat, 9, 1.1); mk(cones, coneGeo, this.coneMat, 12, 1.2);
      this.scene.add(grp); this.tiles.push(grp);
    }
    this.lake = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), new THREE.MeshStandardMaterial({ color: 0x2f7391, roughness: 0.06, metalness: 0.05 }));
    this.lake.rotation.x = -Math.PI / 2; this.lake.position.y = LAKE; this.scene.add(this.lake);
  }

  buildClouds() {
    this.cloudTex = cloudTexture(); this.clouds = [];
    for (let i = 0; i < 38; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.cloudTex, transparent: true, depthWrite: false, fog: false, opacity: 0.4 }));
      sp.position.set(rand(-4500, 4500), rand(520, 1100), -rand(400, 6000)); const s = rand(420, 1000); sp.scale.set(s * 1.8, s * 0.8, 1);
      sp.userData.k = rand(0.18, 0.5); this.scene.add(sp); this.clouds.push(sp);
    }
  }

  buildWeather() {
    this.N = 1800;
    this.wpos = new Float32Array(this.N * 3); this.wcol = new Float32Array(this.N * 3); this.wvel = new Float32Array(this.N * 3);
    this.wBox = new THREE.Vector3(900, 600, 900);
    this.wgeo = new THREE.BufferGeometry();
    this.wgeo.setAttribute('position', new THREE.BufferAttribute(this.wpos, 3)); this.wgeo.setAttribute('color', new THREE.BufferAttribute(this.wcol, 3));
    this.wmat = new THREE.PointsMaterial({ size: 3, map: softTexture(0.9), vertexColors: true, transparent: true, depthWrite: false, opacity: 0.9 });
    this.weather = new THREE.Points(this.wgeo, this.wmat); this.weather.frustumCulled = false; this.scene.add(this.weather);
    this.rainGeo = new THREE.BufferGeometry(); this.rainPos = new Float32Array(this.N * 6);
    this.rainGeo.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(this.rainGeo, new THREE.LineBasicMaterial({ color: 0xcfe0f0, transparent: true, opacity: 0.45 }));
    this.rain.frustumCulled = false; this.scene.add(this.rain);
    this.weatherKind = 'rain';
  }

  buildBird() {
    this.bird = new THREE.Group(); this.scene.add(this.bird);
    this.inner = new THREE.Group(); this.bird.add(this.inner);
    this.mats = [];
    new GLTFLoader().loadAsync(new URL('../assets/Stork.glb', import.meta.url).href).then((gl) => {
      const m = gl.scene;
      m.traverse((o) => {
        if (o.isMesh) { o.frustumCulled = false; o.material = o.material.clone(); o.material.roughness = 0.75; this.mats.push({ m: o.material, color: o.material.color.clone() }); }
      });
      const sz = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());
      m.scale.setScalar(46 / Math.max(sz.x, sz.y, sz.z));
      m.rotation.y = Math.PI; // the model faces +z; the bird flies toward -z
      this.inner.add(m);
      this.mixer = new THREE.AnimationMixer(m); this.action = this.mixer.clipAction(gl.animations[0]); this.action.play();
    }).catch(() => { /* the bird stays invisible if the model fails to load */ });
  }

  buildOverlay() {
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false });
    this.flashMesh = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), this.flashMat);
    this.flashMesh.position.z = -3; this.flashMesh.renderOrder = 999; this.cam.add(this.flashMesh);
  }

  resize() {
    const w = Math.max(this.cv.clientWidth, 320); const h = Math.max(this.cv.clientHeight, 240);
    this.r.setSize(w, h, false); this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
  }

  // ---------- seasons ----------
  // Nothing snaps: sky, sun, light, fog, terrain colours, trees, lake, clouds and weather all ease to the new season.
  colorize(name) {
    const P = SEASONS[name]; const pos = this.terrainGeo.attributes.position; const nrm = this.terrainGeo.attributes.normal;
    const out = new Float32Array(pos.count * 3);
    const lo = new THREE.Color(P.ground[0]); const mid = new THREE.Color(P.ground[1]); const hi = new THREE.Color(P.ground[2]);
    const acc = new THREE.Color(P.accent); const rock = new THREE.Color(name === 'winter' ? 0x6f7a86 : 0x6b5a48); const c = new THREE.Color(); const tmp = new THREE.Color();
    const autumnMix = [0xc2742a, 0x9c2f1b, 0xe3b030, 0x7a8a2a, 0xb5521c];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i); const z = pos.getZ(i); const y = pos.getY(i);
      const t = clamp((y + 260) / 640, 0, 1); const n = Math.sin(x * 0.004) * Math.cos(z * 0.0037) + Math.sin(x * 0.013 + z * 0.011) * 0.5;
      const cell = hash(Math.floor(x / 170) * 31 + Math.floor(z / 170) * 17 + 3); // field-sized patches
      c.copy(lo).lerp(mid, smooth(0, 0.6, t)).lerp(hi, smooth(0.55, 1, t));
      if (name === 'spring') { if (cell > 0.82) c.lerp(acc, 0.55); else if (hash(i * 5.7) > 0.97) c.lerp(acc, 0.9); }
      else if (name === 'summer') { if (cell > 0.68) c.lerp(acc, 0.7); }
      else if (name === 'autumn') { c.lerp(tmp.setHex(autumnMix[Math.floor(cell * 5) % 5]), 0.75); }
      else if (name === 'winter') c.lerp(acc, clamp(0.25 + n * 0.2, 0, 0.5) * (cell > 0.5 ? 1 : 0.4));
      c.lerp(rock, smooth(0.3, 0.52, 1 - nrm.getY(i)) * (name === 'winter' ? 0.75 : 0.9));
      if (y <= -255) c.setHex(name === 'winter' ? 0xb4c8d6 : 0x34596a);
      out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b;
    }
    return out;
  }

  makeLook(name) {
    const P = SEASONS[name]; const C = (h) => new THREE.Color(h);
    return { el: P.sun[0], az: P.sun[1], turb: P.turb, ray: P.ray, mie: P.mie, fog: C(P.fog), fogD: P.fogD, exp: P.exp, sunI: P.sunI, sunC: C(P.sunC), ground: C(P.ground[0]), tree: C(P.tree), blob: C(P.blob), lake: C(P.lake), rough: P.rough, clouds: P.clouds, cloudC: C(P.cloudC) };
  }

  setSeason(name, snap = false) {
    this.curName = name; this.P = SEASONS[name]; this.wantWeather = this.P.weather;
    const A = this.terrainGeo.attributes.color; const B = this.terrainGeo.attributes.colorB;
    if (snap) {
      this.L = this.makeLook(name); A.array.set(this.seasonColors[name]); B.array.set(this.seasonColors[name]); this.uMix.value = 0;
      this.setWeather(this.P.weather); this.wAlpha = 1; this.envDirty = false; this.applyLook(true);
    } else {
      const m = this.uMix.value; // bake the current blend so an interrupted transition continues smoothly
      if (m > 0) for (let i = 0; i < A.array.length; i++) A.array[i] += (B.array[i] - A.array[i]) * m;
      B.array.set(this.seasonColors[name]); this.uMix.value = 0; this.blending = true;
    }
    A.needsUpdate = true; B.needsUpdate = true;
  }

  stepSeason(raw) {
    const P = this.P; const L = this.L; const k = 1 - Math.exp(-raw / 1.1); const lp = (a, b) => a + (b - a) * k; const tc = this._tc ?? (this._tc = new THREE.Color());
    const before = Math.abs(L.el - P.sun[0]) + Math.abs(L.turb - P.turb) * 0.3 + Math.abs(L.ray - P.ray) * 0.5;
    L.el = lp(L.el, P.sun[0]); L.az = lp(L.az, P.sun[1]); L.turb = lp(L.turb, P.turb); L.ray = lp(L.ray, P.ray); L.mie = lp(L.mie, P.mie);
    L.fogD = lp(L.fogD, P.fogD); L.exp = lp(L.exp, P.exp); L.sunI = lp(L.sunI, P.sunI); L.rough = lp(L.rough, P.rough); L.clouds = lp(L.clouds, P.clouds);
    L.fog.lerp(tc.setHex(P.fog), k); L.sunC.lerp(tc.setHex(P.sunC), k); L.ground.lerp(tc.setHex(P.ground[0]), k); L.tree.lerp(tc.setHex(P.tree), k);
    L.blob.lerp(tc.setHex(P.blob), k); L.lake.lerp(tc.setHex(P.lake), k); L.cloudC.lerp(tc.setHex(P.cloudC), k);
    if (this.blending) { this.uMix.value += (1 - this.uMix.value) * k; if (this.uMix.value > 0.998) this.finishTerrainBlend(); }
    // weather fades out, swaps, and fades back in
    if (this.wantWeather !== this.weatherKind) { this.wAlpha -= raw / 1.0; if (this.wAlpha <= 0) { this.wAlpha = 0; this.setWeather(this.wantWeather); } } else this.wAlpha = Math.min(1, this.wAlpha + raw / 1.4);
    this.envT -= raw; const changing = before > 0.02;
    this.applyLook(changing && this.envT <= 0 || (!changing && this.envDirty));
    this.envDirty = changing;
  }

  finishTerrainBlend() {
    const A = this.terrainGeo.attributes.color; A.array.set(this.terrainGeo.attributes.colorB.array); A.needsUpdate = true; this.uMix.value = 0; this.blending = false;
  }

  applyLook(refreshEnv) {
    const L = this.L; const u = this.sky.material.uniforms;
    u.turbidity.value = L.turb; u.rayleigh.value = L.ray; u.mieCoefficient.value = L.mie; u.mieDirectionalG.value = 0.85;
    this.sun.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - L.el), THREE.MathUtils.degToRad(L.az)); u.sunPosition.value.copy(this.sun);
    this.dl.position.copy(this.sun).multiplyScalar(800); this.dl.color.copy(L.sunC);
    if (!(this.boltLight > 0)) this.dl.intensity = L.sunI;
    this.hemi.groundColor.copy(L.ground);
    this.scene.fog.color.copy(L.fog); this.fogBase = L.fogD; if (this.mode !== 'crashing' && this.mode !== 'crashed') this.scene.fog.density = L.fogD;
    this.r.toneMappingExposure = L.exp;
    this.coneMat.color.copy(L.tree); this.blobMat.color.copy(L.blob);
    this.lake.material.color.copy(L.lake); this.lake.material.roughness = L.rough;
    for (const c of this.clouds) { c.material.color.copy(L.cloudC); c.material.opacity = L.clouds * (0.1 + c.userData.k * 0.45); }
    this.wmat.opacity = 0.9 * this.wAlpha; this.rain.material.opacity = 0.3 * this.wAlpha;
    if (refreshEnv) {
      if (this.envTex) this.envTex.dispose();
      this.envTex = this.pm.fromScene(this.sky).texture; this.scene.environment = this.envTex; this.scene.environmentIntensity = 0.7; this.envT = 0.35;
    }
  }

  setWeather(kind) {
    this.weatherKind = kind; const p = this.wpos; const c = this.wcol; const v = this.wvel; const col = new THREE.Color();
    for (let i = 0; i < this.N; i++) {
      p[i * 3] = rand(-1, 1) * this.wBox.x / 2; p[i * 3 + 1] = rand(-1, 1) * this.wBox.y / 2; p[i * 3 + 2] = rand(-1, 1) * this.wBox.z / 2;
      let sp;
      if (kind === 'snow') { col.setHex(0xffffff); sp = [rand(-12, 12), rand(-70, -40), rand(-12, 12)]; }
      else if (kind === 'leaf') { col.setHex(pick(LEAVES)); sp = [rand(-30, 30), rand(-45, -15), rand(-30, 30)]; }
      else if (kind === 'pollen') { col.setHex(0xfff2b0); sp = [rand(-14, 14), rand(-8, 10), rand(-14, 14)]; }
      else { col.setHex(0xffffff); sp = [rand(-15, 15), rand(-520, -400), rand(-15, 15)]; }
      c.set([col.r, col.g, col.b], i * 3); v.set(sp, i * 3);
    }
    this.wgeo.attributes.color.needsUpdate = true;
    this.wmat.size = kind === 'snow' ? 3.2 : kind === 'leaf' ? 6 : kind === 'pollen' ? 2.6 : 0;
    this.weather.visible = kind !== 'rain'; this.rain.visible = kind === 'rain';
  }

  // ---------- death effects ----------
  addFx(kind, at, o) {
    const mat = new THREE.SpriteMaterial({ map: kind === 'feather' ? this.textures.feather : this.textures.soft, color: o.color ?? 0xffffff, transparent: true, depthWrite: false, opacity: o.opacity ?? 1, rotation: rand(0, 6.28), blending: o.glow ? THREE.AdditiveBlending : THREE.NormalBlending, fog: !o.glow });
    const sp = new THREE.Sprite(mat); sp.position.copy(at);
    const s = o.size ?? 10; if (kind === 'feather') sp.scale.set(s * 0.35, s, 1); else sp.scale.set(s, s, 1);
    this.scene.add(sp);
    this.fxs.push({ sp, vel: o.vel ?? new THREE.Vector3(), life: o.life ?? 1, max: o.life ?? 1, grav: o.grav ?? 0, drag: o.drag ?? 0.5, grow: o.grow ?? 0, spin: o.spin ?? 0, sway: kind === 'feather' ? rand(2, 5) : 0, ph: rand(0, 6.28), base: s, opacity: o.opacity ?? 1 });
  }

  spawnHazard(kind, leadIn) {
    const h = makeHazard(kind); const b = this.bird.position; const off = {
      hawk: new THREE.Vector3(-70, 200, -170), drone: new THREE.Vector3(80, 25, -300), kite: new THREE.Vector3(-230, 60, -30),
      flock: new THREE.Vector3(-10, 18, -440), icicle: new THREE.Vector3(6, 300, -14),
    }[kind];
    Object.assign(h.userData, { from: b.clone().add(off), t0: performance.now(), dur: leadIn });
    h.position.copy(h.userData.from); this.scene.add(h); this.hazard = h;
  }

  updateHazard(now) {
    const h = this.hazard; if (!h) return;
    const d = h.userData; const p = clamp((now - d.t0) / d.dur, 0, 1);
    const tgt = this.bird.position;
    h.position.lerpVectors(d.from, tgt, p * p * 0.35 + p * 0.65);
    const dir = new THREE.Vector3().subVectors(tgt, h.position);
    if (dir.lengthSq() > 1) h.lookAt(tgt.x, tgt.y, tgt.z);
    d.dir = dir.normalize().clone();
    const t = now / 1000;
    for (const b of d.mb ?? []) flap(b, t, 22);
    for (const r of d.rotors ?? []) r.rotation.y += 1.2;
    if (d.kind === 'kite') h.rotation.z = Math.sin(t * 6) * 0.3;
  }

  makeBolt(from, to) {
    const g = new THREE.Group(); const pts = [from.clone()]; const n = 14;
    for (let i = 1; i < n; i++) pts.push(from.clone().lerp(to, i / n).add(new THREE.Vector3(rand(-26, 26), 0, rand(-26, 26))));
    pts.push(to.clone());
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]; const b = pts[i + 1]; const len = a.distanceTo(b);
      for (const [r, op, col] of [[1.6, 1, 0xffffff], [5, 0.35, 0x9ec8ff]]) {
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, fog: false, blending: THREE.AdditiveBlending, depthWrite: false }));
        seg.position.copy(a).lerp(b, 0.5); seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3().subVectors(b, a).normalize()); g.add(seg);
      }
    }
    this.scene.add(g); return g;
  }

  tint(color, amount) { for (const { m, color: o } of this.mats) m.color.copy(o).lerp(color, amount); }
  glow(color, k) { for (const { m } of this.mats) { if (m.emissive) m.emissive.copy(color).multiplyScalar(k); } }

  impact(now) {
    const a = this.anim; const cfg = a.cfg; const pos = this.bird.position;
    this.mode = 'crashed'; this.idleAt = now + 12000; // safety cap; normally reset 1.8s after the bird lands
    this.slow = this.reduced ? 1 : 0.4;
    this.shake = this.reduced ? 0 : 1; this.flash = this.reduced ? 0.15 : cfg.fx === 'lightning' ? 0.85 : cfg.hit ? 0.55 : 0.3;
    const dir = this.hazard?.userData.dir?.clone() ?? new THREE.Vector3(rand(-1, 1), 0.2, rand(-1, 0.2)).normalize();
    const type = cfg.fall;
    this.fall = { type, vel: new THREE.Vector3(), ang: new THREE.Vector3(), rest: false, t: 0, water: false };
    if (type === 'tumble') { this.fall.vel.copy(dir).multiplyScalar(170).add(new THREE.Vector3(rand(-30, 30), 70, 0)); this.fall.ang.set(rand(-9, 9), rand(-3, 3), rand(-10, 10)); this.wingSpeed = 3; }
    if (type === 'sink') { this.fall.vel.set(rand(-10, 10), -10, -20); this.fall.ang.set(0.5, rand(-0.6, 0.6), rand(-0.9, 0.9)); this.wingSpeed = 0.9; }
    if (type === 'freeze') { this.fall.vel.set(0, -20, -10); this.fall.ang.set(0, rand(1.2, 2.2), 0); this.wingSpeed = 0; }
    // feather burst (more for violent causes)
    for (let i = 0; i < (type === 'tumble' ? 44 : 22); i++) {
      this.addFx('feather', pos, { color: pick([0xffffff, 0xe8e8e8, 0x1c1c1c, 0xcfcfcf]), size: rand(5, 9), vel: new THREE.Vector3(rand(-130, 130), rand(-30, 150), rand(-130, 130)), life: rand(2.2, 3.4), grav: -45, drag: 1.2, spin: rand(-5, 5) });
    }
    if (cfg.fx === 'lightning') {
      this.tint(new THREE.Color(0x151515), 0.7); this.glow(new THREE.Color(0xaacfff), 2.2); this.scorchFade = 1;
      for (let i = 0; i < 24; i++) this.addFx('soft', pos, { color: 0x2a2a2a, size: rand(7, 13), vel: new THREE.Vector3(rand(-40, 40), rand(10, 70), rand(-40, 40)), life: rand(1.4, 2.4), grow: 10, grav: 12, opacity: 0.42 });
    }
    if (type === 'freeze') {
      this.tint(new THREE.Color(0xb5dcff), 0.8); this.glow(new THREE.Color(0x6fb3ff), 0.35);
      for (let i = 0; i < 38; i++) this.addFx('soft', pos, { color: 0xdff4ff, size: rand(2, 5), vel: new THREE.Vector3(rand(-90, 90), rand(-20, 110), rand(-90, 90)), life: rand(1, 2), grav: -120, glow: true });
    }
    if (cfg.fx === 'heat') { this.tint(new THREE.Color(0x2b2118), 0.55); for (let i = 0; i < 20; i++) this.addFx('soft', pos, { color: 0x403a36, size: rand(12, 22), vel: new THREE.Vector3(rand(-20, 20), rand(10, 50), rand(-20, 20)), life: rand(1.5, 2.5), grow: 18, grav: 10, opacity: 0.55 }); }
    if (cfg.fx === 'rain') this.tint(new THREE.Color(0x394350), 0.45);
    if (cfg.fx === 'gust') for (let i = 0; i < 40; i++) this.addFx('soft', pos, { color: pick(LEAVES), size: rand(5, 9), vel: new THREE.Vector3(rand(-260, 260), rand(-60, 220), rand(-260, 260)), life: rand(1.4, 2.4), grav: -30 });
    if (cfg.hit === 'drone') for (let i = 0; i < 18; i++) this.addFx('soft', pos, { color: pick([0xffb347, 0xffffff, 0xff6b35]), size: rand(5, 11), vel: new THREE.Vector3(rand(-200, 200), rand(-60, 200), rand(-200, 200)), life: rand(0.5, 1.1), grav: -200, glow: true });
    if (this.hazard) this.hazard.userData.exit = (this.hazard.userData.dir ?? new THREE.Vector3(0, -1, 0)).clone().multiplyScalar(160);
    audio.crash(cfg.fx === 'lightning');
    this.onImpact(a.name);
  }

  clearFx() {
    for (const f of this.fxs) { this.scene.remove(f.sp); f.sp.material.dispose(); }
    this.fxs = [];
    if (this.hazard) { this.scene.remove(this.hazard); this.hazard = null; }
    if (this.boltMesh) { this.scene.remove(this.boltMesh); this.boltMesh = null; }
    if (this.ring) { this.scene.remove(this.ring); this.ring = null; }
  }

  resetBird() {
    this.clearFx();
    this.fall = null; this.anim = null; this.flash = 0; this.shake = 0; this.slow = 1; this.wingSpeed = 1; this.cashPulse = 0; this.weatherBoost = 1; this.windX = 0; this.boltLight = 0;
    this.scene.fog.density = this.fogBase ?? 0.0002;
    this.bird.position.set(0, this.alt, -120); this.bird.rotation.set(0, 0, 0);
    this.tint(new THREE.Color(0xffffff), 0); this.glow(new THREE.Color(0), 0);
  }

  idle() {
    this.mult = 1; this.resetBird(); this.alt = 150; this.enter = 1; this.mode = 'idle'; // the bird glides back in from the left
    if (this.pending) { this.setSeason(this.pending); this.pending = null; }
    this.onIdle();
  }

  // ---------- frame ----------
  loop = (now) => {
    const raw = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    if (this.slow < 1) this.slow = Math.min(1, this.slow + raw / 1.6);
    const dt = raw * (this.mode === 'crashed' ? this.slow : 1);
    this.t += dt;
    try { this.update(dt, raw, now); this.r.render(this.scene, this.cam); } catch (e) { console.error(e); }
    requestAnimationFrame(this.loop);
  };

  update(dt, raw, now) {
    const bird = this.bird; const mode = this.mode;
    this.stepSeason(raw);
    // --- speed & altitude ---
    let m = 1;
    if (mode === 'flying') { m = this.currentMult(now); this.onMult(m); audio.windLevel(Math.log(m) / 5); }
    else if (mode === 'cashed' || mode === 'crashing') m = Math.max(1, this.mult);
    const flying = mode === 'flying' || mode === 'cashed' || mode === 'crashing';
    const target = flying ? 260 + 120 * Math.log(m) : 90;
    this.speed += (clamp(target, 0, 900) - this.speed) * Math.min(1, raw * 2);
    if (mode === 'crashed') this.speed *= Math.exp(-raw * 2.2);
    const alt = flying ? Math.min(150 + 85 * Math.log(m), 650) : 150;
    if (mode !== 'crashed') this.alt += (alt - this.alt) * Math.min(1, raw * 1.6);

    // --- scroll the world ---
    this.off = (this.off + this.speed * dt) % TILE;
    this.tiles.forEach((t, k) => { t.position.z = -k * TILE + this.off; });
    for (const c of this.clouds) { c.position.z += this.speed * dt * c.userData.k; if (c.position.z > 400) c.position.z -= 6400; }

    // --- bird in flight ---
    if (mode !== 'crashed') {
      const climb = (alt - this.alt) * 0.004;
      this.enter = Math.max(0, this.enter - raw * 0.8);
      bird.position.set(-420 * this.enter * this.enter, this.alt + Math.sin(this.t * 1.7) * 3, -120);
      bird.rotation.set(-climb * 0.5 + Math.sin(this.t * 1.1) * 0.03, Math.sin(this.t * 0.4) * 0.04, Math.sin(this.t * 0.9) * 0.1 - 0.04);
    }
    if (this.mixer) this.mixer.update(dt * this.wingSpeed * (flying ? 0.8 + Math.min(Math.log(m) * 0.35, 1.2) : 0.5));
    if (mode === 'cashed') {
      this.cashPulse = Math.max(0, this.cashPulse - raw * 1.4); this.glow(new THREE.Color(0xffc24a), this.cashPulse * 0.6);
      if (now - this.cashAt > 1900) this.idle();
    }

    // --- crash lead-in & impact ---
    if (mode === 'crashing') {
      const a = this.anim; const p = clamp((now - a.t0) / a.leadIn, 0, 1);
      this.updateHazard(now);
      if (a.cfg.fx === 'lightning') this.flash = p > 0.6 ? Math.random() * 0.25 : 0;
      if (a.cfg.fx === 'rain') this.weatherBoost = 1 + p * 3;
      if (a.cfg.fx === 'gust') { this.windX = p * 600; this.shake = p * 0.4; }
      if (a.cfg.fx === 'whiteout') { this.scene.fog.density = this.fogBase + p * 0.006; this.flash = p * 0.55; }
      if (a.cfg.fx === 'frost') { this.tint(new THREE.Color(0xb5dcff), p * 0.8); this.scene.fog.density = this.fogBase + p * 0.0012; }
      if (a.cfg.fx === 'heat') { this.tint(new THREE.Color(0xff7a3a), p * 0.5); this.flash = p * 0.25; this.flashMat.color.setHex(0xff9a4a); }
      if (p >= 1) {
        if (a.cfg.fx === 'lightning') { this.boltMesh = this.makeBolt(bird.position.clone().add(new THREE.Vector3(rand(-30, 30), 520, rand(-30, 30))), bird.position.clone()); this.boltLight = 1; }
        this.impact(now);
      }
    }

    // --- falling ---
    if (mode === 'crashed' && this.fall) this.updateFall(dt);
    if (mode === 'crashed' && now > this.idleAt) this.idle();
    if (this.boltMesh) { this.boltLight -= raw * 4; if (this.boltLight <= 0) { this.scene.remove(this.boltMesh); this.boltMesh = null; this.boltLight = 0; } else this.boltMesh.visible = Math.random() > 0.25; }

    // --- fx sprites ---
    for (let i = this.fxs.length - 1; i >= 0; i--) {
      const f = this.fxs[i]; f.life -= dt; if (f.life <= 0) { this.scene.remove(f.sp); f.sp.material.dispose(); this.fxs.splice(i, 1); continue; }
      f.vel.y += f.grav * dt; f.vel.multiplyScalar(Math.exp(-f.drag * dt * 0.6)); f.sp.position.addScaledVector(f.vel, dt);
      if (f.sway) f.sp.position.x += Math.sin(this.t * f.sway + f.ph) * 30 * dt;
      f.sp.material.rotation += f.spin * dt; const k = f.life / f.max;
      f.sp.material.opacity = f.opacity * Math.min(1, k * 2.5);
      if (f.grow) { const s = f.base + f.grow * (1 - k); f.sp.scale.set(s, s, 1); }
    }
    // the hazard that hit the bird keeps going and drops away
    if (this.hazard?.userData.exit) { const e = this.hazard.userData.exit; this.hazard.position.addScaledVector(e, dt); e.y -= 90 * dt; }

    this.updateWeather(dt);
    this.updateCamera(raw);
  }

  updateFall(dt) {
    const f = this.fall; const b = this.bird; f.t += dt;
    if (!f.rest) {
      f.vel.y -= (f.type === 'sink' ? 90 : 520) * dt;
      if (f.type === 'sink') { const d = Math.exp(-dt * 1.4); f.vel.x *= d; f.vel.z *= d; if (f.vel.y < -140) f.vel.y = -140; b.rotation.x += (1.1 - b.rotation.x) * Math.min(1, dt * 2); }
      b.position.addScaledVector(f.vel, dt);
      b.rotation.x += f.ang.x * dt; b.rotation.y += f.ang.y * dt; b.rotation.z += f.ang.z * dt;
      if (f.type === 'tumble') { f.ang.multiplyScalar(Math.exp(-dt * 0.25)); this.wingSpeed = Math.max(0, 3 - f.t * 2.4); }
      if (f.type === 'sink') this.wingSpeed = Math.max(0, 0.9 - f.t * 0.55);
      if (f.type !== 'freeze' && Math.random() < 0.7) this.addFx('soft', b.position, { color: this.curName === 'winter' ? 0xdfe6ee : 0x444444, size: 6, vel: new THREE.Vector3(rand(-8, 8), rand(-8, 8), rand(-8, 8)), life: 1.1, grow: 9, opacity: 0.3 });
      if (f.type === 'freeze' && Math.random() < 0.8) this.addFx('soft', b.position, { color: 0xdff4ff, size: 3, vel: new THREE.Vector3(rand(-20, 20), rand(-20, 10), rand(-20, 20)), life: 0.9, glow: true });
      const ground = BASE + height(b.position.x, b.position.z - this.off);
      const floor = Math.max(ground, LAKE) + 6;
      if (b.position.y <= floor) {
        b.position.y = floor; f.rest = true; this.slow = 1; this.idleAt = performance.now() + 1800;
        this.onGround(ground < LAKE, Math.max(ground, LAKE));
        b.rotation.x = 0.3; b.rotation.z = (Math.random() > 0.5 ? 1 : -1) * 1.45; this.wingSpeed = 0; this.shake = this.reduced ? 0 : 0.8;
      }
    } else if (f.water) b.position.y = LAKE + 3 + Math.sin(this.t * 2.4) * 1.2;
  }

  onGround(water, y) {
    const p = this.bird.position.clone(); p.y = y + 4; this.fall.water = water;
    const winter = this.curName === 'winter';
    for (let i = 0; i < (water ? 46 : 34); i++) {
      this.addFx('soft', p, { color: water ? 0xe8f6ff : winter ? 0xffffff : this.curName === 'autumn' ? 0x9c7a4a : 0x8a7a5a, size: rand(8, 20), vel: new THREE.Vector3(rand(-90, 90), water ? rand(90, 230) : rand(30, 120), rand(-90, 90)), life: rand(0.9, 1.7), grav: -260, grow: water ? 0 : 18, opacity: 0.8 });
    }
    if (water) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(1, 3, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, LAKE + 1.5, p.z); this.scene.add(ring); this.ring = ring; this.ringT = 0;
    }
  }

  updateWeather(dt) {
    const k = this.weatherBoost; const p = this.wpos; const v = this.wvel; const hx = this.wBox.x / 2; const hy = this.wBox.y / 2; const hz = this.wBox.z / 2;
    const n = this.reduced ? Math.floor(this.N / 3) : this.N; const air = this.speed;
    if (this.ring) { this.ringT += dt; const s = 1 + this.ringT * 70; this.ring.scale.set(s, s, 1); this.ring.material.opacity = Math.max(0, 0.7 - this.ringT * 0.5); }
    const wrap = (o) => {
      if (p[o + 1] < -hy) p[o + 1] += this.wBox.y; if (p[o + 1] > hy) p[o + 1] -= this.wBox.y;
      if (p[o + 2] > hz) p[o + 2] -= this.wBox.z; if (p[o + 2] < -hz) p[o + 2] += this.wBox.z;
      if (p[o] > hx) p[o] -= this.wBox.x; if (p[o] < -hx) p[o] += this.wBox.x;
    };
    if (this.weatherKind === 'rain') {
      const r = this.rainPos; let j = 0; const b = this.bird.position;
      for (let i = 0; i < n; i++) {
        const o = i * 3; const vx = v[o] + this.windX * 0.3; const vy = v[o + 1] * k; const vz = v[o + 2] + air;
        p[o] += vx * dt; p[o + 1] += vy * dt; p[o + 2] += vz * dt; wrap(o);
        r[j++] = b.x + p[o]; r[j++] = b.y + p[o + 1]; r[j++] = b.z + p[o + 2];
        r[j++] = b.x + p[o] - vx * 0.02; r[j++] = b.y + p[o + 1] - vy * 0.02; r[j++] = b.z + p[o + 2] - vz * 0.02;
      }
      this.rainGeo.setDrawRange(0, n * 2); this.rainGeo.attributes.position.needsUpdate = true; return;
    }
    for (let i = 0; i < n; i++) {
      const o = i * 3; p[o] += (v[o] + this.windX) * dt; p[o + 1] += v[o + 1] * dt; p[o + 2] += (v[o + 2] + air) * dt; wrap(o);
    }
    this.weather.position.copy(this.bird.position); // particles live in bird-relative space
    this.wgeo.setDrawRange(0, n); this.wgeo.attributes.position.needsUpdate = true;
  }

  updateCamera(raw) {
    const b = this.bird.position; const cam = this.cam; const crashed = this.mode === 'crashed';
    const want = crashed ? new THREE.Vector3(b.x + 90, b.y + 30, b.z + 80) : new THREE.Vector3(b.x + 78, b.y + 10, b.z + 46);
    const look = crashed ? b.clone() : new THREE.Vector3(b.x - 34, b.y + 52, b.z - 112);
    cam.position.lerp(want, Math.min(1, raw * (crashed ? 2.6 : 5)));
    this.lookAt = this.lookAt ?? look.clone(); this.lookAt.lerp(look, Math.min(1, raw * 6));
    if (this.shake > 0) {
      const s = this.shake * 7; cam.position.x += rand(-s, s); cam.position.y += rand(-s, s) * 0.7; this.shake = Math.max(0, this.shake - raw * 1.4);
    }
    cam.lookAt(this.lookAt);
    if (this.flash <= 0.01 && this.mode !== 'crashing') this.flashMat.color.setHex(0xffffff);
    this.flashMat.opacity = clamp(this.flash, 0, 1);
    if (this.mode !== 'crashing') this.flash = Math.max(0, this.flash - raw * 2.2);
    this.dl.intensity = this.boltLight > 0 ? this.L.sunI + this.boltLight * 8 : this.L.sunI;
  }
}
