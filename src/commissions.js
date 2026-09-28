import { getConfig, nowIso, addDays } from './db.js';

// Tous les montants sont en centimes (entiers) : aucun écart d'arrondi en cascade.
export const htFromTtc = (ttcCents, vatRate) => Math.round(ttcCents / (1 + vatRate));
export const appliquerTaux = (baseCents, taux) => Math.round(baseCents * taux + 1e-9);

const PAYE = `('payee', 'livree')`;

function revendeur(db, id) {
  return id == null ? null : db.prepare('SELECT id, parrain_id FROM revendeurs WHERE id = ?').get(id);
}

/**
 * Calcule les lignes de commission d'une commande payée (sans rien écrire).
 * - vente_client : vendeur (niveau 0), son parrain (1), le parrain de son parrain (2)
 * - pack : parrain direct de l'acheteur (1), puis (2), puis (3) ; l'acheteur ne touche rien
 * Un maillon absent n'est ni versé ni redistribué.
 */
export function calculerCommissions(db, order, cfg = getConfig(db)) {
  let base = order.montant_ht_cents;
  if (cfg.DEDUIRE_FRAIS_STRIPE && order.stripe_fee_cents) base -= order.stripe_fee_cents;
  if (base <= 0) return [];

  let taux, r, niveauDepart;
  if (order.type === 'vente_client') {
    if (!order.revendeur_ref_id || order.attribution_bloquee) return [];
    taux = cfg.TAUX_VENTE_CLIENT;
    r = revendeur(db, order.revendeur_ref_id);
    niveauDepart = 0;
  } else {
    if (!cfg.PACK_COMMISSION_ENABLED) return [];
    if (cfg.PACK_COMMISSION_FIRST_ONLY) {
      const autre = db.prepare(`SELECT 1 FROM orders WHERE type = 'pack' AND acheteur_revendeur_id = ?
        AND id <> ? AND statut IN ${PAYE} AND paid_at <= ? LIMIT 1`)
        .get(order.acheteur_revendeur_id, order.id, order.paid_at ?? nowIso());
      if (autre) return [];
    }
    taux = cfg.TAUX_PACK;
    const acheteur = revendeur(db, order.acheteur_revendeur_id);
    r = revendeur(db, acheteur?.parrain_id);
    niveauDepart = 1;
  }

  const lignes = [];
  for (let i = 0; i < taux.length && r; i++) {
    const montant = appliquerTaux(base, taux[i]);
    if (montant > 0) lignes.push({ beneficiaire_id: r.id, niveau: niveauDepart + i, taux: taux[i], base_ht_cents: base, montant_cents: montant });
    r = revendeur(db, r.parrain_id);
  }
  return lignes;
}

export function enregistrerCommissions(db, order, now = new Date(), cfg = getConfig(db)) {
  const ins = db.prepare(`INSERT OR IGNORE INTO commissions
    (order_id, beneficiaire_id, niveau, taux, base_ht_cents, montant_cents, statut, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'en_attente', ?)`);
  const lignes = calculerCommissions(db, order, cfg);
  for (const l of lignes) ins.run(order.id, l.beneficiaire_id, l.niveau, l.taux, l.base_ht_cents, l.montant_cents, nowIso(now));
  return lignes;
}

/** Annule les commissions d'une commande remboursée. Une ligne déjà versée
 *  donne lieu à une régularisation négative, déduite du prochain versement. */
export function annulerCommissions(db, orderId, now = new Date()) {
  const t = nowIso(now);
  db.prepare(`UPDATE commissions SET statut = 'annulee', cancelled_at = ?
    WHERE order_id = ? AND regularisation = 0 AND statut IN ('en_attente', 'validee', 'payable')`).run(t, orderId);
  const versees = db.prepare(`SELECT * FROM commissions WHERE order_id = ? AND regularisation = 0 AND statut = 'versee'`).all(orderId);
  const ins = db.prepare(`INSERT OR IGNORE INTO commissions
    (order_id, beneficiaire_id, niveau, taux, base_ht_cents, montant_cents, regularisation, statut, created_at, validated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'validee', ?, ?)`);
  for (const c of versees) ins.run(orderId, c.beneficiaire_id, c.niveau, c.taux, c.base_ht_cents, -c.montant_cents, t, t);
}

/** en_attente -> validee : commande livrée depuis au moins RETRACTATION_JOURS. */
export function validerCommissions(db, now = new Date(), cfg = getConfig(db)) {
  const limite = nowIso(addDays(now, -cfg.RETRACTATION_JOURS));
  return db.prepare(`UPDATE commissions SET statut = 'validee', validated_at = ?
    WHERE statut = 'en_attente' AND order_id IN
      (SELECT id FROM orders WHERE statut = 'livree' AND delivered_at <= ?)`).run(nowIso(now), limite).changes;
}

/** validee -> payable : quand le solde validé d'un bénéficiaire atteint PAYOUT_MIN. */
export function rendrePayables(db, now = new Date(), cfg = getConfig(db)) {
  const min = Math.round(cfg.PAYOUT_MIN * 100);
  const benefs = db.prepare(`SELECT beneficiaire_id, SUM(montant_cents) AS solde FROM commissions
    WHERE statut = 'validee' GROUP BY beneficiaire_id HAVING solde >= ? AND solde > 0`).all(min);
  const upd = db.prepare(`UPDATE commissions SET statut = 'payable', payable_at = ? WHERE statut = 'validee' AND beneficiaire_id = ?`);
  for (const b of benefs) upd.run(nowIso(now), b.beneficiaire_id);
  return benefs.length;
}

/** payable -> versee : enregistre un versement (virement effectué par Biocez). */
export function verser(db, revendeurId, { reference = null, now = new Date() } = {}) {
  const { total } = db.prepare(`SELECT COALESCE(SUM(montant_cents), 0) AS total FROM commissions
    WHERE statut = 'payable' AND beneficiaire_id = ?`).get(revendeurId);
  if (total <= 0) return null;
  const t = nowIso(now);
  const { lastInsertRowid } = db.prepare(`INSERT INTO payouts (revendeur_id, montant_cents, reference, date_versement)
    VALUES (?, ?, ?, ?)`).run(revendeurId, total, reference, t);
  db.prepare(`UPDATE commissions SET statut = 'versee', paid_at = ?, payout_id = ?
    WHERE statut = 'payable' AND beneficiaire_id = ?`).run(t, lastInsertRowid, revendeurId);
  return { id: Number(lastInsertRowid), revendeur_id: revendeurId, montant_cents: total, date_versement: t, reference };
}

/** Rang : les deux seuils (CA personnel TTC et filleuls sur 3 niveaux) doivent être franchis. */
export function calculerRang(caCents, nbFilleuls, rangs) {
  let idx = 0;
  rangs.forEach((r, i) => { if (caCents >= r.ca * 100 && nbFilleuls >= r.filleuls) idx = i; });
  return { index: idx, actuel: rangs[idx], suivant: rangs[idx + 1] ?? null };
}

export function caPersonnelCents(db, revendeurId) {
  return db.prepare(`SELECT COALESCE(SUM(montant_ttc_cents), 0) AS ca FROM orders
    WHERE type = 'vente_client' AND revendeur_ref_id = ? AND attribution_bloquee = 0 AND statut IN ${PAYE}`).get(revendeurId).ca;
}

export function filleuls(db, revendeurId) {
  return db.prepare(`WITH RECURSIVE t(id, niveau) AS (
      SELECT id, 1 FROM revendeurs WHERE parrain_id = ?
      UNION ALL
      SELECT r.id, t.niveau + 1 FROM revendeurs r JOIN t ON r.parrain_id = t.id WHERE t.niveau < 3
    ) SELECT r.id, r.prenom, r.nom, r.ville, r.statut, r.parrain_id, r.date_inscription, t.niveau
      FROM t JOIN revendeurs r ON r.id = t.id ORDER BY t.niveau, r.date_inscription DESC`).all(revendeurId);
}

export function mettreAJourRangs(db, cfg = getConfig(db)) {
  const upd = db.prepare('UPDATE revendeurs SET rang = ? WHERE id = ? AND rang <> ?');
  for (const { id } of db.prepare('SELECT id FROM revendeurs').all()) {
    const { actuel } = calculerRang(caPersonnelCents(db, id), filleuls(db, id).length, cfg.RANGS);
    upd.run(actuel.nom, id, actuel.nom);
  }
}

/** Tâche périodique : validation, passage en payable, rangs. */
export function cycleCommissions(db, now = new Date()) {
  const cfg = getConfig(db);
  const validees = validerCommissions(db, now, cfg);
  const payables = rendrePayables(db, now, cfg);
  mettreAJourRangs(db, cfg);
  return { validees, beneficiaires_payables: payables };
}
