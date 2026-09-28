import { scryptSync, randomBytes, timingSafeEqual, randomInt } from 'node:crypto';
import { nowIso, addDays, HttpError, tx } from './db.js';

const SESSION_JOURS = 30;

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'), b = scryptSync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function genererCode(db, prenom) {
  const base = String(prenom).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10) || 'BIOCEZ';
  for (;;) {
    let suffixe = '';
    for (let i = 0; i < 4; i++) suffixe += ALPHABET[randomInt(ALPHABET.length)];
    const code = `${base}-${suffixe}`;
    if (!db.prepare('SELECT 1 FROM revendeurs WHERE code_parrainage = ?').get(code)) return code;
  }
}

/**
 * Inscription gratuite. `codeParrain` : code saisi ou issu du cookie ?ref=.
 * Le parrain est fixé ici, une fois pour toutes.
 */
export function inscrire(db, { prenom, nom, email, password, ville, adresse, code_postal, codeParrain, codeParrainExplicite = false, now = new Date() }) {
  prenom = String(prenom ?? '').trim(); nom = String(nom ?? '').trim();
  email = String(email ?? '').trim().toLowerCase();
  if (!prenom || !nom) throw new HttpError(400, 'Prénom et nom requis');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'E-mail invalide');
  if (String(password ?? '').length < 8) throw new HttpError(400, 'Mot de passe : 8 caractères minimum');

  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM revendeurs WHERE email = ?').get(email)) throw new HttpError(409, 'Un compte existe déjà avec cet e-mail');
    let parrain = null;
    if (codeParrain) {
      parrain = db.prepare('SELECT id, email FROM revendeurs WHERE code_parrainage = ?').get(String(codeParrain).trim());
      if (!parrain && codeParrainExplicite) throw new HttpError(400, 'Code parrain inconnu');
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO revendeurs
      (prenom, nom, email, password_hash, ville, adresse, code_postal, code_parrainage, parrain_id, date_inscription)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(prenom, nom, email, hashPassword(password), String(ville ?? '').trim() || null,
      String(adresse ?? '').trim() || null, String(code_postal ?? '').trim() || null, genererCode(db, prenom), parrain?.id ?? null, nowIso(now));
    return getRevendeur(db, Number(lastInsertRowid));
  });
}

export const getRevendeur = (db, id) => db.prepare(`SELECT id, prenom, nom, email, ville, adresse, code_postal, code_parrainage,
  parrain_id, statut, rang, date_inscription, date_premier_pack FROM revendeurs WHERE id = ?`).get(id);

export function connecter(db, email, password) {
  const r = db.prepare('SELECT id, password_hash FROM revendeurs WHERE email = ?').get(String(email ?? '').trim().toLowerCase());
  if (!r || !verifyPassword(String(password ?? ''), r.password_hash)) throw new HttpError(401, 'E-mail ou mot de passe incorrect');
  return creerSession(db, r.id);
}

export function creerSession(db, revendeurId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, revendeur_id, expires_at) VALUES (?, ?, ?)').run(token, revendeurId, nowIso(addDays(new Date(), SESSION_JOURS)));
  return { token, maxAge: SESSION_JOURS * 86400000 };
}

export function revendeurDeSession(db, token) {
  if (!token) return null;
  const s = db.prepare('SELECT revendeur_id FROM sessions WHERE token = ? AND expires_at > ?').get(token, nowIso());
  return s ? getRevendeur(db, s.revendeur_id) : null;
}

export const supprimerSession = (db, token) => db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
