import { nowIso } from './db.js';
import { getOrderItems } from './orders.js';

/*
 * E-mails transactionnels.
 * - Envoi via l'API Brevo (BREVO_API_KEY) ; sans clé, les e-mails sont affichés dans la console.
 * - Chaque e-mail est journalisé dans la table `emails`. La colonne `cle` est unique :
 *   un même événement (ex. « commande:12 ») ne déclenche jamais deux envois,
 *   même si le webhook Stripe est rejoué.
 * - Un échec d'envoi n'interrompt jamais le parcours de l'utilisateur.
 */

const fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const eur = c => fmt.format(c / 100);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function transportBrevo(apiKey) {
  return async ({ from, to, subject, html, text }) => {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: from, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Brevo ${res.status} : ${(await res.text()).slice(0, 300)}`);
  };
}

export const transportConsole = async ({ to, subject, text }) => {
  console.log(`\n[e-mail non envoyé : BREVO_API_KEY absent]\nÀ : ${to}\nObjet : ${subject}\n${text}\n`);
};

function parseFrom(s) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(s ?? '');
  return m ? { name: m[1] || 'Biocez', email: m[2] } : { name: 'Biocez', email: s || 'contact@biocez.com' };
}

/** Mise en page commune : en-tête noir, logo doré, bouton d'action. */
function layout({ titre, intro, lignes = [], bouton, apres = [] }) {
  const p = t => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#2b2a26">${t}</p>`;
  const html = `<!DOCTYPE html><html lang="fr"><body style="margin:0;background:#f7f4ee;font-family:Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ee;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e2ddd0">
<tr><td style="background:#0e0e0d;padding:22px 28px;font-family:'Courier New',monospace;font-weight:bold;letter-spacing:2px;color:#d4af5a;font-size:16px">BIOCEZ</td></tr>
<tr><td style="padding:30px 28px 12px">
<h1 style="margin:0 0 16px;font-size:21px;color:#0e0e0d">${esc(titre)}</h1>
${p(intro)}${lignes.map(p).join('')}
${bouton ? `<p style="margin:24px 0"><a href="${esc(bouton.url)}" style="display:inline-block;background:#d4af5a;color:#241a05;text-decoration:none;font-family:'Courier New',monospace;font-weight:bold;font-size:13px;padding:14px 22px;border-radius:3px">${esc(bouton.texte)} →</a></p>` : ''}
${apres.map(p).join('')}
</td></tr>
<tr><td style="padding:18px 28px 26px;border-top:1px solid #efece3;font-size:12px;color:#8a8577;line-height:1.5">Biocez · Compléments alimentaires · Avignon, France<br>Cet e-mail vous est envoyé suite à une action sur biocez.com.</td></tr>
</table></td></tr></table></body></html>`;
  const strip = t => t.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [titre, '', intro, ...lignes, ...(bouton ? ['', `${bouton.texte} : ${bouton.url}`] : []), ...apres, '', '— Biocez'].map(strip).join('\n');
  return { html, text };
}

const tableau = rows => `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">${rows.map(([a, b, gras]) =>
  `<tr><td style="padding:8px 0;border-bottom:1px solid #efece3;${gras ? 'font-weight:bold' : ''}">${a}</td><td style="padding:8px 0;border-bottom:1px solid #efece3;text-align:right;font-family:'Courier New',monospace;${gras ? 'font-weight:bold' : ''}">${b}</td></tr>`).join('')}</table>`;

/** Modèles : chacun renvoie { sujet, titre, intro, lignes?, bouton?, apres? }. */
const MODELES = {
  bienvenue: ({ r, url }) => ({
    sujet: 'Bienvenue dans le réseau Biocez',
    titre: `Bienvenue ${r.prenom} !`,
    intro: 'Votre compte revendeur est actif. Inscription gratuite, sans pack obligatoire : vous pouvez vendre et parrainer dès maintenant.',
    lignes: [
      `Votre code de parrainage : <b style="font-family:'Courier New',monospace">${esc(r.code_parrainage)}</b>`,
      `Votre lien personnel : <a href="${esc(url)}/?ref=${esc(r.code_parrainage)}" style="color:#ba7517">${esc(url)}/?ref=${esc(r.code_parrainage)}</a>`,
      'Chaque client qui commande via ce lien vous rapporte 20 % du montant HT, et chaque personne qui s’inscrit via ce lien devient votre filleul.',
    ],
    bouton: { texte: 'MON ESPACE', url: `${url}/espace` },
  }),

  nouveau_filleul: ({ parrain, filleul, url }) => ({
    sujet: `Nouveau filleul : ${filleul.prenom} a rejoint votre réseau`,
    titre: 'Un nouveau filleul dans votre réseau',
    intro: `${esc(filleul.prenom)} ${esc(filleul.nom.slice(0, 1))}. vient de s’inscrire avec votre lien. Il ou elle est désormais votre filleul direct (niveau 1), de façon définitive.`,
    lignes: ['Vous toucherez une commission sur ses ventes clients et sur son premier pack s’il en prend un.'],
    bouton: { texte: 'VOIR MES FILLEULS', url: `${url}/espace#filleuls` },
  }),

  commande: ({ o, items, url }) => ({
    sujet: `Confirmation de votre commande n° ${o.id}`,
    titre: 'Merci pour votre commande',
    intro: `Bonjour ${esc(o.client_nom)}, nous avons bien reçu votre paiement. Votre commande n° ${o.id} est en préparation.`,
    lignes: [tableau([
      ...items.map(i => [`${i.quantite} × ${esc(i.nom)}`, eur(i.quantite * i.prix_unitaire_ttc_cents)]),
      ['Total TTC', eur(o.montant_ttc_cents), true],
    ]), `Livraison : ${esc(o.adresse)}, ${esc(o.code_postal)} ${esc(o.ville)}`],
    apres: ['Vous disposez de 14 jours après réception pour exercer votre droit de rétractation.'],
    bouton: { texte: 'RETOUR À LA BOUTIQUE', url },
  }),

  pack: ({ o, items, url }) => ({
    sujet: `Votre pack ${o.pack_taille} est confirmé`,
    titre: `Pack ${o.pack_taille} confirmé`,
    intro: `Nous avons bien reçu votre paiement pour votre pack de démarrage (commande n° ${o.id}). Il est en préparation.`,
    lignes: [tableau([
      ...items.map(i => [esc(i.nom), `${i.quantite} pot${i.quantite > 1 ? 's' : ''}`]),
      [`Remise pack`, `-${Math.round(o.remise * 100)} %`],
      ['Total TTC', eur(o.montant_ttc_cents), true],
    ]), `Livraison : ${esc(o.adresse)}, ${esc(o.code_postal)} ${esc(o.ville)}`],
    bouton: { texte: 'MON ESPACE', url: `${url}/espace` },
  }),

  versement: ({ r, p, url }) => ({
    sujet: `Versement de vos commissions : ${eur(p.montant_cents)}`,
    titre: 'Vos commissions ont été versées',
    intro: `Bonjour ${esc(r.prenom)}, un versement de <b>${eur(p.montant_cents)}</b> vient d’être effectué sur votre compte.`,
    lignes: p.reference ? [`Référence : <span style="font-family:'Courier New',monospace">${esc(p.reference)}</span>`] : [],
    bouton: { texte: 'VOIR MES GAINS', url: `${url}/espace#gains` },
  }),

  mot_de_passe_oublie: ({ r, lien, minutes }) => ({
    sujet: 'Réinitialisation de votre mot de passe Biocez',
    titre: 'Réinitialiser votre mot de passe',
    intro: `Bonjour ${esc(r.prenom)}, vous avez demandé à réinitialiser le mot de passe de votre compte Biocez.`,
    bouton: { texte: 'CHOISIR UN NOUVEAU MOT DE PASSE', url: lien },
    apres: [`Ce lien est valable ${minutes} minutes et ne peut servir qu’une fois.`, 'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail : votre mot de passe reste inchangé.'],
  }),

  mot_de_passe_modifie: ({ r, url }) => ({
    sujet: 'Votre mot de passe a été modifié',
    titre: 'Mot de passe modifié',
    intro: `Bonjour ${esc(r.prenom)}, le mot de passe de votre compte Biocez vient d’être modifié. Toutes vos autres sessions ont été déconnectées.`,
    apres: [`Si vous n’êtes pas à l’origine de ce changement, réinitialisez immédiatement votre mot de passe : <a href="${esc(url)}/mot-de-passe-oublie" style="color:#ba7517">${esc(url)}/mot-de-passe-oublie</a>, puis contactez-nous.`],
  }),
};

export function creerMailer(db, {
  apiKey = process.env.BREVO_API_KEY, from = process.env.MAIL_FROM || 'Biocez <contact@biocez.com>',
  publicUrl = process.env.PUBLIC_URL || 'http://localhost:3000', transport = null,
} = {}) {
  const envoyerBrut = transport ?? (apiKey ? transportBrevo(apiKey) : transportConsole);
  const sender = parseFrom(from);

  /**
   * @param {string|null} cle  identifiant de l'événement (null = pas de dédoublonnage)
   * @returns {Promise<boolean>} true si l'e-mail est parti
   */
  async function envoyer(cle, to, modele, data) {
    let id;
    try {
      const m = MODELES[modele]({ ...data, url: publicUrl });
      const { html, text } = layout(m);
      const ins = db.prepare(`INSERT OR IGNORE INTO emails (cle, modele, destinataire, sujet, statut, created_at)
        VALUES (?, ?, ?, ?, 'en_cours', ?)`).run(cle, modele, to, m.sujet, nowIso());
      if (!ins.changes) return false;
      id = Number(ins.lastInsertRowid);
      await envoyerBrut({ from: sender, to, subject: m.sujet, html, text });
      db.prepare(`UPDATE emails SET statut = 'envoye', sent_at = ? WHERE id = ?`).run(nowIso(), id);
      return true;
    } catch (e) {
      console.error(`E-mail « ${modele} » à ${to} :`, e.message);
      if (id) db.prepare(`UPDATE emails SET statut = 'erreur', erreur = ? WHERE id = ?`).run(String(e.message).slice(0, 500), id);
      return false;
    }
  }

  return {
    envoyer,
    mode: transport ? 'personnalise' : apiKey ? 'brevo' : 'console',

    bienvenue: r => envoyer(`bienvenue:${r.id}`, r.email, 'bienvenue', { r }),

    nouveauFilleul: filleul => {
      if (!filleul.parrain_id) return Promise.resolve(false);
      const parrain = db.prepare('SELECT id, prenom, email FROM revendeurs WHERE id = ?').get(filleul.parrain_id);
      return envoyer(`filleul:${filleul.id}`, parrain.email, 'nouveau_filleul', { parrain, filleul });
    },

    /** Après un paiement confirmé : confirmation au client ou au revendeur (pack). */
    commandePayee: o => {
      if (!o || !['payee', 'livree'].includes(o.statut)) return Promise.resolve(false);
      const items = getOrderItems(db, o.id);
      return envoyer(`commande:${o.id}`, o.client_email, o.type === 'pack' ? 'pack' : 'commande', { o, items });
    },

    versement: p => {
      const r = db.prepare('SELECT prenom, email FROM revendeurs WHERE id = ?').get(p.revendeur_id);
      return envoyer(`versement:${p.id}`, r.email, 'versement', { r, p });
    },

    motDePasseOublie: (r, lien, minutes) => envoyer(null, r.email, 'mot_de_passe_oublie', { r, lien, minutes }),
    motDePasseModifie: r => envoyer(null, r.email, 'mot_de_passe_modifie', { r }),
  };
}
