import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setConfig, getConfig, addDays } from '../src/db.js';
import { inscrire } from '../src/auth.js';
import { creerCommandeClient, creerCommandePack, marquerPayee, marquerLivree, rembourser, prixPack } from '../src/orders.js';
import { htFromTtc, cycleCommissions, verser } from '../src/commissions.js';
import { dashboard } from '../src/dashboard.js';

const client = { email: 'client@exemple.fr', nom: 'Jean Client', adresse: '1 rue des Lilas', code_postal: '84000', ville: 'Avignon' };
let n = 0;
function rev(db, parrain = null, extra = {}) {
  n++;
  return inscrire(db, { prenom: `P${n}`, nom: `N${n}`, email: `r${n}@exemple.fr`, password: 'motdepasse', codeParrain: parrain?.code_parrainage, ...extra });
}
function chaine(db) {
  const a = rev(db), b = rev(db, a), c = rev(db, b), d = rev(db, c), e = rev(db, d);
  return { a, b, c, d, e };
}
const lignes = (db, orderId) => db.prepare('SELECT beneficiaire_id, niveau, taux, montant_cents, statut FROM commissions WHERE order_id = ? ORDER BY niveau').all(orderId);
// Chaque vente = un client différent (sinon le client resterait rattaché au premier revendeur).
let nClient = 0;
const unClient = () => ({ ...client, email: `client${++nClient}@exemple.fr`, adresse: `${nClient} rue des Lilas` });
const venteFer = (db, vendeur, qte = 1, c = unClient()) =>
  marquerPayee(db, creerCommandeClient(db, { items: [{ produit_id: 'fer', quantite: qte }], client: c, refCode: vendeur.code_parrainage }).id);
const pack10 = (db, r) => creerCommandePack(db, {
  revendeurId: r.id, taille: 10,
  items: [{ produit_id: 'fer', quantite: 4 }, { produit_id: 'vit', quantite: 3 }, { produit_id: 'pro', quantite: 3 }],
  livraison: { adresse: `${r.id} avenue du Stock`, code_postal: '13000', ville: 'Marseille' },
});

describe('Montants de référence du cahier des charges', () => {
  test('42,90 € TTC = 40,66 € HT', () => assert.equal(htFromTtc(4290, 0.055), 4066));

  test('vente Fer & Énergie : 8,13 + 4,07 + 2,03 = 14,23 €', () => {
    const db = openDb(':memory:');
    const { a, b, c, d } = chaine(db);
    const o = venteFer(db, d);
    assert.deepEqual(lignes(db, o.id).map(l => [l.beneficiaire_id, l.niveau, l.montant_cents]), [[d.id, 0, 813], [c.id, 1, 407], [b.id, 2, 203]]);
    assert.ok(!lignes(db, o.id).some(l => l.beneficiaire_id === a.id), 'pas de 4e niveau');
  });

  test('Pack 10 (4 Fer, 3 Mix, 3 Force) : 429,00 → 300,30 € TTC, 284,64 € HT', () => {
    const db = openDb(':memory:');
    const p = prixPack(db, 10, [{ produit_id: 'fer', quantite: 4 }, { produit_id: 'vit', quantite: 3 }, { produit_id: 'pro', quantite: 3 }]);
    assert.deepEqual([p.public_ttc_cents, p.ttc_cents, p.ht_cents], [42900, 30030, 28464]);
  });
});

describe('Vente client (usage A)', () => {
  test('chaîne plus courte : moins de lignes, rien de redistribué', () => {
    const db = openDb(':memory:');
    const a = rev(db), b = rev(db, a);
    assert.deepEqual(lignes(db, venteFer(db, b).id).map(l => l.montant_cents), [813, 407]);
    assert.deepEqual(lignes(db, venteFer(db, a).id).map(l => l.montant_cents), [813]);
  });

  test('sans lien : aucune commission', () => {
    const db = openDb(':memory:');
    const o = marquerPayee(db, creerCommandeClient(db, { items: [{ produit_id: 'fer', quantite: 1 }], client }).id);
    assert.equal(lignes(db, o.id).length, 0);
  });

  test('un revendeur sans pack vend, parraine et perçoit des commissions', () => {
    const db = openDb(':memory:');
    const a = rev(db), b = rev(db, a);
    assert.equal(a.statut, 'inscrit');
    const o1 = venteFer(db, a);
    const o2 = venteFer(db, b);
    assert.equal(lignes(db, o1.id)[0].montant_cents, 813);
    assert.equal(lignes(db, o2.id).find(l => l.beneficiaire_id === a.id).montant_cents, 407);
  });

  test('le taux est figé sur la ligne : changer la grille ne modifie pas l’historique', () => {
    const db = openDb(':memory:');
    const { c, d } = chaine(db);
    const o1 = venteFer(db, d);
    setConfig(db, 'TAUX_VENTE_CLIENT', [0.25, 0.10, 0.05]);
    const o2 = venteFer(db, d);
    assert.equal(lignes(db, o1.id)[0].taux, 0.20);
    assert.equal(lignes(db, o1.id)[0].montant_cents, 813);
    assert.equal(lignes(db, o2.id)[0].montant_cents, 1017);
    assert.ok(c);
  });

  test('paiement confirmé deux fois (webhook rejoué) : pas de doublon', () => {
    const db = openDb(':memory:');
    const { d } = chaine(db);
    const o = venteFer(db, d);
    marquerPayee(db, o.id);
    assert.equal(lignes(db, o.id).length, 3);
  });
});

describe('Achat de pack (usage B)', () => {
  test('premier pack : 56,93 + 28,46 + 14,23 € aux 3 parrains, rien pour l’acheteur', () => {
    const db = openDb(':memory:');
    const { a, b, c, d, e } = chaine(db);
    const o = marquerPayee(db, pack10(db, e).id);
    assert.deepEqual(lignes(db, o.id).map(l => [l.beneficiaire_id, l.niveau, l.montant_cents]), [[d.id, 1, 5693], [c.id, 2, 2846], [b.id, 3, 1423]]);
    assert.ok(!lignes(db, o.id).some(l => [a.id, e.id].includes(l.beneficiaire_id)));
    assert.equal(db.prepare('SELECT statut FROM revendeurs WHERE id = ?').get(e.id).statut, 'pack');
  });

  test('réachat : aucune commission si PACK_COMMISSION_FIRST_ONLY', () => {
    const db = openDb(':memory:');
    const { e } = chaine(db);
    marquerPayee(db, pack10(db, e).id);
    assert.equal(lignes(db, marquerPayee(db, pack10(db, e).id).id).length, 0);
    setConfig(db, 'PACK_COMMISSION_FIRST_ONLY', false);
    assert.equal(lignes(db, marquerPayee(db, pack10(db, e).id).id).length, 3);
  });

  test('PACK_COMMISSION_ENABLED = false : aucune commission', () => {
    const db = openDb(':memory:');
    const { e } = chaine(db);
    setConfig(db, 'PACK_COMMISSION_ENABLED', false);
    assert.equal(lignes(db, marquerPayee(db, pack10(db, e).id).id).length, 0);
  });

  test('le pack doit contenir exactement le nombre de pots', () => {
    const db = openDb(':memory:');
    assert.throws(() => prixPack(db, 10, [{ produit_id: 'fer', quantite: 9 }]), /exactement 10/);
  });
});

describe('Cycle de vie', () => {
  test('en_attente → validée (14 j après livraison) → payable (≥ PAYOUT_MIN) → versée', () => {
    const db = openDb(':memory:');
    const { d } = chaine(db);
    const t0 = new Date('2026-01-01T10:00:00Z');
    const ids = [];
    for (let i = 0; i < 7; i++) {
      const o = creerCommandeClient(db, { items: [{ produit_id: 'fer', quantite: 1 }], client, refCode: d.code_parrainage, now: t0 });
      marquerPayee(db, o.id, { now: t0 });
      marquerLivree(db, o.id, addDays(t0, 2));
      ids.push(o.id);
    }
    const statutD = () => db.prepare('SELECT statut, SUM(montant_cents) s FROM commissions WHERE beneficiaire_id = ? GROUP BY statut').all(d.id).map(r => ({ ...r }));
    cycleCommissions(db, addDays(t0, 15));
    assert.deepEqual(statutD(), [{ statut: 'en_attente', s: 7 * 813 }]);
    cycleCommissions(db, addDays(t0, 16));
    assert.deepEqual(statutD(), [{ statut: 'payable', s: 7 * 813 }]); // 56,91 € ≥ 50 €
    const p = verser(db, d.id, { reference: 'VIR-1', now: addDays(t0, 20) });
    assert.equal(p.montant_cents, 5691);
    assert.deepEqual(statutD(), [{ statut: 'versee', s: 5691 }]);
  });

  test('sous le seuil : reste validée', () => {
    const db = openDb(':memory:');
    const { d } = chaine(db);
    const t0 = new Date('2026-01-01T10:00:00Z');
    const o = creerCommandeClient(db, { items: [{ produit_id: 'fer', quantite: 1 }], client, refCode: d.code_parrainage, now: t0 });
    marquerPayee(db, o.id, { now: t0 });
    marquerLivree(db, o.id, t0);
    cycleCommissions(db, addDays(t0, 30));
    assert.equal(db.prepare('SELECT statut FROM commissions WHERE beneficiaire_id = ?').get(d.id).statut, 'validee');
  });

  test('un remboursement annule les lignes ; déjà versée → régularisation négative', () => {
    const db = openDb(':memory:');
    const { d, e } = chaine(db);
    const o = venteFer(db, d);
    rembourser(db, o.id);
    assert.ok(lignes(db, o.id).every(l => l.statut === 'annulee'));

    const t0 = new Date('2026-01-01T10:00:00Z');
    const p = creerCommandePack(db, { revendeurId: e.id, taille: 10, items: [{ produit_id: 'fer', quantite: 10 }], livraison: { adresse: 'x', code_postal: '1', ville: 'y' }, now: t0 });
    marquerPayee(db, p.id, { now: t0 });
    marquerLivree(db, p.id, t0);
    cycleCommissions(db, addDays(t0, 15));
    verser(db, d.id);
    rembourser(db, p.id);
    const regul = db.prepare('SELECT montant_cents, statut FROM commissions WHERE order_id = ? AND beneficiaire_id = ? AND regularisation = 1').get(p.id, d.id);
    assert.ok(regul.montant_cents < 0);
    assert.equal(regul.statut, 'validee');
    assert.equal(db.prepare('SELECT statut FROM revendeurs WHERE id = ?').get(e.id).statut, 'inscrit');
  });
});

describe('Anti-abus', () => {
  test('même e-mail que le vendeur : aucune commission, signalement', () => {
    const db = openDb(':memory:');
    const { d } = chaine(db);
    const o = venteFer(db, d, 1, { ...client, email: d.email });
    assert.equal(lignes(db, o.id).length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM fraud_flags WHERE order_id = ? AND bloquant = 1').get(o.id).n, 1);
  });

  test('même adresse de livraison ou même carte que le vendeur : bloqué', () => {
    const db = openDb(':memory:');
    const { d } = chaine(db);
    const p = pack10(db, d);
    marquerPayee(db, p.id, { fingerprint: 'fp_123' });
    const o1 = venteFer(db, d, 1, { ...client, adresse: `${d.id} Avenue du stock`, code_postal: '13000' });
    assert.equal(lignes(db, o1.id).length, 0);
    const o2 = creerCommandeClient(db, { items: [{ produit_id: 'fer', quantite: 1 }], client: { ...client, email: 'autre@x.fr' }, refCode: d.code_parrainage });
    marquerPayee(db, o2.id, { fingerprint: 'fp_123' });
    assert.equal(lignes(db, o2.id).length, 0);
  });

  test('le parrain est définitif (aucune boucle possible)', () => {
    const db = openDb(':memory:');
    const { a, b } = chaine(db);
    assert.throws(() => db.prepare('UPDATE revendeurs SET parrain_id = ? WHERE id = ?').run(b.id, a.id), /définitif/);
  });
});

describe('Dashboard', () => {
  test('gains par statut et par niveau, 3 niveaux de filleuls', () => {
    const db = openDb(':memory:');
    const { b, c, d, e } = chaine(db);
    venteFer(db, b);
    venteFer(db, c);
    venteFer(db, d);
    marquerPayee(db, pack10(db, e).id);
    const dash = dashboard(db, b.id);
    assert.deepEqual(dash.kpis.nb_par_niveau, [1, 1, 1]);
    assert.equal(dash.gains.par_statut.en_attente, 813 + 407 + 203 + 1423);
    const parNiveau = n => dash.gains.par_source.filter(s => s.niveau === n).reduce((t, s) => t + s.s, 0);
    assert.deepEqual([0, 1, 2, 3].map(parNiveau), [813, 407, 203, 1423]);
    assert.equal(dash.niveaux[2].filleuls[0].id, e.id);
  });
});

describe('Client rattaché (option A)', () => {
  const achat = (db, email, refCode, opts = {}) => {
    const o = creerCommandeClient(db, { items: [{ produit_id: 'fer', quantite: 1 }], refCode,
      client: { ...client, email, adresse: opts.adresse ?? '9 rue du Client' } });
    return opts.payer === false ? o : marquerPayee(db, o.id);
  };

  test('le 1er achat payé via un lien rattache le client ; ses achats suivants sans lien comptent pour ce revendeur', () => {
    const db = openDb(':memory:');
    const camille = rev(db);
    const o1 = achat(db, 'marie@x.fr', camille.code_parrainage);
    const o2 = achat(db, 'Marie@X.fr', null); // 2 mois plus tard, sans lien, e-mail en majuscules
    assert.equal(o2.revendeur_ref_id, camille.id);
    assert.equal(lignes(db, o2.id)[0].montant_cents, 813);
    assert.ok(o1);
  });

  test('le lien d’un autre revendeur ne « vole » pas un client rattaché', () => {
    const db = openDb(':memory:');
    const camille = rev(db), autre = rev(db);
    achat(db, 'marie@x.fr', camille.code_parrainage);
    assert.equal(achat(db, 'marie@x.fr', autre.code_parrainage).revendeur_ref_id, camille.id);
  });

  test('un panier non payé ne rattache personne', () => {
    const db = openDb(':memory:');
    const camille = rev(db), autre = rev(db);
    achat(db, 'marie@x.fr', camille.code_parrainage, { payer: false });
    assert.equal(achat(db, 'marie@x.fr', autre.code_parrainage).revendeur_ref_id, autre.id);
  });

  test('un auto-achat bloqué (fraude) ne rattache pas', () => {
    const db = openDb(':memory:');
    const camille = rev(db);
    achat(db, camille.email, camille.code_parrainage);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, 0);
  });

  test('si le 1er achat est remboursé, le rattachement est annulé', () => {
    const db = openDb(':memory:');
    const camille = rev(db), autre = rev(db);
    const o1 = achat(db, 'marie@x.fr', camille.code_parrainage);
    rembourser(db, o1.id);
    assert.equal(achat(db, 'marie@x.fr', autre.code_parrainage).revendeur_ref_id, autre.id);
  });

  test('CLIENT_RATTACHE_DEFINITIF = false : retour au lien seul (30 jours)', () => {
    const db = openDb(':memory:');
    setConfig(db, 'CLIENT_RATTACHE_DEFINITIF', false);
    const camille = rev(db);
    achat(db, 'marie@x.fr', camille.code_parrainage);
    assert.equal(achat(db, 'marie@x.fr', null).revendeur_ref_id, null);
  });
});

describe('Classement national', () => {
  test('ordre par ventes clients, top 30, position hors top, données minimales, fraude exclue', async () => {
    const { classement } = await import('../src/classement.js');
    const db = openDb(':memory:');
    const revs = Array.from({ length: 35 }, () => rev(db));
    // Le revendeur i vend (i + 1) pots : le dernier créé est 1er.
    revs.forEach((r, i) => marquerPayee(db, creerCommandeClient(db, {
      items: [{ produit_id: 'fer', quantite: i + 1 }], refCode: r.code_parrainage,
      client: { ...client, email: `c${i}@x.fr`, adresse: `${i} rue Classement` } }).id));
    const moi = revs[2]; // 3 pots -> 33e
    const c = classement(db, moi.id);
    assert.equal(c.participants, 35);
    assert.equal(c.top.length, 30);
    assert.equal(c.top[0].ventes_ttc_cents, 35 * 4290);
    assert.ok(c.top.every((x, i) => i === 0 || c.top[i - 1].ventes_ttc_cents >= x.ventes_ttc_cents));
    assert.equal(c.moi.position, 33);
    assert.equal(c.visible, true);
    assert.equal(c.moi.ecart_place_suivante_cents, 4290 + 1);
    assert.deepEqual(Object.keys(c.top[0]).sort(), ['initiale', 'moi', 'nb_ventes', 'position', 'prenom', 'rang', 'ventes_ttc_cents', 'ville']);
    assert.ok(!JSON.stringify(c).includes('@'), 'aucun e-mail exposé');

    // Une vente bloquée (auto-achat) ne compte pas.
    const fraudeur = revs[0];
    marquerPayee(db, creerCommandeClient(db, { items: [{ produit_id: 'fer', quantite: 100 }], refCode: fraudeur.code_parrainage,
      client: { ...client, email: fraudeur.email } }).id);
    assert.equal(classement(db, fraudeur.id).moi.ventes_ttc_cents, 4290);

    // Case décochée : absent chez les autres, position privée parmi les visibles.
    const discret = revs[34]; // 1er
    db.prepare('UPDATE revendeurs SET classement_visible = 0 WHERE id = ?').run(discret.id);
    const vu = classement(db, moi.id);
    assert.equal(vu.participants, 34);
    assert.ok(!vu.top.some(x => x.ventes_ttc_cents === 35 * 4290), 'masqué absent du top');
    assert.equal(vu.moi.position, 32);
    const prive = classement(db, discret.id);
    assert.equal(prive.visible, false);
    assert.equal(prive.moi.masque, true);
    assert.equal(prive.moi.position, 1);
    assert.ok(!prive.top.some(x => x.moi));
    const second = classement(db, revs[33].id);
    assert.equal(second.moi.position, 1);

    // Désactivable.
    setConfig(db, 'CLASSEMENT_ACTIF', false);
    assert.equal(classement(db, moi.id).actif, false);
  });
});

describe('Configuration', () => {
  test('valeurs impossibles refusées, valeurs correctes enregistrées', () => {
    const db = openDb(':memory:');
    for (const [k, v] of [['PAYOUT_MIN', -5], ['RETRACTATION_JOURS', 2.5], ['RETRACTATION_JOURS', 400], ['REF_COOKIE_JOURS', 0],
      ['ACTIF_JOURS', 1000], ['PACKS', [{ taille: 10, remise: 0.3 }, { taille: 10, remise: 0.4 }]], ['PACKS', [{ taille: 10, remise: 1 }]],
      ['RANGS', [{ nom: ' ', ca: 0, filleuls: 0 }]], ['RANGS', [{ nom: 'Or', ca: 0, filleuls: 1.5 }]], ['TAUX_VENTE_CLIENT', [0.2, 0.1, 1.2]], ['CLASSEMENT_ACTIF', 'oui']])
      assert.throws(() => setConfig(db, k, v), /Valeur invalide/, `${k} = ${JSON.stringify(v)}`);
    setConfig(db, 'PAYOUT_MIN', 30); setConfig(db, 'RETRACTATION_JOURS', 14); setConfig(db, 'VAT_RATE', 0.055);
    setConfig(db, 'PACKS', [{ taille: 10, remise: 0.3 }, { taille: 20, remise: 0.35 }]);
    const c = getConfig(db);
    assert.equal(c.PAYOUT_MIN, 30);
    assert.deepEqual(c.PACKS.map(p => p.taille), [10, 20]);
  });
});

describe('Livraison', () => {
  test('offerte dès 60 € de produits, sinon 4,90 € ; hors commissions et hors classement', () => {
    const db = openDb(':memory:');
    const vendeur = rev(db);
    const un = creerCommandeClient(db, { items: [{ produit_id: 'fer', quantite: 1 }], refCode: vendeur.code_parrainage, client: { ...client, email: 'un@x.fr' } });
    assert.equal(un.montant_ttc_cents, 4290);
    assert.equal(un.frais_livraison_cents, 490);
    const deux = creerCommandeClient(db, { items: [{ produit_id: 'fer', quantite: 2 }], client: { ...client, email: 'deux@x.fr' } });
    assert.equal(deux.frais_livraison_cents, 0, '85,80 € ≥ 60 €');
    const pile = creerCommandeClient(db, { items: [{ produit_id: 'pro', quantite: 1 }, { produit_id: 'vit', quantite: 1 }], client: { ...client, email: 'pile@x.fr' } });
    assert.equal(pile.frais_livraison_cents, 0);
    // Les commissions portent sur les produits seuls.
    marquerPayee(db, un.id);
    const com = db.prepare('SELECT montant_cents FROM commissions WHERE order_id = ? AND beneficiaire_id = ?').get(un.id, vendeur.id);
    assert.equal(com.montant_cents, Math.round(Math.round(4290 / 1.055) * 0.2));
    // Réglable ; les packs restent livrés gratuitement.
    setConfig(db, 'LIVRAISON_OFFERTE_DES', 100); setConfig(db, 'FRAIS_LIVRAISON', 5.5);
    assert.equal(creerCommandeClient(db, { items: [{ produit_id: 'fer', quantite: 2 }], client: { ...client, email: 'trois@x.fr' } }).frais_livraison_cents, 550);
    const pack = creerCommandePack(db, { revendeurId: vendeur.id, taille: 10, items: [{ produit_id: 'fer', quantite: 10 }], livraison: { adresse: '1 a', code_postal: '1', ville: 'V' } });
    assert.equal(pack.frais_livraison_cents, 0);
    assert.throws(() => setConfig(db, 'FRAIS_LIVRAISON', -1), /Valeur invalide/);
  });
});

describe('Avis clients', () => {
  test('liste vide par défaut, avis valides acceptés, avis mal formés refusés', () => {
    const db = openDb(':memory:');
    assert.deepEqual(getConfig(db).AVIS, []);
    const ok = [{ prenom: 'Marie', ville: 'Avignon', note: 5, texte: 'Très bon goût.', produit: 'fer' }];
    setConfig(db, 'AVIS', ok);
    assert.deepEqual(getConfig(db).AVIS, ok);
    assert.throws(() => setConfig(db, 'AVIS', [{ prenom: 'Marie', ville: '', note: 6, texte: 'x' }]), /Valeur invalide/);
    assert.throws(() => setConfig(db, 'AVIS', [{ prenom: '', ville: '', note: 5, texte: 'x' }]), /Valeur invalide/);
    assert.throws(() => setConfig(db, 'AVIS', [{ prenom: 'A', ville: '', note: 5, texte: ' ' }]), /Valeur invalide/);
  });
  test('note globale : source libre, note entre 0 et 5, lien https uniquement', () => {
    const db = openDb(':memory:');
    assert.equal(getConfig(db).AVIS_RESUME.source, '');
    setConfig(db, 'AVIS_RESUME', { note: 4.9, nombre: 418, source: 'Google', lien: 'https://g.page/biocez' });
    assert.equal(getConfig(db).AVIS_RESUME.nombre, 418);
    assert.throws(() => setConfig(db, 'AVIS_RESUME', { note: 6, nombre: 1, source: 'x', lien: '' }), /Valeur invalide/);
    assert.throws(() => setConfig(db, 'AVIS_RESUME', { note: 4, nombre: 1, source: 'x', lien: 'javascript:alert(1)' }), /Valeur invalide/);
  });
});
