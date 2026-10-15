// Accounts, login and the login-event log. Passwords are salted with scrypt and compared in constant time.
// shortcut: everything lives in memory, so accounts vanish on restart; persist to a database before real use.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { GameError } from './errors.js';

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const TOKEN_MS = 12 * 3600_000;
const MAX_EVENTS = 200;

export function createAuth({ now = Date.now } = {}) {
  const users = new Map();
  const tokens = new Map();
  const events = []; // newest last

  const log = (e) => { events.push({ t: now(), ...e }); if (events.length > MAX_EVENTS) events.shift(); };
  const hash = (pw, salt) => scryptSync(pw, salt, 32);

  function register(username, password, client) {
    if (typeof username !== 'string' || !/^[a-z0-9_]{3,24}$/.test(username)) throw new GameError('bad_username');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new GameError('bad_password');
    if (users.has(username)) throw new GameError('username_taken', 409);
    const salt = randomBytes(16);
    users.set(username, { salt, hash: hash(password, salt), created: now(), fails: [] });
    log({ username, ok: true, client, reason: 'registered' });
    return issue(username);
  }

  function login(username, password, client) {
    const u = typeof username === 'string' ? users.get(username) : undefined;
    const name = typeof username === 'string' ? username.slice(0, 24) : '?';
    if (u) {
      u.fails = u.fails.filter((t) => now() - t < LOCK_MS);
      if (u.fails.length >= MAX_FAILS) { log({ username: name, ok: false, client, reason: 'locked' }); throw new GameError('account_locked', 429); }
    }
    // Hash even for unknown users so response time does not reveal which usernames exist.
    const salt = u?.salt ?? Buffer.alloc(16);
    const got = hash(typeof password === 'string' ? password : '', salt);
    const ok = u && timingSafeEqual(got, u.hash);
    if (!ok) {
      u?.fails.push(now());
      log({ username: name, ok: false, client, reason: 'bad_credentials' });
      throw new GameError('bad_credentials', 401);
    }
    u.fails = [];
    log({ username, ok: true, client, reason: 'login' });
    return issue(username);
  }

  function issue(username) {
    const token = randomBytes(24).toString('hex');
    tokens.set(token, { username, exp: now() + TOKEN_MS });
    return { token, username };
  }

  // Returns the username for a live token, otherwise null.
  function who(token) {
    const t = typeof token === 'string' ? tokens.get(token) : undefined;
    if (!t) return null;
    if (t.exp < now()) { tokens.delete(token); return null; }
    return t.username;
  }

  return { register, login, who, logout: (token) => tokens.delete(token), events: () => events.slice(-50).reverse() };
}
