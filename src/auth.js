'use strict';

const crypto = require('crypto');

const SESSION_COOKIE = 'jmr_sessao';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;            // 12 horas
const SESSION_TTL_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias ("lembrar")

// ---------- Senhas (scrypt, nativo do Node) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

// Hash fixo para gastar o mesmo tempo quando o usuário não existe (evita descobrir logins válidos)
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'A senha precisa ter pelo menos 8 caracteres.';
  }
  if (password.length > 200) return 'Senha muito longa.';
  return null;
}

// ---------- Sessões ----------
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createSession(db, userId, remember) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = remember ? SESSION_TTL_REMEMBER_MS : SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + ttl);
  return { token, ttl };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function getSessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.name, u.email, u.username, u.role, u.active, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now() || !row.active) {
    destroySession(db, token);
    return null;
  }
  return row;
}

function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

// ---------- Limite de tentativas de login ----------
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();

function loginKey(ip, login) {
  return `${ip}|${String(login).toLowerCase()}`;
}

function isLoginBlocked(ip, login) {
  const entry = attempts.get(loginKey(ip, login));
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    attempts.delete(loginKey(ip, login));
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function registerFailedLogin(ip, login) {
  const key = loginKey(ip, login);
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count++;
  }
}

function clearFailedLogins(ip, login) {
  attempts.delete(loginKey(ip, login));
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  validatePasswordStrength,
  createSession,
  destroySession,
  getSessionUser,
  purgeExpiredSessions,
  parseCookies,
  isLoginBlocked,
  registerFailedLogin,
  clearFailedLogins,
};
