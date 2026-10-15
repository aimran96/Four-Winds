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

export const token = () => { try { return sessionStorage.getItem('fw-token'); } catch { return null; } };
const keep = (r) => { try { sessionStorage.setItem('fw-token', r.token); sessionStorage.removeItem('fw-sid'); } catch { /* ignore */ } return r; };
export const signIn = async (mode, username, password) => keep(await call('POST', `/api/${mode}`, { username, password }));
export async function signOut() {
  await call('POST', '/api/logout', { token: token() }).catch(() => {});
  try { sessionStorage.removeItem('fw-token'); sessionStorage.removeItem('fw-sid'); } catch { /* ignore */ }
}
export const sendLocation = (lat, lon) => call('POST', '/api/location', { lat, lon });
export const clearLocation = () => call('DELETE', `/api/location?sessionId=${sid}`);

export async function session() {
  if (sid) {
    try { return await call('GET', `/api/state?sessionId=${sid}`); } catch (e) { if (e.status !== 404) throw e; }
  }
  const s = await call('POST', '/api/session', { token: token() });
  sid = s.sessionId;
  try { sessionStorage.setItem('fw-sid', sid); } catch { /* ignore */ }
  return s;
}

export const bet = (b) => call('POST', '/api/bet', { ...b, idempotencyKey: uid() });
export const cashout = (roundId) => call('POST', '/api/cashout', { roundId, idempotencyKey: uid() });
export const setLimit = (lossLimit) => call('POST', '/api/limits', { lossLimit });
export const agentSnapshot = () => call('GET', `/api/agent?sessionId=${sid}`);
export const agentDemo = (action) => call('POST', '/api/agent/demo', { action });
export const verify = (roundId) => call('GET', `/api/verify/${roundId}?sessionId=${sid}`);
export const stream = () => new EventSource(`/api/stream?sessionId=${sid}`);
