import { getConfig, getProduits, nowIso, addDays } from './db.js';
import { calculerRang, caPersonnelCents, filleuls } from './commissions.js';
import { getRevendeur } from './auth.js';

const PAYE = `('payee', 'livree')`;
const STATUTS = ['en_attente', 'validee', 'payable', 'versee', 'annulee'];

/** Données complètes de l'espace personnel d'un revendeur. */
export function dashboard(db, revendeurId, { now = new Date(), publicUrl = '' } = {}) {
  const cfg = getConfig(db);
  const me = getRevendeur(db, revendeurId);
  const depuis = d => nowIso(addDays(now, -d));
  const actifDepuis = depuis(cfg.ACTIF_JOURS);

  // --- Réseau
  const reseau = filleuls(db, revendeurId);
  const caFilleul = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN type = 'vente_client' AND revendeur_ref_id = ?1 AND attribution_bloquee = 0 THEN montant_ttc_cents END), 0) AS ventes,
      COALESCE(SUM(CASE WHEN type = 'pack' AND acheteur_revendeur_id = ?1 THEN montant_ttc_cents END), 0) AS packs,
      MAX(paid_at) AS derniere
    FROM orders WHERE statut IN ${PAYE} AND (revendeur_ref_id = ?1 OR acheteur_revendeur_id = ?1)`);
  const noms = new Map([[me.id, me], ...reseau.map(r => [r.id, r])]);
  const niveaux = [1, 2, 3].map(n => {
    const liste = reseau.filter(r => r.niveau === n).map(r => {
      const ca = caFilleul.get(r.id);
      const p = noms.get(r.parrain_id);
      return {
        id: r.id, prenom: r.prenom, nom: r.nom, ville: r.ville, date_inscription: r.date_inscription,
        pack: r.statut === 'pack', actif: !!ca.derniere && ca.derniere >= actifDepuis,
        ca_ventes_cents: ca.ventes, ca_packs_cents: ca.packs, ca_cents: ca.ventes + ca.packs,
        parrain: n > 1 && p ? `${p.prenom} ${p.nom}` : null,
      };
    });
    const com = db.prepare(`SELECT COALESCE(SUM(montant_cents), 0) AS s FROM commissions
      WHERE beneficiaire_id = ? AND niveau = ? AND statut <> 'annulee'`).get(revendeurId, n).s;
    return { niveau: n, filleuls: liste, commissions_cents: com };
  });

  // --- Rang et chiffres clés
  const ca = caPersonnelCents(db, revendeurId);
  const nbFilleuls = reseau.length;
  const rang = calculerRang(ca, nbFilleuls, cfg.RANGS);
  const debutMois = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const somme = (where, ...args) => db.prepare(`SELECT COALESCE(SUM(montant_cents), 0) AS s FROM commissions
    WHERE beneficiaire_id = ? AND ${where}`).get(revendeurId, ...args).s;

  // --- Gains
  const parStatut = Object.fromEntries(STATUTS.map(s => [s, 0]));
  for (const r of db.prepare(`SELECT statut, SUM(montant_cents) AS s FROM commissions WHERE beneficiaire_id = ? GROUP BY statut`).all(revendeurId))
    parStatut[r.statut] = r.s;
  const source = db.prepare(`SELECT c.niveau, o.type, c.statut, SUM(c.montant_cents) AS s FROM commissions c
    JOIN orders o ON o.id = c.order_id WHERE c.beneficiaire_id = ? AND c.statut <> 'annulee'
    GROUP BY c.niveau, o.type, c.statut`).all(revendeurId);
  const parMois = db.prepare(`SELECT substr(c.created_at, 1, 7) AS mois, c.niveau, o.type, SUM(c.montant_cents) AS s
    FROM commissions c JOIN orders o ON o.id = c.order_id
    WHERE c.beneficiaire_id = ? AND c.statut <> 'annulee' AND c.created_at >= ?
    GROUP BY mois, c.niveau, o.type`).all(revendeurId, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString());

  const dernieres = db.prepare(`SELECT c.id, c.niveau, c.taux, c.base_ht_cents, c.montant_cents, c.statut, c.regularisation, c.created_at,
      o.type, o.id AS order_id, v.prenom AS source_prenom, v.nom AS source_nom
    FROM commissions c JOIN orders o ON o.id = c.order_id
    LEFT JOIN revendeurs v ON v.id = CASE o.type WHEN 'pack' THEN o.acheteur_revendeur_id ELSE o.revendeur_ref_id END
    WHERE c.beneficiaire_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 30`).all(revendeurId);

  const versements = db.prepare(`SELECT id, montant_cents, reference, date_versement FROM payouts
    WHERE revendeur_id = ? ORDER BY date_versement DESC`).all(revendeurId);

  // --- Ventes par produit (ventes clients via mon lien)
  const produits = getProduits(db);
  const ventesProduit = db.prepare(`SELECT i.produit_id, SUM(i.quantite) AS pots, SUM(i.quantite * i.prix_unitaire_ttc_cents) AS ttc
    FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE o.type = 'vente_client' AND o.revendeur_ref_id = ? AND o.attribution_bloquee = 0 AND o.statut IN ${PAYE}
    GROUP BY i.produit_id`).all(revendeurId);

  // --- Lien et conversions
  const clics = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(created_at >= ?), 0) AS n30 FROM referral_clicks WHERE revendeur_id = ?`)
    .get(depuis(30), revendeurId);
  const ventesLien = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(paid_at >= ?), 0) AS n30 FROM orders
    WHERE type = 'vente_client' AND revendeur_ref_id = ? AND attribution_bloquee = 0 AND statut IN ${PAYE}`).get(depuis(30), revendeurId);
  const inscriptions = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(date_inscription >= ?), 0) AS n30 FROM revendeurs WHERE parrain_id = ?`)
    .get(depuis(30), revendeurId);

  return {
    me: { ...me, email: undefined },
    config: configPublique(db, cfg),
    rang: { index: rang.index, actuel: rang.actuel, suivant: rang.suivant },
    kpis: {
      ca_cents: ca,
      ca_30j_cents: db.prepare(`SELECT COALESCE(SUM(montant_ttc_cents), 0) AS s FROM orders WHERE type = 'vente_client'
        AND revendeur_ref_id = ? AND attribution_bloquee = 0 AND statut IN ${PAYE} AND paid_at >= ?`).get(revendeurId, depuis(30)).s,
      nb_filleuls: nbFilleuls,
      nb_par_niveau: niveaux.map(n => n.filleuls.length),
      gains_mois_cents: somme(`statut <> 'annulee' AND created_at >= ?`, debutMois),
    },
    niveaux,
    gains: {
      par_statut: parStatut,
      cumules_cents: parStatut.en_attente + parStatut.validee + parStatut.payable + parStatut.versee,
      par_source: source,
      par_mois: parMois,
      dernieres_commissions: dernieres,
      versements,
    },
    ventes_par_produit: produits.map(p => {
      const v = ventesProduit.find(x => x.produit_id === p.id);
      return { id: p.id, nom: p.nom, couleur: p.couleur, pots: v?.pots ?? 0, ttc_cents: v?.ttc ?? 0 };
    }),
    lien: {
      code: me.code_parrainage,
      url: `${publicUrl}/?ref=${encodeURIComponent(me.code_parrainage)}`,
      clics: clics.n, clics_30j: clics.n30,
      ventes: ventesLien.n, ventes_30j: ventesLien.n30,
      inscriptions: inscriptions.n, inscriptions_30j: inscriptions.n30,
    },
  };
}

/** Paramètres exposés au front (simulateur, packs, grille). Aucune valeur n'est dupliquée côté client. */
export function configPublique(db, cfg = getConfig(db)) {
  return {
    VAT_RATE: cfg.VAT_RATE,
    PACKS: cfg.PACKS,
    TAUX_VENTE_CLIENT: cfg.TAUX_VENTE_CLIENT,
    TAUX_PACK: cfg.TAUX_PACK,
    PACK_COMMISSION_ENABLED: cfg.PACK_COMMISSION_ENABLED,
    PACK_COMMISSION_FIRST_ONLY: cfg.PACK_COMMISSION_FIRST_ONLY,
    PAYOUT_MIN: cfg.PAYOUT_MIN,
    RETRACTATION_JOURS: cfg.RETRACTATION_JOURS,
    ACTIF_JOURS: cfg.ACTIF_JOURS,
    RANGS: cfg.RANGS,
    PRODUITS: getProduits(db).map(({ id, nom, prix_ttc_cents, couleur }) => ({ id, nom, prix_ttc_cents, couleur })),
  };
}
