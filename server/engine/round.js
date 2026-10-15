import { commitment, crashPoint, uniform } from './rng.js';

// Round state machine: FLYING -> CASHED | CRASHED | LANDED (IDLE is "no round").
// The multiplier is a pure function of elapsed time: m(t) = e^(growthRate * t).
export const floor2 = (x) => Math.floor(x * 100) / 100;
export const multAt = (r, sec) => Math.exp(r.growthRate * sec);
const timeAt = (r, mult) => (Math.log(mult) / r.growthRate) * 1000;

export function startRound({ id, seed, seasonName, season, edge, wagerCents, autoCashOut, now }) {
  const { crashAt, capped } = crashPoint(uniform(seed, id), edge, season.maxMultiplier, season.bustChance ?? 0);
  return {
    id, seed, commit: commitment(seed), seasonName, edge, bust: season.bustChance ?? 0,
    growthRate: season.growthRate, maxMultiplier: season.maxMultiplier,
    wagerCents, autoCashOut, crashAt, capped,
    startedAt: now, status: 'FLYING', cashedAt: null, payoutCents: 0,
  };
}

function settle(r, status, mult) {
  r.status = status;
  r.cashedAt = mult;
  r.payoutCents = mult ? Math.floor((r.wagerCents * Math.round(mult * 100)) / 100) : 0;
  return r;
}

// Applies whatever has happened by `now` (auto cash-out, crash or landing). Idempotent.
export function resolve(r, now) {
  if (r.status !== 'FLYING') return r;
  const elapsed = now - r.startedAt;
  const auto = r.autoCashOut;
  const autoHits = auto && (auto < r.crashAt || (r.capped && auto <= r.crashAt));
  if (autoHits && elapsed >= timeAt(r, auto)) return settle(r, 'CASHED', auto);
  if (elapsed >= timeAt(r, r.crashAt)) return r.capped ? settle(r, 'LANDED', r.crashAt) : settle(r, 'CRASHED', null);
  return r;
}

export function cashOut(r, now) {
  resolve(r, now);
  if (r.status !== 'FLYING') return r;
  return settle(r, 'CASHED', Math.max(1, floor2(multAt(r, (now - r.startedAt) / 1000))));
}
