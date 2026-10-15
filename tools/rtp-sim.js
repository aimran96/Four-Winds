// Simulates rounds per season with the real RNG and prints RTP for fixed cash-out targets.
// Usage: npm run sim [-- rounds]   (default 200000 per season)
import { game, seasons } from '../server/config.js';
import { crashPoint, newSeed, uniform } from '../server/engine/rng.js';

const rounds = Number(process.argv[2]) || 200_000;
const targets = [1.5, 2, 5, 10, 'max'];
const pct = (x) => `${(x * 100).toFixed(2)}%`;

console.log(`Rounds per season: ${rounds}, house edge ${pct(game.houseEdge)}, expected RTP ~${pct(1 - game.houseEdge)}\n`);
console.log(['season'.padEnd(8), 'max'.padStart(6), ...targets.map((x) => `x${x}`.padStart(9)), 'stdev(max)'.padStart(11)].join(' '));

for (const [name, season] of Object.entries(seasons)) {
  const paid = Object.fromEntries(targets.map((x) => [x, 0]));
  let sumSq = 0;
  for (let i = 0; i < rounds; i++) {
    const { crashAt, capped } = crashPoint(uniform(newSeed(), `sim-${i}`), game.houseEdge, season.maxMultiplier, season.bustChance);
    for (const x of targets) {
      const target = x === 'max' ? season.maxMultiplier : x;
      if (target > season.maxMultiplier) continue;
      if (capped || target < crashAt) paid[x] += target;
    }
    if (capped) sumSq += season.maxMultiplier ** 2;
  }
  const cells = targets.map((x) => ((x !== 'max' && x > season.maxMultiplier) ? '-' : pct(paid[x] / rounds)).padStart(9));
  const mean = paid.max / rounds;
  const sd = Math.sqrt(sumSq / rounds - mean ** 2);
  console.log([name.padEnd(8), String(season.maxMultiplier).padStart(6), ...cells, sd.toFixed(1).padStart(11)].join(' '));
}
