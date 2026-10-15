import test from 'node:test';
import assert from 'node:assert/strict';
import { game, seasons } from '../server/config.js';
import { crashPoint } from '../server/engine/rng.js';
import { createSentinel, winProb } from '../server/agent/sentinel.js';

// Small seeded generator so these statistical tests are repeatable.
const prng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const wins = (auto, c) => auto < c.crashAt || (c.capped && auto <= c.crashAt);

test('winProb matches the real crash formula in every season', () => {
  const rnd = prng(7);
  const N = 200_000;
  for (const s of Object.values(seasons)) {
    for (const auto of [1.01, 1.2, 2, 5, 25]) {
      if (auto > s.maxMultiplier) continue;
      let w = 0;
      for (let i = 0; i < N; i++) if (wins(auto, crashPoint(rnd(), game.houseEdge, s.maxMultiplier, s.bustChance ?? 0))) w++;
      const p = winProb(auto, game.houseEdge, s.maxMultiplier, s.bustChance ?? 0);
      const sd = Math.sqrt((p * (1 - p)) / N);
      assert.ok(Math.abs(w / N - p) < 4.5 * sd + 1e-4, `auto ${auto} max ${s.maxMultiplier} bust ${s.bustChance}: simulated ${w / N}, formula ${p}`);
    }
  }
});

const roundFor = (rnd, auto, season, boost = 0) => {
  const c = crashPoint(rnd(), game.houseEdge, season.maxMultiplier, season.bustChance ?? 0);
  const win = wins(auto, c) || rnd() < boost; // `boost` models a cheater who sometimes knows the outcome
  return { wagerCents: 1000, payoutCents: win ? Math.floor(1000 * auto) : 0, autoCashOut: auto, status: win ? 'CASHED' : 'CRASHED', cashedAt: win ? auto : null, maxMultiplier: season.maxMultiplier, bust: season.bustChance ?? 0 };
};

test('honest players are almost never sent to review, whatever their target', () => {
  const rnd = prng(99);
  const names = Object.keys(seasons);
  let review = 0;
  const PLAYERS = 1500;
  for (let i = 0; i < PLAYERS; i++) {
    const sentinel = createSentinel({ edge: game.houseEdge });
    const auto = [1.2, 1.5, 2, 3, 10][i % 5];
    for (let r = 0; r < 300; r++) {
      const season = seasons[names[Math.floor(rnd() * 4)]];
      if (auto > season.maxMultiplier) continue;
      if (sentinel.observe('p', roundFor(rnd, auto, season)).level === 'review') { review++; break; }
    }
  }
  assert.ok(review <= 3, `${review} of ${PLAYERS} honest players reached review`);
});

test('a high win rate at a low target is normal, but the same rate at 2x is caught', () => {
  const rnd = prng(5);
  const spring = seasons.spring;
  const low = createSentinel({ edge: game.houseEdge });
  let v;
  for (let i = 0; i < 300; i++) v = low.observe('a', roundFor(rnd, 1.2, spring));
  assert.ok(v.wins / v.n > 0.7 && v.level === 'clear', `80% wins at 1.2x is fair (got ${v.wins}/${v.n}, ${v.level})`);

  const cheat = createSentinel({ edge: game.houseEdge });
  let caught = null;
  for (let i = 1; i <= 300 && !caught; i++) { const r = cheat.observe('b', roundFor(rnd, 2, spring, 0.25)); if (r.level === 'review') caught = i; }
  assert.ok(caught && caught <= 300, 'cheater with partial foresight reaches review');
  assert.match(cheat.verdict('b').summary, /Won \d+ of \d+ fixed-target rounds/);
});

test('manual cash-outs do not count as wins or losses', () => {
  const s = createSentinel({ edge: game.houseEdge });
  const v = s.observe('m', { wagerCents: 1000, payoutCents: 1500, autoCashOut: 3, status: 'CASHED', cashedAt: 1.5, maxMultiplier: 100, bust: 0 });
  assert.equal(v.n, 0);
  assert.equal(v.rounds, 1);
});

// ---- through the API: an impossible winning streak is flagged live ----
import { createApp } from '../server/app.js';
import { newSeed, uniform } from '../server/engine/rng.js';

test('the agent raises an alert, with its reasoning, and can pause betting', async () => {
  let t = 9_000_000;
  let n = 0;
  const seedFor = (id) => { for (;;) { const s = newSeed(); const c = crashPoint(uniform(s, id), game.houseEdge, seasons.spring.maxMultiplier, 0); if (c.crashAt > 5.5) return s; } };
  const seeds = Array.from({ length: 10 }, (_, i) => seedFor(`s${i + 1}`));
  const app = createApp({
    seasons: { spring: seasons.spring, summer: { ...seasons.spring } }, // identical odds, so every round uses the seeds picked above
    game: { ...game, sentinel: { minRounds: 8, watchZ: 3, reviewZ: 4, onReview: 'coolOff' } },
    newSeed: () => seeds.shift(), newId: () => `s${++n}`, now: () => t, rand: () => 0.5, monitorToken: 'k',
  });
  await new Promise((r) => app.listen(0, r));
  const base = `http://localhost:${app.address().port}`;
  const post = async (path, body) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    const s = await post('/api/session', {});
    for (let i = 0; i < 8; i++) {
      const b = await post('/api/bet', { sessionId: s.sessionId, amount: 1, autoCashOut: 5, idempotencyKey: `key-${i}-abcdefgh` });
      assert.ok(!b.error, `bet ${i}: ${b.error}`);
      t += 20_000;
      await fetch(`${base}/api/state?sessionId=${s.sessionId}`); // settles the round
    }
    const mon = await (await fetch(`${base}/api/monitor`, { headers: { 'x-monitor-token': 'k' } })).json();
    const alert = mon.alerts.find((a) => a.code === 'sentinel');
    assert.ok(alert, 'sentinel alert raised');
    assert.match(alert.detail, /Won 8 of 8 fixed-target rounds/);
    assert.equal(mon.sessions[0].sentinel.level, 'review');
    const next = await post('/api/bet', { sessionId: s.sessionId, amount: 1, autoCashOut: 5, idempotencyKey: 'key-after-review' });
    assert.equal(next.error, 'cooling_off'); // onReview: coolOff pauses betting
  } finally {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
  }
});

// ---- the live "what is the agent doing" feed ----
import { startSimulation } from '../server/agent/demo.js';

test('the demo simulation builds evidence step by step and ends in a review alert', async () => {
  const events = [];
  const keepAlive = setInterval(() => {}, 1000); // the simulation timer is unref'd, so hold the loop open while we wait
  await new Promise((done) => startSimulation({ edge: game.houseEdge, season: seasons.spring, sentinel: game.sentinel, delay: 1, emit: (kind, text, extra) => events.push({ kind, text, extra }), onDone: done }));
  clearInterval(keepAlive);
  const kinds = events.map((e) => e.kind);
  assert.equal(kinds[0], 'sim');
  assert.ok(kinds.includes('round') && kinds.at(-2) === 'alert' && kinds.at(-1) === 'action', kinds.join(','));
  assert.ok(events.filter((e) => e.kind === 'round').every((e) => e.extra.sim && e.extra.v.zRaw !== undefined));
});

test('each settled round is explained in the feed, and the feed can be switched off', async () => {
  let t = 7_000_000;
  const mk = (g) => createApp({ game: g, now: () => t, rand: () => 0.5 });
  const on = mk(game);
  const off = mk({ ...game, demo: { agentView: false } });
  await Promise.all([on, off].map((a) => new Promise((r) => a.listen(0, r))));
  const url = (a) => `http://localhost:${a.address().port}`;
  try {
    const post = async (a, path, body) => (await fetch(url(a) + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const s = await post(on, '/api/session', {});
    await post(on, '/api/bet', { sessionId: s.sessionId, amount: 1, autoCashOut: 1.5, idempotencyKey: 'key-feed-abcdefgh' });
    t += 60_000;
    await fetch(`${url(on)}/api/state?sessionId=${s.sessionId}`);
    const feed = await (await fetch(`${url(on)}/api/agent?sessionId=${s.sessionId}`)).json();
    assert.match(feed.events[0].text, /Round 1: target 1.5x had a \d+\.\d% chance/);
    assert.equal((await fetch(`${url(off)}/api/agent?sessionId=x`)).status, 403);
    assert.equal((await fetch(`${url(off)}/api/config`).then((r) => r.json())).agentView, false);
  } finally {
    for (const a of [on, off]) { a.closeAllConnections(); await new Promise((r) => a.close(r)); }
  }
});
