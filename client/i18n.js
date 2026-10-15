// Tiny i18n: one JSON file per language in ./i18n/. Adding a language = adding a file + an <option>.
const FALLBACK = 'en';
const packs = {};
let current = FALLBACK;

async function load(code) {
  if (!packs[code]) packs[code] = await (await fetch(`/i18n/${code}.json`)).json();
}

const dig = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

export const lang = () => current;

export function t(key, vars = {}) {
  const raw = dig(packs[current], key) ?? dig(packs[FALLBACK], key) ?? key;
  return typeof raw === 'string' ? raw.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`) : raw;
}

export function applyDom(root = document) {
  document.documentElement.lang = current;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  document.title = t('title');
}

export async function setLang(code) {
  await Promise.all([load(FALLBACK), load(code)]);
  current = code;
  try { localStorage.setItem('fw-lang', code); } catch { /* storage may be blocked */ }
  applyDom();
}

export async function initI18n() {
  let saved = null;
  try { saved = localStorage.getItem('fw-lang'); } catch { /* ignore */ }
  const guess = saved ?? (navigator.language?.startsWith('fr') ? 'fr' : FALLBACK);
  await setLang(guess === 'fr' ? 'fr' : FALLBACK);
}
