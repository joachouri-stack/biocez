// Génère un réseau de démonstration réaliste en passant par le vrai moteur
// (commandes, paiements, livraisons, remboursements, cycle, versements).
// Usage : npm run seed   (base : DATABASE_PATH ou data/biocez.db, remise à zéro)
import { rmSync } from 'node:fs';
import { openDb, addDays } from '../src/db.js';
import { inscrire } from '../src/auth.js';
import { creerCommandeClient, creerCommandePack, marquerPayee, marquerLivree, rembourser } from '../src/orders.js';
import { cycleCommissions, verser } from '../src/commissions.js';

const file = process.env.DATABASE_PATH || 'data/biocez.db';
for (const s of ['', '-wal', '-shm']) rmSync(file + s, { force: true });
const db = openDb(file);

let seed = 20260928;
const R = () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const rint = (a, b) => a + Math.floor(R() * (b - a + 1));
const pick = a => a[Math.floor(R() * a.length)];
const NOW = new Date();
const ago = d => addDays(NOW, -d);

const PRENOMS = ['Léa', 'Hugo', 'Inès', 'Thomas', 'Chloé', 'Nabil', 'Manon', 'Yanis', 'Sarah', 'Lucas', 'Julien', 'Awa', 'Mathis', 'Élodie', 'Karim', 'Jade', 'Romain', 'Nora', 'Bastien', 'Aïcha', 'Enzo', 'Clara', 'Samuel', 'Lina'];
const NOMS = ['Martin', 'Bernard', 'Dubois', 'Durand', 'Lefèvre', 'Mercier', 'Girard', 'Bonnet', 'Lambert', 'Fontaine', 'Rousseau', 'Vincent', 'Faure', 'André', 'Garnier', 'Chevalier', 'Benali', 'Diallo', 'Nguyen', 'Traoré', 'Petit', 'Roux', 'Perrin', 'Blanc'];
const VILLES = ['Avignon', 'Marseille', 'Nîmes', 'Lyon', 'Montpellier', 'Aix-en-Provence', 'Orange', 'Arles', 'Toulouse', 'Paris', 'Valence', 'Grenoble', 'Nice'];

const events = []; // { at: Date, run: () => void } rejoués dans l'ordre chronologique
const membres = [];

function membre(parrain, joursAvant, extra = {}) {
  const i = membres.length;
  const r = inscrire(db, {
    prenom: extra.prenom ?? PRENOMS[i % PRENOMS.length], nom: extra.nom ?? NOMS[(i * 7) % NOMS.length],
    email: extra.email ?? `demo${i}@biocez.test`, password: 'biocez2026', ville: extra.ville ?? pick(VILLES),
    codeParrain: parrain?.code_parrainage, now: ago(joursAvant),
  });
  db.prepare('UPDATE revendeurs SET date_inscription = ? WHERE id = ?').run(ago(joursAvant).toISOString(), r.id);
  const m = { ...r, joursAvant, k: extra.k ?? 0.5 + R() * 2.2, stop: extra.stop ?? (R() < 0.25 ? rint(30, 120) : Infinity) };
  membres.push(m);
  const packTaille = extra.pack !== undefined ? extra.pack : (R() < 0.6 ? pick([10, 10, 30, 50]) : null);
  if (packTaille) {
    const j = Math.max(0, joursAvant - rint(0, 5));
    events.push({ at: ago(j), run: () => achatPack(m, packTaille, ago(j)) });
  }
  return m;
}

function repartir(n) {
  const q = { fer: 0, vit: 0, pro: 0 };
  for (let i = 0; i < n; i++) q[pick(['fer', 'fer', 'vit', 'pro'])]++;
  return Object.entries(q).filter(([, v]) => v).map(([produit_id, quantite]) => ({ produit_id, quantite }));
}

function achatPack(m, taille, at) {
  const o = creerCommandePack(db, { revendeurId: m.id, taille, items: repartir(taille), livraison: { adresse: `${m.id} rue du Dépôt`, code_postal: '84000', ville: m.ville }, now: at });
  marquerPayee(db, o.id, { now: at, fingerprint: `fp_rev_${m.id}` });
  livrer(o.id, at);
}

function livrer(id, at) {
  const d = addDays(at, rint(2, 5));
  if (d < NOW) marquerLivree(db, id, d);
}

let nClient = 0;
function ventesDe(m) {
  for (let j = m.joursAvant - 3; j > 0; j -= 7) {
    if (m.joursAvant - j > m.stop) break;
    const n = Math.round(m.k * (0.4 + R() * 1.2));
    for (let i = 0; i < n; i++) {
      const at = ago(Math.max(0, j - rint(0, 6)));
      const c = nClient++;
      events.push({ at, run: () => {
        const o = creerCommandeClient(db, { items: repartir(R() < 0.25 ? 2 : 1), refCode: m.code_parrainage, now: at,
          client: { email: `client${c}@exemple.fr`, nom: `Client ${c}`, adresse: `${c} avenue des Clients`, code_postal: String(10000 + c), ville: pick(VILLES) } });
        marquerPayee(db, o.id, { now: at, fingerprint: `fp_client_${c}` });
        livrer(o.id, at);
        if (R() < 0.02) rembourser(db, o.id, addDays(at, 8));
      } });
    }
  }
}

// Réseau : Camille (compte de démo) et 3 niveaux sous elle, plus son propre parrain.
const top = membre(null, 520, { prenom: 'Sophie', nom: 'Lambert', email: 'sophie@biocez.test', pack: 50, k: 2 });
const camille = membre(top, 430, { prenom: 'Camille', nom: 'Moreau', email: 'camille@biocez.test', ville: 'Avignon', pack: 30, k: 4.5, stop: Infinity });
for (let i = 0; i < 7; i++) {
  const n1 = membre(camille, rint(60, 400));
  for (let j = rint(0, 3); j > 0; j--) {
    if (n1.joursAvant < 60) break;
    const n2 = membre(n1, rint(20, n1.joursAvant - 30));
    for (let k = rint(0, 2); k > 0; k--) if (n2.joursAvant > 50) membre(n2, rint(10, n2.joursAvant - 30));
  }
}
membres.forEach(ventesDe);

// Rejoue tout dans l'ordre, avec un cycle et des versements mensuels (le 5).
events.sort((a, b) => a.at - b.at);
let mois = null;
for (const e of events) {
  const m = e.at.toISOString().slice(0, 7);
  if (m !== mois && mois) {
    const d5 = new Date(`${m}-05T10:00:00Z`);
    cycleCommissions(db, d5);
    for (const { beneficiaire_id } of db.prepare(`SELECT DISTINCT beneficiaire_id FROM commissions WHERE statut = 'payable'`).all())
      verser(db, beneficiaire_id, { reference: `VIR-${m}-${beneficiaire_id}`, now: d5 });
  }
  mois = m;
  e.run();
}
cycleCommissions(db, NOW);
// Quelques clics sur les liens
const clic = db.prepare('INSERT INTO referral_clicks (revendeur_id, landing, created_at) VALUES (?, ?, ?)');
const nbVentes = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE type = 'vente_client' AND revendeur_ref_id = ?`);
const nbFilleuls = db.prepare('SELECT COUNT(*) AS n FROM revendeurs WHERE parrain_id = ?');
for (const m of membres) {
  const conversions = nbVentes.get(m.id).n + nbFilleuls.get(m.id).n;
  for (let i = Math.round(conversions * (4 + R() * 6)) + rint(5, 30); i > 0; i--) clic.run(m.id, '/', ago(rint(0, m.joursAvant)).toISOString());
}

const n = t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(`Démo : ${n('revendeurs')} revendeurs, ${n('orders')} commandes, ${n('commissions')} commissions, ${n('payouts')} versements.`);
console.log('Connexion : camille@biocez.test / biocez2026');
