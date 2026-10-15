import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { game as defaultGame, seasons as defaultSeasons } from './config.js';
import { GameError } from './errors.js';
import { newSeed as defaultSeed } from './engine/rng.js';
import { startRound, resolve, cashOut, multAt, floor2 } from './engine/round.js';
import { Wallet } from './engine/wallet.js';
import { createAuth } from './auth.js';
import { createSentinel } from './agent/sentinel.js';
import { startSimulation } from './agent/demo.js';
import { newProfile, recordLocation, recordBet, recordResult, assess, lossUsed, remaining } from './engine/risk.js';

const CLIENT_DIR = fileURLToPath(new URL('../client/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
};
const MAX_SESSIONS = 5000;
const MAX_IDEMPOTENCY_KEYS = 200;

// Everything injectable (clock, seed, ids, config) so tests can force exact rounds.
export function createApp({
  game = defaultGame, seasons = defaultSeasons,
  newSeed = defaultSeed, newId = randomUUID, now = Date.now, rand = Math.random,
  monitorToken = process.env.MONITOR_TOKEN,
} = {}) {
  const sessions = new Map();
  const auth = createAuth({ now });
  const sentinel = createSentinel({ edge: game.houseEdge, ...game.sentinel });
  const alerts = []; // newest last; kept after a session expires so investigators can still see it
  const names = Object.keys(seasons);

  const publicConfig = {
    authRequired: !!game.auth?.required, agentView: !!game.demo?.agentView, minBet: game.minBet, maxBet: game.maxBet, quickBets: game.quickBets, houseEdge: game.houseEdge,
    seasons: Object.fromEntries(names.map((n) => [n, seasons[n]])),
  };

  // Seasons are random and short: each lasts seasonMs[0]..seasonMs[1], and the next one is a random other season.
  const seasonLen = () => game.seasonMs[0] + rand() * (game.seasonMs[1] - game.seasonMs[0]);
  const pickNext = (cur) => { const o = names.filter((n) => n !== cur); return o[Math.floor(rand() * o.length)]; };
  const advanceSeason = (s) => {
    while (now() >= s.season.endsAt) s.season = { current: s.season.next, next: pickNext(s.season.next), endsAt: s.season.endsAt + seasonLen() };
    return s.season;
  };

  // ---------- views ----------
  const roundView = (r, t) => ({
    id: r.id, commit: r.commit, season: r.seasonName, wager: r.wagerCents / 100,
    autoCashOut: r.autoCashOut, status: r.status, growthRate: r.growthRate,
    ...(r.status === 'FLYING'
      ? { elapsedMs: t - r.startedAt }
      : { crashAt: r.crashAt, capped: r.capped, mult: r.cashedAt, payout: r.payoutCents / 100 }),
  });

  const view = (s) => {
    const f = advanceSeason(s);
    return {
      sessionId: s.id,
      balance: s.wallet.cents / 100,
      status: s.round?.status ?? 'IDLE',
      season: f.current,
      forecast: { next: f.next, msLeft: f.endsAt - now() },
      round: s.round ? roundView(s.round, now()) : null,
      history: s.history.slice(-20).map(({ seed, ...h }) => h),
      protection: protection(s),
      account: s.profile.account,
      locationShared: s.profile.places.length > 0,
    };
  };

  // What the player may see about their own profile: budget, level and plain reasons. Fraud flags stay private.
  const protection = (s) => {
    const p = s.profile;
    const { risk } = assess(p, now());
    return {
      lossLimit: p.limitCents / 100, lossUsed: lossUsed(p) / 100, remaining: remaining(p) / 100,
      level: risk.level, flags: risk.flags.map((f) => f.code), coolMs: Math.max(0, p.coolUntil - now()),
    };
  };

  // ---------- sessions ----------
  function newSession(client = 'unknown', account = null) {
    if (sessions.size >= MAX_SESSIONS) throw new GameError('busy', 503);
    const bankrollCents = Math.round(game.startingBalance * 100);
    const profile = newProfile({ bankrollCents, limitCents: Math.round(game.protection.defaultLossLimit * 100), now: now(), client });
    const peers = [...sessions.values()].filter((o) => o.profile.client === client);
    profile.account = account;
    if (account) {
      const same = [...sessions.values()].filter((o) => o.profile.account === account && o.profile.client !== client);
      if (same.length) { profile.sharedAccount = true; for (const o of same) o.profile.sharedAccount = true; }
    }
    profile.peers = peers.length;
    for (const o of peers) o.profile.peers = peers.length;
    const s = {
      profile,
      id: randomUUID(), wallet: new Wallet(Math.round(game.startingBalance * 100)),
      round: null, history: [], roundsPlayed: 0, lossStreak: 0, netCents: 0,
      lastWagerCents: 0, lastLost: false, idem: new Map(), streams: new Set(), seen: now(),
    };
    s.season = { current: names[0], next: pickNext(names[0]), endsAt: now() + seasonLen() };
    sessions.set(s.id, s);
    return s;
  }

  function getSession(id) {
    const s = sessions.get(id);
    if (!s) throw new GameError('no_session', 404);
    s.seen = now();
    return s;
  }

  const emit = (s, event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of s.streams) res.write(msg);
  };

  // Credits the payout, records history, computes nudges. Runs once per round.
  function finalize(s) {
    const r = s.round;
    if (!r || r.status === 'FLYING' || r.finalized) return null;
    r.finalized = true;
    s.wallet.credit(r.payoutCents);
    s.roundsPlayed += 1;
    const lost = r.payoutCents < r.wagerCents;
    s.netCents += r.payoutCents - r.wagerCents;
    s.lossStreak = lost ? s.lossStreak + 1 : 0;
    s.lastLost = lost;
    const manual = r.status === 'CASHED' && r.manualAt != null && r.cashedAt !== r.autoCashOut;
    recordResult(s.profile, { payoutCents: r.payoutCents, wagerCents: r.wagerCents, cashMs: manual ? r.manualAt - r.startedAt : null, manual });
    s.history.push({
      id: r.id, seed: r.seed, commit: r.commit, season: r.seasonName,
      wager: r.wagerCents / 100, status: r.status, crashAt: r.crashAt, capped: r.capped,
      mult: r.cashedAt, payout: r.payoutCents / 100, edge: r.edge, bust: r.bust, maxMultiplier: r.maxMultiplier,
    });
    const nudges = [];
    if (s.roundsPlayed % game.nudges.realityCheckEveryRounds === 0) {
      nudges.push({ code: 'realityCheck', rounds: s.roundsPlayed, net: s.netCents / 100 });
    }
    if (s.lossStreak >= game.nudges.lossStreak) nudges.push({ code: 'lossStreak', streak: s.lossStreak });
    nudges.push(...watch(s, r));
    nudges.push(...screen(s));
    r.nudges = nudges; // kept on the round so every reply and event for it carries the same nudges
    return nudges;
  }

  // The Sentinel agent reads every settled round. A rise to watch/review raises an alert with its reasoning;
  // by default a human decides, and `sentinel.onReview: "coolOff"` also pauses betting.
  // The live feed behind the "Sentinel live" drawer (demo view of this session's own analysis).
  function trace(s, kind, text, extra = {}) {
    const e = { t: now(), kind, text, ...extra };
    (s.trace ??= []).push(e);
    if (s.trace.length > 80) s.trace.shift();
    emit(s, 'agent', e);
  }

  function watch(s, r) {
    const v = sentinel.observe(s.id, r);
    const view = { level: v.level, z: v.z, zRaw: v.zRaw, n: v.n, wins: v.wins, expected: v.expected, sd: v.sd, rounds: v.rounds, meanReturn: v.meanReturn, need: v.need };
    trace(s, 'round', v.round
      ? `Round ${v.rounds}: target ${r.autoCashOut}x had a ${(v.round.p * 100).toFixed(1)}% chance and ${v.round.win ? 'was reached' : 'was not reached'}. Running: ${v.wins} wins vs ${v.expected.toFixed(1)} expected${v.n < v.need ? ` (collecting evidence, ${v.n}/${v.need} rounds)` : ` (z ${v.z.toFixed(1)})`}.`
      : `Round ${v.rounds}: manual cash-out or no target, so the win test skips it. Return so far ${(v.meanReturn * 100).toFixed(0)}% (fair is ${Math.round((1 - game.houseEdge) * 100)}%).`, { v: view });
    if (!v.changed) return [];
    trace(s, v.level === 'review' ? 'alert' : 'warn', `${v.level.toUpperCase()}: ${v.summary}`, { v: view });
    const p = s.profile;
    alerts.push({ t: now(), session: s.id.slice(0, 8), client: p.client, kind: 'fraud', code: 'sentinel', sev: v.level === 'review' ? 3 : 2, detail: v.summary });
    if (alerts.length > 500) alerts.shift();
    if (v.level !== 'review' || game.sentinel?.onReview !== 'coolOff') return [];
    trace(s, 'action', 'Betting paused for a cool-off while a human reviews this player.');
    p.coolUntil = now() + game.protection.coolOffMs;
    return [{ code: 'coolOff', seconds: Math.round(game.protection.coolOffMs / 1000) }];
  }

  // Re-scores the player after each round: raises monitor alerts once per flag, and starts a short cool-off when risk is high.
  function screen(s) {
    const p = s.profile;
    const { risk, fraud } = assess(p, now());
    for (const [kind, flags] of [['player', risk.flags], ['fraud', fraud.flags]]) {
      for (const f of flags) {
        if (p.raised.has(f.code)) continue;
        p.raised.add(f.code);
        alerts.push({ t: now(), session: s.id.slice(0, 8), client: p.client, kind, ...f });
        trace(s, kind === 'fraud' ? 'alert' : 'warn', `${kind === 'fraud' ? 'Fraud signal' : 'Player-protection flag'} "${f.code}": ${f.detail}.`);
        if (alerts.length > 500) alerts.shift();
      }
    }
    if (risk.level !== 'high' || now() - p.lastCool < game.protection.coolOffGapMs) return [];
    p.lastCool = now();
    p.coolUntil = now() + game.protection.coolOffMs;
    trace(s, 'action', `High risk: betting paused for ${Math.round(game.protection.coolOffMs / 1000)} s to give the player a break.`);
    return [{ code: 'coolOff', seconds: Math.round(game.protection.coolOffMs / 1000) }];
  }

  // Resolves time-based outcomes, then finalizes and broadcasts if the round ended.
  function sync(s) {
    if (s.round) resolve(s.round, now());
    const nudges = finalize(s);
    if (nudges) emit(s, 'settled', { ...view(s), nudges });
    return nudges ?? [];
  }

  // ---------- actions ----------
  const idemKey = (k) => {
    if (typeof k !== 'string' || !/^[\w-]{8,64}$/.test(k)) throw new GameError('bad_key');
    return k;
  };

  const remember = (s, key, value) => {
    s.idem.set(key, value);
    if (s.idem.size > MAX_IDEMPOTENCY_KEYS) s.idem.delete(s.idem.keys().next().value);
    return value;
  };

  function toCents(v) {
    const n = Number(v);
    const c = Math.round(n * 100);
    if (v === null || v === '' || !Number.isFinite(n) || Math.abs(n * 100 - c) > 1e-6) throw new GameError('bad_amount');
    if (c < game.minBet * 100 || c > game.maxBet * 100) throw new GameError('bad_amount');
    return c;
  }

  function bet(s, b) {
    const key = `bet:${idemKey(b.idempotencyKey)}`;
    if (s.idem.has(key)) return s.idem.get(key);
    sync(s);
    if (s.round?.status === 'FLYING') throw new GameError('round_in_progress', 409);

    const wagerCents = toCents(b.amount);
    if (now() < s.profile.coolUntil) { trace(s, 'action', 'Bet refused: cool-off is active.'); throw new GameError('cooling_off', 429); }
    if (wagerCents > remaining(s.profile)) { trace(s, 'action', 'Bet refused: wager is above the remaining loss limit.'); throw new GameError('limit_reached', 403); }
    const f = advanceSeason(s);
    const season = seasons[f.current];
    let autoCashOut = null;
    if (b.autoCashOut != null && b.autoCashOut !== '') {
      autoCashOut = Math.round(Number(b.autoCashOut) * 100) / 100;
      if (!(autoCashOut >= 1.01 && autoCashOut <= season.maxMultiplier)) throw new GameError('bad_auto');
    }

    const nudges = [];
    if (s.lastLost && wagerCents > s.lastWagerCents * game.nudges.escalationFactor) nudges.push({ code: 'escalation' });
    s.wallet.debit(wagerCents);
    recordBet(s.profile, { t: now(), wagerCents, auto: autoCashOut });
    s.lastWagerCents = wagerCents;
    s.round = startRound({
      id: newId(), seed: newSeed(), seasonName: f.current, season,
      edge: game.houseEdge, wagerCents, autoCashOut, now: now(),
    });
    return remember(s, key, { ...view(s), nudges });
  }

  function cashout(s, b) {
    const key = `cashout:${idemKey(b.idempotencyKey)}`;
    if (s.idem.has(key)) return s.idem.get(key);
    if (!s.round || s.round.id !== b.roundId) throw new GameError('no_round', 404);
    if (s.round.status === 'FLYING') s.round.manualAt = now();
    cashOut(s.round, now());
    const fresh = finalize(s);
    if (fresh) emit(s, 'settled', { ...view(s), nudges: fresh });
    return remember(s, key, { ...view(s), nudges: s.round.nudges ?? [] });
  }

  // Lowering the limit always works. Raising it is refused once the limit is hit or risk is high.
  function setLimit(s, v) {
    const c = Math.round(Number(v) * 100);
    const p = s.profile;
    if (v === null || v === '' || !Number.isFinite(c) || c < game.minBet * 100 || c > p.bankrollCents) throw new GameError('bad_limit');
    if (c > p.limitCents && (remaining(p) === 0 || assess(p, now()).risk.level === 'high')) throw new GameError('limit_locked', 403);
    p.limitCents = c;
    return protection(s);
  }

  // Location is opt-in: the browser asks the player first, and updates arrive at most every 5 seconds.
  function setLocation(s, b) {
    const lat = Number(b.lat);
    const lon = Number(b.lon);
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || b.lat == null || b.lon == null) throw new GameError('bad_location');
    const last = s.profile.places.at(-1);
    if (last && now() - last.t < 5000) throw new GameError('too_fast', 429);
    recordLocation(s.profile, { t: now(), lat, lon });
    trace(s, 'info', 'Location update received (kept rounded to about 1 km). Checking for impossible travel.');
    screen(s); // re-score right away so a jump raises its alert in real time
    return { locationShared: true };
  }

  function monitor() {
    const t = now();
    const rows = [...sessions.values()].map((s) => {
      const a = assess(s.profile, t);
      const p = s.profile;
      return {
        session: s.id.slice(0, 8), client: p.client, ageMin: Math.round((t - p.born) / 60_000), rounds: p.rounds,
        wagered: p.wageredCents / 100, net: p.netCents / 100, balance: s.wallet.cents / 100,
        lossLimit: p.limitCents / 100, lossUsed: lossUsed(p) / 100, coolMs: Math.max(0, p.coolUntil - t), sentinel: sentinel.verdict(s.id), account: p.account, location: p.places.length ? { ...p.places.at(-1), ageSec: Math.round((t - p.places.at(-1).t) / 1000) } : null, ...a,
      };
    }).sort((x, y) => Math.max(y.fraud.score, y.risk.score) - Math.max(x.fraud.score, x.risk.score));
    return { sessions: rows, alerts: alerts.slice(-100).reverse(), logins: auth.events() };
  }

  function verify(s, roundId) {
    const h = s.history.find((x) => x.id === roundId);
    if (!h) throw new GameError('no_round', 404); // only settled rounds are revealed
    return {
      roundId: h.id, serverSeed: h.seed, commit: h.commit, crashAt: h.crashAt, capped: h.capped,
      edge: h.edge, bust: h.bust, maxMultiplier: h.maxMultiplier, season: h.season,
    };
  }

  // ---------- http ----------
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 10_000) throw new GameError('too_large', 413);
      chunks.push(c);
    }
    return size ? JSON.parse(Buffer.concat(chunks)) : {};
  }

  async function serveStatic(pathname, res) {
    let file;
    try {
      file = path.resolve(CLIENT_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''));
    } catch {
      throw new GameError('not_found', 404);
    }
    if (!file.startsWith(CLIENT_DIR)) throw new GameError('not_found', 404);
    let data;
    try {
      data = await readFile(file);
    } catch {
      throw new GameError('not_found', 404);
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (!p.startsWith('/api/')) return serveStatic(p, res);

    const q = (name) => url.searchParams.get(name);
    if (req.method === 'GET' && p === '/api/config') return json(res, 200, publicConfig);
    const clientId = () => createHash('sha256').update(req.socket.remoteAddress ?? '').digest('hex').slice(0, 10);
    if (req.method === 'POST' && p === '/api/session') {
      const b = await readBody(req);
      const account = auth.who(b.token);
      if (game.auth?.required && !account) throw new GameError('login_required', 401);
      return json(res, 200, view(newSession(clientId(), account)));
    }
    if (req.method === 'POST' && (p === '/api/register' || p === '/api/login')) {
      const b = await readBody(req);
      return json(res, 200, (p === '/api/register' ? auth.register : auth.login)(b.username, b.password, clientId()));
    }
    if (req.method === 'POST' && p === '/api/logout') {
      auth.logout((await readBody(req)).token);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/agent') {
      if (!game.demo?.agentView) throw new GameError('forbidden', 403);
      const s = getSession(q('sessionId'));
      return json(res, 200, { events: s.trace ?? [], verdict: sentinel.verdict(s.id), simulating: !!s.sim });
    }
    if (req.method === 'POST' && p === '/api/agent/demo') {
      if (!game.demo?.agentView) throw new GameError('forbidden', 403);
      const b = await readBody(req);
      const s = getSession(b.sessionId);
      s.sim?.stop();
      if (b.action === 'stop') return json(res, 200, { simulating: false });
      s.sim = startSimulation({
        edge: game.houseEdge, season: seasons[s.season.current], sentinel: game.sentinel,
        emit: (kind, text, extra) => trace(s, kind, text, extra), onDone: () => { s.sim = null; },
      });
      return json(res, 200, { simulating: true });
    }
    if (req.method === 'POST' && p === '/api/location') {
      const b = await readBody(req);
      return json(res, 200, setLocation(getSession(b.sessionId), b));
    }
    if (req.method === 'DELETE' && p === '/api/location') {
      const s = getSession(q('sessionId'));
      s.profile.places = []; s.profile.travel = null; // the player withdrew consent: forget everything
      return json(res, 200, { locationShared: false });
    }
    if (req.method === 'GET' && p === '/api/monitor') {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const ok = monitorToken ? req.headers['x-monitor-token'] === monitorToken : local; // no token configured: this machine only
      if (!ok) throw new GameError('forbidden', 403);
      return json(res, 200, monitor());
    }
    if (req.method === 'POST' && p === '/api/limits') {
      const b = await readBody(req);
      return json(res, 200, setLimit(getSession(b.sessionId), b.lossLimit));
    }
    if (req.method === 'GET' && p === '/api/state') {
      const s = getSession(q('sessionId'));
      sync(s);
      return json(res, 200, view(s));
    }
    if (req.method === 'POST' && p === '/api/bet') {
      const b = await readBody(req);
      return json(res, 200, bet(getSession(b.sessionId), b));
    }
    if (req.method === 'POST' && p === '/api/cashout') {
      const b = await readBody(req);
      return json(res, 200, cashout(getSession(b.sessionId), b));
    }
    if (req.method === 'GET' && p === '/api/history') {
      const s = getSession(q('sessionId'));
      return json(res, 200, { history: s.history.map(({ seed, ...h }) => h) });
    }
    const m = p.match(/^\/api\/verify\/([\w-]+)$/);
    if (req.method === 'GET' && m) return json(res, 200, verify(getSession(q('sessionId')), m[1]));
    if (req.method === 'GET' && p === '/api/stream') {
      const s = getSession(q('sessionId'));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(view(s))}\n\n`);
      s.streams.add(res);
      req.on('close', () => s.streams.delete(res));
      return undefined;
    }
    throw new GameError('not_found', 404);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:");
    try {
      await route(req, res);
    } catch (e) {
      const err = e instanceof GameError ? e : e instanceof SyntaxError ? new GameError('bad_json') : null;
      if (!err) console.error(e);
      if (!res.headersSent) json(res, err?.status ?? 500, { error: err?.code ?? 'internal' });
    }
  });

  // Live multiplier ticks. The crash point itself never leaves the server before settlement.
  const ticker = setInterval(() => {
    const t = now();
    for (const s of sessions.values()) {
      const r = s.round;
      if (r?.status !== 'FLYING') continue;
      sync(s);
      if (r.status === 'FLYING') emit(s, 'tick', { id: r.id, mult: floor2(multAt(r, (t - r.startedAt) / 1000)) });
    }
  }, game.tickMs);

  const janitor = setInterval(() => {
    const t = now();
    for (const [id, s] of sessions) {
      if (t - s.seen > game.sessionTtlMs) {
        for (const res of s.streams) res.end();
        sentinel.forget(id);
        s.sim?.stop();
        sessions.delete(id);
      } else {
        for (const res of s.streams) res.write(': hb\n\n');
        s.seen = s.streams.size ? t : s.seen;
      }
    }
  }, 15_000);

  ticker.unref();
  janitor.unref();
  server.on('close', () => {
    clearInterval(ticker);
    clearInterval(janitor);
  });
  server.sessions = sessions; // exposed for tests
  return server;
}
