import { getConfig, getProduits, tx, nowIso, HttpError } from './db.js';
import { htFromTtc, enregistrerCommissions, annulerCommissions } from './commissions.js';

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const adresseCle = (adresse, cp) => (norm(adresse) && norm(cp) ? norm(adresse) + '|' + norm(cp) : null);

function lignesPanier(db, items) {
  const produits = new Map(getProduits(db).map(p => [p.id, p]));
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Panier vide');
  const lignes = new Map();
  for (const it of items) {
    const p = produits.get(it?.produit_id);
    const q = Number(it?.quantite);
    if (!p) throw new HttpError(400, 'Produit inconnu');
    if (!Number.isInteger(q) || q < 0 || q > 500) throw new HttpError(400, 'Quantité invalide');
    if (q) lignes.set(p.id, { produit: p, quantite: (lignes.get(p.id)?.quantite ?? 0) + q });
  }
  if (!lignes.size) throw new HttpError(400, 'Panier vide');
  return [...lignes.values()];
}

function livraison(l) {
  const out = {
    client_email: String(l?.email ?? '').trim().toLowerCase(),
    client_nom: String(l?.nom ?? '').trim(),
    adresse: String(l?.adresse ?? '').trim(),
    code_postal: String(l?.code_postal ?? '').trim(),
    ville: String(l?.ville ?? '').trim(),
  };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.client_email)) throw new HttpError(400, 'E-mail invalide');
  if (!out.client_nom || !out.adresse || !out.code_postal || !out.ville) throw new HttpError(400, 'Adresse de livraison incomplète');
  return out;
}

function inserer(db, o, lignes) {
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO orders
    (type, client_email, client_nom, adresse, code_postal, ville, revendeur_ref_id, acheteur_revendeur_id,
     pack_taille, remise, montant_ttc_cents, montant_ht_cents, vat_rate, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    o.type, o.client_email, o.client_nom, o.adresse, o.code_postal, o.ville, o.revendeur_ref_id ?? null,
    o.acheteur_revendeur_id ?? null, o.pack_taille ?? null, o.remise ?? 0, o.montant_ttc_cents, o.montant_ht_cents,
    o.vat_rate, o.created_at);
  const ins = db.prepare('INSERT INTO order_items (order_id, produit_id, quantite, prix_unitaire_ttc_cents) VALUES (?, ?, ?, ?)');
  for (const l of lignes) ins.run(id, l.produit.id, l.quantite, l.produit.prix_ttc_cents);
  return getOrder(db, Number(id));
}

export const getOrder = (db, id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
export const getOrderItems = (db, id) => db.prepare(`SELECT i.*, p.nom FROM order_items i JOIN produits p ON p.id = i.produit_id WHERE order_id = ?`).all(id);

/** Commande client (usage A). `refCode` : code du cookie de parrainage (dernier clic). */
export function creerCommandeClient(db, { items, client, refCode = null, acheteurRevendeurId = null, now = new Date() }) {
  const cfg = getConfig(db);
  const lignes = lignesPanier(db, items);
  const ttc = lignes.reduce((s, l) => s + l.quantite * l.produit.prix_ttc_cents, 0);
  const liv = livraison(client);
  // Client déjà rattaché : son revendeur l'emporte sur tout lien cliqué ; sinon, le lien (dernier clic).
  let ref = cfg.CLIENT_RATTACHE_DEFINITIF ? revendeurDuClient(db, liv.client_email) : null;
  ref ??= refCode ? db.prepare('SELECT id FROM revendeurs WHERE code_parrainage = ?').get(refCode) : null;
  // Un revendeur connecté qui passe par son propre lien n'est pas un client : pas d'attribution.
  if (ref && acheteurRevendeurId && ref.id === acheteurRevendeurId) ref = null;
  return inserer(db, {
    type: 'vente_client', ...liv, revendeur_ref_id: ref?.id,
    montant_ttc_cents: ttc, montant_ht_cents: htFromTtc(ttc, cfg.VAT_RATE), vat_rate: cfg.VAT_RATE, created_at: nowIso(now),
  }, lignes);
}

export function revendeurDuClient(db, email) {
  const c = db.prepare('SELECT revendeur_id FROM clients WHERE email = ?').get(String(email ?? '').trim());
  return c ? { id: c.revendeur_id } : null;
}

/** Prix d'un pack : somme des prix publics des pots choisis x (1 - remise). */
export function prixPack(db, taille, items, cfg = getConfig(db)) {
  const pack = cfg.PACKS.find(p => p.taille === Number(taille));
  if (!pack) throw new HttpError(400, 'Pack inconnu');
  const lignes = lignesPanier(db, items);
  const pots = lignes.reduce((s, l) => s + l.quantite, 0);
  if (pots !== pack.taille) throw new HttpError(400, `Le pack ${pack.taille} doit contenir exactement ${pack.taille} pots (${pots} choisis)`);
  const publicTtc = lignes.reduce((s, l) => s + l.quantite * l.produit.prix_ttc_cents, 0);
  const ttc = Math.round(publicTtc * (1 - pack.remise));
  return { pack, lignes, public_ttc_cents: publicTtc, ttc_cents: ttc, ht_cents: htFromTtc(ttc, cfg.VAT_RATE) };
}

/** Commande de pack (usage B) par un revendeur connecté. */
export function creerCommandePack(db, { revendeurId, taille, items, livraison: liv, now = new Date() }) {
  const cfg = getConfig(db);
  const rev = db.prepare('SELECT * FROM revendeurs WHERE id = ?').get(revendeurId);
  if (!rev) throw new HttpError(401, 'Connexion requise');
  const p = prixPack(db, taille, items, cfg);
  return inserer(db, {
    type: 'pack', ...livraison({ ...liv, email: rev.email, nom: liv?.nom || `${rev.prenom} ${rev.nom}` }),
    acheteur_revendeur_id: rev.id, pack_taille: p.pack.taille, remise: p.pack.remise,
    montant_ttc_cents: p.ttc_cents, montant_ht_cents: p.ht_cents, vat_rate: cfg.VAT_RATE, created_at: nowIso(now),
  }, p.lignes);
}

/**
 * Contrôle anti auto-parrainage d'une vente client : même e-mail, même adresse de livraison
 * ou même moyen de paiement que le revendeur dont le lien est utilisé -> aucune commission.
 * Les cas seulement suspects (même nom) sont signalés sans être bloqués.
 */
export function controleAutoParrainage(db, order) {
  if (order.type !== 'vente_client' || !order.revendeur_ref_id) return { bloque: false, raisons: [], suspects: [] };
  const rev = db.prepare('SELECT * FROM revendeurs WHERE id = ?').get(order.revendeur_ref_id);
  const siens = db.prepare(`SELECT adresse, code_postal, payment_fingerprint FROM orders
    WHERE id <> ? AND (acheteur_revendeur_id = ? OR client_email = ? COLLATE NOCASE)`).all(order.id, rev.id, rev.email);
  const raisons = [], suspects = [];
  if (order.client_email.toLowerCase() === rev.email.toLowerCase()) raisons.push('Même e-mail que le revendeur');
  const cle = adresseCle(order.adresse, order.code_postal);
  if (cle && [adresseCle(rev.adresse, rev.code_postal), ...siens.map(o => adresseCle(o.adresse, o.code_postal))].includes(cle))
    raisons.push('Même adresse de livraison que le revendeur');
  if (order.payment_fingerprint && siens.some(o => o.payment_fingerprint === order.payment_fingerprint))
    raisons.push('Même moyen de paiement que le revendeur');
  if (!raisons.length && norm(order.client_nom) && [norm(rev.prenom + rev.nom), norm(rev.nom + rev.prenom)].includes(norm(order.client_nom)))
    suspects.push('Nom du client identique à celui du revendeur');
  return { bloque: raisons.length > 0, raisons, suspects };
}

/** Paiement confirmé (webhook Stripe ou simulation) : statut, anti-abus, commissions. Idempotent. */
export function marquerPayee(db, orderId, { paymentIntent = null, fingerprint = null, feeCents = null, now = new Date() } = {}) {
  return tx(db, () => {
    const order = getOrder(db, orderId);
    if (!order) throw new HttpError(404, 'Commande introuvable');
    if (order.statut !== 'en_attente_paiement') return order;
    const t = nowIso(now);
    db.prepare(`UPDATE orders SET statut = 'payee', paid_at = ?, stripe_payment_intent = COALESCE(?, stripe_payment_intent),
      payment_fingerprint = ?, stripe_fee_cents = ? WHERE id = ?`).run(t, paymentIntent, fingerprint, feeCents, orderId);
    let o = getOrder(db, orderId);

    const ctrl = controleAutoParrainage(db, o);
    const flag = db.prepare('INSERT INTO fraud_flags (order_id, revendeur_id, raison, bloquant, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const r of ctrl.raisons) flag.run(o.id, o.revendeur_ref_id, r, 1, t);
    for (const r of ctrl.suspects) flag.run(o.id, o.revendeur_ref_id, r, 0, t);
    if (ctrl.bloque) { db.prepare('UPDATE orders SET attribution_bloquee = 1 WHERE id = ?').run(o.id); o = getOrder(db, orderId); }

    // Premier achat payé via un lien, sans fraude : le client est rattaché à ce revendeur.
    if (o.type === 'vente_client' && o.revendeur_ref_id && !o.attribution_bloquee && getConfig(db).CLIENT_RATTACHE_DEFINITIF)
      db.prepare(`INSERT OR IGNORE INTO clients (email, revendeur_id, first_order_id, attached_at) VALUES (?, ?, ?, ?)`)
        .run(o.client_email, o.revendeur_ref_id, o.id, t);

    if (o.type === 'pack') db.prepare(`UPDATE revendeurs SET statut = 'pack', date_premier_pack = COALESCE(date_premier_pack, ?)
      WHERE id = ?`).run(t, o.acheteur_revendeur_id);

    enregistrerCommissions(db, o, now);
    return o;
  });
}

export function marquerLivree(db, orderId, now = new Date()) {
  const r = db.prepare(`UPDATE orders SET statut = 'livree', delivered_at = ? WHERE id = ? AND statut = 'payee'`).run(nowIso(now), orderId);
  if (!r.changes) throw new HttpError(409, 'Seule une commande payée peut être marquée livrée');
  return getOrder(db, orderId);
}

/** Remboursement ou retour : annule les commissions. Idempotent. */
export function rembourser(db, orderId, now = new Date()) {
  return tx(db, () => {
    const order = getOrder(db, orderId);
    if (!order) throw new HttpError(404, 'Commande introuvable');
    if (order.statut === 'remboursee') return order;
    if (!['payee', 'livree'].includes(order.statut)) throw new HttpError(409, 'Commande non payée');
    db.prepare(`UPDATE orders SET statut = 'remboursee', refunded_at = ? WHERE id = ?`).run(nowIso(now), orderId);
    annulerCommissions(db, orderId, now);
    // Le premier achat est remboursé et aucun autre achat payé n'existe : le rattachement est annulé.
    if (order.type === 'vente_client') {
      const autre = db.prepare(`SELECT 1 FROM orders WHERE type = 'vente_client' AND client_email = ? COLLATE NOCASE
        AND revendeur_ref_id = ? AND statut IN ('payee', 'livree') LIMIT 1`).get(order.client_email, order.revendeur_ref_id);
      if (!autre) db.prepare('DELETE FROM clients WHERE first_order_id = ?').run(orderId);
    }
    if (order.type === 'pack') {
      const reste = db.prepare(`SELECT 1 FROM orders WHERE type = 'pack' AND acheteur_revendeur_id = ?
        AND statut IN ('payee', 'livree') LIMIT 1`).get(order.acheteur_revendeur_id);
      if (!reste) db.prepare(`UPDATE revendeurs SET statut = 'inscrit' WHERE id = ?`).run(order.acheteur_revendeur_id);
    }
    return getOrder(db, orderId);
  });
}
