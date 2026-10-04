// Utilitaires partagés par toutes les pages.

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Erreur ${res.status}`); e.status = res.status; e.code = data.code; throw e; }
  return data;
}

const fmt2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const fmt0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
export const eur = cents => fmt2.format((cents ?? 0) / 100);
export const eur0 = cents => fmt0.format((cents ?? 0) / 100);
export const pct = x => `${(x * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
export const fdate = iso => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);

// Panier (préférence locale du visiteur)
const CART_KEY = 'biocez_panier';
/** Frais de livraison d'une vente client (centimes), comme le serveur : offerte dès le seuil, sinon forfait. */
export const fraisLivraison = (totalCents, cfg) =>
  totalCents >= Math.round(cfg.LIVRAISON_OFFERTE_DES * 100) ? 0 : Math.round(cfg.FRAIS_LIVRAISON * 100);

export function getCart() { try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; } catch { return {}; } }
export function setCart(c) { try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch { /* stockage indisponible */ } updateCartCount(); }
export const cartCount = () => Object.values(getCart()).reduce((s, n) => s + n, 0);
function updateCartCount() { const el = document.getElementById('cart-count'); if (el) el.textContent = cartCount(); }

// Bouton « Afficher / Masquer » dans chaque champ mot de passe (les fautes de frappe sont fréquentes sur téléphone).
export function afficherMotsDePasse(root = document) {
  for (const input of root.querySelectorAll('input[type=password]')) {
    const box = document.createElement('span'); box.className = 'pw';
    input.replaceWith(box); box.append(input);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'pw-toggle'; btn.textContent = 'Afficher';
    btn.setAttribute('aria-pressed', 'false'); btn.setAttribute('aria-label', 'Afficher le mot de passe');
    btn.addEventListener('click', () => {
      const voir = input.type === 'password';
      input.type = voir ? 'text' : 'password';
      btn.textContent = voir ? 'Masquer' : 'Afficher';
      btn.setAttribute('aria-pressed', String(voir));
      btn.setAttribute('aria-label', voir ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    });
    box.append(btn);
    // Remasqué à l'envoi, pour que le gestionnaire de mots de passe le reconnaisse.
    input.form?.addEventListener('submit', () => { if (input.type !== 'password') btn.click(); }, true);
  }
}

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
    <a class="logo-top" href="/" aria-label="Biocez — accueil"><img src="/assets/img/logo-header.webp" alt="Biocez — Naturellement plus loin" width="600" height="186"></a>
    <nav>
      <a href="/" class="hide-m ${actif === 'boutique' ? 'on' : ''}">Boutique</a>
      <a href="/revendeur" class="hide-m ${actif === 'revendeur' ? 'on' : ''}">Devenir revendeur</a>
      ${me ? `<a href="/espace" class="${actif === 'espace' ? 'on' : ''}">Mon espace</a>` : `<a href="/connexion">Espace<span class="hide-xs"> revendeur</span></a>`}
      <a href="/panier" class="cart-btn">Panier <b id="cart-count">${cartCount()}</b></a>
    </nav></div>`;
  return me;
}

export function footer() {
  const el = document.querySelector('.site-footer');
  if (el) el.innerHTML = `<div class="wrap"><a class="logo-top f-logo" href="/" aria-label="Biocez — accueil"><img src="/assets/img/logo-header.webp" alt="Biocez — Naturellement plus loin" width="600" height="186" loading="lazy"></a><span class="f-links"><a href="/conditions-revendeur">Conditions revendeur</a><a href="/confidentialite">Confidentialité</a></span><span>Compléments alimentaires · Avignon, France</span></div>
    <div class="wrap f-bottom"><span>© ${new Date().getFullYear()} <b>BIOCEZ</b> · Tous droits réservés</span><span>Design by <b>Johane A.</b></span></div>`;
}

/**
 * Bouton officiel « Continuer avec Google » (Google Identity Services), affiché seulement si le site est configuré.
 * @param {HTMLElement} el      conteneur du bouton (masqué si Google n'est pas configuré)
 * @param {string|null} clientId  /api/config → google_client_id
 * @param {(credential: string) => void} surJeton  appelé avec le jeton Google à envoyer à /api/auth/google
 * @param {'continue_with'|'signup_with'|'signin_with'} texte
 */
export async function boutonGoogle(el, clientId, surJeton, texte = 'continue_with') {
  const bloc = el.closest('[data-google]') ?? el;
  if (!clientId) { bloc.hidden = true; return false; }
  await new Promise((ok, ko) => {
    if (window.google?.accounts?.id) return ok();
    const s = Object.assign(document.createElement('script'), { src: 'https://accounts.google.com/gsi/client', async: true });
    s.onload = ok; s.onerror = ko; document.head.append(s);
  }).catch(() => { bloc.hidden = true; });
  if (!window.google?.accounts?.id) return false;
  google.accounts.id.initialize({ client_id: clientId, callback: r => surJeton(r.credential), ux_mode: 'popup', context: texte === 'signup_with' ? 'signup' : 'signin' });
  google.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', text: texte, shape: 'rectangular', locale: 'fr', width: Math.min(400, el.clientWidth || 360) });
  bloc.hidden = false;
  return true;
}
