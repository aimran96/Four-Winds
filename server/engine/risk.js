// Behaviour profile for one player. It feeds two separate outputs:
//   - player protection (risk): loss budget, cool-off, plain-language flags the player may see
//   - fraud review (fraud): bot / abuse signals shown only to monitors, never to the player
// Everything is in-memory, per session. The only personal data is the account name and, if the player opts in, a position rounded to about 1 km.
const WINDOW = 40;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const cv = (a) => { const m = mean(a); return m ? Math.sqrt(mean(a.map((x) => (x - m) ** 2))) / m : 0; };

export function newProfile({ bankrollCents, limitCents, now, client }) {
  return { born: now, client, bankrollCents, limitCents, netCents: 0, wageredCents: 0, rounds: 0, bets: [], peers: 0, account: null, sharedAccount: false, places: [], travel: null, coolUntil: 0, lastCool: -Infinity, raised: new Set() };
}

export const lossUsed = (p) => Math.max(0, -p.netCents);
export const remaining = (p) => Math.max(0, p.limitCents - lossUsed(p));

export function recordBet(p, { t, wagerCents, auto }) {
  p.bets.push({ t, w: wagerCents, auto, lost: null, cashMs: null });
  if (p.bets.length > WINDOW) p.bets.shift();
  p.wageredCents += wagerCents;
}

export function recordResult(p, { payoutCents, wagerCents, cashMs, manual }) {
  const b = p.bets.at(-1);
  if (b) { b.lost = payoutCents < wagerCents; b.cashMs = manual ? cashMs : null; }
  p.netCents += payoutCents - wagerCents;
  p.rounds += 1;
}

const km = (a, b) => { // great-circle distance
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

// Positions are rounded to 2 decimals (about 1 km) before they are kept, so the profile never holds an exact address.
// A hop of more than 50 km faster than 900 km/h is impossible for a person on a real device, so it is flagged.
export function recordLocation(p, { t, lat, lon }) {
  const here = { t, lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
  const prev = p.places.at(-1);
  if (prev && t > prev.t) {
    const d = km(prev, here);
    const kmh = d / ((t - prev.t) / 3_600_000);
    if (d > 50 && kmh > 900) p.travel = { km: Math.round(d), kmh: Math.round(kmh), t };
  }
  p.places.push(here);
  if (p.places.length > 20) p.places.shift();
  return here;
}

// Flags are {code, sev 1-3, detail}. `detail` is for monitors; the player only sees the code.
export function assess(p, now) {
  const b = p.bets;
  const player = [];
  const fraud = [];
  const used = lossUsed(p) / p.limitCents;
  if (used >= 0.8) player.push({ code: 'nearLimit', sev: 3, detail: `${Math.round(used * 100)}% of loss limit used` });
  else if (used >= 0.5) player.push({ code: 'halfLimit', sev: 2, detail: `${Math.round(used * 100)}% of loss limit used` });

  const last10 = b.slice(-10);
  const chases = last10.filter((x, i) => i && last10[i - 1].lost && x.w > last10[i - 1].w * 1.5).length;
  if (chases >= 2) player.push({ code: 'chasing', sev: chases >= 3 ? 3 : 2, detail: `${chases} raised bets right after a loss in the last 10` });

  const perMin = b.filter((x) => now - x.t <= 60_000).length;
  if (perMin >= 8) player.push({ code: 'fastPlay', sev: 2, detail: `${perMin} bets in the last minute` });
  if (perMin >= 12) fraud.push({ code: 'velocity', sev: 2, detail: `${perMin} bets in the last minute` });
  if (now - p.born > 45 * 60_000) player.push({ code: 'longSession', sev: 1, detail: `${Math.round((now - p.born) / 60_000)} min session` });
  if (b.length && b.at(-1).w > p.bankrollCents / 4) player.push({ code: 'bigBets', sev: 1, detail: 'last wager above 25% of starting bankroll' });

  const gaps = b.slice(-13).map((x, i, a) => (i ? x.t - a[i - 1].t : null)).slice(1);
  if (gaps.length >= 12 && cv(gaps) < 0.08) fraud.push({ code: 'botTiming', sev: 3, detail: `bet spacing varies only ${(cv(gaps) * 100).toFixed(1)}% over ${gaps.length} bets` });
  const fast = b.filter((x) => x.cashMs != null && x.cashMs < 250).length;
  if (fast >= 4) fraud.push({ code: 'superhumanReaction', sev: 3, detail: `${fast} manual cash-outs within 250 ms of take-off` });
  const run = b.slice(-15);
  if (run.length >= 15 && run.every((x) => x.w === run[0].w && x.auto === run[0].auto)) fraud.push({ code: 'scripted', sev: 2, detail: '15 bets with identical wager and auto cash-out' });
  if (p.peers >= 3) fraud.push({ code: 'multiSession', sev: 2, detail: `${p.peers + 1} live sessions from one client` });

  if (p.sharedAccount) fraud.push({ code: 'sharedAccount', sev: 2, detail: `account ${p.account} is live from more than one client` });
  if (p.travel) fraud.push({ code: 'impossibleTravel', sev: 3, detail: `moved ${p.travel.km} km at ${p.travel.kmh} km/h between two location updates` });

  const score = (fl) => Math.min(100, fl.reduce((s, f) => s + f.sev * 20, 0));
  const rs = score(player);
  const fs = score(fraud);
  return {
    risk: { score: rs, level: rs >= 60 ? 'high' : rs >= 30 ? 'elevated' : 'low', flags: player },
    fraud: { score: fs, level: fs >= 60 ? 'review' : fs >= 30 ? 'watch' : 'clear', flags: fraud },
  };
}
