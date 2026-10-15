// Synthesized sound (no asset files): chirp on cash-out, thunder on crash, wind while flying.
let ctx = null;
let muted = false;
let wind = null;
let noise = null;

const ac = () => {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
};

function noiseBuffer(a) {
  if (noise) return noise;
  noise = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

function tone(a, freq, start, dur, type = 'sine', vol = 0.14) {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(a.destination);
  o.start(start);
  o.stop(start + dur + 0.05);
}

const safe = (fn) => (...args) => {
  if (muted) return;
  try { fn(...args); } catch { /* audio is optional */ }
};

export const audio = {
  unlock() { try { ac().resume(); } catch { /* ignore */ } },

  setMuted(v) {
    muted = v;
    if (v) this.windStop();
  },

  chirp: safe(() => {
    const a = ac(); const t = a.currentTime;
    tone(a, 1500, t, 0.09); tone(a, 2100, t + 0.1, 0.1); tone(a, 1800, t + 0.22, 0.14);
  }),

  crash: safe((thunder) => {
    const a = ac(); const t = a.currentTime;
    const src = a.createBufferSource();
    src.buffer = noiseBuffer(a);
    const lp = a.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = thunder ? 380 : 1100;
    const g = a.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (thunder ? 1.6 : 0.7));
    src.connect(lp).connect(g).connect(a.destination);
    src.start(t);
    src.stop(t + 1.7);
    if (thunder) tone(a, 70, t, 0.9, 'sine', 0.3);
  }),

  windStart: safe(() => {
    if (wind) return;
    const a = ac();
    const src = a.createBufferSource();
    src.buffer = noiseBuffer(a);
    src.loop = true;
    const bp = a.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520;
    bp.Q.value = 0.6;
    const g = a.createGain();
    g.gain.value = 0.015;
    src.connect(bp).connect(g).connect(a.destination);
    src.start();
    wind = { src, g };
  }),

  windLevel(x) {
    if (wind) try { wind.g.gain.setTargetAtTime(0.015 + 0.05 * Math.min(1, x), ctx.currentTime, 0.2); } catch { /* ignore */ }
  },

  windStop() {
    if (!wind) return;
    const w = wind;
    wind = null;
    try {
      w.g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.1);
      w.src.stop(ctx.currentTime + 0.5);
    } catch { /* ignore */ }
  },
};
