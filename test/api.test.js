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
