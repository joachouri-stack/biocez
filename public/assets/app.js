// Utilitaires partagés par toutes les pages.

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Erreur ${res.status}`); e.status = res.status; throw e; }
  return data;
}

const fmt2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const fmt0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
export const eur = cents => fmt2.format((cents ?? 0) / 100);
export const eur0 = cents => fmt0.format((cents ?? 0) / 100);
export const pct = x => `${(x * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
export const fdate = iso => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);

// Panier (préférence locale du visiteur)
const CART_KEY = 'biocez_panier';
export function getCart() { try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; } catch { return {}; } }
export function setCart(c) { try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch { /* stockage indisponible */ } updateCartCount(); }
export const cartCount = () => Object.values(getCart()).reduce((s, n) => s + n, 0);
function updateCartCount() { const el = document.getElementById('cart-count'); if (el) el.textContent = cartCount(); }

export function toast(text, err = false) {
  let el = document.getElementById('toast');
  if (!el) { el = Object.assign(document.createElement('div'), { id: 'toast', className: 'toast' }); el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = text; el.classList.toggle('err', err); el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

export async function copier(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0'; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('Copié ✓');
}

/** En-tête commun. `actif` : 'boutique' | 'revendeur' | 'espace'. */
export async function header(actif) {
  const el = document.querySelector('.site-header');
  let me = null;
  try { me = (await api('/api/session')).revendeur; } catch { /* hors ligne */ }
  el.innerHTML = `<div class="wrap">
    <a class="logo" href="/">BIOCEZ</a>
    <nav>
      <a href="/" class="hide-m ${actif === 'boutique' ? 'on' : ''}">Boutique</a>
      <a href="/revendeur" class="hide-m ${actif === 'revendeur' ? 'on' : ''}">Devenir revendeur</a>
      ${me ? `<a href="/espace" class="${actif === 'espace' ? 'on' : ''}">Mon espace</a>` : `<a href="/connexion">Espace revendeur</a>`}
      <a href="/panier" class="cart-btn">Panier <b id="cart-count">${cartCount()}</b></a>
    </nav></div>`;
  return me;
}

export function footer() {
  const el = document.querySelector('.site-footer');
  if (el) el.innerHTML = `<div class="wrap"><span class="logo">BIOCEZ</span><span>Compléments alimentaires · Avignon, France</span></div>`;
}
