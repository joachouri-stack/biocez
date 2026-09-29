import { scryptSync, randomBytes, timingSafeEqual, randomInt, createHash } from 'node:crypto';
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
/** Version des conditions revendeur et de la politique de confidentialité (à changer à chaque mise à jour des textes). */
export const CONDITIONS_VERSION = '2026-09-29';

export function inscrire(db, { prenom, nom, email, password, ville, adresse, code_postal, codeParrain, codeParrainExplicite = false,
  conditionsVersion = null, now = new Date() }) {
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
      (prenom, nom, email, password_hash, ville, adresse, code_postal, code_parrainage, parrain_id, date_inscription, cgu_version, cgu_acceptees_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(prenom, nom, email, hashPassword(password), String(ville ?? '').trim() || null,
      String(adresse ?? '').trim() || null, String(code_postal ?? '').trim() || null, genererCode(db, prenom), parrain?.id ?? null, nowIso(now),
      conditionsVersion, conditionsVersion ? nowIso(now) : null);
    return getRevendeur(db, Number(lastInsertRowid));
  });
}

/**
 * Connexion ou inscription avec un compte Google déjà vérifié (jeton contrôlé par l'appelant).
 * - compte déjà lié à ce Google : connexion ;
 * - compte existant avec le même e-mail (vérifié par Google) : on le lie, puis connexion ;
 * - sinon : inscription, seulement si les conditions sont acceptées (sinon erreur « inscription_requise »).
 * @returns {{ revendeur: object, nouveau: boolean }}
 */
export function connexionGoogle(db, profil, { accepteConditions = false, codeParrain = null, codeParrainExplicite = false, now = new Date() } = {}) {
  const sub = String(profil?.sub ?? ''), email = String(profil?.email ?? '').trim().toLowerCase();
  if (!sub || !email || profil.email_verified !== true) throw new HttpError(401, 'Compte Google non vérifié');
  const lie = db.prepare('SELECT id FROM revendeurs WHERE google_sub = ?').get(sub);
  if (lie) return { revendeur: getRevendeur(db, lie.id), nouveau: false };
  const parEmail = db.prepare('SELECT id FROM revendeurs WHERE email = ?').get(email);
  if (parEmail) {
    db.prepare('UPDATE revendeurs SET google_sub = ? WHERE id = ?').run(sub, parEmail.id);
    return { revendeur: getRevendeur(db, parEmail.id), nouveau: false };
  }
  if (!accepteConditions) {
    const e = new HttpError(409, 'Aucun compte Biocez avec cette adresse Google. Créez votre compte gratuit en acceptant les conditions.');
    e.code = 'inscription_requise';
    throw e;
  }
  const prenom = String(profil.given_name || profil.name || email.split('@')[0]).trim();
  const nom = String(profil.family_name || '').trim() || '-';
  // Mot de passe aléatoire inutilisable : le revendeur peut en choisir un plus tard via « Mot de passe oublié ».
  const r = inscrire(db, { prenom, nom, email, password: randomBytes(24).toString('base64url'), codeParrain, codeParrainExplicite,
    conditionsVersion: CONDITIONS_VERSION, now });
  db.prepare('UPDATE revendeurs SET google_sub = ? WHERE id = ?').run(sub, r.id);
  return { revendeur: getRevendeur(db, r.id), nouveau: true };
}

export const getRevendeur = (db, id) => db.prepare(`SELECT id, prenom, nom, email, ville, adresse, code_postal, code_parrainage,
  parrain_id, statut, rang, date_inscription, date_premier_pack, classement_visible FROM revendeurs WHERE id = ?`).get(id);

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

// --- Mot de passe oublié
export const RESET_MINUTES = 60;
const RESET_MAX_PAR_HEURE = 3;
const sha256 = t => createHash('sha256').update(t).digest('hex');

/**
 * Crée un jeton de réinitialisation. Renvoie null (sans erreur) si l'e-mail est inconnu
 * ou si trop de demandes ont été faites : la réponse HTTP ne doit rien révéler.
 */
export function demanderReinitialisation(db, email, now = new Date()) {
  const r = db.prepare('SELECT id, prenom, email FROM revendeurs WHERE email = ?').get(String(email ?? '').trim().toLowerCase());
  if (!r) return null;
  const recentes = db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE revendeur_id = ? AND created_at > ?')
    .get(r.id, nowIso(new Date(now.getTime() - 3600000))).n;
  if (recentes >= RESET_MAX_PAR_HEURE) return null;
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO password_resets (revendeur_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(r.id, sha256(token), nowIso(now), nowIso(new Date(now.getTime() + RESET_MINUTES * 60000)));
  return { revendeur: r, token };
}

const resetValide = (db, token, now) => db.prepare(`SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
  .get(sha256(String(token ?? '')), nowIso(now));

export const verifierJetonReset = (db, token, now = new Date()) => !!resetValide(db, token, now);

/** Change le mot de passe, invalide le jeton et tous les autres jetons, ferme toutes les sessions. */
export function reinitialiser(db, token, password, now = new Date()) {
  if (String(password ?? '').length < 8) throw new HttpError(400, 'Mot de passe : 8 caractères minimum');
  return tx(db, () => {
    const reset = resetValide(db, token, now);
    if (!reset) throw new HttpError(400, 'Lien invalide ou expiré. Faites une nouvelle demande.');
    db.prepare('UPDATE revendeurs SET password_hash = ? WHERE id = ?').run(hashPassword(password), reset.revendeur_id);
    db.prepare('UPDATE password_resets SET used_at = ? WHERE revendeur_id = ? AND used_at IS NULL').run(nowIso(now), reset.revendeur_id);
    db.prepare('DELETE FROM sessions WHERE revendeur_id = ?').run(reset.revendeur_id);
    return getRevendeur(db, reset.revendeur_id);
  });
}
