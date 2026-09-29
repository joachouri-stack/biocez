import { getConfig, getProduits, nowIso, addDays } from './db.js';

const PAYE = `('payee', 'livree')`;

/**
 * Statistiques du tableau de bord administrateur.
 * @param {number} jours  durée de la période (0 = depuis le début)
 * Les montants sont en centimes ; chaque indicateur clé est comparé à la période précédente de même durée.
 */
export function statsAdmin(db, { jours = 30, now = new Date() } = {}) {
  const cfg = getConfig(db);
  const premier = db.prepare(`SELECT MIN(paid_at) AS d FROM orders WHERE statut IN ${PAYE}`).get().d;
  const fin = now;
  const debut = jours > 0 ? addDays(now, -jours) : new Date(premier ?? now);
  const span = fin - debut;
  const avant = new Date(debut.getTime() - span);
  const [D, F, A] = [nowIso(debut), nowIso(fin), nowIso(avant)];

  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  // --- Chiffre d'affaires et commandes (période et période précédente)
  function ventes(d, f) {
    const r = one(`SELECT
        COALESCE(SUM(montant_ttc_cents), 0) AS ttc, COALESCE(SUM(montant_ht_cents), 0) AS ht,
        COALESCE(SUM(CASE WHEN type = 'vente_client' THEN montant_ttc_cents END), 0) AS ttc_clients,
        COALESCE(SUM(CASE WHEN type = 'pack' THEN montant_ttc_cents END), 0) AS ttc_packs,
        COALESCE(SUM(type = 'vente_client'), 0) AS nb_clients, COALESCE(SUM(type = 'pack'), 0) AS nb_packs,
        COALESCE(SUM(CASE WHEN type = 'vente_client' AND (revendeur_ref_id IS NULL OR attribution_bloquee = 1) THEN montant_ttc_cents END), 0) AS ttc_direct
      FROM orders WHERE statut IN ${PAYE} AND paid_at >= ? AND paid_at < ?`, d, f);
    const pots = one(`SELECT COALESCE(SUM(i.quantite), 0) AS n FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.statut IN ${PAYE} AND o.paid_at >= ? AND o.paid_at < ?`, d, f).n;
    const com = one(`SELECT COALESCE(SUM(montant_cents), 0) AS s FROM commissions
      WHERE statut <> 'annulee' AND regularisation = 0 AND created_at >= ? AND created_at < ?`, d, f).s;
    const nouveaux = one(`SELECT COUNT(*) AS n FROM revendeurs WHERE date_inscription >= ? AND date_inscription < ?`, d, f).n;
    return { ...r, panier_moyen: r.nb_clients ? Math.round(r.ttc_clients / r.nb_clients) : 0, pots, commissions: com, nouveaux_revendeurs: nouveaux };
  }
  const cur = ventes(D, F), prev = ventes(A, D);
  const evol = k => (jours > 0 && prev[k] ? (cur[k] - prev[k]) / prev[k] : null);

  // --- Remboursements
  const remb = one(`SELECT COUNT(*) AS n, COALESCE(SUM(montant_ttc_cents), 0) AS s FROM orders
    WHERE statut = 'remboursee' AND refunded_at >= ? AND refunded_at < ?`, D, F);

  // --- Clients : nouveaux et réachats
  const clientsPeriode = one(`SELECT COUNT(DISTINCT client_email) AS n FROM orders
    WHERE type = 'vente_client' AND statut IN ${PAYE} AND paid_at >= ? AND paid_at < ?`, D, F).n;
  const nouveauxClients = one(`SELECT COUNT(*) AS n FROM (SELECT client_email, MIN(paid_at) AS p FROM orders
    WHERE type = 'vente_client' AND statut IN ${PAYE} GROUP BY client_email COLLATE NOCASE) WHERE p >= ? AND p < ?`, D, F).n;
  const reachats = one(`SELECT COUNT(*) AS n FROM orders o WHERE o.type = 'vente_client' AND o.statut IN ${PAYE}
    AND o.paid_at >= ? AND o.paid_at < ? AND EXISTS (SELECT 1 FROM orders p WHERE p.type = 'vente_client'
      AND p.statut IN ${PAYE} AND p.client_email = o.client_email COLLATE NOCASE AND p.paid_at < o.paid_at)`, D, F).n;

  // --- Réseau
  const reseau = one(`SELECT COUNT(*) AS total, COALESCE(SUM(statut = 'pack'), 0) AS avec_pack FROM revendeurs`);
  const actifs = one(`SELECT COUNT(DISTINCT revendeur_ref_id) AS n FROM orders WHERE type = 'vente_client'
    AND statut IN ${PAYE} AND attribution_bloquee = 0 AND revendeur_ref_id IS NOT NULL AND paid_at >= ? AND paid_at < ?`, D, F).n;
  const rangs = cfg.RANGS.map(r => ({ nom: r.nom, n: one('SELECT COUNT(*) AS n FROM revendeurs WHERE rang = ?', r.nom).n }));

  // --- Série temporelle (jour / semaine / mois selon la durée)
  const jSpan = span / 864e5;
  const pas = jSpan <= 31 ? 'jour' : jSpan <= 120 ? 'semaine' : 'mois';
  const cle = { jour: `substr(paid_at, 1, 10)`, semaine: `date(substr(paid_at, 1, 10), 'weekday 1', '-7 days')`, mois: `substr(paid_at, 1, 7)` }[pas];
  const brut = all(`SELECT ${cle} AS k, type, SUM(montant_ttc_cents) AS s, COUNT(*) AS n FROM orders
    WHERE statut IN ${PAYE} AND paid_at >= ? AND paid_at < ? GROUP BY k, type`, D, F);
  const serie = [];
  const curseur = new Date(Date.UTC(debut.getUTCFullYear(), debut.getUTCMonth(), pas === 'mois' ? 1 : debut.getUTCDate()));
  if (pas === 'semaine') curseur.setUTCDate(curseur.getUTCDate() - ((curseur.getUTCDay() + 6) % 7));
  while (curseur <= fin) {
    const k = pas === 'mois' ? curseur.toISOString().slice(0, 7) : curseur.toISOString().slice(0, 10);
    const b = brut.filter(x => x.k === k);
    serie.push({ k, clients: b.find(x => x.type === 'vente_client')?.s ?? 0, packs: b.find(x => x.type === 'pack')?.s ?? 0 });
    if (pas === 'jour') curseur.setUTCDate(curseur.getUTCDate() + 1);
    else if (pas === 'semaine') curseur.setUTCDate(curseur.getUTCDate() + 7);
    else curseur.setUTCMonth(curseur.getUTCMonth() + 1);
  }

  // --- Produits vendus
  const prodRows = all(`SELECT i.produit_id AS id, o.type, SUM(i.quantite) AS pots, SUM(i.quantite * i.prix_unitaire_ttc_cents) AS public_ttc
    FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.statut IN ${PAYE} AND o.paid_at >= ? AND o.paid_at < ?
    GROUP BY i.produit_id, o.type`, D, F);
  const produits = getProduits(db).map(p => {
    const c = prodRows.find(r => r.id === p.id && r.type === 'vente_client'), k = prodRows.find(r => r.id === p.id && r.type === 'pack');
    return { id: p.id, nom: p.nom, couleur: p.couleur, pots_clients: c?.pots ?? 0, pots_packs: k?.pots ?? 0, ca_clients_ttc: c?.public_ttc ?? 0 };
  });

  // --- Packs vendus
  const packRows = all(`SELECT pack_taille AS taille, COUNT(*) AS n, SUM(montant_ttc_cents) AS ttc,
      SUM(NOT EXISTS (SELECT 1 FROM orders p WHERE p.type = 'pack' AND p.acheteur_revendeur_id = o.acheteur_revendeur_id
        AND p.statut IN ${PAYE} AND p.paid_at < o.paid_at)) AS premiers
    FROM orders o WHERE type = 'pack' AND statut IN ${PAYE} AND paid_at >= ? AND paid_at < ? GROUP BY pack_taille`, D, F);
  const packs = cfg.PACKS.map(p => {
    const r = packRows.find(x => x.taille === p.taille);
    return { taille: p.taille, remise: p.remise, n: r?.n ?? 0, ttc: r?.ttc ?? 0, premiers: r?.premiers ?? 0 };
  });

  // --- Meilleurs revendeurs
  const top = all(`SELECT r.id, r.prenom, r.nom, r.ville, r.rang, r.statut,
      COALESCE(v.ttc, 0) AS ventes_ttc, COALESCE(v.n, 0) AS nb_ventes, COALESCE(c.s, 0) AS commissions,
      (SELECT COUNT(*) FROM revendeurs f WHERE f.parrain_id = r.id) AS filleuls
    FROM revendeurs r
    LEFT JOIN (SELECT revendeur_ref_id AS id, SUM(montant_ttc_cents) AS ttc, COUNT(*) AS n FROM orders
      WHERE type = 'vente_client' AND statut IN ${PAYE} AND attribution_bloquee = 0 AND paid_at >= ? AND paid_at < ? GROUP BY revendeur_ref_id) v ON v.id = r.id
    LEFT JOIN (SELECT beneficiaire_id AS id, SUM(montant_cents) AS s FROM commissions
      WHERE statut <> 'annulee' AND created_at >= ? AND created_at < ? GROUP BY beneficiaire_id) c ON c.id = r.id
    WHERE COALESCE(v.ttc, 0) > 0 OR COALESCE(c.s, 0) > 0
    ORDER BY ventes_ttc DESC, commissions DESC LIMIT 10`, D, F, D, F);

  // --- À faire (indépendant de la période)
  const aLivrer = one(`SELECT COUNT(*) AS n FROM orders WHERE statut = 'payee'`).n;
  const aVerser = one(`SELECT COALESCE(SUM(montant_cents), 0) AS s, COUNT(DISTINCT beneficiaire_id) AS n FROM commissions WHERE statut = 'payable'`);
  const enCours = one(`SELECT COALESCE(SUM(montant_cents), 0) AS s FROM commissions WHERE statut IN ('en_attente', 'validee')`).s;
  const signalements = one(`SELECT COUNT(*) AS n, COALESCE(SUM(bloquant), 0) AS bloquants FROM fraud_flags WHERE resolu = 0`);

  const dernieres = all(`SELECT o.id, o.type, o.statut, o.montant_ttc_cents, o.pack_taille, o.client_nom, o.paid_at, o.created_at,
      r.prenom || ' ' || r.nom AS revendeur, a.prenom || ' ' || a.nom AS acheteur
    FROM orders o LEFT JOIN revendeurs r ON r.id = o.revendeur_ref_id LEFT JOIN revendeurs a ON a.id = o.acheteur_revendeur_id
    WHERE o.statut <> 'en_attente_paiement' ORDER BY COALESCE(o.paid_at, o.created_at) DESC LIMIT 8`);

  return {
    periode: { jours, debut: D, fin: F, pas },
    kpis: {
      ca_ttc: cur.ttc, ca_ht: cur.ht, ca_clients_ttc: cur.ttc_clients, ca_packs_ttc: cur.ttc_packs, ca_direct_ttc: cur.ttc_direct,
      nb_commandes: cur.nb_clients, nb_packs: cur.nb_packs, panier_moyen: cur.panier_moyen, pots: cur.pots,
      commissions: cur.commissions, part_commissions: cur.ht ? cur.commissions / cur.ht : 0,
      nouveaux_revendeurs: cur.nouveaux_revendeurs, revendeurs_actifs: actifs,
      clients: clientsPeriode, nouveaux_clients: nouveauxClients, taux_reachat: cur.nb_clients ? reachats / cur.nb_clients : 0,
      remboursements: remb.n, remboursements_ttc: remb.s,
    },
    evolution: {
      ca_ttc: evol('ttc'), nb_commandes: evol('nb_clients'), nb_packs: evol('nb_packs'), panier_moyen: evol('panier_moyen'),
      pots: evol('pots'), commissions: evol('commissions'), nouveaux_revendeurs: evol('nouveaux_revendeurs'),
    },
    serie, produits, packs, top,
    reseau: { total: reseau.total, avec_pack: reseau.avec_pack, rangs },
    a_faire: { a_livrer: aLivrer, a_verser: aVerser.s, a_verser_revendeurs: aVerser.n, commissions_en_cours: enCours,
      signalements: signalements.n, signalements_bloquants: signalements.bloquants },
    dernieres,
  };
}

export function listeRevendeurs(db) {
  return db.prepare(`SELECT r.id, r.prenom, r.nom, r.email, r.ville, r.code_parrainage, r.statut, r.rang, r.date_inscription, r.classement_visible,
      p.prenom || ' ' || p.nom AS parrain,
      (SELECT COUNT(*) FROM revendeurs f WHERE f.parrain_id = r.id) AS filleuls,
      (SELECT COUNT(*) FROM clients c WHERE c.revendeur_id = r.id) AS clients,
      (SELECT COALESCE(SUM(montant_ttc_cents), 0) FROM orders o WHERE o.type = 'vente_client' AND o.revendeur_ref_id = r.id
        AND o.attribution_bloquee = 0 AND o.statut IN ${PAYE}) AS ventes_ttc,
      (SELECT COALESCE(SUM(montant_cents), 0) FROM commissions c WHERE c.beneficiaire_id = r.id AND c.statut <> 'annulee') AS gains,
      (SELECT MAX(paid_at) FROM orders o WHERE o.revendeur_ref_id = r.id AND o.statut IN ${PAYE}) AS derniere_vente
    FROM revendeurs r LEFT JOIN revendeurs p ON p.id = r.parrain_id ORDER BY ventes_ttc DESC`).all();
}
