// Sentinel: an in-process agent that watches every settled round and tests whether a player wins more often
// than the odds allow. Crash points come from a hidden server seed, so no strategy can beat the house on average;
// a significant excess means leaked information, an exploit or collusion, and is flagged for a human to review.
//
// Two tests, both one-sided z-scores:
//   wins   : for rounds with a fixed auto cash-out, wins vs the sum of the exact win probabilities
//   return : mean payout/wager vs the fair return (1 - edge)
// shortcut: z uses the normal approximation and peeks after every round, so thresholds (z>=4, 100+ rounds) are
// deliberately strict; move to a sequential test (SPRT/CUSUM) if you need earlier detection with a known error rate.

// Chance that an auto cash-out at `auto` survives. Win needs crashAt > auto (crash points are floored to 0.01),
// and a non-bust round is the best any target can do, hence the min with 1 - bust.
export const winProb = (auto, edge, max, bust = 0) => Math.min(1 - bust, auto >= max ? (1 - edge) / max : (1 - edge) / (auto + 0.01));

// Upper-tail probability of a standard normal (Abramowitz & Stegun 7.1.26).
const tail = (z) => {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
};
const RANK = { clear: 0, watch: 1, review: 2 };

export function createSentinel({ edge, minRounds = 100, watchZ = 3, reviewZ = 4 }) {
  const state = new Map();

  function verdictOf(s) {
    const zWin = s.n >= minRounds && s.sv > 0 ? (s.wins - s.sp) / Math.sqrt(s.sv) : 0;
    let zRet = 0;
    if (s.m >= minRounds) {
      const mean = s.sr / s.m;
      const variance = (s.sr2 - s.m * mean * mean) / (s.m - 1);
      if (variance > 0) zRet = (mean - (1 - edge)) / Math.sqrt(variance / s.m);
    }
    // The return test has heavy tails (rare huge payouts), so it needs a stronger signal to reach "review".
    const level = zWin >= reviewZ || zRet >= reviewZ + 1 ? 'review' : Math.max(zWin, zRet) >= watchZ ? 'watch' : 'clear';
    const useWin = zWin >= zRet;
    const z = useWin ? zWin : zRet;
    const summary = level === 'clear'
      ? `No excess wins (${s.n} fixed-target rounds, ${s.m} rounds in total).`
      : useWin
        ? `Won ${s.wins} of ${s.n} fixed-target rounds; the odds predict ${s.sp.toFixed(1)} ± ${Math.sqrt(s.sv).toFixed(1)} (z = ${z.toFixed(1)}, chance by luck about ${tail(z).toExponential(1)}).`
        : `Returned ${((s.sr / s.m) * 100).toFixed(0)}% of wagers over ${s.m} rounds; fair play returns about ${Math.round((1 - edge) * 100)}% (z = ${z.toFixed(1)}).`;
    // zRaw ignores the minimum-rounds gate: it is only for showing the evidence building up, never for deciding.
    const zRaw = s.sv > 0 ? (s.wins - s.sp) / Math.sqrt(s.sv) : 0;
    return { level, zWin, zRet, z, zRaw, n: s.n, wins: s.wins, expected: s.sp, sd: Math.sqrt(s.sv), rounds: s.m, meanReturn: s.m ? s.sr / s.m : 0, need: minRounds, summary };
  }

  // Feed one settled round. Returns the verdict, plus `changed: true` when the level just went up.
  function observe(key, r) {
    const s = state.get(key) ?? { n: 0, wins: 0, sp: 0, sv: 0, m: 0, sr: 0, sr2: 0, level: 'clear' };
    state.set(key, s);
    const ratio = r.payoutCents / r.wagerCents;
    s.m += 1; s.sr += ratio; s.sr2 += ratio * ratio;
    // A manual cash-out before the target hides the player's real intent, so only untouched auto rounds count as wins/losses.
    const untouched = r.autoCashOut != null && !(r.status === 'CASHED' && r.cashedAt !== r.autoCashOut);
    if (untouched) {
      const p = winProb(r.autoCashOut, edge, r.maxMultiplier, r.bust ?? 0);
      s.n += 1; s.sp += p; s.sv += p * (1 - p);
      if (r.status === 'CASHED') s.wins += 1;
    }
    const v = verdictOf(s);
    const changed = RANK[v.level] > RANK[s.level];
    s.level = v.level;
    // `round` explains this one round: the chance the target had, and whether it was reached (null = not testable).
    return { ...v, changed, round: untouched ? { p: winProb(r.autoCashOut, edge, r.maxMultiplier, r.bust ?? 0), win: r.status === 'CASHED' } : null };
  }

  return { observe, verdict: (key) => (state.has(key) ? verdictOf(state.get(key)) : null), forget: (key) => state.delete(key) };
}
