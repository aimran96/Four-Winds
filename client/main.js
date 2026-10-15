import * as api from './api.js';
import { initI18n, setLang, t, lang } from './i18n.js';
import { audio } from './scene/audio.js';
import { verifyRound } from './ui/verify.js';
import { initAgent, pushEvent } from './ui/agent.js';

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(
  ['balance', 'wager', 'quick', 'auto', 'bet', 'cash', 'status', 'history', 'verify', 'verifyOut', 'commit', 'mult',
    'seasonName', 'riskPips', 'riskText', 'acctInfo', 'signIn', 'locToggle', 'locStatus', 'auth', 'authForm', 'authUser', 'authPass', 'authMsg', 'authLogin', 'authRegister', 'authGuest', 'budget', 'flags', 'lossLimit', 'saveLimit', 'lang', 'mute', 'motion', 'toast', 'reality', 'realityText', 'scene']
    .map((id) => [id, $(id)]),
);

const ICON = { spring: '🌸', summer: '☀️', autumn: '🍂', winter: '❄️' };
const f2 = (m) => (Math.floor(m * 100) / 100).toFixed(2);
const fmt = (n) => n.toLocaleString(lang(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let cfg = null;
let S = null; // latest server state
let flying = false; // a round is in progress (cash out allowed)
let animating = false; // crash/landing animation still playing (new bet not allowed yet)
let settledId = null;
let statusKey = null;
let muted = false;
let toastTimer = null;
// Realistic 3D scene when WebGL works, the 2D painted scene otherwise (add ?2d to force it).
const hasGL = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
let scene;
if (hasGL && !location.search.includes('2d')) {
  try { scene = new (await import('./scene/scene3d.js')).Scene(el.scene); } catch (e) { console.warn('3D scene unavailable, using 2D', e); }
}
if (!scene) {
  const fresh = el.scene.cloneNode(false); el.scene.replaceWith(fresh); el.scene = fresh;
  scene = new (await import('./scene/scene.js')).Scene(fresh);
}

// ---------- small UI helpers ----------
function setStatus(key, vars = {}) {
  statusKey = { key, vars };
  el.status.textContent = t(key, vars);
}

function toast(msg, ms = 5500) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function fail(e) {
  const code = e?.code ?? 'generic';
  toast(t(`err.${code}`, { min: cfg?.minBet, max: cfg?.maxBet }) === `err.${code}` ? t('err.generic') : t(`err.${code}`, { min: cfg?.minBet, max: cfg?.maxBet }));
  if (code === 'no_session') setTimeout(() => location.reload(), 1200);
}

function showNudge(n) {
  if (n.code === 'realityCheck') {
    el.realityText.textContent = t('nudge.realityCheck', { n: n.rounds, net: fmt(n.net) });
    if (el.reality.showModal) el.reality.showModal(); else toast(el.realityText.textContent, 9000);
  } else if (n.code === 'lossStreak') toast(t('nudge.lossStreak', { n: n.streak }));
  else if (n.code === 'escalation') toast(t('nudge.escalation'));
  else if (n.code === 'coolOff') toast(t('nudge.coolOff', { n: n.seconds }), 9000);
}

function setButtons() {
  el.bet.disabled = flying || animating || !S;
  el.cash.disabled = !flying;
  if (!flying) el.cash.textContent = t('cashOut');
}

function renderHistory(history) {
  const items = [...history].reverse().slice(0, 12).map((h) => {
    const li = document.createElement('li');
    li.className = h.payout >= h.wager ? 'win' : 'loss';
    li.textContent = `${f2(h.crashAt)}x`;
    li.title = `${t(`seasons.${h.season}`)} · ${fmt(h.wager)} → ${fmt(h.payout)}`;
    return li;
  });
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = t('noHistory');
    items.push(li);
  }
  el.history.replaceChildren(...items);
}

function renderProtection(p) {
  if (!p) return;
  el.budget.textContent = t('safe.budget', { used: fmt(p.lossUsed), limit: fmt(p.lossLimit), left: fmt(p.remaining) });
  el.flags.textContent = p.flags.length ? `${t('safe.level.' + p.level)}: ${p.flags.map((f) => t('safe.flag.' + f)).join(' · ')}` : '';
  if (document.activeElement !== el.lossLimit) el.lossLimit.value = p.lossLimit;
}

el.saveLimit.addEventListener('click', async () => {
  try {
    const p = await api.setLimit(Number(el.lossLimit.value));
    S.protection = p; renderProtection(p); toast(t('safe.saved'));
  } catch (e) { fail(e); }
});

// ---------- account and (optional) location ----------
let watchId = null;
let lastSent = -Infinity;
const locFlag = (on) => { try { on ? sessionStorage.setItem('fw-loc', '1') : sessionStorage.removeItem('fw-loc'); } catch { /* ignore */ } };

function renderAccount() {
  el.acctInfo.textContent = S?.account ? t('acct.signedIn', { name: S.account }) : t('acct.guest');
  el.signIn.textContent = S?.account ? t('acct.signOut') : t('acct.signIn');
  el.locToggle.textContent = watchId == null ? t('loc.share') : t('loc.stop');
  el.locStatus.textContent = watchId == null ? t('loc.off') : t('loc.on');
}

function startLocation() {
  if (!navigator.geolocation) { el.locStatus.textContent = t('loc.unavailable'); return; }
  // The browser shows its own permission prompt here; nothing is read before the player agrees.
  watchId = navigator.geolocation.watchPosition(async (pos) => {
    if (performance.now() - lastSent < 15000) return;
    lastSent = performance.now();
    try { await api.sendLocation(pos.coords.latitude, pos.coords.longitude); } catch (e) { if (e.code !== 'too_fast') fail(e); }
  }, (err) => { stopLocation(false); el.locStatus.textContent = err.code === 1 ? t('loc.denied') : t('loc.unavailable'); }, { enableHighAccuracy: false, maximumAge: 30000, timeout: 20000 });
  locFlag(true); renderAccount();
}

async function stopLocation(erase = true) {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null; locFlag(false); renderAccount();
  if (erase) { try { await api.clearLocation(); } catch { /* ignore */ } }
}

el.locToggle.addEventListener('click', () => (watchId == null ? startLocation() : stopLocation()));
el.signIn.addEventListener('click', async () => {
  if (S?.account) { await api.signOut(); location.reload(); } else openAuth();
});

function openAuth() {
  el.authMsg.textContent = '';
  el.authGuest.hidden = !!cfg?.authRequired;
  if (el.auth.showModal && !el.auth.open) el.auth.showModal();
}
async function submitAuth(mode) {
  if (!el.authForm.reportValidity()) return;
  try {
    await api.signIn(mode, el.authUser.value.trim(), el.authPass.value);
    location.reload(); // a fresh game session is created for the account
  } catch (e) {
    el.authMsg.textContent = t(`err.${e.code}`) === `err.${e.code}` ? t('err.generic') : t(`err.${e.code}`);
  }
}
el.authForm.addEventListener('submit', (e) => { e.preventDefault(); submitAuth('login'); });
el.authRegister.addEventListener('click', () => submitAuth('register'));
el.authGuest.addEventListener('click', () => el.auth.close());
el.auth.addEventListener('cancel', (e) => { if (cfg?.authRequired) e.preventDefault(); });

const msLeft = () => S.forecast.msLeft - (performance.now() - S.at);

function renderSeason() {
  if (!S) return;
  const season = S.season;
  const risk = cfg.seasons[season]?.risk ?? 0.3;
  const pips = Math.max(1, Math.ceil(risk * 4));
  document.body.dataset.season = season;
  el.seasonName.textContent = `${ICON[season] ?? '🐦'} ${t(`seasons.${season}`)}`;
  el.riskPips.replaceChildren(...[0, 1, 2, 3].map((i) => Object.assign(document.createElement('i'), { className: i < pips ? 'on' : '' })));
  el.riskText.textContent = t('riskLevels')[pips - 1];
}

function applyState(s) {
  S = s;
  S.at = performance.now();
  el.balance.textContent = fmt(s.balance);
  renderSeason();
  renderProtection(s.protection);
  renderAccount();
  renderHistory(s.history);
  if (s.round) {
    el.commit.textContent = s.round.commit;
    el.commit.title = s.round.commit;
  }
  scene.queueSeason(s.season, cfg.seasons[s.season]);
  setButtons();
}

function buildQuick() {
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.addEventListener('click', fn);
    return b;
  };
  const set = (v) => { el.wager.value = String(Math.round(Math.min(cfg.maxBet, Math.max(cfg.minBet, v)) * 100) / 100); };
  el.quick.replaceChildren(
    ...cfg.quickBets.map((v) => mk(String(v), () => set(v))),
    mk('½', () => set(Number(el.wager.value) / 2)),
    mk('2×', () => set(Number(el.wager.value) * 2)),
    mk(t('max'), () => set(Math.min(cfg.maxBet, S?.balance ?? cfg.maxBet))),
  );
}

// ---------- round flow ----------
function startFlight(s) {
  settledId = null; flying = true; animating = false;
  applyState(s);
  scene.begin(s.round.growthRate, s.round.elapsedMs);
  el.mult.className = 'mult flying';
  el.verifyOut.textContent = '';
  setStatus('status.flying');
  setButtons();
}

async function placeBet() {
  audio.unlock();
  if (flying || animating || !S) return;
  const raw = el.auto.value.trim();
  try {
    const s = await api.bet({ amount: Number(el.wager.value), autoCashOut: raw ? Number(raw) : null });
    startFlight(s);
    (s.nudges ?? []).forEach(showNudge);
  } catch (e) { fail(e); }
}

async function cashOut() {
  if (!flying || !S?.round) return;
  el.cash.disabled = true;
  try {
    settle(await api.cashout(S.round.id));
  } catch (e) { fail(e); setButtons(); }
}

// Called for both the HTTP reply and the SSE "settled" event; the first one wins.
function settle(s) {
  const r = s.round;
  if (!r || r.status === 'FLYING' || settledId === r.id) return;
  settledId = r.id; flying = false; animating = true;
  applyState(s);
  if (r.status === 'CRASHED') {
    el.mult.textContent = `${f2(r.crashAt)}x`;
    el.mult.className = 'mult bad';
    scene.crash(r.crashAt);
  } else {
    el.mult.textContent = `${f2(r.mult)}x`;
    el.mult.className = 'mult good';
    scene.cash(r.mult, r.status === 'LANDED');
    setStatus(r.status === 'LANDED' ? 'status.landed' : 'status.cashed', { mult: f2(r.mult), amount: fmt(r.payout) });
  }
  (s.nudges ?? []).forEach(showNudge);
  setButtons();
}

if (location.search.includes('debug')) window.__fw = { scene }; // test hook

scene.onMult = (m) => {
  if (!flying || !S?.round) return;
  el.mult.textContent = `${f2(m)}x`;
  const label = t('cashOutAt', { amount: fmt(S.round.wager * Math.floor(m * 100) / 100) });
  if (el.cash.textContent !== label) el.cash.textContent = label;
};
scene.onImpact = (cause) => {
  setStatus('status.crashed', { mult: f2(S.round.crashAt), cause: t(`causes.${cause}`) });
};
scene.onIdle = () => { animating = false; setButtons(); };

// ---------- fairness check ----------
el.verify.addEventListener('click', async () => {
  const r = S?.round;
  if (!r || r.status === 'FLYING') { el.verifyOut.textContent = t('verify.hint'); return; }
  el.verifyOut.textContent = t('verify.running');
  try {
    const result = await verifyRound(await api.verify(r.id), r.commit);
    el.verifyOut.textContent = result.ok ? t('verify.ok', { mult: f2(result.crashAt) }) : t('verify.fail');
  } catch (e) {
    el.verifyOut.textContent = e.message === 'no_crypto' ? t('verify.noCrypto') : t('verify.fail');
  }
});

// ---------- controls ----------
el.bet.addEventListener('click', placeBet);
el.cash.addEventListener('click', cashOut);
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(e.target.tagName)) return;
  e.preventDefault();
  if (flying) cashOut(); else placeBet();
});

el.lang.addEventListener('change', async () => {
  await setLang(el.lang.value);
  buildQuick(); renderSeason(); renderHistory(S?.history ?? []); renderMute();
  if (statusKey) el.status.textContent = t(statusKey.key, statusKey.vars);
});

function renderMute() {
  el.mute.textContent = t(muted ? 'ui.unmute' : 'ui.mute');
  el.mute.setAttribute('aria-pressed', String(muted));
}
el.mute.addEventListener('click', () => { muted = !muted; audio.setMuted(muted); renderMute(); });

function setMotion(reduced) {
  el.motion.setAttribute('aria-pressed', String(reduced));
  scene.setReduced(reduced);
  try { localStorage.setItem('fw-motion', reduced ? '1' : '0'); } catch { /* ignore */ }
}
el.motion.addEventListener('click', () => setMotion(el.motion.getAttribute('aria-pressed') !== 'true'));

// Seasons change on the clock: count down, and pull fresh state when the season flips (never mid-flight).
setInterval(async () => {
  if (!S) return;
  if (msLeft() > 0) return;
  if (flying || animating) return;
  try { applyState(await api.session()); } catch { /* retry next tick */ }
}, 1000);

// ---------- boot ----------
async function boot() {
  await initI18n();
  el.lang.value = lang();
  let savedMotion = null;
  try { savedMotion = localStorage.getItem('fw-motion'); } catch { /* ignore */ }
  setMotion(savedMotion ? savedMotion === '1' : matchMedia('(prefers-reduced-motion: reduce)').matches);

  cfg = await api.config();
  if (cfg.authRequired && !api.token()) openAuth();
  el.wager.min = cfg.minBet; el.wager.max = cfg.maxBet;
  let s;
  try { s = await api.session(); } catch (e) { if (e.code === 'login_required') { await api.signOut(); openAuth(); return; } throw e; }
  buildQuick(); renderMute();
  applyState(s);

  if (s.round?.status === 'FLYING') {
    startFlight(s);
  } else {
    if (s.round) { settledId = s.round.id; el.mult.textContent = `${f2(s.round.mult ?? s.round.crashAt)}x`; }
    setStatus('status.idle');
  }

  try { if (sessionStorage.getItem('fw-loc')) startLocation(); } catch { /* ignore */ }
  if (cfg.agentView) initAgent().catch(() => {});
  const es = api.stream();
  es.addEventListener('agent', (e) => { if (cfg.agentView) pushEvent(JSON.parse(e.data)); });
  es.addEventListener('tick', (e) => scene.sync(JSON.parse(e.data).mult));
  es.addEventListener('settled', (e) => settle(JSON.parse(e.data)));
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) location.reload(); };
}

boot().catch(fail);
