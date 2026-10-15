import test from 'node:test';
import assert from 'node:assert/strict';
import { commitment, crashPoint, newSeed, uniform } from '../server/engine/rng.js';
import { Wallet } from '../server/engine/wallet.js';
import { startRound, resolve, cashOut } from '../server/engine/round.js';

test('rng is deterministic, in range, and committed by SHA-256', () => {
  const seed = newSeed();
  assert.equal(uniform(seed, 'a'), uniform(seed, 'a'));
  assert.notEqual(uniform(seed, 'a'), uniform(seed, 'b'));
  for (let i = 0; i < 1000; i++) {
    const u = uniform(newSeed(), 'x');
    assert.ok(u >= 0 && u < 1);
  }
  assert.match(commitment(seed), /^[0-9a-f]{64}$/);
});

test('crash point is bounded by 1.00x and the season max', () => {
  assert.deepEqual(crashPoint(0, 0.03, 10), { crashAt: 1, capped: false });
  assert.deepEqual(crashPoint(0.9999999, 0.03, 10), { crashAt: 10, capped: true });
  for (let i = 0; i < 5000; i++) {
    const { crashAt } = crashPoint(uniform(newSeed(), 'x'), 0.03, 50);
    assert.ok(crashAt >= 1 && crashAt <= 50);
  }
});

test('RTP of fixed cash-out targets is near 1 - edge in every season', () => {
  for (const max of [10, 50, 200, 1000]) {
    const n = 60000;
    for (const target of [1.5, 2, 5]) {
      let paid = 0;
      for (let i = 0; i < n; i++) {
        const { crashAt, capped } = crashPoint(uniform(newSeed(), 'x'), 0.03, max);
        if (capped || target < crashAt) paid += target;
      }
      const rtp = paid / n;
      assert.ok(rtp > 0.9 && rtp < 1.03, `max ${max} target ${target}: RTP ${rtp}`);
    }
  }
});

test('wallet debits and credits in cents and rejects overdrafts', () => {
  const w = new Wallet(1000);
  w.debit(250);
  w.credit(100);
  assert.equal(w.cents, 850);
  assert.throws(() => w.debit(851), { code: 'insufficient_funds' });
  assert.throws(() => w.debit(0), { code: 'bad_amount' });
  assert.throws(() => w.debit(1.5), { code: 'bad_amount' });
});

const season = { growthRate: 0.1, maxMultiplier: 10 };
const mk = (over = {}) => ({
  ...startRound({ id: 't', seed: newSeed(), seasonName: 'spring', season, edge: 0.03, wagerCents: 1000, autoCashOut: null, now: 0 }),
  ...over,
});

test('round crashes at crashAt and loses the wager', () => {
  const r = mk({ crashAt: 2, capped: false }); // 2.00x is reached at ln(2)/0.1 = 6931 ms
  assert.equal(resolve(r, 6000).status, 'FLYING');
  assert.equal(resolve(r, 7000).status, 'CRASHED');
  assert.equal(r.payoutCents, 0);
});

test('manual cash-out pays wager x floored multiplier', () => {
  const r = mk({ crashAt: 5, capped: false });
  cashOut(r, 3000); // e^0.3 = 1.3498 -> 1.34x
  assert.equal(r.status, 'CASHED');
  assert.equal(r.cashedAt, 1.34);
  assert.equal(r.payoutCents, 1340);
});

test('cash-out after the crash is too late', () => {
  const r = mk({ crashAt: 2, capped: false });
  cashOut(r, 8000);
  assert.equal(r.status, 'CRASHED');
  assert.equal(r.payoutCents, 0);
});

test('auto cash-out triggers at its target', () => {
  const r = mk({ crashAt: 5, capped: false, autoCashOut: 1.5 });
  assert.equal(resolve(r, 4000).status, 'FLYING'); // 1.5x at 4055 ms
  assert.equal(resolve(r, 5000).status, 'CASHED');
  assert.equal(r.payoutCents, 1500);
});

test('auto cash-out above the crash point does not save the player', () => {
  const r = mk({ crashAt: 2, capped: false, autoCashOut: 3 });
  assert.equal(resolve(r, 20000).status, 'CRASHED');
});

test('a capped round lands and pays the season maximum', () => {
  const r = mk({ crashAt: 10, capped: true });
  assert.equal(resolve(r, 30000).status, 'LANDED');
  assert.equal(r.payoutCents, 10000);
});

test('bust chance makes instant crashes likely but keeps RTP at 1 - edge', () => {
  assert.deepEqual(crashPoint(0.34, 0.03, 1000, 0.35), { crashAt: 1, capped: false });
  assert.ok(crashPoint(0.36, 0.03, 1000, 0.35).crashAt > 1.4);
  const n = 100000;
  let busts = 0; let paid = 0;
  for (let i = 0; i < n; i++) {
    const { crashAt, capped } = crashPoint(uniform(newSeed(), 'x'), 0.03, 1000, 0.35);
    if (crashAt === 1) busts++;
    if (capped || 2 < crashAt) paid += 2;
  }
  assert.ok(Math.abs(busts / n - 0.35) < 0.01, `bust rate ${busts / n}`);
  assert.ok(paid / n > 0.93 && paid / n < 1.01, `RTP ${paid / n}`);
});
