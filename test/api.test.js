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
    const img = await fetch(`${base}/assets/img/${id}.jpg`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
  }
  assert.equal((await fetch(`${base}/produit/inconnu`)).status, 404);
  assert.equal((await fetch(`${base}/assets/img/hero.jpg`)).status, 200);
});
