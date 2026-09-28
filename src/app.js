import express from 'express';
import { fileURLToPath } from 'node:url';
import { getConfig, setConfig, HttpError, nowIso, DEFAULT_CONFIG } from './db.js';
import { inscrire, connecter, creerSession, revendeurDeSession, supprimerSession } from './auth.js';
import { creerCommandeClient, creerCommandePack, prixPack, marquerPayee, marquerLivree, rembourser, getOrder } from './orders.js';
import { cycleCommissions, verser } from './commissions.js';
import { dashboard, configPublique } from './dashboard.js';
import { creerSessionCheckout, traiterWebhook } from './stripe.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const REF_COOKIE = 'bz_ref', SESSION_COOKIE = 'bz_session';

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {import('stripe').Stripe|null} opts.stripe  null = mode test (paiement simulé)
 */
export function createApp({ db, stripe = null, publicUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`,
  adminToken = process.env.ADMIN_TOKEN || (process.env.NODE_ENV === 'production' ? null : 'dev'), production = process.env.NODE_ENV === 'production' } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  const secure = publicUrl.startsWith('https://');
  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure, path: '/' };
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Webhook Stripe : corps brut requis pour vérifier la signature.
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), wrap(async (req, res) => {
    if (!stripe) throw new HttpError(404, 'Stripe non configuré');
    try {
      res.json({ received: await traiterWebhook(stripe, db, req.body, req.headers['stripe-signature']) });
    } catch (e) {
      if (e.type === 'StripeSignatureVerificationError') throw new HttpError(400, 'Signature invalide');
      throw e;
    }
  }));

  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    req.revendeur = revendeurDeSession(db, req.cookies[SESSION_COOKIE]);
    next();
  });

  // Lien de parrainage ?ref=CODE : cookie 30 jours, le dernier clic l'emporte.
  app.use((req, res, next) => {
    const code = req.method === 'GET' && !req.path.startsWith('/api/') ? req.query.ref : null;
    if (typeof code === 'string' && code) {
      const r = db.prepare('SELECT id, code_parrainage FROM revendeurs WHERE code_parrainage = ?').get(code.trim());
      if (r) {
        res.cookie(REF_COOKIE, r.code_parrainage, { ...cookieOpts, maxAge: getConfig(db).REF_COOKIE_JOURS * 86400000 });
        db.prepare('INSERT INTO referral_clicks (revendeur_id, landing, created_at) VALUES (?, ?, ?)').run(r.id, req.path, nowIso());
        req.cookies[REF_COOKIE] = r.code_parrainage;
      }
    }
    next();
  });

  const auth = (req, res, next) => (req.revendeur ? next() : next(new HttpError(401, 'Connexion requise')));
  const admin = (req, res, next) => {
    if (!adminToken) return next(new HttpError(503, 'ADMIN_TOKEN non configuré'));
    return req.headers['x-admin-token'] === adminToken ? next() : next(new HttpError(401, 'Accès administrateur requis'));
  };
  const ouvrirSession = (res, id) => { const s = creerSession(db, id); res.cookie(SESSION_COOKIE, s.token, { ...cookieOpts, maxAge: s.maxAge }); };
  const payer = async order => stripe ? creerSessionCheckout(stripe, db, order, publicUrl) : `/paiement-test?commande=${order.id}`;

  // --- Public
  app.get('/api/config', (req, res) => res.json({ ...configPublique(db), paiement: stripe ? 'stripe' : 'test' }));

  app.get('/api/ref', (req, res) => {
    const code = req.cookies[REF_COOKIE];
    const r = code ? db.prepare('SELECT prenom, code_parrainage FROM revendeurs WHERE code_parrainage = ?').get(code) : null;
    res.json({ parrain: r ? { prenom: r.prenom, code: r.code_parrainage } : null });
  });

  app.post('/api/pack/devis', (req, res) => {
    const p = prixPack(db, req.body.taille, req.body.items);
    res.json({ taille: p.pack.taille, remise: p.pack.remise, public_ttc_cents: p.public_ttc_cents, ttc_cents: p.ttc_cents, ht_cents: p.ht_cents });
  });

  app.post('/api/checkout/client', wrap(async (req, res) => {
    const order = creerCommandeClient(db, { items: req.body.items, client: req.body.client, refCode: req.cookies[REF_COOKIE] });
    res.json({ commande: order.id, url: await payer(order) });
  }));

  app.get('/api/commandes/:id', (req, res) => {
    const o = getOrder(db, Number(req.params.id));
    if (!o) throw new HttpError(404, 'Commande introuvable');
    res.json({ id: o.id, type: o.type, statut: o.statut, montant_ttc_cents: o.montant_ttc_cents, pack_taille: o.pack_taille });
  });

  // Paiement simulé : uniquement sans Stripe et hors production.
  app.post('/api/dev/commandes/:id/payer', (req, res) => {
    if (stripe || production) throw new HttpError(404, 'Indisponible');
    const fp = typeof req.body?.carte === 'string' && req.body.carte ? `test_${req.body.carte.replace(/\D/g, '').slice(-8)}` : null;
    res.json(marquerPayee(db, Number(req.params.id), { fingerprint: fp }));
  });

  // --- Comptes
  app.post('/api/auth/inscription', (req, res) => {
    const b = req.body;
    const r = inscrire(db, {
      ...b, codeParrain: b.code_parrain || req.cookies[REF_COOKIE], codeParrainExplicite: !!b.code_parrain,
    });
    ouvrirSession(res, r.id);
    res.status(201).json(r);
  });
  app.post('/api/auth/connexion', (req, res) => {
    const s = connecter(db, req.body.email, req.body.password);
    res.cookie(SESSION_COOKIE, s.token, { ...cookieOpts, maxAge: s.maxAge });
    res.json({ ok: true });
  });
  app.post('/api/auth/deconnexion', (req, res) => {
    supprimerSession(db, req.cookies[SESSION_COOKIE] ?? '');
    res.clearCookie(SESSION_COOKIE, cookieOpts).json({ ok: true });
  });
  app.get('/api/me', auth, (req, res) => res.json(req.revendeur));
  app.get('/api/me/dashboard', auth, (req, res) => res.json(dashboard(db, req.revendeur.id, { publicUrl })));

  app.post('/api/checkout/pack', auth, wrap(async (req, res) => {
    const order = creerCommandePack(db, { revendeurId: req.revendeur.id, taille: req.body.taille, items: req.body.items, livraison: req.body.livraison });
    res.json({ commande: order.id, url: await payer(order) });
  }));

  // --- Administration (en-tête X-Admin-Token)
  app.get('/api/admin/commandes', admin, (req, res) => {
    const statut = req.query.statut;
    res.json(db.prepare(`SELECT o.*, r.code_parrainage AS ref_code, a.prenom || ' ' || a.nom AS acheteur
      FROM orders o LEFT JOIN revendeurs r ON r.id = o.revendeur_ref_id LEFT JOIN revendeurs a ON a.id = o.acheteur_revendeur_id
      WHERE (?1 IS NULL OR o.statut = ?1) ORDER BY o.id DESC LIMIT 200`).all(typeof statut === 'string' && statut ? statut : null));
  });
  app.post('/api/admin/commandes/:id/livrer', admin, (req, res) => res.json(marquerLivree(db, Number(req.params.id))));
  app.post('/api/admin/commandes/:id/rembourser', admin, wrap(async (req, res) => {
    const o = getOrder(db, Number(req.params.id));
    if (!o) throw new HttpError(404, 'Commande introuvable');
    if (stripe && o.stripe_payment_intent && o.statut !== 'remboursee') await stripe.refunds.create({ payment_intent: o.stripe_payment_intent });
    res.json(rembourser(db, o.id));
  }));
  app.post('/api/admin/cycle', admin, (req, res) => res.json(cycleCommissions(db)));
  app.get('/api/admin/versements', admin, (req, res) => res.json({
    a_verser: db.prepare(`SELECT r.id AS revendeur_id, r.prenom, r.nom, r.email, SUM(c.montant_cents) AS montant_cents, COUNT(*) AS lignes
      FROM commissions c JOIN revendeurs r ON r.id = c.beneficiaire_id WHERE c.statut = 'payable' GROUP BY r.id ORDER BY montant_cents DESC`).all(),
    historique: db.prepare(`SELECT p.*, r.prenom, r.nom FROM payouts p JOIN revendeurs r ON r.id = p.revendeur_id ORDER BY p.id DESC LIMIT 100`).all(),
  }));
  app.post('/api/admin/versements', admin, (req, res) => {
    const p = verser(db, Number(req.body.revendeur_id), { reference: req.body.reference || null });
    if (!p) throw new HttpError(409, 'Rien à verser');
    res.json(p);
  });
  app.get('/api/admin/signalements', admin, (req, res) => res.json(db.prepare(`SELECT f.*, r.prenom, r.nom, r.code_parrainage
    FROM fraud_flags f LEFT JOIN revendeurs r ON r.id = f.revendeur_id ORDER BY f.resolu, f.id DESC LIMIT 200`).all()));
  app.post('/api/admin/signalements/:id/resoudre', admin, (req, res) => {
    db.prepare('UPDATE fraud_flags SET resolu = 1 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });
  app.get('/api/admin/config', admin, (req, res) => res.json(Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(k => [k, getConfig(db)[k]]))));
  app.put('/api/admin/config/:key', admin, (req, res) => { setConfig(db, req.params.key, req.body.value); res.json({ ok: true }); });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Introuvable' }));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Erreur interne' : err.message });
  });
  return app;
}

