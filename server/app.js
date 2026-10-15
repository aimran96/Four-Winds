import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { game as defaultGame, seasons as defaultSeasons } from './config.js';
import { GameError } from './errors.js';
import { newSeed as defaultSeed } from './engine/rng.js';
import { startRound, resolve, cashOut, multAt, floor2 } from './engine/round.js';
import { Wallet } from './engine/wallet.js';

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
} = {}) {
  const sessions = new Map();
  const names = Object.keys(seasons);

  const publicConfig = {
    minBet: game.minBet, maxBet: game.maxBet, quickBets: game.quickBets, houseEdge: game.houseEdge,
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
    };
  };

  // ---------- sessions ----------
  function newSession() {
    if (sessions.size >= MAX_SESSIONS) throw new GameError('busy', 503);
    const s = {
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
    r.nudges = nudges; // kept on the round so every reply and event for it carries the same nudges
    return nudges;
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
    cashOut(s.round, now());
    const fresh = finalize(s);
    if (fresh) emit(s, 'settled', { ...view(s), nudges: fresh });
    return remember(s, key, { ...view(s), nudges: s.round.nudges ?? [] });
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
    if (req.method === 'POST' && p === '/api/session') return json(res, 200, view(newSession()));
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
