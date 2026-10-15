import { readFileSync } from 'node:fs';

const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));

export const game = load('./config/game.json');
export const seasons = load('./config/seasons.json');

for (const [name, s] of Object.entries(seasons)) {
  if (!(s.maxMultiplier > 1 && s.growthRate > 0)) throw new Error(`seasons.json: bad season "${name}"`);
}
