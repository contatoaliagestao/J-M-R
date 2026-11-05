// Senhas, sessões e limite de tentativas de login (Cloudflare Workers + D1).

export const SESSION_COOKIE = 'jmr_sessao';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;               // 12 horas
const SESSION_TTL_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias ("manter conectado")

// O Cloudflare limita o PBKDF2 a 100.000 iterações
const PBKDF2_ITERATIONS = 100000;
const enc = new TextEncoder();

const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = hex => new Uint8Array(hex.match(/.{2}/g).map(h => parseInt(h, 16)));

function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

function base64url(bytes) {
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

// ---------- Senhas ----------
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'pbkdf2' || !saltHex || !hashHex) return false;
  const actual = new Uint8Array(await pbkdf2(String(password), fromHex(saltHex), Number(iter)));
  return timingSafeEqual(actual, fromHex(hashHex));
}

// Hash fixo para gastar o mesmo tempo quando o usuário não existe (evita descobrir logins válidos)
export const DUMMY_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$${'00'.repeat(16)}$${'00'.repeat(32)}`;

export function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (password.length > 200) return 'Senha muito longa.';
  return null;
}

// ---------- Sessões ----------
export async function sha256(value) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

export async function createSession(db, userId, remember) {
  const token = base64url(randomBytes(32));
  const ttl = remember ? SESSION_TTL_REMEMBER_MS : SESSION_TTL_MS;
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, Date.now() + ttl).run();
  return { token, ttl };
}

export async function destroySession(db, token) {
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

export async function getSessionUser(db, token) {
  if (!token) return null;
  const row = await db.prepare(`
    SELECT u.id, u.name, u.email, u.username, u.role, u.active, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).bind(await sha256(token)).first();
  if (!row) return null;
  if (row.expires_at < Date.now() || !row.active) {
    await destroySession(db, token);
    return null;
  }
  return row;
}

export async function purgeExpired(db) {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
    db.prepare('DELETE FROM login_attempts WHERE first_at < ?').bind(Date.now() - WINDOW_MS),
  ]);
}

export function parseCookies(header) {
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

// ---------- Limite de tentativas de login (guardado no banco) ----------
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const attemptKey = (ip, login) => `${ip}|${String(login).toLowerCase()}`;

export async function isLoginBlocked(db, ip, login) {
  const row = await db.prepare('SELECT count, first_at FROM login_attempts WHERE key = ?').bind(attemptKey(ip, login)).first();
  if (!row || Date.now() - row.first_at > WINDOW_MS) return false;
  return row.count >= MAX_ATTEMPTS;
}

export async function registerFailedLogin(db, ip, login) {
  const now = Date.now();
  await db.prepare(`
    INSERT INTO login_attempts (key, count, first_at) VALUES (?1, 1, ?2)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN ?2 - first_at > ?3 THEN 1 ELSE count + 1 END,
      first_at = CASE WHEN ?2 - first_at > ?3 THEN ?2 ELSE first_at END`)
    .bind(attemptKey(ip, login), now, WINDOW_MS).run();
}

export async function clearFailedLogins(db, ip, login) {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(attemptKey(ip, login)).run();
}
