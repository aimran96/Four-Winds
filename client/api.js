// Thin wrapper around the server API. The session id lives in sessionStorage so a refresh keeps the balance.
let sid = null;
try { sid = sessionStorage.getItem('fw-sid'); } catch { /* ignore */ }

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify({ sessionId: sid, ...body }) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error), { code: data.error, status: res.status });
  return data;
}

export const uid = () => (crypto.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);

export const config = () => call('GET', '/api/config');

export async function session() {
  if (sid) {
    try { return await call('GET', `/api/state?sessionId=${sid}`); } catch (e) { if (e.status !== 404) throw e; }
  }
  const s = await call('POST', '/api/session', {});
  sid = s.sessionId;
  try { sessionStorage.setItem('fw-sid', sid); } catch { /* ignore */ }
  return s;
}

export const bet = (b) => call('POST', '/api/bet', { ...b, idempotencyKey: uid() });
export const cashout = (roundId) => call('POST', '/api/cashout', { roundId, idempotencyKey: uid() });
export const verify = (roundId) => call('GET', `/api/verify/${roundId}?sessionId=${sid}`);
export const stream = () => new EventSource(`/api/stream?sessionId=${sid}`);
