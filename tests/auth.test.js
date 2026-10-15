import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { game } from '../server/config.js';
import { createAuth } from '../server/auth.js';

test('register, login, wrong password and lockout', () => {
  let t = 0;
  const a = createAuth({ now: () => t });
  const { token } = a.register('om_joshi', 'correct horse', 'c1');
  assert.equal(a.who(token), 'om_joshi');
  assert.throws(() => a.register('om_joshi', 'another pass', 'c1'), (e) => e.code === 'username_taken');
  assert.throws(() => a.register('x', 'longenough', 'c1'), (e) => e.code === 'bad_username');
  assert.throws(() => a.register('okname', 'short', 'c1'), (e) => e.code === 'bad_password');
  assert.equal(a.who(a.login('om_joshi', 'correct horse', 'c2').token), 'om_joshi');
  for (let i = 0; i < 5; i++) assert.throws(() => a.login('om_joshi', 'wrong', 'c3'), (e) => e.code === 'bad_credentials');
  assert.throws(() => a.login('om_joshi', 'correct horse', 'c3'), (e) => e.code === 'account_locked'); // even the right password
  t += 16 * 60_000;
  assert.equal(a.who(a.login('om_joshi', 'correct horse', 'c3').token), 'om_joshi'); // lock expires
  assert.throws(() => a.login('nobody', 'whatever1', 'c3'), (e) => e.code === 'bad_credentials');
  assert.equal(a.who('not-a-token'), null);
  const log = a.events();
  assert.ok(log.some((e) => e.reason === 'locked') && log.some((e) => e.reason === 'registered'));
  assert.ok(!JSON.stringify(log).includes('correct horse'), 'passwords never reach the log');
});

let t = 20_000_000;
const post = async (base, path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

test('login can be required, and the monitor sees logins and locations', async () => {
  const app = createApp({ game: { ...game, auth: { required: true } }, now: () => t, monitorToken: 'k' });
  await new Promise((r) => app.listen(0, r));
  const base = `http://localhost:${app.address().port}`;
  try {
    assert.equal((await post(base, '/api/session', {})).body.error, 'login_required');
    const { body: acct } = await post(base, '/api/register', { username: 'player_one', password: 'longpassword' });
    const s = (await post(base, '/api/session', { token: acct.token })).body;
    assert.equal(s.account, 'player_one');
    assert.equal(s.locationShared, false);

    // Opt-in location: kept at about 1 km precision, never exact.
    assert.equal((await post(base, '/api/location', { sessionId: s.sessionId, lat: 46.52345, lon: -84.34567 })).body.locationShared, true);
    assert.equal((await post(base, '/api/location', { sessionId: s.sessionId, lat: 46.5, lon: -84.3 })).body.error, 'too_fast');
    assert.equal((await post(base, '/api/location', { sessionId: s.sessionId, lat: 999, lon: 0 })).body.error, 'bad_location');
    t += 10_000;
    // Sault Ste. Marie to Mumbai in 10 seconds is impossible for one device.
    await post(base, '/api/location', { sessionId: s.sessionId, lat: 19.076, lon: 72.8777 });

    const mon = await (await fetch(`${base}/api/monitor`, { headers: { 'x-monitor-token': 'k' } })).json();
    const row = mon.sessions[0];
    assert.equal(row.account, 'player_one');
    assert.deepEqual([row.location.lat, row.location.lon], [19.08, 72.88]);
    assert.ok(row.fraud.flags.some((f) => f.code === 'impossibleTravel'));
    assert.ok(mon.alerts.some((a) => a.code === 'impossibleTravel'));
    assert.ok(mon.logins.some((l) => l.username === 'player_one' && l.reason === 'registered'));
    assert.ok(!JSON.stringify(mon).includes('longpassword') && !JSON.stringify(mon).includes(acct.token));

    // Withdrawing consent erases what was kept.
    const del = await (await fetch(`${base}/api/location?sessionId=${s.sessionId}`, { method: 'DELETE' })).json();
    assert.equal(del.locationShared, false);
    const after = await (await fetch(`${base}/api/monitor`, { headers: { 'x-monitor-token': 'k' } })).json();
    assert.equal(after.sessions[0].location, null);
    assert.ok(!after.sessions[0].fraud.flags.some((f) => f.code === 'impossibleTravel'));
  } finally {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
  }
});
