// Re-derives a settled round in the browser: SHA-256(seed) must equal the commitment shown
// before the flight, and HMAC-SHA256(seed, roundId) must reproduce the crash point.
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function verifyRound(v, commitShownBeforeFlight) {
  const { subtle } = globalThis.crypto ?? {};
  if (!subtle) throw new Error('no_crypto');
  const sha = hex(await subtle.digest('SHA-256', enc.encode(v.serverSeed)));
  const key = await subtle.importKey('raw', enc.encode(v.serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await subtle.sign('HMAC', key, enc.encode(v.roundId)));
  const u = parseInt(mac.slice(0, 13), 16) / 2 ** 52;
  const bust = v.bust ?? 0;
  const raw = ((1 - v.edge) / (1 - bust)) / (1 - (u - bust) / (1 - bust));
  const crashAt = u < bust ? 1 : raw >= v.maxMultiplier ? v.maxMultiplier : Math.max(1, Math.floor(raw * 100) / 100);
  return { ok: sha === commitShownBeforeFlight && sha === v.commit && crashAt === v.crashAt, crashAt };
}
