import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { game, seasons } from '../server/config.js';
import { crashPoint, newSeed, uniform } from '../server/engine/rng.js';
import { newProfile, recordBet, recordResult, assess } from '../server/engine/risk.js';

const profile = () => newProfile({ bankrollCents: 100_000, limitCents: 50_000, now: 0, client: 'c' });
const codes = (a) => [...a.risk.flags, ...a.fraud.flags].map((f) => f.code);
const play = (p, t, wagerCents, lost = true, extra = {}) => {
  recordBet(p, { t, wagerCents, auto: null });
  recordResult(p, { payoutCents: lost ? 0 : wagerCents * 2, wagerCents, ...extra });
};

test('raising the bet right after losses is flagged as chasing', () => {
  const p = profile();
  [1000, 2000, 4000, 8000].forEach((w, i) => play(p, i * 7000, w));
  const a = assess(p, 30_000);
  assert.ok(codes(a).includes('chasing'));
  assert.notEqual(a.risk.level, 'low');
});

test('perfectly regular bet spacing looks like a bot, human-like spacing does not', () => {
  const bot = profile();
  for (let i = 0; i < 14; i++) play(bot, i * 5000, 1000, i % 2 === 0);
  assert.ok(codes(assess(bot, 80_000)).includes('botTiming'));

  const human = profile();
  let t = 0;
  for (let i = 0; i < 14; i++) { t += 4000 + ((i * 7919) % 9000); play(human, t, 1000, i % 2 === 0); }
  assert.ok(!codes(assess(human, t + 1000)).includes('botTiming'));
});

test('repeated near-instant manual cash-outs are flagged, and only to monitors', () => {
  const p = profile();
  for (let i = 0; i < 4; i++) play(p, i * 9000, 1000, false, { manual: true, cashMs: 80 });
  const a = assess(p, 40_000);
  assert.ok(a.fraud.flags.some((f) => f.code === 'superhumanReaction'));
  assert.ok(!a.risk.flags.some((f) => f.code === 'superhumanReaction'));
});

test('a calm player stays low risk and clear', () => {
  const p = profile();
  play(p, 0, 1000, true); play(p, 20_000, 1000, false);
  const a = assess(p, 40_000);
  assert.equal(a.risk.level, 'low');
  assert.equal(a.fraud.level, 'clear');
});

// ---- through the API ----
let t = 5_000_000;
let n = 0;
const crashSeed = (id) => { for (;;) { const s = newSeed(); if (crashPoint(uniform(s, id), game.houseEdge, seasons.spring.maxMultiplier).crashAt === 1) return s; } };
const post = async (base, path, body, headers = {}) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('loss limit, cool-off and monitor view work end to end', async () => {
  const seeds = ['x1', 'x2'].map(crashSeed);
  const app = createApp({ newSeed: () => seeds.shift(), newId: () => `x${++n}`, now: () => t, rand: () => 0.5, monitorToken: 'secret' });
  await new Promise((r) => app.listen(0, r));
  const base = `http://localhost:${app.address().port}`;
  try {
    const s = (await post(base, '/api/session', {})).body;
    assert.equal(s.protection.lossLimit, 500);
    assert.equal((await post(base, '/api/limits', { sessionId: s.sessionId, lossLimit: 20 })).body.lossLimit, 20);
    assert.equal((await post(base, '/api/limits', { sessionId: s.sessionId, lossLimit: 0 })).body.error, 'bad_limit');

    const bet = (amount) => post(base, '/api/bet', { sessionId: s.sessionId, amount, idempotencyKey: `key-${Math.random().toString(36).slice(2)}-${t}` });
    assert.equal((await bet(25)).body.error, 'limit_reached'); // bigger than the whole budget
    assert.equal((await bet(10)).status, 200);
    t += 3000;
    assert.equal((await bet(10)).status, 200); // first round was an instant crash, so this settles it first
    t += 3000;
    const st = await (await fetch(`${base}/api/state?sessionId=${s.sessionId}`)).json(); // settles round 2
    assert.equal(st.protection.remaining, 0);
    assert.equal(st.protection.level, 'high');
    assert.ok(st.protection.coolMs > 0);
    assert.equal((await bet(1)).body.error, 'cooling_off');
    // Raising the limit to dodge the budget is refused while it is exhausted.
    assert.equal((await post(base, '/api/limits', { sessionId: s.sessionId, lossLimit: 400 })).body.error, 'limit_locked');
    assert.ok(!JSON.stringify(st).includes('fraud'), 'player view must not expose fraud flags');

    assert.equal((await fetch(`${base}/api/monitor`, { headers: { 'x-monitor-token': 'wrong' } })).status, 403);
    const mon = await (await fetch(`${base}/api/monitor`, { headers: { 'x-monitor-token': 'secret' } })).json();
    assert.equal(mon.sessions[0].session, s.sessionId.slice(0, 8));
    assert.ok(!JSON.stringify(mon).includes(s.sessionId), 'full session id is a bearer token and must not leak');
    assert.ok(mon.alerts.some((a) => a.code === 'nearLimit'));
  } finally {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
  }
});
