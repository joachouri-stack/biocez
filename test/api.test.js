import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

async function serveur() {
  const db = openDb(':memory:');
  const srv = createApp({ db, adminToken: 'secret', production: false }).listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { db, srv, base };
}

// Petit client HTTP qui conserve les cookies, comme un navigateur.
function navigateur(base) {
  const jar = new Map();
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
}

test('parcours complet : lien ?ref → inscription filleul → pack → vente client → admin', async t => {
  const { srv, base } = await serveur();
  t.after(() => srv.close());

  const parrain = navigateur(base);
  const p = await parrain('/api/auth/inscription', { method: 'POST', body: { prenom: 'Camille', nom: 'Moreau', email: 'camille@exemple.fr', password: 'motdepasse' } });
  assert.equal(p.status, 201);
  assert.equal(p.data.statut, 'inscrit');

  // Un visiteur clique sur le lien, puis s'inscrit gratuitement : il devient filleul niveau 1.
  const filleul = navigateur(base);
  await filleul(`/?ref=${p.data.code_parrainage}`);
  assert.equal((await filleul('/api/ref')).data.parrain.prenom, 'Camille');
  const f = await filleul('/api/auth/inscription', { method: 'POST', body: { prenom: 'Léa', nom: 'Martin', email: 'lea@exemple.fr', password: 'motdepasse' } });
  assert.equal(f.data.parrain_id, p.data.id);

  // Il achète un pack (paiement simulé) : Camille touche 20 % du HT.
  const achat = await filleul('/api/checkout/pack', { method: 'POST', body: {
    taille: 10, items: [{ produit_id: 'fer', quantite: 4 }, { produit_id: 'vit', quantite: 3 }, { produit_id: 'pro', quantite: 3 }],
    livraison: { adresse: '2 rue Haute', code_postal: '13000', ville: 'Marseille' } } });
  assert.match(achat.data.url, /paiement-test/);
  await filleul(`/api/dev/commandes/${achat.data.commande}/payer`, { method: 'POST', body: {} });

  // Un client passe par le lien de Léa : Léa 20 %, Camille 10 %.
  const client = navigateur(base);
  await client(`/?ref=${f.data.code_parrainage}`);
  const cmd = await client('/api/checkout/client', { method: 'POST', body: {
    items: [{ produit_id: 'fer', quantite: 1 }],
    client: { email: 'client@exemple.fr', nom: 'Jean Client', adresse: '1 rue des Lilas', code_postal: '84000', ville: 'Avignon' } } });
  await client(`/api/dev/commandes/${cmd.data.commande}/payer`, { method: 'POST', body: {} });

  const dash = (await parrain('/api/me/dashboard')).data;
  assert.equal(dash.gains.par_statut.en_attente, 5693 + 407);
  assert.equal(dash.lien.clics, 1);
  assert.equal(dash.lien.inscriptions, 1);
  assert.equal(dash.niveaux[0].filleuls[0].pack, true);
  assert.equal((await filleul('/api/me/dashboard')).data.gains.par_statut.en_attente, 813);

  // Admin : protégé par jeton ; remboursement -> annulation.
  assert.equal((await client('/api/admin/commandes')).status, 401);
  const admin = navigateur(base);
  const h = { 'x-admin-token': 'secret' };
  assert.equal((await admin(`/api/admin/commandes/${cmd.data.commande}/rembourser`, { method: 'POST', headers: h })).data.statut, 'remboursee');
  assert.equal((await filleul('/api/me/dashboard')).data.gains.par_statut.annulee, 813);
  assert.equal((await admin('/api/admin/config/PAYOUT_MIN', { method: 'PUT', headers: h, body: { value: 'abc' } })).status, 400);
});

test('le simulateur lit la grille depuis la config', async t => {
  const { srv, base } = await serveur();
  t.after(() => srv.close());
  const cfg = (await navigateur(base)('/api/config')).data;
  assert.deepEqual(cfg.TAUX_VENTE_CLIENT, [0.2, 0.1, 0.05]);
  assert.deepEqual(cfg.PACKS.map(p => p.remise), [0.3, 0.4, 0.5]);
  assert.equal(cfg.PRODUITS.length, 3);
});

test('sécurité : pas d’admin sans jeton, pas de paiement simulé en ligne, pas d’auto-achat, limite de connexion', async t => {
  const db = openDb(':memory:');
  const srv = createApp({ db, publicUrl: 'https://biocez.com' }).listen(0);
  await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  const nav = navigateur(`http://127.0.0.1:${srv.address().port}`);

  assert.equal((await nav('/api/admin/commandes', { headers: { 'x-admin-token': 'dev' } })).status, 503);
  const r = await nav('/api/auth/inscription', { method: 'POST', body: { prenom: 'Camille', nom: 'M', email: 'c@x.fr', password: 'motdepasse' } });
  const client = { email: 'autre@x.fr', nom: 'A B', adresse: '1 rue', code_postal: '1', ville: 'V' };
  const cmd = await nav('/api/checkout/client', { method: 'POST', body: { items: [{ produit_id: 'fer', quantite: 1 }], client } });
  assert.equal(cmd.status, 503, 'sans Stripe en ligne : paiement indisponible');
  assert.equal((await nav('/api/dev/commandes/1/payer', { method: 'POST', body: {} })).status, 404);

  // Revendeur connecté passant par son propre lien : commande sans attribution.
  await nav(`/?ref=${r.data.code_parrainage}`);
  const { creerCommandeClient } = await import('../src/orders.js');
  const o = creerCommandeClient(db, { items: [{ produit_id: 'fer', quantite: 1 }], client, refCode: r.data.code_parrainage, acheteurRevendeurId: r.data.id });
  assert.equal(o.revendeur_ref_id, null);

  // Requête sans JSON : erreur 400, pas 500.
  const brut = await fetch(`http://127.0.0.1:${srv.address().port}/api/checkout/client`, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } });
  assert.equal(brut.status, 400);

  for (let i = 0; i < 10; i++) assert.equal((await nav('/api/auth/connexion', { method: 'POST', body: { email: 'c@x.fr', password: 'mauvais' } })).status, 401);
  assert.equal((await nav('/api/auth/connexion', { method: 'POST', body: { email: 'c@x.fr', password: 'motdepasse' } })).status, 429);
});

test('fiches produit et photos servies', async t => {
  const { srv, base } = await serveur();
  t.after(() => srv.close());
  for (const id of ['fer', 'vit', 'pro']) {
    const r = await fetch(`${base}/produit/${id}`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /catalogue\.js/);
    const img = await fetch(`${base}/assets/img/${id}.webp`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/webp');
  }
  assert.equal((await fetch(`${base}/produit/inconnu`)).status, 404);
  assert.equal((await fetch(`${base}/assets/img/hero.webp`)).status, 200);
});

test('page panier servie', async t => {
  const { srv, base } = await serveur();
  t.after(() => srv.close());
  const r = await fetch(`${base}/panier`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Mon panier/);
});

test('statistiques admin : protégées et cohérentes avec les commandes', async t => {
  const db = openDb(':memory:');
  const srv = createApp({ db, adminToken: 'secret', production: false }).listen(0);
  await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const nav = navigateur(base);
  assert.equal((await nav('/api/admin/stats')).status, 401);

  const p = (await nav('/api/auth/inscription', { method: 'POST', body: { prenom: 'Camille', nom: 'M', email: 'c@x.fr', password: 'motdepasse' } })).data;
  const f = navigateur(base);
  await f(`/?ref=${p.code_parrainage}`);
  await f('/api/auth/inscription', { method: 'POST', body: { prenom: 'Léa', nom: 'L', email: 'l@x.fr', password: 'motdepasse' } });
  const pk = await f('/api/checkout/pack', { method: 'POST', body: { taille: 10, items: [{ produit_id: 'fer', quantite: 10 }], livraison: { adresse: '1 a', code_postal: '1', ville: 'V' } } });
  await f(`/api/dev/commandes/${pk.data.commande}/payer`, { method: 'POST', body: {} });
  const cl = navigateur(base);
  await cl(`/?ref=${p.code_parrainage}`);
  const c = await cl('/api/checkout/client', { method: 'POST', body: { items: [{ produit_id: 'vit', quantite: 2 }, { produit_id: 'pro', quantite: 1 }],
    client: { email: 'client@x.fr', nom: 'Jean', adresse: '2 b', code_postal: '2', ville: 'W' } } });
  await cl(`/api/dev/commandes/${c.data.commande}/payer`, { method: 'POST', body: {} });
  await cl('/api/checkout/client', { method: 'POST', body: { items: [{ produit_id: 'fer', quantite: 5 }],
    client: { email: 'abandon@x.fr', nom: 'X', adresse: '3 c', code_postal: '3', ville: 'Z' } } }); // non payée : ignorée

  const s = (await nav('/api/admin/stats?jours=30', { headers: { 'x-admin-token': 'secret' } })).data;
  const packTtc = Math.round(10 * 4290 * 0.7), clientTtc = 2 * 4790 + 3790;
  assert.equal(s.kpis.ca_ttc, packTtc + clientTtc);
  assert.equal(s.kpis.nb_commandes, 1);
  assert.equal(s.kpis.nb_packs, 1);
  assert.equal(s.kpis.pots, 13);
  assert.equal(s.kpis.panier_moyen, clientTtc);
  assert.deepEqual(s.produits.map(x => [x.id, x.pots_clients, x.pots_packs]), [['fer', 0, 10], ['vit', 2, 0], ['pro', 1, 0]]);
  assert.equal(s.packs.find(x => x.taille === 10).premiers, 1);
  assert.equal(s.serie.reduce((a, x) => a + x.clients + x.packs, 0), s.kpis.ca_ttc);
  assert.equal(s.top[0].prenom, 'Camille');
  assert.equal(s.a_faire.a_livrer, 2);
  assert.equal(s.reseau.total, 2);
  const revs = (await nav('/api/admin/revendeurs', { headers: { 'x-admin-token': 'secret' } })).data;
  assert.equal(revs.find(r => r.prenom === 'Camille').filleuls, 1);
});

test('case « Apparaître dans le classement » : préférence enregistrée, validée, et migration des anciennes bases', async t => {
  const { srv, base } = await serveur();
  t.after(() => srv.close());
  const nav = navigateur(base);
  assert.equal((await nav('/api/me/preferences', { method: 'PUT', body: { classement_visible: false } })).status, 401);
  await nav('/api/auth/inscription', { method: 'POST', body: { prenom: 'Camille', nom: 'M', email: 'c@x.fr', password: 'motdepasse' } });
  assert.equal((await nav('/api/me')).data.classement_visible, 1, 'cochée par défaut');
  assert.equal((await nav('/api/me/preferences', { method: 'PUT', body: { classement_visible: 'non' } })).status, 400);
  assert.equal((await nav('/api/me/preferences', { method: 'PUT', body: { classement_visible: false } })).status, 200);
  assert.equal((await nav('/api/me')).data.classement_visible, 0);
  assert.equal((await nav('/api/me/classement')).data.visible, false);

  // Une base créée avant la case reçoit la colonne, cochée pour tout le monde.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(mkdtempSync(join(tmpdir(), 'bz-')), 'old.db');
  const old = openDb(file);
  const now = new Date().toISOString();
  old.prepare(`INSERT INTO revendeurs (prenom, nom, email, password_hash, code_parrainage, date_inscription) VALUES ('A', 'B', 'a@b.fr', 'x', 'ANCIEN', ?)`).run(now);
  old.close();
  const raw = new DatabaseSync(file);
  raw.exec('ALTER TABLE revendeurs DROP COLUMN classement_visible');
  raw.close();
  const migre = openDb(file);
  assert.equal(migre.prepare('SELECT classement_visible FROM revendeurs').get().classement_visible, 1);
  migre.close();
});

test('page merci : commande lisible seulement par sa référence aléatoire, jamais par son numéro', async t => {
  const { srv, base } = await serveur();
  t.after(() => srv.close());
  const nav = navigateur(base);
  const cmd = (await nav('/api/checkout/client', { method: 'POST', body: {
    items: [{ produit_id: 'fer', quantite: 2 }], client: { email: 'merci@x.fr', nom: 'Marie Durand', adresse: '3 rue des Lilas', code_postal: '84000', ville: 'Avignon' } } })).data;
  assert.match(cmd.ref, /^[A-Za-z0-9_-]{24}$/);
  assert.match(cmd.url, new RegExp(`/paiement-test\\?ref=${cmd.ref}$`));
  assert.equal((await nav(`/api/commandes/${cmd.commande}`)).status, 404, 'le numéro ne donne rien');
  assert.equal((await nav('/api/commandes/' + 'A'.repeat(24))).status, 404);

  let o = (await nav(`/api/commandes/${cmd.ref}`)).data;
  assert.equal(o.statut, 'en_attente_paiement');
  await nav(`/api/dev/commandes/${cmd.ref}/payer`, { method: 'POST', body: {} });
  o = (await nav(`/api/commandes/${cmd.ref}`)).data;
  assert.equal(o.statut, 'payee');
  assert.deepEqual(o.articles.map(a => ({ ...a })), [{ produit_id: 'fer', nom: 'Fer & Énergie', quantite: 2 }]);
  assert.equal(o.livraison.ville, 'Avignon');
  assert.equal(o.montant_ttc_cents, 2 * 4290);

  // Références toutes différentes, et ajoutées aux commandes d'une ancienne base.
  const r2 = (await nav('/api/checkout/client', { method: 'POST', body: { items: [{ produit_id: 'vit', quantite: 1 }], client: { email: 'b@x.fr', nom: 'B', adresse: '1 a', code_postal: '1', ville: 'V' } } })).data.ref;
  assert.notEqual(r2, cmd.ref);
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { creerCommandeClient } = await import('../src/orders.js');
  const file = join(mkdtempSync(join(tmpdir(), 'bz-')), 'old.db');
  const old = openDb(file);
  for (const email of ['a@x.fr', 'b@x.fr']) creerCommandeClient(old, { items: [{ produit_id: 'fer', quantite: 1 }], client: { email, nom: 'N', adresse: '1 a', code_postal: '1', ville: 'V' } });
  old.close();
  const raw = new DatabaseSync(file);
  raw.exec('DROP INDEX idx_orders_refpub'); raw.exec('ALTER TABLE orders DROP COLUMN ref');
  raw.close();
  const migre = openDb(file);
  const refs = migre.prepare('SELECT ref FROM orders').all().map(r => r.ref);
  assert.equal(refs.length, 2);
  assert.ok(refs.every(r => /^[A-Za-z0-9_-]{24}$/.test(r)) && refs[0] !== refs[1]);
  assert.ok(migre.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_orders_refpub'").get(), 'index unique créé');
  migre.close();
});
