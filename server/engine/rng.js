import { createHash, createHmac, randomBytes } from 'node:crypto';

export const newSeed = () => randomBytes(32).toString('hex');

export const commitment = (seed) => createHash('sha256').update(seed).digest('hex');

// Uniform in [0, 1) from the first 52 bits of HMAC-SHA256(seed, roundId).
export function uniform(seed, roundId) {
  const mac = createHmac('sha256', seed).update(roundId).digest('hex');
  return parseInt(mac.slice(0, 13), 16) / 2 ** 52;
}

// P(crash > x) = (1 - edge) / x for 1 < x < max, so RTP is (1 - edge) for every cash-out target.
// A draw at or above `max` is a "landing": the bird reaches its destination and pays `max`.
// `bust` is the chance of an instant 1.00x crash. Survivors' curve is lifted by 1/(1 - bust), so
// RTP stays (1 - edge) while the season gets riskier: more busts, bigger wins when it survives.
export function crashPoint(u, edge, max, bust = 0) {
  if (u < bust) return { crashAt: 1, capped: false };
  const raw = ((1 - edge) / (1 - bust)) / (1 - (u - bust) / (1 - bust));
  if (raw >= max) return { crashAt: max, capped: true };
  return { crashAt: Math.max(1, Math.floor(raw * 100) / 100), capped: false };
}
