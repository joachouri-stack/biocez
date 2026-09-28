// Panier latéral partagé (accueil, fiches produit) : s'ouvre après chaque ajout.
import { eur, esc, getCart, setCart } from '/assets/app.js';
import { CATALOGUE } from '/assets/catalogue.js';

/** @param {Array<{id:string, nom:string, prix_ttc_cents:number}>} produits  (depuis /api/config) */
export function panierLateral(produits) {
  const prods = new Map(produits.map(p => [p.id, p]));
  const veil = Object.assign(document.createElement('div'), { className: 'veil' });
  const drawer = document.createElement('aside');
  drawer.className = 'drawer';
  drawer.setAttribute('aria-label', 'Panier');
  drawer.setAttribute('aria-hidden', 'true');
  drawer.innerHTML = `
    <div class="d-head"><b>✓ AJOUTÉ AU PANIER</b><button class="x" data-fermer aria-label="Fermer">×</button></div>
    <div class="d-list"></div>
    <div class="d-foot">
      <div class="d-sum"><span>Total TTC</span><b></b></div>
      <a class="btn gold" href="/panier">COMMANDER →</a>
      <button class="btn" data-fermer>CONTINUER MES ACHATS</button>
    </div>`;
  document.body.append(veil, drawer);
  let dernierFocus = null;

  function ouvrir(nouveau) {
    const cart = getCart();
    const ids = Object.keys(cart).filter(k => prods.has(k) && cart[k] > 0);
    drawer.querySelector('.d-list').innerHTML = ids.map(k => {
      const x = prods.get(k);
      return `<div class="d-line ${k === nouveau ? 'new' : ''}"><img src="${CATALOGUE[k]?.image ?? ''}" alt="">
        <div>${esc(x.nom)}<small>${cart[k]} × ${eur(x.prix_ttc_cents)}</small></div><span>${eur(cart[k] * x.prix_ttc_cents)}</span></div>`;
    }).join('');
    drawer.querySelector('.d-sum b').textContent = eur(ids.reduce((s, k) => s + cart[k] * prods.get(k).prix_ttc_cents, 0));
    dernierFocus = document.activeElement;
    drawer.classList.add('show'); veil.classList.add('show'); drawer.setAttribute('aria-hidden', 'false');
    drawer.querySelector('.x').focus();
  }
  function fermer() {
    drawer.classList.remove('show'); veil.classList.remove('show'); drawer.setAttribute('aria-hidden', 'true');
    dernierFocus?.focus?.();
  }
  veil.addEventListener('click', fermer);
  drawer.addEventListener('click', e => { if (e.target.closest('[data-fermer]')) fermer(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.classList.contains('show')) fermer(); });

  return {
    ouvrir,
    ajouter(id, n = 1) {
      const cart = getCart(); cart[id] = (cart[id] || 0) + n; setCart(cart);
      ouvrir(id);
    },
  };
}
