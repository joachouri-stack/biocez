import Stripe from 'stripe';
import { getOrderItems, marquerPayee, rembourser } from './orders.js';

export function creerStripe(secretKey = process.env.STRIPE_SECRET_KEY) {
  return secretKey ? new Stripe(secretKey) : null;
}

/** Session Stripe Checkout (CB). Les prix sont TTC ; la commande est retrouvée via metadata.order_id. */
export async function creerSessionCheckout(stripe, db, order, baseUrl) {
  const items = getOrderItems(db, order.id);
  const line_items = order.type === 'pack'
    ? [{
        quantity: 1,
        price_data: {
          currency: 'eur', unit_amount: order.montant_ttc_cents, tax_behavior: 'inclusive',
          product_data: {
            name: `Pack ${order.pack_taille} Biocez (-${Math.round(order.remise * 100)} %)`,
            description: items.map(i => `${i.quantite} x ${i.nom}`).join(', '),
          },
        },
      }]
    : items.map(i => ({
        quantity: i.quantite,
        price_data: { currency: 'eur', unit_amount: i.prix_unitaire_ttc_cents, tax_behavior: 'inclusive', product_data: { name: i.nom } },
      }));
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: order.client_email,
    line_items,
    locale: 'fr',
    metadata: { order_id: String(order.id) },
    payment_intent_data: { metadata: { order_id: String(order.id) } },
    success_url: `${baseUrl}/merci?ref=${order.ref}`,
    cancel_url: `${baseUrl}/${order.type === 'pack' ? 'pack' : 'panier'}?annule=1`,
  });
  db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, order.id);
  return session.url;
}

/** Webhook Stripe : paiement confirmé -> commissions ; remboursement total -> annulation. */
export async function traiterWebhook(stripe, db, rawBody, signature, secret = process.env.STRIPE_WEBHOOK_SECRET, mailer = null) {
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const s = event.data.object;
      if (s.payment_status !== 'paid') break;
      const orderId = Number(s.metadata?.order_id);
      const pi = await stripe.paymentIntents.retrieve(s.payment_intent, { expand: ['payment_method', 'latest_charge.balance_transaction'] });
      const o = marquerPayee(db, orderId, {
        paymentIntent: pi.id,
        fingerprint: pi.payment_method?.card?.fingerprint ?? null,
        feeCents: pi.latest_charge?.balance_transaction?.fee ?? null,
      });
      await mailer?.commandePayee(o);
      break;
    }
    case 'charge.refunded': {
      const ch = event.data.object;
      if (!ch.refunded) break; // remboursement partiel : à traiter manuellement depuis l'admin
      const o = db.prepare('SELECT id FROM orders WHERE stripe_payment_intent = ?').get(ch.payment_intent);
      if (o) rembourser(db, o.id);
      break;
    }
  }
  return event.type;
}
