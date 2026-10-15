// "Sentinel live" drawer: shows what the fraud agent is doing for this session, as it happens (demo view).
import * as api from '../api.js';
import { t } from '../i18n.js';

const $ = (id) => document.getElementById(id);
const ICON = { round: '\u2022', info: '\u2139', warn: '\u26A0', alert: '\uD83D\uDEA8', action: '\u26D4', sim: '\u25B6' };
const MAX_ROWS = 60;
let unseen = false;
let simulating = false;

function open(on) {
  $('agentPanel').classList.toggle('open', on);
  $('agentPanel').setAttribute('aria-hidden', String(!on));
  $('agentTab').setAttribute('aria-expanded', String(on));
  if (on) { unseen = false; $('agentTab').classList.remove('ping'); }
}

function renderStats(v) {
  if (!v) return;
  const need = v.n < v.need;
  const z = need ? v.zRaw : v.z; // provisional until enough rounds have been seen
  $('agentLevel').textContent = t(`agent.level.${v.level}`);
  $('agentLevel').className = `lvl ${v.level}`;
  $('agentEvidence').textContent = need ? t('agent.collecting', { n: v.n, need: v.need }) : t('agent.enough');
  const fill = $('agentFill');
  fill.style.width = `${Math.min(Math.max(z, 0), 5) * 20}%`;
  fill.style.background = v.level === 'review' ? 'var(--bad)' : v.level === 'watch' ? 'var(--cash)' : need ? 'var(--muted)' : 'var(--good)';
  const rows = [
    [t('agent.rounds'), v.rounds],
    [t('agent.wins'), `${v.wins} / ${v.expected.toFixed(1)} \u00B1 ${v.sd.toFixed(1)}`],
    [t('agent.return'), `${Math.round(v.meanReturn * 100)}%`],
    ['z', need ? `${v.zRaw.toFixed(1)}*` : v.z.toFixed(1)],
  ];
  $('agentStats').replaceChildren(...rows.map(([k, val]) => {
    const d = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = val;
    d.append(dt, dd);
    return d;
  }));
}

function row(e) {
  const li = document.createElement('li');
  li.className = e.kind;
  const time = document.createElement('time');
  time.textContent = new Date(e.t).toLocaleTimeString([], { hour12: false });
  li.append(time);
  if (e.sim) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'SIM'; li.append(tag); }
  li.append(`${ICON[e.kind] ?? ''} ${e.text}`);
  return li;
}

export function pushEvent(e) {
  const feed = $('agentFeed');
  feed.prepend(row(e));
  while (feed.children.length > MAX_ROWS) feed.lastChild.remove();
  if (e.v) renderStats(e.v);
  const tab = $('agentTab');
  if (e.kind === 'alert') tab.classList.add('alarm');
  if (!$('agentPanel').classList.contains('open') && !unseen) { unseen = true; tab.classList.add('ping'); }
  if (e.sim && /finished|stopped|Monitors alerted/.test(e.text)) setSim(false);
}

function setSim(on) {
  simulating = on;
  $('agentSim').textContent = t(on ? 'agent.stop' : 'agent.simulate');
  $('agentSim').setAttribute('aria-pressed', String(on));
}

export async function initAgent() {
  $('agentTab').hidden = false;
  $('agentTab').addEventListener('click', () => open(!$('agentPanel').classList.contains('open')));
  $('agentClose').addEventListener('click', () => open(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });
  $('agentSim').addEventListener('click', async () => {
    try { await api.agentDemo(simulating ? 'stop' : 'start'); setSim(!simulating); if (simulating) { $('agentTab').classList.remove('alarm'); } } catch { /* ignore */ }
  });
  const snap = await api.agentSnapshot();
  setSim(snap.simulating);
  const feed = $('agentFeed');
  feed.replaceChildren(...snap.events.slice(-MAX_ROWS).reverse().map(row));
  const last = [...snap.events].reverse().find((e) => e.v);
  if (last) renderStats(last.v);
  else if (snap.verdict) renderStats(snap.verdict);
  else { $('agentLevel').textContent = t('agent.level.clear'); $('agentEvidence').textContent = t('agent.empty'); }
}
