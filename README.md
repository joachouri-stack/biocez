# Biocez : boutique et réseau de revendeurs

Boutique en ligne et réseau de revendeurs / parrains sur 3 niveaux, avec paiement Stripe et espace personnel.

- **Stack** : Node.js 22 (≥ 22.13), Express 5, SQLite intégré (`node:sqlite`), Stripe Checkout. Pages en HTML/JS sans framework.
- **Montants** : tous en centimes (entiers). Commissions calculées sur le HT (`TTC / (1 + VAT_RATE)`), arrondies au centime par bénéficiaire.

## Démarrer

```bash
npm install
npm run seed     # réseau de démonstration (compte : camille@biocez.test / biocez2026)
npm start        # http://localhost:3000
npm test         # critères d'acceptation
```

Sans `STRIPE_SECRET_KEY`, le paiement est simulé sur `/paiement-test`, **uniquement** si le site tourne en local (`PUBLIC_URL` en `http://localhost`) ; en ligne, il est refusé. L'admin est sur `/admin` avec le jeton `ADMIN_TOKEN` ; s'il est absent, un jeton temporaire est généré et affiché au démarrage. Voir `.env.example`.

Sécurité : cookies `httpOnly` / `SameSite=Lax` (et `Secure` en HTTPS), mots de passe hachés (scrypt), 10 échecs de connexion max par IP sur 15 minutes, comparaison du jeton admin à temps constant.

## Pages

| URL | Rôle |
| --- | --- |
| `/` | Boutique. Avec `?ref=CODE` : choix « Acheter un produit » / « Devenir revendeur » |
| `/panier` | Panier et commande (livraison, paiement par carte) ; un panier latéral s'ouvre après chaque ajout |
| `/produit/fer`, `/produit/vit`, `/produit/pro` | Fiches produit : photo, composition, mention légale, ajout au panier |
| `/revendeur` | Présentation, deux parcours « Commencer gratuitement » / « Démarrer avec un pack » |
| `/inscription`, `/connexion` | Comptes revendeurs (code parrain repris du lien) |
| `/mot-de-passe-oublie`, `/reinitialiser` | Réinitialisation du mot de passe par e-mail |
| `/pack` | Composition d'un pack (mix libre, nombre exact de pots) |
| `/espace` | Espace revendeur en 4 onglets (`#accueil`, `#gains`, `#equipe`, `#simulateur`) : gains du mois, prochain versement, lien à partager, activité en clair, équipe, simulateur |
| `/admin` | Commandes (livrée, remboursement), versements, signalements anti-abus, configuration |

## Règles métier (config modifiable dans `/admin`, table `config`)

| Paramètre | Valeur initiale |
| --- | --- |
| `PACKS` | 10 pots −30 %, 30 pots −40 %, 50 pots −50 % |
| `TAUX_VENTE_CLIENT` | vendeur 20 %, parrain 10 %, parrain du parrain 5 % |
| `TAUX_PACK` | parrain direct 20 %, suivant 10 %, 3e 5 % (l'acheteur ne touche rien) |
| `PACK_COMMISSION_ENABLED` / `PACK_COMMISSION_FIRST_ONLY` | `true` / `true` |
| `PAYOUT_MIN` | 50 € |
| `VAT_RATE` | 0,055 (à confirmer avec l'expert-comptable) |
| `RETRACTATION_JOURS`, `REF_COOKIE_JOURS`, `ACTIF_JOURS` | 14, 30, 30 |
| `DEDUIRE_FRAIS_STRIPE` | `false` |
| `RANGS` | Starter → Diamant (seuils CA **et** filleuls, à ajuster) |

- **Taux figé** : chaque ligne de commission enregistre son taux ; modifier la grille ne touche pas l'historique.
- **Cycle** : `en_attente` (paiement) → `validee` (livrée depuis 14 jours) → `payable` (solde validé ≥ `PAYOUT_MIN`) → `versee` (versement enregistré dans l'admin). Le cycle tourne toutes les heures (et à la demande dans l'admin).
- **Remboursement** (webhook `charge.refunded` ou bouton admin) : lignes annulées ; si une ligne était déjà versée, une régularisation négative est déduite du versement suivant.
- **Parrainage** : cookie `bz_ref` 30 jours, le dernier clic l'emporte ; parrain fixé à l'inscription et verrouillé en base (trigger), donc aucune boucle possible.
- **Client rattaché** (`CLIENT_RATTACHE_DEFINITIF`, activé) : achat sans compte ; le premier achat payé d'un client via un lien rattache son e-mail au revendeur (table `clients`). Ses commandes suivantes lui sont attribuées, même sans lien ou via le lien d'un autre revendeur. Pas de rattachement pour un panier non payé ou un achat bloqué (auto-parrainage) ; annulé si ce premier achat est remboursé sans autre achat payé.
- **Anti auto-parrainage** : même e-mail, même adresse de livraison ou même carte (empreinte Stripe) que le revendeur du lien → aucune commission et signalement ; même nom → signalement seul.
- **Statut** : `inscrit` (sans pack) ou `pack` (dès le premier pack payé). Aucun impact sur les taux.

## E-mails

Envoyés via l'API Brevo (`BREVO_API_KEY`, `MAIL_FROM`) ; sans clé, affichés dans la console. Tous sont journalisés (table `emails`, onglet E-MAILS de l'admin) et un même événement n'est jamais envoyé deux fois. Une panne d'envoi ne bloque jamais le parcours.

| Événement | Destinataire |
| --- | --- |
| Inscription | le nouveau revendeur (lien et code) |
| Inscription via un lien | le parrain (« nouveau filleul ») |
| Commande client payée | le client (récapitulatif) |
| Pack payé | le revendeur |
| Versement enregistré | le revendeur |
| Mot de passe oublié / modifié | le revendeur |

Mot de passe oublié : même réponse que l'e-mail existe ou non, lien valable 1 h et à usage unique (seul son hachage est stocké), 3 demandes max par compte et par heure, 5 par IP sur 15 min ; après changement, toutes les autres sessions sont fermées.

## Structure

```
src/db.js           schéma SQLite, config par défaut
src/commissions.js  moteur de commissions et cycle de vie
src/orders.js       commandes, prix des packs, paiement, livraison, remboursement, anti-abus
src/auth.js         inscription, sessions, codes de parrainage
src/dashboard.js    agrégats de l'espace revendeur
src/stripe.js       Checkout et webhook
src/mail.js         e-mails transactionnels (Brevo)
src/app.js          routes HTTP
public/             pages (contenu produits : public/assets/catalogue.js, photos : public/assets/img/)
maquettes/          maquettes statiques d'origine, archivées (non servies)
test/               critères d'acceptation (node:test)
```

## Hors périmètre / à prévoir

- Virement effectif des versements (aujourd'hui : virement manuel puis « Marquer versé » dans l'admin ; Stripe Connect possible ensuite).
- Remboursements partiels (à traiter manuellement), intégration transporteur pour la date de livraison (et e-mail d'expédition).
- Limite de connexion en mémoire : suffisante pour un seul serveur ; à déplacer (Redis…) si plusieurs instances.
