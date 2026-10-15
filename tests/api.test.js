import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { game, seasons } from '../server/config.js';
import { commitment, crashPoint, newSeed, uniform } from '../server/engine/rng.js';

const findSeed = (id, pred) => {
  for (;;) {
    const s = newSeed();
    if (pred(crashPoint(uniform(s, id), game.houseEdge, seasons.spring.maxMultiplier))) return s;
  }
};

let server, base, t = 1_000_000, n = 0;
const seeds = [
  findSeed('r1', (c) => c.crashAt >= 5), // round 1: a long flight we can cash out of
  findSeed('r2', (c) => c.crashAt === 1), // round 2: instant crash
];

before(async () => {
  server = createApp({ newSeed: () => seeds.shift(), newId: () => `r${++n}`, now: () => t, rand: () => 0.5 });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
let sid;
const key = () => `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;

test('session starts in spring with the starting balance', async () => {
  const { status, body } = await call('POST', '/api/session', {});
  assert.equal(status, 200);
  sid = body.sessionId;
  assert.equal(body.balance, game.startingBalance);
  assert.equal(body.season, 'spring');
  assert.equal(body.round, null);
});

test('bet validation rejects bad input', async () => {
  for (const amount of [0, -5, 'abc', null, game.maxBet + 1, 1.234]) {
    const r = await call('POST', '/api/bet', { sessionId: sid, amount, idempotencyKey: key() });
    assert.equal(r.status, 400, `amount ${amount}`);
  }
  assert.equal((await call('POST', '/api/bet', { sessionId: sid, amount: 10 })).body.error, 'bad_key');
  assert.equal((await call('POST', '/api/bet', { sessionId: sid, amount: 10, autoCashOut: 99, idempotencyKey: key() })).body.error, 'bad_auto');
  assert.equal((await call('POST', '/api/bet', { sessionId: 'nope', amount: 10, idempotencyKey: key() })).status, 404);
});

test('bet deducts the wager, hides the crash point, and is idempotent', async () => {
  const k = key();
  const a = await call('POST', '/api/bet', { sessionId: sid, amount: 100, idempotencyKey: k });
  assert.equal(a.status, 200);
  assert.equal(a.body.balance, game.startingBalance - 100);
  assert.equal(a.body.round.status, 'FLYING');
  assert.equal(a.body.round.crashAt, undefined);
  assert.match(a.body.round.commit, /^[0-9a-f]{64}$/);
  const b = await call('POST', '/api/bet', { sessionId: sid, amount: 100, idempotencyKey: k });
  assert.deepEqual(b.body, a.body);
  assert.equal((await call('GET', `/api/state?sessionId=${sid}`)).body.balance, game.startingBalance - 100);
});

test('a second bet during a flight is refused', async () => {
  const r = await call('POST', '/api/bet', { sessionId: sid, amount: 10, idempotencyKey: key() });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'round_in_progress');
});

test('the fairness proof is not revealed before the round ends', async () => {
  assert.equal((await call('GET', `/api/verify/r1?sessionId=${sid}`)).status, 404);
});

test('cash-out pays wager x multiplier exactly once', async () => {
  t += 3000; // e^(0.1*3) = 1.3498 -> 1.34x
  const k = key();
  const a = await call('POST', '/api/cashout', { sessionId: sid, roundId: 'r1', idempotencyKey: k });
  assert.equal(a.body.round.status, 'CASHED');
  assert.equal(a.body.round.mult, 1.34);
  assert.equal(a.body.round.payout, 134);
  assert.equal(a.body.balance, game.startingBalance - 100 + 134);
  const again = await call('POST', '/api/cashout', { sessionId: sid, roundId: 'r1', idempotencyKey: k });
  assert.deepEqual(again.body, a.body);
  const other = await call('POST', '/api/cashout', { sessionId: sid, roundId: 'r1', idempotencyKey: key() });
  assert.equal(other.body.balance, a.body.balance);
});

test('a settled round can be verified from its revealed seed', async () => {
  const { body: v } = await call('GET', `/api/verify/r1?sessionId=${sid}`);
  assert.equal(commitment(v.serverSeed), v.commit);
  assert.deepEqual(crashPoint(uniform(v.serverSeed, v.roundId), v.edge, v.maxMultiplier), { crashAt: v.crashAt, capped: v.capped });
  assert.ok(v.crashAt >= 5);
});

test('an instant crash loses the wager', async () => {
  const bet = await call('POST', '/api/bet', { sessionId: sid, amount: 50, idempotencyKey: key() });
  assert.equal(bet.status, 200);
  t += 10;
  const s = (await call('GET', `/api/state?sessionId=${sid}`)).body;
  assert.equal(s.round.status, 'CRASHED');
  assert.equal(s.round.crashAt, 1);
  assert.equal(s.balance, game.startingBalance - 100 + 134 - 50);
  const late = await call('POST', '/api/cashout', { sessionId: sid, roundId: 'r2', idempotencyKey: key() });
  assert.equal(late.body.balance, s.balance);
});

test('the live stream sends state and multiplier ticks', async () => {
  seeds.push(findSeed('r3', (c) => c.crashAt >= 5));
  const ac = new AbortController();
  const res = await fetch(`${base}/api/stream?sessionId=${sid}`, { signal: ac.signal });
  const reader = res.body.getReader();
  await call('POST', '/api/bet', { sessionId: sid, amount: 10, idempotencyKey: key() });
  let text = '';
  const deadline = Date.now() + 3000;
  while (!text.includes('event: tick') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString();
  }
  ac.abort();
  const events = text.split('\n\n').filter(Boolean).map((chunk) => ({
    name: chunk.match(/event: (\w+)/)?.[1],
    data: JSON.parse(chunk.match(/data: (.*)/)[1]),
  }));
  assert.ok(events.some((e) => e.name === 'state'));
  const ticks = events.filter((e) => e.name === 'tick');
  assert.ok(ticks.length > 0);
  for (const e of ticks) assert.deepEqual(Object.keys(e.data).sort(), ['id', 'mult']);
  // Past rounds in history may show their crash point; the in-flight round (r3) must not.
  for (const e of events) {
    if (e.data.round?.id === 'r3') assert.equal(e.data.round.crashAt, undefined);
  }
});

test('overdrafts are refused', async () => {
  const poor = createApp({ game: { ...game, startingBalance: 5 } });
  await new Promise((r) => poor.listen(0, r));
  const url = `http://localhost:${poor.address().port}`;
  const s = await (await fetch(`${url}/api/session`, { method: 'POST' })).json();
  const res = await fetch(`${url}/api/bet`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: s.sessionId, amount: 10, idempotencyKey: key() }),
  });
  assert.equal((await res.json()).error, 'insufficient_funds');
  poor.close();
});

test('seasons change on their own after a short random time and never repeat back to back', async () => {
  const a = createApp({ now: () => t2, rand: () => 0.5 });
  let t2 = 0;
  const cur = () => { const s = a.sessions.values().next().value; return s; };
  await new Promise((r) => a.listen(0, r));
  const base = `http://localhost:${a.address().port}`;
  const post = await (await fetch(`${base}/api/session`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json();
  const seen = [post.season];
  for (let i = 0; i < 6; i++) {
    t2 += 7000;
    const v = await (await fetch(`${base}/api/state?sessionId=${post.sessionId}`)).json();
    seen.push(v.season);
    assert.ok(v.forecast.msLeft > 0 && v.forecast.msLeft <= 9000);
  }
  assert.ok(new Set(seen).size > 1, `seasons ${seen}`);
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1]);
  void cur;
  await new Promise((r) => a.close(r));
});
