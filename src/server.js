import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { creerStripe } from './stripe.js';
import { cycleCommissions } from './commissions.js';

const db = openDb();
const stripe = creerStripe();
const port = Number(process.env.PORT) || 3000;
// Sans ADMIN_TOKEN : jeton aléatoire valable jusqu'au redémarrage, affiché dans la console.
const adminToken = process.env.ADMIN_TOKEN || randomBytes(12).toString('hex');

const app = createApp({ db, stripe, adminToken });
app.listen(port, process.env.HOST || undefined, () => {
  console.log(`Biocez sur http://localhost:${port}`);
  if (!process.env.ADMIN_TOKEN) console.log(`ADMIN_TOKEN absent : jeton admin temporaire ${adminToken}`);
  if (!stripe) console.log('STRIPE_SECRET_KEY absent : paiements simulés (/paiement-test) en local uniquement.');
});

// Validation (14 jours après livraison), passage en payable, rangs : toutes les heures.
const cycle = () => { try { cycleCommissions(db); } catch (e) { console.error('Cycle commissions :', e); } };
cycle();
setInterval(cycle, 60 * 60 * 1000).unref();
