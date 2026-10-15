const $ = (id) => document.getElementById(id);
const pill = (level) => `<span class="pill ${level}">${level}</span>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const flags = (f) => f.flags.map((x) => `${esc(x.code)} (${esc(x.detail)})`).join('<br>') || '-';
const table = (el, head, rows) => { el.innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}`; };

async function load() {
  const token = $('token').value;
  try {
    const res = await fetch('/api/monitor', { headers: token ? { 'x-monitor-token': token } : {} });
    if (!res.ok) throw new Error(res.status === 403 ? 'Access denied: enter the monitor token.' : `Error ${res.status}`);
    const d = await res.json();
    $('msg').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    table($('sessions'), ['Session', 'Account', 'Location', 'Client', 'Min', 'Rounds', 'Wagered', 'Net', 'Loss used / limit', 'Player risk', 'Fraud', 'Sentinel'],
      d.sessions.map((s) => [esc(s.session), esc(s.account ?? 'guest'), s.location ? `${s.location.lat}, ${s.location.lon} (${s.location.ageSec}s ago)` : 'not shared', esc(s.client), s.ageMin, s.rounds, s.wagered.toFixed(2), s.net.toFixed(2),
        `${s.lossUsed.toFixed(2)} / ${s.lossLimit.toFixed(2)}${s.coolMs ? ' (cooling off)' : ''}`,
        `${pill(s.risk.level)} ${s.risk.score}<br>${flags(s.risk)}`, `${pill(s.fraud.level)} ${s.fraud.score}<br>${flags(s.fraud)}`,
        s.sentinel ? `${pill(s.sentinel.level === 'review' ? 'review' : s.sentinel.level === 'watch' ? 'watch' : 'clear')} z ${Math.max(s.sentinel.zWin, s.sentinel.zRet).toFixed(1)}<br>${esc(s.sentinel.summary)}` : '-']));
    table($('alerts'), ['Time', 'Session', 'Kind', 'Severity', 'Signal'],
      d.alerts.map((a) => [new Date(a.t).toLocaleTimeString(), esc(a.session), esc(a.kind), a.sev, `${esc(a.code)}: ${esc(a.detail)}`]));
    table($('logins'), ['Time', 'Username', 'Result', 'Client'],
      d.logins.map((l) => [new Date(l.t).toLocaleTimeString(), esc(l.username), l.ok ? esc(l.reason) : `<span class="pill review">${esc(l.reason)}</span>`, esc(l.client)]));
  } catch (e) { $('msg').textContent = e.message; }
}
load();
setInterval(load, 3000);
