// Demo only: replays a synthetic cheater through a fresh Sentinel so judges can watch it catch one live.
// The simulated player targets 2x every round but secretly knows the outcome `boost` of the time.
import { crashPoint } from '../engine/rng.js';
import { createSentinel } from './sentinel.js';

const prng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

// emit(kind, text, extra) receives the feed entries. Returns { stop }.
export function startSimulation({ edge, season, sentinel: opts, emit, seed = 11, boost = 0.4, auto = 2, rounds = 200, step = 10, delay = 700, onDone = () => {} }) {
  const rnd = prng(seed);
  const sentinel = createSentinel({ edge, ...opts });
  let done = 0;
  emit('sim', `Simulation started: a player always cashes out at ${auto}x but secretly knows the outcome ${Math.round(boost * 100)}% of the time.`);
  const timer = setInterval(() => {
    let v;
    let wins = 0;
    for (let i = 0; i < step && done < rounds; i++, done++) {
      const c = crashPoint(rnd(), edge, season.maxMultiplier, season.bustChance ?? 0);
      const win = auto < c.crashAt || (c.capped && auto <= c.crashAt) || rnd() < boost;
      if (win) wins++;
      v = sentinel.observe('sim', { wagerCents: 1000, payoutCents: win ? Math.floor(1000 * auto) : 0, autoCashOut: auto, status: win ? 'CASHED' : 'CRASHED', cashedAt: win ? auto : null, maxMultiplier: season.maxMultiplier, bust: season.bustChance ?? 0 });
      if (v.changed) {
        emit(v.level === 'review' ? 'alert' : 'warn', `${v.level.toUpperCase()}: ${v.summary}`, { v, sim: true });
        if (v.level === 'review') { emit('action', 'Monitors alerted with this evidence. In live mode this player could also be paused (cool-off) pending human review.', { sim: true }); clearInterval(timer); onDone(); return; }
      }
    }
    if (v) emit('round', `Rounds ${done - step + 1}-${done}: won ${wins} of ${step}. Running total ${v.wins} wins vs ${v.expected.toFixed(1)} expected (z ${(v.n < v.need ? v.zRaw : v.z).toFixed(1)}${v.n < v.need ? ', provisional' : ''}).`, { v: { ...v, round: undefined }, sim: true });
    if (done >= rounds) { clearInterval(timer); emit('info', 'Simulation finished without a review flag.', { sim: true }); onDone(); }
  }, delay);
  timer.unref?.();
  return { stop: () => { clearInterval(timer); emit('sim', 'Simulation stopped.'); onDone(); } };
}
