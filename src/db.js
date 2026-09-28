import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Valeurs initiales de la table `config`. Elles ne sont insérées qu'une fois :
// ensuite, la base fait foi (modifiable depuis l'admin, jamais codée en dur ailleurs).
export const DEFAULT_CONFIG = {
  VAT_RATE: 0.055,
  PACKS: [
    { taille: 10, remise: 0.30 },
    { taille: 30, remise: 0.40 },
    { taille: 50, remise: 0.50 },
  ],
  // Vente client via un lien : [vendeur, parrain direct, parrain du parrain]
  TAUX_VENTE_CLIENT: [0.20, 0.10, 0.05],
  // Achat d'un pack : [parrain direct, parrain du parrain, 3e parrain]
  TAUX_PACK: [0.20, 0.10, 0.05],
  PACK_COMMISSION_ENABLED: true,
  PACK_COMMISSION_FIRST_ONLY: true,
  PAYOUT_MIN: 50,                 // euros
  RETRACTATION_JOURS: 14,
  REF_COOKIE_JOURS: 30,
  // true : un client reste rattaché pour toujours au revendeur de son premier achat payé (via son e-mail)
  CLIENT_RATTACHE_DEFINITIF: true,
  ACTIF_JOURS: 30,
  DEDUIRE_FRAIS_STRIPE: false,
  // Rang atteint quand les deux seuils sont franchis (CA personnel TTC en euros, filleuls tous niveaux)
  RANGS: [
    { nom: 'Starter', ca: 0, filleuls: 0 },
    { nom: 'Bronze', ca: 1000, filleuls: 3 },
    { nom: 'Argent', ca: 5000, filleuls: 10 },
    { nom: 'Or', ca: 15000, filleuls: 25 },
    { nom: 'Platine', ca: 40000, filleuls: 60 },
    { nom: 'Diamant', ca: 100000, filleuls: 150 },
  ],
};

export const DEFAULT_PRODUITS = [
  { id: 'fer', nom: 'Fer & Énergie', prix_ttc_cents: 4290, couleur: '#d85a30' },
  { id: 'vit', nom: 'Mix Vitamines / Boost', prix_ttc_cents: 4790, couleur: '#4c7a3f' },
  { id: 'pro', nom: 'Force & Protéines', prix_ttc_cents: 3790, couleur: '#ba7517' },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS produits (
  id             TEXT PRIMARY KEY,
  nom            TEXT NOT NULL,
  prix_ttc_cents INTEGER NOT NULL,
  couleur        TEXT,
  actif          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS revendeurs (
  id                INTEGER PRIMARY KEY,
  prenom            TEXT NOT NULL,
  nom               TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash     TEXT NOT NULL,
  ville             TEXT,
  adresse           TEXT,
  code_postal       TEXT,
  code_parrainage   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  parrain_id        INTEGER REFERENCES revendeurs(id),
  statut            TEXT NOT NULL DEFAULT 'inscrit' CHECK (statut IN ('inscrit', 'pack')),
  rang              TEXT NOT NULL DEFAULT 'Starter',
  date_inscription  TEXT NOT NULL,
  date_premier_pack TEXT
);
CREATE INDEX IF NOT EXISTS idx_revendeurs_parrain ON revendeurs(parrain_id);

-- Le rattachement filleul -> parrain est définitif : aucune boucle ne peut apparaître,
-- puisqu'un parrain existe toujours avant son filleul et ne peut plus être modifié.
CREATE TRIGGER IF NOT EXISTS revendeurs_parrain_definitif
BEFORE UPDATE OF parrain_id ON revendeurs
WHEN OLD.parrain_id IS NOT NEW.parrain_id
BEGIN
  SELECT RAISE(ABORT, 'Le parrain est définitif');
END;

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  revendeur_id INTEGER NOT NULL REFERENCES revendeurs(id),
  expires_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                    INTEGER PRIMARY KEY,
  type                  TEXT NOT NULL CHECK (type IN ('vente_client', 'pack')),
  client_email          TEXT NOT NULL,
  client_nom            TEXT,
  adresse               TEXT,
  code_postal           TEXT,
  ville                 TEXT,
  revendeur_ref_id      INTEGER REFERENCES revendeurs(id),   -- vente_client : lien utilisé
  acheteur_revendeur_id INTEGER REFERENCES revendeurs(id),   -- pack : revendeur qui achète
  pack_taille           INTEGER,
  remise                REAL NOT NULL DEFAULT 0,
  montant_ttc_cents     INTEGER NOT NULL,
  montant_ht_cents      INTEGER NOT NULL,
  vat_rate              REAL NOT NULL,
  statut                TEXT NOT NULL DEFAULT 'en_attente_paiement'
                        CHECK (statut IN ('en_attente_paiement', 'payee', 'livree', 'remboursee', 'abandonnee')),
  attribution_bloquee   INTEGER NOT NULL DEFAULT 0,
  stripe_session_id     TEXT,
  stripe_payment_intent TEXT,
  payment_fingerprint   TEXT,
  stripe_fee_cents      INTEGER,
  created_at            TEXT NOT NULL,
  paid_at               TEXT,
  delivered_at          TEXT,
  refunded_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_ref ON orders(revendeur_ref_id);
CREATE INDEX IF NOT EXISTS idx_orders_acheteur ON orders(acheteur_revendeur_id);
CREATE INDEX IF NOT EXISTS idx_orders_pi ON orders(stripe_payment_intent);

CREATE TABLE IF NOT EXISTS order_items (
  id                      INTEGER PRIMARY KEY,
  order_id                INTEGER NOT NULL REFERENCES orders(id),
  produit_id              TEXT NOT NULL REFERENCES produits(id),
  quantite                INTEGER NOT NULL CHECK (quantite > 0),
  prix_unitaire_ttc_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS payouts (
  id             INTEGER PRIMARY KEY,
  revendeur_id   INTEGER NOT NULL REFERENCES revendeurs(id),
  montant_cents  INTEGER NOT NULL,
  reference      TEXT,
  date_versement TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commissions (
  id              INTEGER PRIMARY KEY,
  order_id        INTEGER NOT NULL REFERENCES orders(id),
  beneficiaire_id INTEGER NOT NULL REFERENCES revendeurs(id),
  niveau          INTEGER NOT NULL,           -- vente_client : 0 vendeur, 1, 2 · pack : 1, 2, 3
  taux            REAL NOT NULL,              -- figé au moment de la vente
  base_ht_cents   INTEGER NOT NULL,
  montant_cents   INTEGER NOT NULL,           -- négatif pour une régularisation
  regularisation  INTEGER NOT NULL DEFAULT 0,
  statut          TEXT NOT NULL DEFAULT 'en_attente'
                  CHECK (statut IN ('en_attente', 'validee', 'payable', 'versee', 'annulee')),
  payout_id       INTEGER REFERENCES payouts(id),
  created_at      TEXT NOT NULL,
  validated_at    TEXT,
  payable_at      TEXT,
  paid_at         TEXT,
  cancelled_at    TEXT,
  UNIQUE (order_id, beneficiaire_id, niveau, regularisation)
);
CREATE INDEX IF NOT EXISTS idx_commissions_benef ON commissions(beneficiaire_id, statut);

CREATE TABLE IF NOT EXISTS referral_clicks (
  id           INTEGER PRIMARY KEY,
  revendeur_id INTEGER NOT NULL REFERENCES revendeurs(id),
  landing      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clicks_rev ON referral_clicks(revendeur_id, created_at);

-- Client rattaché : l'e-mail d'un client est lié au revendeur de son premier achat payé via un lien.
CREATE TABLE IF NOT EXISTS clients (
  email          TEXT PRIMARY KEY COLLATE NOCASE,
  revendeur_id   INTEGER NOT NULL REFERENCES revendeurs(id),
  first_order_id INTEGER NOT NULL REFERENCES orders(id),
  attached_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_rev ON clients(revendeur_id);

CREATE TABLE IF NOT EXISTS emails (
  id           INTEGER PRIMARY KEY,
  cle          TEXT UNIQUE,                -- événement (ex. commande:12) : jamais deux envois
  modele       TEXT NOT NULL,
  destinataire TEXT NOT NULL,
  sujet        TEXT NOT NULL,
  statut       TEXT NOT NULL CHECK (statut IN ('en_cours', 'envoye', 'erreur')),
  erreur       TEXT,
  created_at   TEXT NOT NULL,
  sent_at      TEXT
);

-- Jetons de réinitialisation : seul le hachage SHA-256 est stocké.
CREATE TABLE IF NOT EXISTS password_resets (
  id           INTEGER PRIMARY KEY,
  revendeur_id INTEGER NOT NULL REFERENCES revendeurs(id),
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_resets_rev ON password_resets(revendeur_id, created_at);

CREATE TABLE IF NOT EXISTS fraud_flags (
  id           INTEGER PRIMARY KEY,
  order_id     INTEGER REFERENCES orders(id),
  revendeur_id INTEGER REFERENCES revendeurs(id),
  raison       TEXT NOT NULL,
  bloquant     INTEGER NOT NULL DEFAULT 1,
  resolu       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
`;

export function openDb(file = process.env.DATABASE_PATH || 'data/biocez.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const insConf = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) insConf.run(k, JSON.stringify(v));
  const insProd = db.prepare('INSERT OR IGNORE INTO produits (id, nom, prix_ttc_cents, couleur) VALUES (?, ?, ?, ?)');
  for (const p of DEFAULT_PRODUITS) insProd.run(p.id, p.nom, p.prix_ttc_cents, p.couleur);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getConfig(db) {
  const cfg = { ...DEFAULT_CONFIG };
  for (const { key, value } of db.prepare('SELECT key, value FROM config').all()) cfg[key] = JSON.parse(value);
  return cfg;
}

export function setConfig(db, key, value) {
  if (!(key in DEFAULT_CONFIG)) throw new HttpError(400, `Paramètre inconnu : ${key}`);
  validateConfigValue(key, value);
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function validateConfigValue(key, v) {
  const rate = x => typeof x === 'number' && x >= 0 && x < 1;
  const ok = {
    VAT_RATE: () => rate(v),
    PACKS: () => Array.isArray(v) && v.length > 0 && v.every(p => Number.isInteger(p.taille) && p.taille > 0 && rate(p.remise)),
    TAUX_VENTE_CLIENT: () => Array.isArray(v) && v.length <= 3 && v.every(rate),
    TAUX_PACK: () => Array.isArray(v) && v.length <= 3 && v.every(rate),
    RANGS: () => Array.isArray(v) && v.length > 0 && v.every(r => r.nom && r.ca >= 0 && r.filleuls >= 0),
  }[key] ?? (() => typeof v === typeof DEFAULT_CONFIG[key]);
  if (!ok()) throw new HttpError(400, `Valeur invalide pour ${key}`);
}

export const getProduits = db => db.prepare('SELECT * FROM produits WHERE actif = 1 ORDER BY rowid').all();

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const nowIso = (d = new Date()) => d.toISOString();
export const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
