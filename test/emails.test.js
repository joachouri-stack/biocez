import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { creerMailer } from '../src/mail.js';
import { demanderReinitialisation, reinitialiser } from '../src/auth.js';

async function serveur({ transport } = {}) {
  const db = openDb(':memory:');
  const boite = [];
  const mailer = creerMailer(db, { publicUrl: 'http://localhost:3000', transport: transport ?? (async m => { boite.push(m); }) });
  const srv = createApp({ db, mailer, adminToken: 'secret', publicUrl: 'http://localhost:3000' }).listen(0);
  await new Promise(r => srv.once('listening', r));
  return { db, srv, boite, base: `http://127.0.0.1:${srv.address().port}` };
}

function navigateur(base) {
  const jar = new Map();
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}
const inscription = (nav, prenom, email) => nav('/api/auth/inscription', { method: 'POST', body: { prenom, nom: 'Test', email, password: 'motdepasse', accepte_conditions: true } });
const client = { email: 'client@x.fr', nom: 'Jean Client', adresse: '1 rue', code_postal: '84000', ville: 'Avignon' };

test('e-mails : bienvenue, nouveau filleul, commande, pack, versement — jamais en double', async t => {
  const { srv, base, boite, db } = await serveur();
  t.after(() => srv.close());
  const parrain = navigateur(base);
  const p = (await inscription(parrain, 'Camille', 'camille@x.fr')).data;
  assert.equal(boite.length, 1);
  assert.equal(boite[0].to, 'camille@x.fr');
  assert.match(boite[0].subject, /Bienvenue/);
  assert.ok(boite[0].text.includes(`?ref=${p.code_parrainage}`), 'le lien de parrainage est dans l’e-mail');

  const filleul = navigateur(base);
  await filleul(`/?ref=${p.code_parrainage}`);
  await inscription(filleul, 'Léa', 'lea@x.fr');
  assert.deepEqual(boite.slice(1).map(m => [m.to, /Bienvenue/.test(m.subject) ? 'bienvenue' : 'filleul']).sort(),
    [['camille@x.fr', 'filleul'], ['lea@x.fr', 'bienvenue']]);

  const cmd = await navigateur(base)('/api/checkout/client', { method: 'POST', body: { items: [{ produit_id: 'fer', quantite: 2 }], client } });
  const nav = navigateur(base);
  await nav(`/api/dev/commandes/${cmd.data.commande}/payer`, { method: 'POST', body: {} });
  await nav(`/api/dev/commandes/${cmd.data.commande}/payer`, { method: 'POST', body: {} }); // rejouée
  const confirmations = boite.filter(m => m.to === 'client@x.fr');
  assert.equal(confirmations.length, 1, 'une seule confirmation même si le paiement est confirmé deux fois');
  assert.ok(confirmations[0].text.includes('85,80'));

  const pk = await filleul('/api/checkout/pack', { method: 'POST', body: { taille: 10, items: [{ produit_id: 'fer', quantite: 10 }], livraison: { adresse: '2 rue', code_postal: '1', ville: 'V' } } });
  await filleul(`/api/dev/commandes/${pk.data.commande}/payer`, { method: 'POST', body: {} });
  assert.match(boite.at(-1).subject, /pack 10 est confirmé/);
  assert.equal(boite.at(-1).to, 'lea@x.fr');

  db.prepare(`UPDATE commissions SET statut = 'payable' WHERE beneficiaire_id = ?`).run(p.id);
  const v = await nav('/api/admin/versements', { method: 'POST', headers: { 'x-admin-token': 'secret' }, body: { revendeur_id: p.id, reference: 'VIR-1' } });
  assert.equal(v.status, 200);
  assert.match(boite.at(-1).subject, /Versement de vos commissions/);
  assert.ok(boite.at(-1).text.includes('VIR-1'));

  const journal = (await nav('/api/admin/emails', { headers: { 'x-admin-token': 'secret' } })).data;
  assert.equal(journal.emails.length, boite.length);
  assert.ok(journal.emails.every(e => e.statut === 'envoye'));
});

test('le contenu saisi par les utilisateurs est échappé dans les e-mails', async t => {
  const { srv, base, boite } = await serveur();
  t.after(() => srv.close());
  await inscription(navigateur(base), '<img src=x onerror=alert(1)>', 'x@x.fr');
  assert.ok(!boite[0].html.includes('<img src=x'));
  assert.ok(boite[0].html.includes('&lt;img'));
});

test('mot de passe oublié : parcours complet', async t => {
  const { srv, base, boite } = await serveur();
  t.after(() => srv.close());
  const autreAppareil = navigateur(base);
  await inscription(autreAppareil, 'Camille', 'camille@x.fr');
  boite.length = 0;
  const nav = navigateur(base);

  // E-mail inconnu : même réponse, aucun e-mail.
  assert.deepEqual((await nav('/api/auth/mot-de-passe-oublie', { method: 'POST', body: { email: 'inconnu@x.fr' } })).data, { ok: true });
  assert.equal(boite.length, 0);

  assert.deepEqual((await nav('/api/auth/mot-de-passe-oublie', { method: 'POST', body: { email: 'Camille@X.fr ' } })).data, { ok: true });
  assert.equal(boite.length, 1);
  const jeton = /reinitialiser\?jeton=([\w-]+)/.exec(boite[0].text)[1];
  assert.equal((await nav(`/api/auth/reinitialiser/${jeton}`)).data.valide, true);
  assert.equal((await nav(`/api/auth/reinitialiser/faux`)).data.valide, false);

  assert.equal((await nav('/api/auth/reinitialiser', { method: 'POST', body: { jeton, password: 'court' } })).status, 400);
  const ok = await nav('/api/auth/reinitialiser', { method: 'POST', body: { jeton, password: 'nouveaumotdepasse' } });
  assert.equal(ok.status, 200);
  assert.equal((await nav('/api/me')).status, 200, 'connecté après la réinitialisation');
  assert.equal((await autreAppareil('/api/me')).status, 401, 'les autres sessions sont fermées');
  assert.match(boite.at(-1).subject, /mot de passe a été modifié/);

  assert.equal((await nav('/api/auth/reinitialiser', { method: 'POST', body: { jeton, password: 'encoreunautre' } })).status, 400, 'lien à usage unique');
  assert.equal((await nav('/api/auth/connexion', { method: 'POST', body: { email: 'camille@x.fr', password: 'motdepasse' } })).status, 401);
  assert.equal((await nav('/api/auth/connexion', { method: 'POST', body: { email: 'camille@x.fr', password: 'nouveaumotdepasse' } })).status, 200);
});

test('mot de passe oublié : expiration après 1 h, 3 demandes max par heure', () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO revendeurs (prenom, nom, email, password_hash, code_parrainage, date_inscription) VALUES ('A', 'B', 'a@x.fr', 'x', 'A-1', ?)`).run(new Date().toISOString());
  const t0 = new Date('2026-01-01T10:00:00Z');
  const d = demanderReinitialisation(db, 'a@x.fr', t0);
  assert.throws(() => reinitialiser(db, d.token, 'motdepasse', new Date(t0.getTime() + 61 * 60000)), /expiré/);
  assert.ok(demanderReinitialisation(db, 'a@x.fr', t0));
  assert.ok(demanderReinitialisation(db, 'a@x.fr', t0));
  assert.equal(demanderReinitialisation(db, 'a@x.fr', t0), null, '4e demande dans l’heure refusée');
  assert.ok(demanderReinitialisation(db, 'a@x.fr', new Date(t0.getTime() + 61 * 60000)));
});

test('une panne du service d’e-mail ne bloque pas l’inscription', async t => {
  const { srv, base, db } = await serveur({ transport: async () => { throw new Error('Brevo 500'); } });
  t.after(() => srv.close());
  const r = await inscription(navigateur(base), 'Camille', 'c@x.fr');
  assert.equal(r.status, 201);
  const e = db.prepare('SELECT statut, erreur FROM emails').get();
  assert.equal(e.statut, 'erreur');
  assert.match(e.erreur, /Brevo 500/);
});

test('e-mail « commande arrivée » avec demande d’avis : une seule fois, jamais pour un pack', async t => {
  const { srv, base, boite } = await serveur();
  t.after(() => srv.close());
  const nav = navigateur(base);
  const adm = { 'x-admin-token': 'secret' };
  const cmd = await nav('/api/checkout/client', { method: 'POST', body: { items: [{ produit_id: 'fer', quantite: 1 }], client } });
  await nav(`/api/dev/commandes/${cmd.data.commande}/payer`, { method: 'POST', body: {} });
  const avant = boite.length;
  const r = await nav(`/api/admin/commandes/${cmd.data.commande}/livrer`, { method: 'POST', headers: adm });
  assert.equal(r.status, 200);
  const m = boite.at(-1);
  assert.equal(boite.length, avant + 1);
  assert.equal(m.to, 'client@x.fr');
  assert.match(m.subject, /est arrivée/);
  assert.match(m.text, /Votre avis compte/);
  assert.match(m.text, /votre accord/);
  // Deuxième clic : refusé et aucun nouvel e-mail
  assert.equal((await nav(`/api/admin/commandes/${cmd.data.commande}/livrer`, { method: 'POST', headers: adm })).status, 409);
  assert.equal(boite.length, avant + 1);
  // Pack revendeur livré : pas de demande d'avis
  const rev = navigateur(base);
  await inscription(rev, 'Paul', 'paul@x.fr');
  const pk = await rev('/api/checkout/pack', { method: 'POST', body: { taille: 10, items: [{ produit_id: 'fer', quantite: 10 }], livraison: { adresse: '2 rue', code_postal: '1', ville: 'V' } } });
  await rev(`/api/dev/commandes/${pk.data.commande}/payer`, { method: 'POST', body: {} });
  const n = boite.length;
  assert.equal((await nav(`/api/admin/commandes/${pk.data.commande}/livrer`, { method: 'POST', headers: adm })).status, 200);
  assert.equal(boite.length, n, 'aucun e-mail d’avis pour un pack');
});
