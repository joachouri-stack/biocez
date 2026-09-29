import { getConfig, nowIso } from './db.js';

const PAYE = `('payee', 'livree')`;

/**
 * Classement national des revendeurs sur leurs ventes clients (TTC, commandes payées, hors fraude).
 * Seuls le prénom, l'initiale du nom, la ville et le rang sont exposés : jamais l'e-mail ni le nom complet.
 * @param {'mois'|'tout'} periode  mois civil en cours, ou depuis le début
 */
export function classement(db, revendeurId, { periode = 'mois', limite = 30, now = new Date() } = {}) {
  const debut = periode === 'tout' ? '' : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const lignes = db.prepare(`SELECT r.id, r.prenom, r.nom, r.ville, r.rang,
      SUM(o.montant_ttc_cents) AS ventes, COUNT(*) AS nb, MIN(o.paid_at) AS premiere
    FROM orders o JOIN revendeurs r ON r.id = o.revendeur_ref_id
    WHERE o.type = 'vente_client' AND o.statut IN ${PAYE} AND o.attribution_bloquee = 0 AND o.paid_at >= ? AND o.paid_at < ?
    GROUP BY r.id ORDER BY ventes DESC, nb DESC, premiere ASC`).all(debut, nowIso(now));

  const public_ = (l, i) => ({
    position: i + 1, prenom: l.prenom, initiale: l.nom ? l.nom[0].toUpperCase() + '.' : '', ville: l.ville ?? null,
    rang: l.rang, ventes_ttc_cents: l.ventes, nb_ventes: l.nb, moi: l.id === revendeurId,
  });
  const i = lignes.findIndex(l => l.id === revendeurId);
  const moi = i < 0 ? null : {
    ...public_(lignes[i], i),
    // Ce qu'il manque pour dépasser la place du dessus (1 centime de plus que son total).
    ecart_place_suivante_cents: i > 0 ? lignes[i - 1].ventes - lignes[i].ventes + 1 : 0,
  };
  return {
    actif: getConfig(db).CLASSEMENT_ACTIF,
    periode, debut: debut || null, participants: lignes.length,
    top: lignes.slice(0, limite).map(public_),
    moi,
  };
}
