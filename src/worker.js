// Servidor do sistema JMR para Cloudflare Workers (API + banco D1).
// As telas (pasta public/) são servidas pelo próprio Cloudflare como arquivos estáticos.

import { Hono } from 'hono';
import * as auth from './auth.js';
import * as finance from './finance.js';
import { parseOfx, suggestMatch } from './ofx.js';
import STATIC_FILES from './generated/static.js';

const COLOR_THEMES = ['amber', 'emerald', 'blue', 'rose', 'purple', 'cyan', 'orange'];
const ROLES_ASSIGNABLE = ['GESTOR', 'OPERADOR'];
const PAYMENT_CHANNELS = ['DINHEIRO', 'PIX_MANUAL'];
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- Validação ----------
function str(value, { field, max = 200, required = false } = {}) {
  const v = typeof value === 'string' ? value.trim() : (value == null ? '' : String(value).trim());
  if (required && !v) throw new HttpError(400, `Preencha o campo: ${field}.`);
  if (v.length > max) throw new HttpError(400, `O campo ${field} é muito longo (máx. ${max}).`);
  return v;
}

function moneyToCents(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `Valor inválido em: ${field}.`);
  if (n > 100_000_000) throw new HttpError(400, `Valor muito alto em: ${field}.`);
  return Math.round(n * 100);
}

function percent(value, field, { min = 0, max = 1000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Percentual inválido em: ${field}.`);
  return Math.round(n * 10000) / 10000;
}

function validateLogo(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return '';
  if (v.length > 700_000) throw new HttpError(400, 'Logotipo muito grande (máx. ~500 KB).');
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(v)) return v;
  if (/^https:\/\/[^\s"'<>]+$/i.test(v)) return v;
  throw new HttpError(400, 'Logotipo inválido: use um link https ou envie uma imagem.');
}

function makePrefix(shortName) {
  const letters = shortName.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').toUpperCase();
  return (letters.slice(0, 3) || 'EMP').padEnd(3, 'X');
}

function companyInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.official_name !== undefined) out.official_name = str(body.official_name, { field: 'Razão social', required: true });
  if (!partial || body.short_name !== undefined) out.short_name = str(body.short_name, { field: 'Nome fantasia', required: true, max: 60 });
  if (!partial || body.tagline !== undefined) out.tagline = str(body.tagline, { field: 'Subtítulo', max: 80 });
  if (!partial || body.cnpj !== undefined) out.cnpj = str(body.cnpj, { field: 'CNPJ', max: 20 });
  if (!partial || body.color_theme !== undefined) out.color_theme = COLOR_THEMES.includes(body.color_theme) ? body.color_theme : 'amber';
  if (!partial || body.logo_url !== undefined) out.logo_url = validateLogo(body.logo_url);
  return out;
}

const brl = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brDate = iso => iso.split('-').reverse().join('/');

// ---------- Ajudantes de banco ----------
// Se o comando anterior do lote não alterou exatamente 1 linha, aborta o lote inteiro (nada é gravado).
const guard = db => db.prepare('INSERT INTO _guard (ok) SELECT changes() WHERE changes() != 1');

async function atomic(db, statements, conflictMessage) {
  try {
    return await db.batch(statements);
  } catch (err) {
    const msg = String(err && (err.cause?.message || err.message));
    if (msg.includes('CHECK constraint failed') && msg.includes('ok = 1')) throw new HttpError(409, conflictMessage);
    if (msg.includes('UNIQUE constraint failed')) throw new HttpError(409, 'Registro duplicado.');
    throw err;
  }
}

function occurrenceStmt(db, contractIdOrSql, user, text) {
  return db.prepare(`INSERT INTO occurrences (contract_id, user_id, author_name, author_role, text) VALUES (${contractIdOrSql}, ?, ?, ?, ?)`)
    .bind(user ? user.id : null, user ? user.name : 'Sistema', user ? user.role : 'SISTEMA', text);
}

function publicCompany(c) {
  return {
    id: c.id, official_name: c.official_name, short_name: c.short_name, tagline: c.tagline,
    cnpj: c.cnpj, color_theme: c.color_theme, logo_url: c.logo_url, code_prefix: c.code_prefix,
  };
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email || null, username: u.username || null, role: u.role };
}

function contractView(c, today, agreement = null) {
  const debt = finance.calculateDebt(c, today);
  let situation = debt.overdueDays > 0 ? 'ATRASADO' : 'EM_DIA';
  if (c.status === 'QUITADO') situation = 'QUITADO';
  else if (c.in_agreement) situation = 'ACORDO';
  return {
    id: c.id, code: c.code, client_name: c.client_name, cpf: c.cpf, phone: c.phone,
    address: c.address, social_media: c.social_media,
    principal_cents: c.principal_cents, rate: c.rate, late_fee_rate: c.late_fee_rate,
    cycle_days: c.cycle_days, start_date: c.start_date, due_date: c.due_date,
    status: c.status, rollover_count: c.rollover_count, settled_at: c.settled_at,
    in_agreement: !!c.in_agreement,
    situation,
    debt,
    agreement: c.in_agreement ? agreement : null,
  };
}

// Resumo dos acordos ATIVOS de uma empresa (ou de um contrato), por contrato.
async function agreementSummaries(db, companyId, today, contractId = null) {
  const rows = (await db.prepare(`
    SELECT a.id AS agreement_id, a.contract_id, a.total_cents, a.debt_at_agreement_cents, a.principal_at_agreement_cents,
           a.notes, a.created_at, a.replaces_id,
           COALESCE((SELECT SUM(principal_cents) FROM ledger WHERE agreement_id = a.id), 0) AS principal_recovered_cents,
           i.id AS inst_id, i.number, i.due_date, i.amount_cents, i.status, i.paid_cents, i.paid_at, i.channel, i.notes AS inst_notes
    FROM agreements a JOIN agreement_installments i ON i.agreement_id = a.id
    WHERE a.company_id = ? AND a.status = 'ATIVO' ${contractId ? 'AND a.contract_id = ?' : ''}
    ORDER BY a.id, i.number`).bind(...(contractId ? [companyId, contractId] : [companyId])).all()).results;

  const map = new Map();
  for (const r of rows) {
    let a = map.get(r.contract_id);
    if (!a) {
      a = {
        id: r.agreement_id, contract_id: r.contract_id, total_cents: r.total_cents,
        debt_at_agreement_cents: r.debt_at_agreement_cents, discount_cents: Math.max(0, r.debt_at_agreement_cents - r.total_cents),
        principal_pending_cents: Math.max(0, r.principal_at_agreement_cents - r.principal_recovered_cents),
        notes: r.notes, created_at: r.created_at, renegotiated: !!r.replaces_id,
        paid_cents: 0, remaining_cents: 0, installments_count: 0, paid_count: 0,
        overdue_count: 0, overdue_cents: 0, next_installment: null, installments: [],
      };
      map.set(r.contract_id, a);
    }
    a.installments_count++;
    const inst = {
      id: r.inst_id, number: r.number, due_date: r.due_date, amount_cents: r.amount_cents, status: r.status,
      paid_cents: r.paid_cents, paid_at: r.paid_at, channel: r.channel, notes: r.inst_notes,
      overdue_days: r.status === 'PENDENTE' ? Math.max(0, finance.diffDaysIso(today, r.due_date)) : 0,
    };
    a.installments.push(inst);
    if (r.status === 'PAGO') {
      a.paid_count++;
      a.paid_cents += r.paid_cents;
    } else {
      a.remaining_cents += r.amount_cents;
      if (!a.next_installment) a.next_installment = inst;
      if (inst.overdue_days > 0) { a.overdue_count++; a.overdue_cents += r.amount_cents; }
    }
  }
  return map;
}

async function allowedCompanies(db, user) {
  const r = user.role === 'ADMIN'
    ? await db.prepare('SELECT * FROM companies ORDER BY id').all()
    : await db.prepare(`SELECT c.* FROM companies c JOIN user_companies uc ON uc.company_id = c.id
        WHERE uc.user_id = ? ORDER BY c.id`).bind(user.id).all();
  return r.results;
}

async function getContract(db, companyId, contractId) {
  const c = await db.prepare('SELECT * FROM contracts WHERE id = ? AND company_id = ?').bind(Number(contractId), companyId).first();
  if (!c) throw new HttpError(404, 'Contrato não encontrado.');
  return c;
}

async function readJson(c) {
  try { return (await c.req.json()) || {}; } catch { throw new HttpError(400, 'Dados inválidos.'); }
}

// ---------- Aplicação ----------
const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Erro interno. Tente novamente.' }, 500);
});

// Cabeçalhos de segurança + proteção CSRF (alterações só aceitam JSON) + usuário da sessão
app.use('/api/*', async (c, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)
      && !(c.req.header('content-type') || '').toLowerCase().startsWith('application/json')) {
    return c.json({ error: 'Requisição inválida.' }, 415);
  }
  const db = c.env.DB;
  const token = auth.parseCookies(c.req.header('cookie'))[auth.SESSION_COOKIE];
  c.set('db', db);
  c.set('token', token);
  c.set('user', await auth.getSessionUser(db, token));
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'same-origin');
  c.header('Cache-Control', 'no-store');
});

const secureFlag = c => (new URL(c.req.url).protocol === 'https:' ? '; Secure' : '');
function setSessionCookie(c, token, ttlMs) {
  c.header('Set-Cookie', `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${secureFlag(c)}`);
}
function clearSessionCookie(c) {
  c.header('Set-Cookie', `${auth.SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(c)}`);
}

const maxCompanies = c => Number(c.env.MAX_EMPRESAS || 3);
const clientIp = c => c.req.header('cf-connecting-ip') || '';

const requireAuth = async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Sessão expirada. Faça login novamente.' }, 401);
  await next();
};
const requireAdmin = async (c, next) => {
  if (c.get('user').role !== 'ADMIN') return c.json({ error: 'Seu perfil não tem permissão para esta ação.' }, 403);
  await next();
};
const isManager = u => u.role === 'ADMIN' || u.role === 'GESTOR';
const managerOnly = async (c, next) => {
  if (!isManager(c.get('user'))) return c.json({ error: 'Acesso restrito ao perfil Gestor.' }, 403);
  await next();
};

// ===== Configuração inicial (cadastro do administrador por e-mail) =====
const hasAdmin = async db => !!(await db.prepare("SELECT 1 AS x FROM users WHERE role = 'ADMIN' LIMIT 1").first());

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

app.get('/api/setup', async c => c.json({
  needsSetup: !(await hasAdmin(c.get('db'))),
  needsSetupCode: !!c.env.SETUP_CODE,
  maxCompanies: maxCompanies(c),
}));

app.post('/api/setup', async c => {
  const db = c.get('db');
  const b = await readJson(c);
  const name = str(b.name, { field: 'Nome do administrador', required: true, max: 100 });
  const email = str(b.email, { field: 'E-mail', required: true, max: 120 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'E-mail inválido.');
  const pwErr = auth.validatePasswordStrength(b.password);
  if (pwErr) throw new HttpError(400, pwErr);
  const company = companyInput(b.company || {});
  if (await hasAdmin(db)) throw new HttpError(409, 'O sistema já foi configurado. Faça login.');
  // Código de configuração: impede que um estranho que ache o endereço faça o cadastro inicial
  if (c.env.SETUP_CODE && !safeEqual(String(b.setup_code || '').trim(), c.env.SETUP_CODE)) {
    throw new HttpError(403, 'Código de configuração incorreto.');
  }

  const hash = await auth.hashPassword(b.password);
  // Tudo-ou-nada: só grava se ainda não existir administrador
  await atomic(db, [
    db.prepare(`INSERT INTO users (name, email, password_hash, role)
      SELECT ?, ?, ?, 'ADMIN' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN')`).bind(name, email, hash),
    guard(db),
    db.prepare(`INSERT INTO companies (official_name, short_name, tagline, cnpj, color_theme, logo_url, code_prefix)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(company.official_name, company.short_name, company.tagline, company.cnpj,
      company.color_theme, company.logo_url, makePrefix(company.short_name)),
  ], 'O sistema já foi configurado. Faça login.');

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const { token, ttl } = await auth.createSession(db, user.id, false);
  setSessionCookie(c, token, ttl);
  return c.json({ user: publicUser(user) }, 201);
});

// ===== Login / logout =====
app.post('/api/login', async c => {
  const db = c.get('db');
  const b = await readJson(c);
  const login = str(b.login, { field: 'Usuário', required: true, max: 120 });
  const password = typeof b.password === 'string' ? b.password : '';
  const ip = clientIp(c);

  if (await auth.isLoginBlocked(db, ip, login)) {
    return c.json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' }, 429);
  }

  // Administrador entra com e-mail; demais usuários com nome de usuário
  const user = login.includes('@')
    ? await db.prepare("SELECT * FROM users WHERE email = ? AND role = 'ADMIN'").bind(login).first()
    : await db.prepare('SELECT * FROM users WHERE username = ?').bind(login).first();

  const ok = (await auth.verifyPassword(password, user ? user.password_hash : auth.DUMMY_HASH)) && !!user;
  if (!ok || !user.active) {
    await auth.registerFailedLogin(db, ip, login);
    return c.json({ error: user && ok && !user.active ? 'Usuário desativado. Fale com o administrador.' : 'Usuário ou senha incorretos.' }, 401);
  }

  await auth.clearFailedLogins(db, ip, login);
  await auth.purgeExpired(db);
  const { token, ttl } = await auth.createSession(db, user.id, !!b.remember);
  setSessionCookie(c, token, ttl);
  return c.json({ user: publicUser(user) });
});

app.post('/api/logout', async c => {
  await auth.destroySession(c.get('db'), c.get('token'));
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.get('/api/me', requireAuth, async c => {
  const user = c.get('user');
  return c.json({
    user: publicUser(user),
    companies: (await allowedCompanies(c.get('db'), user)).map(publicCompany),
    maxCompanies: maxCompanies(c),
    today: finance.todayIso(),
  });
});

app.put('/api/me/password', requireAuth, async c => {
  const db = c.get('db');
  const user = c.get('user');
  const b = await readJson(c);
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!(await auth.verifyPassword(String(b.current_password || ''), row.password_hash))) throw new HttpError(400, 'Senha atual incorreta.');
  const pwErr = auth.validatePasswordStrength(b.new_password);
  if (pwErr) throw new HttpError(400, pwErr);
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await auth.hashPassword(b.new_password), user.id),
    // Encerra as outras sessões deste usuário
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, await auth.sha256(c.get('token'))),
  ]);
  return c.json({ ok: true });
});

// ===== Empresas (somente administrador cria/edita) =====
app.post('/api/companies', requireAuth, requireAdmin, async c => {
  const db = c.get('db');
  const d = companyInput(await readJson(c));
  const max = maxCompanies(c);
  const r = await db.prepare(`INSERT INTO companies (official_name, short_name, tagline, cnpj, color_theme, logo_url, code_prefix)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM companies) < ? RETURNING *`)
    .bind(d.official_name, d.short_name, d.tagline, d.cnpj, d.color_theme, d.logo_url, makePrefix(d.short_name), max).first();
  if (!r) throw new HttpError(400, `Limite de ${max} empresas atingido.`);
  return c.json({ company: publicCompany(r) }, 201);
});

app.put('/api/companies/:id', requireAuth, requireAdmin, async c => {
  const db = c.get('db');
  const id = Number(c.req.param('id'));
  if (!(await db.prepare('SELECT 1 AS x FROM companies WHERE id = ?').bind(id).first())) throw new HttpError(404, 'Empresa não encontrada.');
  const d = companyInput(await readJson(c), { partial: true });
  const keys = Object.keys(d);
  if (keys.length) {
    await db.prepare(`UPDATE companies SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map(k => d[k]), id).run();
  }
  return c.json({ company: publicCompany(await db.prepare('SELECT * FROM companies WHERE id = ?').bind(id).first()) });
});

// ===== Usuários (somente administrador) =====
async function validCompanyIds(db, ids) {
  if (!Array.isArray(ids)) return [];
  const all = new Set((await db.prepare('SELECT id FROM companies').all()).results.map(r => r.id));
  return [...new Set(ids.map(Number))].filter(id => all.has(id));
}

async function userWithCompanies(db, u) {
  const rows = u.role === 'ADMIN'
    ? (await db.prepare('SELECT id AS company_id FROM companies ORDER BY id').all()).results
    : (await db.prepare('SELECT company_id FROM user_companies WHERE user_id = ? ORDER BY company_id').bind(u.id).all()).results;
  return { ...publicUser(u), active: !!u.active, created_at: u.created_at, company_ids: rows.map(r => r.company_id) };
}

app.get('/api/users', requireAuth, requireAdmin, async c => {
  const db = c.get('db');
  const users = (await db.prepare("SELECT * FROM users ORDER BY role = 'ADMIN' DESC, name").all()).results;
  return c.json({ users: await Promise.all(users.map(u => userWithCompanies(db, u))) });
});

app.post('/api/users', requireAuth, requireAdmin, async c => {
  const db = c.get('db');
  const b = await readJson(c);
  const name = str(b.name, { field: 'Nome', required: true, max: 100 });
  const username = str(b.username, { field: 'Nome de usuário', required: true, max: 30 }).toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Nome de usuário: use de 3 a 30 letras, números, ponto, hífen ou sublinhado (sem espaços e sem @).');
  }
  if (!ROLES_ASSIGNABLE.includes(b.role)) throw new HttpError(400, 'Perfil inválido.');
  const pwErr = auth.validatePasswordStrength(b.password);
  if (pwErr) throw new HttpError(400, pwErr);
  const companyIds = await validCompanyIds(db, b.company_ids);
  if (!companyIds.length) throw new HttpError(400, 'Selecione ao menos 1 empresa para este usuário.');
  if (await db.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(username).first()) {
    throw new HttpError(409, 'Este nome de usuário já está em uso.');
  }

  const hash = await auth.hashPassword(b.password);
  try {
    await db.batch([
      db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)').bind(name, username, hash, b.role),
      ...companyIds.map(cid => db.prepare('INSERT INTO user_companies (user_id, company_id) SELECT id, ? FROM users WHERE username = ?').bind(cid, username)),
    ]);
  } catch (err) {
    if (String(err.cause?.message || err.message).includes('UNIQUE')) throw new HttpError(409, 'Este nome de usuário já está em uso.');
    throw err;
  }
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  return c.json({ user: await userWithCompanies(db, user) }, 201);
});

app.put('/api/users/:id', requireAuth, requireAdmin, async c => {
  const db = c.get('db');
  const me = c.get('user');
  const id = Number(c.req.param('id'));
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!target) throw new HttpError(404, 'Usuário não encontrado.');
  const b = await readJson(c);
  const stmts = [];

  if (b.name !== undefined) {
    stmts.push(db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(str(b.name, { field: 'Nome', required: true, max: 100 }), id));
  }
  if (b.username !== undefined && target.role !== 'ADMIN') {
    const username = str(b.username, { field: 'Nome de usuário', required: true, max: 30 }).toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'Nome de usuário: use de 3 a 30 letras, números, ponto, hífen ou sublinhado (sem espaços e sem @).');
    }
    if (username !== target.username) {
      if (await db.prepare('SELECT 1 AS x FROM users WHERE username = ? AND id != ?').bind(username, id).first()) {
        throw new HttpError(409, 'Este nome de usuário já está em uso.');
      }
      stmts.push(db.prepare('UPDATE users SET username = ? WHERE id = ?').bind(username, id));
    }
  }
  if (b.password) {
    const pwErr = auth.validatePasswordStrength(b.password);
    if (pwErr) throw new HttpError(400, pwErr);
    stmts.push(db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await auth.hashPassword(b.password), id));
    if (id !== me.id) stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  }
  if (target.role === 'ADMIN') {
    if (b.role !== undefined || b.active !== undefined || b.company_ids !== undefined) {
      throw new HttpError(400, 'O perfil, o status e as empresas do administrador não podem ser alterados.');
    }
  } else {
    if (b.role !== undefined) {
      if (!ROLES_ASSIGNABLE.includes(b.role)) throw new HttpError(400, 'Perfil inválido.');
      stmts.push(db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(b.role, id));
    }
    if (b.active !== undefined) {
      stmts.push(db.prepare('UPDATE users SET active = ? WHERE id = ?').bind(b.active ? 1 : 0, id));
      if (!b.active) stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
    }
    if (b.company_ids !== undefined) {
      const companyIds = await validCompanyIds(db, b.company_ids);
      if (!companyIds.length) throw new HttpError(400, 'Selecione ao menos 1 empresa para este usuário.');
      stmts.push(db.prepare('DELETE FROM user_companies WHERE user_id = ?').bind(id));
      companyIds.forEach(cid => stmts.push(db.prepare('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)').bind(id, cid)));
    }
  }
  if (stmts.length) {
    try {
      await db.batch(stmts);
    } catch (err) {
      if (String(err.cause?.message || err.message).includes('UNIQUE')) throw new HttpError(409, 'Este nome de usuário já está em uso.');
      throw err;
    }
  }
  return c.json({ user: await userWithCompanies(db, await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()) });
});

// ===== Rotas por empresa =====
const company = new Hono();

app.use('/api/companies/:cid/*', requireAuth, async (c, next) => {
  const id = Number(c.req.param('cid'));
  const comp = (await allowedCompanies(c.get('db'), c.get('user'))).find(x => x.id === id);
  if (!comp) return c.json({ error: 'Você não tem acesso a esta empresa.' }, 403);
  c.set('company', comp);
  await next();
});

// ----- Dashboard -----
company.get('/dashboard', managerOnly, async c => {
  const db = c.get('db');
  const cid = c.get('company').id;
  const today = finance.todayIso();
  const active = (await db.prepare("SELECT * FROM contracts WHERE company_id = ? AND status = 'ATIVO' AND in_agreement = 0").bind(cid).all()).results;
  const s = {
    capital_alocado_cents: 0, receita_a_entrar_cents: 0, contratos_ativos: active.length,
    em_atraso: 0, ciclo15: 0, ciclo30: 0, outros_ciclos: 0, total_rolagens: 0, ultimo_vencimento: null,
  };
  for (const ct of active) {
    const d = finance.calculateDebt(ct, today);
    s.capital_alocado_cents += ct.principal_cents;
    s.receita_a_entrar_cents += d.cycleInterest;
    s.total_rolagens += ct.rollover_count;
    if (d.overdueDays > 0) s.em_atraso++;
    if (ct.cycle_days === 15) s.ciclo15++; else if (ct.cycle_days === 30) s.ciclo30++; else s.outros_ciclos++;
    if (!s.ultimo_vencimento || ct.due_date > s.ultimo_vencimento) s.ultimo_vencimento = ct.due_date;
  }
  const t = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type IN ('ROLAGEM','QUITACAO','PARCELA_ACORDO') THEN revenue_cents END), 0) AS receita,
      COALESCE(SUM(CASE WHEN type = 'PARCELA_ACORDO' THEN revenue_cents END), 0) AS receita_acordos,
      COALESCE(SUM(CASE WHEN type = 'OUTRA_ENTRADA' THEN amount_cents END), 0) AS outras,
      COALESCE(SUM(CASE WHEN type = 'DESPESA' THEN -amount_cents END), 0) AS despesas
    FROM ledger WHERE company_id = ?`).bind(cid).first();
  s.receita_realizada_cents = t.receita;
  s.outras_entradas_cents = t.outras;
  s.despesas_cents = t.despesas;
  s.lucro_liquido_cents = t.receita + t.outras - t.despesas;
  s.taxa_atraso = active.length ? Math.round(s.em_atraso / active.length * 100) : 0;

  // Acordos
  const agreements = [...(await agreementSummaries(db, cid, today)).values()];
  const in30 = finance.addDaysIso(today, 30);
  const discount = await db.prepare(`SELECT COALESCE(SUM(MAX(0, debt_at_agreement_cents - total_cents)), 0) AS d
    FROM agreements WHERE company_id = ? AND status IN ('ATIVO','CONCLUIDO')`).bind(cid).first();
  const concluded = await db.prepare("SELECT COUNT(*) AS n FROM agreements WHERE company_id = ? AND status = 'CONCLUIDO'").bind(cid).first();
  s.acordos = {
    ativos: agreements.length,
    concluidos: concluded.n,
    total_acordado_cents: agreements.reduce((t, a) => t + a.total_cents, 0),
    recebido_cents: agreements.reduce((t, a) => t + a.paid_cents, 0),
    a_receber_cents: agreements.reduce((t, a) => t + a.remaining_cents, 0),
    parcelas_atrasadas: agreements.reduce((t, a) => t + a.overdue_count, 0),
    atrasado_cents: agreements.reduce((t, a) => t + a.overdue_cents, 0),
    proximos_30d_cents: agreements.reduce((t, a) => t + a.installments
      .filter(i => i.status === 'PENDENTE' && i.due_date >= today && i.due_date <= in30).reduce((x, i) => x + i.amount_cents, 0), 0),
    desconto_concedido_cents: discount.d,
    receita_cents: t.receita_acordos,
    principal_pendente_cents: agreements.reduce((t2, a) => t2 + a.principal_pending_cents, 0),
  };
  // O principal ainda não recuperado nos acordos continua sendo "dinheiro na rua"
  s.capital_alocado_cents += s.acordos.principal_pendente_cents;
  return c.json({ dashboard: s, today });
});

// ----- Contratos -----
company.get('/contracts', async c => {
  const today = finance.todayIso();
  const db = c.get('db');
  const cid = c.get('company').id;
  const rows = (await db.prepare('SELECT * FROM contracts WHERE company_id = ? ORDER BY status, due_date').bind(cid).all()).results;
  const agr = await agreementSummaries(db, cid, today);
  return c.json({ contracts: rows.map(x => contractView(x, today, agr.get(x.id) || null)), today });
});

company.post('/contracts', async c => { // Gestor e Operador podem lançar empréstimos
  const db = c.get('db');
  const user = c.get('user');
  const cid = c.get('company').id;
  const b = await readJson(c);
  const client_name = str(b.client_name, { field: 'Nome do cliente', required: true, max: 120 });
  const cpf = str(b.cpf, { field: 'CPF', required: true, max: 20 });
  const phone = str(b.phone, { field: 'WhatsApp', required: true, max: 30 }).replace(/\D/g, '');
  if (phone.length < 10) throw new HttpError(400, 'WhatsApp inválido: informe DDD + número.');
  const address = str(b.address, { field: 'Endereço', required: true, max: 250 });
  const social_media = str(b.social_media, { field: 'Rede social', max: 120 });
  const principal_cents = moneyToCents(b.principal, 'Valor principal');
  const rate = percent(b.rate, 'Taxa de juros');
  const late_fee_rate = percent(b.late_fee_rate ?? 10, 'Diária de atraso', { max: 100 });
  const cycle_days = Number(b.cycle_days);
  if (!Number.isInteger(cycle_days) || cycle_days < 1 || cycle_days > 365) throw new HttpError(400, 'Ciclo inválido.');
  const start_date = b.start_date || finance.todayIso();
  if (!finance.isValidIsoDate(start_date)) throw new HttpError(400, 'Data de início inválida.');
  const due_date = finance.addDaysIso(start_date, cycle_days);

  // Tudo-ou-nada: reserva o número, cria o contrato, lança a concessão e a ocorrência
  const res = await atomic(db, [
    db.prepare('UPDATE companies SET next_number = next_number + 1 WHERE id = ?').bind(cid),
    db.prepare(`INSERT INTO contracts
      (company_id, code, client_name, cpf, phone, address, social_media, principal_cents, rate, late_fee_rate,
       cycle_days, start_date, due_date, created_by)
      SELECT ?1, code_prefix || '-' || (next_number - 1), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
      FROM companies WHERE id = ?1 RETURNING *`)
      .bind(cid, client_name, cpf, phone, address, social_media, principal_cents, rate, late_fee_rate, cycle_days, start_date, due_date, user.id),
    db.prepare(`INSERT INTO ledger (company_id, contract_id, date, type, description, amount_cents, principal_cents, channel, user_id)
      SELECT company_id, id, start_date, 'CONCESSAO', 'Concessão ' || code || ' (' || client_name || ')', -principal_cents, principal_cents, 'SISTEMA', ?
      FROM contracts WHERE id = last_insert_rowid()`).bind(user.id),
    occurrenceStmt(db, '(SELECT contract_id FROM ledger WHERE id = last_insert_rowid())', null,
      `Contrato cadastrado por ${user.name}: ${brl(principal_cents)} a ${rate}% a cada ${cycle_days} dias. 1º vencimento em ${brDate(due_date)}.`),
  ], 'Não foi possível gravar o contrato. Tente novamente.');
  return c.json({ contract: contractView(res[1].results[0], finance.todayIso()) }, 201);
});

company.get('/contracts/:id', async c => {
  const db = c.get('db');
  const ct = await getContract(db, c.get('company').id, c.req.param('id'));
  const today = finance.todayIso();
  const [occ, pay, hist] = await db.batch([
    db.prepare('SELECT id, author_name, author_role, text, created_at FROM occurrences WHERE contract_id = ? ORDER BY id DESC').bind(ct.id),
    db.prepare('SELECT date, type, amount_cents, channel, notes FROM ledger WHERE contract_id = ? ORDER BY id DESC').bind(ct.id),
    db.prepare(`SELECT id, status, total_cents, debt_at_agreement_cents, created_at, closed_at FROM agreements
      WHERE contract_id = ? ORDER BY id DESC`).bind(ct.id),
  ]);
  const agr = await agreementSummaries(db, c.get('company').id, today, ct.id);
  return c.json({
    contract: contractView(ct, today, agr.get(ct.id) || null),
    occurrences: occ.results, payments: pay.results, agreements_history: hist.results,
  });
});

// Editar contrato (somente Administrador).
// Dados do cliente: sempre. Condições financeiras: só com o contrato ativo e fora de acordo.
// Toda alteração fica registrada no histórico (antes → depois).
company.put('/contracts/:id', requireAdmin, async c => {
  const db = c.get('db');
  const user = c.get('user');
  const ct = await getContract(db, c.get('company').id, c.req.param('id'));
  const b = await readJson(c);

  const next = {};
  if (b.client_name !== undefined) next.client_name = str(b.client_name, { field: 'Nome do cliente', required: true, max: 120 });
  if (b.cpf !== undefined) next.cpf = str(b.cpf, { field: 'CPF', required: true, max: 20 });
  if (b.phone !== undefined) {
    next.phone = str(b.phone, { field: 'WhatsApp', required: true, max: 30 }).replace(/\D/g, '');
    if (next.phone.length < 10) throw new HttpError(400, 'WhatsApp inválido: informe DDD + número.');
  }
  if (b.address !== undefined) next.address = str(b.address, { field: 'Endereço', required: true, max: 250 });
  if (b.social_media !== undefined) next.social_media = str(b.social_media, { field: 'Rede social', max: 120 });

  const financial = {};
  if (b.principal !== undefined) financial.principal_cents = moneyToCents(b.principal, 'Valor principal');
  if (b.rate !== undefined) financial.rate = percent(b.rate, 'Taxa de juros');
  if (b.late_fee_rate !== undefined) financial.late_fee_rate = percent(b.late_fee_rate, 'Diária de atraso', { max: 100 });
  if (b.cycle_days !== undefined) {
    financial.cycle_days = Number(b.cycle_days);
    if (!Number.isInteger(financial.cycle_days) || financial.cycle_days < 1 || financial.cycle_days > 365) throw new HttpError(400, 'Ciclo inválido.');
  }
  if (b.start_date !== undefined) {
    if (!finance.isValidIsoDate(b.start_date)) throw new HttpError(400, 'Data de concessão inválida.');
    financial.start_date = b.start_date;
  }
  if (b.due_date !== undefined) {
    if (!finance.isValidIsoDate(b.due_date)) throw new HttpError(400, 'Vencimento inválido.');
    financial.due_date = b.due_date;
  }
  // Só considera o que realmente mudou
  for (const k of Object.keys(financial)) if (financial[k] === ct[k]) delete financial[k];
  for (const k of Object.keys(next)) if (next[k] === ct[k]) delete next[k];

  if (Object.keys(financial).length) {
    if (ct.status !== 'ATIVO') throw new HttpError(400, 'Contrato quitado: só os dados do cliente podem ser editados.');
    if (ct.in_agreement) throw new HttpError(400, 'Contrato em acordo: só os dados do cliente podem ser editados. Para mudar valores, renegocie o acordo.');
  }
  const changes = { ...next, ...financial };
  const keys = Object.keys(changes);
  if (!keys.length) return c.json({ ok: true, changed: 0 });

  const LABELS = {
    client_name: 'Nome', cpf: 'CPF', phone: 'WhatsApp', address: 'Endereço', social_media: 'Rede social',
    principal_cents: 'Principal', rate: 'Juros (%)', late_fee_rate: 'Diária (%)', cycle_days: 'Ciclo (dias)',
    start_date: 'Data de concessão', due_date: 'Vencimento',
  };
  const fmt = (k, v) => {
    if (k === 'principal_cents') return brl(v);
    if (k === 'start_date' || k === 'due_date') return brDate(v);
    return v === '' || v == null ? '(vazio)' : String(v);
  };
  const summary = keys.map(k => `${LABELS[k]}: ${fmt(k, ct[k])} → ${fmt(k, changes[k])}`).join('; ');

  const stmts = [
    // Só aplica se o contrato não mudou desde que foi lido (ex.: uma baixa feita agora por outra pessoa)
    db.prepare(`UPDATE contracts SET ${keys.map(k => `${k} = ?`).join(', ')}
      WHERE id = ? AND status = ? AND in_agreement = ? AND due_date = ? AND rollover_count = ?`)
      .bind(...keys.map(k => changes[k]), ct.id, ct.status, ct.in_agreement, ct.due_date, ct.rollover_count),
    guard(db),
  ];
  // Mantém o lançamento de concessão coerente com o novo principal / data
  if (financial.principal_cents !== undefined || financial.start_date !== undefined || next.client_name !== undefined) {
    const amortized = (await db.prepare("SELECT COALESCE(SUM(principal_cents), 0) AS t FROM ledger WHERE contract_id = ? AND type = 'AMORTIZACAO'").bind(ct.id).first()).t;
    const granted = (financial.principal_cents ?? ct.principal_cents) + amortized;
    stmts.push(db.prepare(`UPDATE ledger SET amount_cents = -?, principal_cents = ?, date = ?, description = ?
      WHERE contract_id = ? AND type = 'CONCESSAO'`)
      .bind(granted, granted, financial.start_date ?? ct.start_date, `Concessão ${ct.code} (${next.client_name ?? ct.client_name})`, ct.id));
  }
  stmts.push(occurrenceStmt(db, ct.id, null, `Contrato editado por ${user.name}. ${summary}.`));
  await atomic(db, stmts, 'Este contrato foi alterado por outra pessoa enquanto você editava. Atualize a página e tente de novo.');
  return c.json({ ok: true, changed: keys.length });
});

// Excluir contrato (Gestor/Administrador). Só é permitido se o contrato não tem nenhum recebimento,
// para não apagar receita nem caixa já registrados. Fica um registro da exclusão.
const RECEIPT_TYPES_SQL = "('ROLAGEM','QUITACAO','PARCELA_ACORDO','OUTRA_ENTRADA','AMORTIZACAO')";

company.delete('/contracts/:id', managerOnly, async c => {
  const db = c.get('db');
  const user = c.get('user');
  const ct = await getContract(db, c.get('company').id, c.req.param('id'));
  const reason = str((await readJson(c)).reason, { field: 'Motivo', required: true, max: 300 });
  const receipts = await db.prepare(`SELECT COUNT(*) AS n FROM ledger WHERE contract_id = ? AND type IN ${RECEIPT_TYPES_SQL}`).bind(ct.id).first();
  if (receipts.n > 0) {
    throw new HttpError(400, 'Este contrato já tem recebimentos (rolagem, quitação ou parcela de acordo) e não pode ser excluído, para não apagar valores do caixa.');
  }
  await atomic(db, [
    // 1º: registra a exclusão, mas só se, neste instante, ainda não houver recebimento (outra pessoa pode ter dado baixa agora)
    db.prepare(`INSERT INTO deleted_contracts (company_id, contract_code, client_name, cpf, principal_cents, data_json, reason, deleted_by, deleted_by_name)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ledger WHERE contract_id = ? AND type IN ${RECEIPT_TYPES_SQL})`)
      .bind(ct.company_id, ct.code, ct.client_name, ct.cpf, ct.principal_cents, JSON.stringify(ct), reason, user.id, user.name, ct.id),
    guard(db),
    // Lançamentos de extrato vinculados (ex.: desembolso confirmado) ficam no extrato, só perdem o vínculo
    db.prepare('UPDATE bank_transactions SET contract_id = NULL WHERE contract_id = ?').bind(ct.id),
    db.prepare('DELETE FROM ledger WHERE contract_id = ?').bind(ct.id),
    db.prepare('DELETE FROM agreement_installments WHERE agreement_id IN (SELECT id FROM agreements WHERE contract_id = ?)').bind(ct.id),
    db.prepare('DELETE FROM agreements WHERE contract_id = ?').bind(ct.id),
    db.prepare('DELETE FROM occurrences WHERE contract_id = ?').bind(ct.id),
    db.prepare('DELETE FROM contracts WHERE id = ?').bind(ct.id),
    guard(db),
  ], 'Este contrato recebeu um pagamento agora há pouco e não pode mais ser excluído. Atualize a página.');
  return c.json({ ok: true });
});

company.post('/contracts/:id/occurrences', async c => {
  const db = c.get('db');
  const ct = await getContract(db, c.get('company').id, c.req.param('id'));
  const text = str((await readJson(c)).text, { field: 'Ocorrência', required: true, max: 2000 });
  await occurrenceStmt(db, ct.id, c.get('user'), text).run();
  return c.json({ ok: true }, 201);
});

function paymentInput(b) {
  const channel = PAYMENT_CHANNELS.includes(b.channel) ? b.channel : null;
  if (!channel) throw new HttpError(400, 'Escolha o método de baixa.');
  // Valor recebido é opcional: se não vier, usa o valor cheio calculado pelo sistema
  const amount_cents = b.amount === undefined || b.amount === null || b.amount === '' ? undefined : moneyToCents(b.amount, 'Valor recebido');
  // Data do recebimento: opcional (padrão = hoje) e livre — qualquer data válida
  const today = finance.todayIso();
  let paid_on = today;
  if (b.paid_on !== undefined && b.paid_on !== null && b.paid_on !== '') {
    if (!finance.isValidIsoDate(b.paid_on)) throw new HttpError(400, 'Data do recebimento inválida.');
    paid_on = b.paid_on;
  }
  return { channel, notes: str(b.notes, { field: 'Observações', max: 300 }), amount_cents, paid_on };
}


// Texto do histórico quando o valor recebido difere do calculado
function differenceText(paid, expected) {
  if (paid < expected) return ` Desconto concedido: ${brl(expected - paid)} (valor cheio era ${brl(expected)}).`;
  if (paid > expected) return ` Recebido ${brl(paid - expected)} a mais que o valor calculado (${brl(expected)}).`;
  return '';
}

// Comandos de uma rolagem. O 1º só altera o contrato se ele continua como foi lido (ativo e com o mesmo vencimento).
function rolloverStmts(db, ct, { amount_cents, channel, notes, date, user, today, label }) {
  const debt = finance.calculateDebt(ct, today);
  const newDue = finance.nextDueDateAfterRollover(ct, today);
  const paid = amount_cents ?? debt.totalToRollover;
  const diff = paid - debt.totalToRollover;
  return {
    newDue,
    stmts: [
      db.prepare("UPDATE contracts SET due_date = ?, rollover_count = rollover_count + 1 WHERE id = ? AND status = 'ATIVO' AND in_agreement = 0 AND due_date = ?")
        .bind(newDue, ct.id, ct.due_date),
      guard(db),
      db.prepare(`INSERT INTO ledger (company_id, contract_id, date, type, description, amount_cents, revenue_cents, channel, notes, user_id)
        VALUES (?, ?, ?, 'ROLAGEM', ?, ?, ?, ?, ?, ?)`)
        .bind(ct.company_id, ct.id, date, `Rolagem ${ct.code} (${ct.client_name})`, paid, paid, channel, notes, user.id),
      occurrenceStmt(db, ct.id, null,
        `${label} por ${user.name}: recebido ${brl(paid)} (${channel})${date !== finance.todayIso() ? ` em ${brDate(date)}` : ''}. Novo vencimento: ${brDate(newDue)}.` +
        differenceText(paid, debt.totalToRollover) +
        (notes ? ` Obs.: ${notes}` : '')),
    ],
  };
}

function settleStmts(db, ct, { amount_cents, channel, notes, date, user, today, label }) {
  const debt = finance.calculateDebt(ct, today);
  const paid = amount_cents ?? debt.totalToSettle;
  const principalPart = Math.min(paid, ct.principal_cents);
  const diff = paid - debt.totalToSettle;
  return [
    db.prepare("UPDATE contracts SET status = 'QUITADO', settled_at = ? WHERE id = ? AND status = 'ATIVO' AND in_agreement = 0 AND due_date = ?")
      .bind(date, ct.id, ct.due_date),
    guard(db),
    db.prepare(`INSERT INTO ledger (company_id, contract_id, date, type, description, amount_cents, principal_cents, revenue_cents, channel, notes, user_id)
      VALUES (?, ?, ?, 'QUITACAO', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(ct.company_id, ct.id, date, `Quitação ${ct.code} (${ct.client_name})`, paid, principalPart, paid - principalPart, channel, notes, user.id),
    occurrenceStmt(db, ct.id, null,
      `${label} por ${user.name}: recebido ${brl(paid)} (${channel})${date !== finance.todayIso() ? ` em ${brDate(date)}` : ''}. Contrato QUITADO.` +
      differenceText(paid, debt.totalToSettle) +
      (notes ? ` Obs.: ${notes}` : '')),
  ];
}

const IN_AGREEMENT_MSG = 'Este contrato está em acordo. Registre o recebimento pelas parcelas do acordo, na ficha do cliente.';
const CONFLICT_MSG = 'Este contrato foi alterado por outra pessoa ou já está quitado. Atualize a página e confira.';

company.post('/contracts/:id/rollover', managerOnly, async c => {
  const db = c.get('db');
  const { channel, notes, amount_cents, paid_on } = paymentInput(await readJson(c));
  const ct = await getContract(db, c.get('company').id, c.req.param('id'));
  if (ct.status !== 'ATIVO') throw new HttpError(400, 'Este contrato já está quitado.');
  if (ct.in_agreement) throw new HttpError(400, IN_AGREEMENT_MSG);
  // Diárias e novo vencimento são calculados na data em que o cliente pagou
  const { newDue, stmts } = rolloverStmts(db, ct, { amount_cents, channel, notes, date: paid_on, user: c.get('user'), today: paid_on, label: 'Rolagem (baixa manual)' });
  await atomic(db, stmts, CONFLICT_MSG);
  return c.json({ ok: true, new_due_date: newDue });
});

company.post('/contracts/:id/settle', managerOnly, async c => {
  const db = c.get('db');
  const { channel, notes, amount_cents, paid_on } = paymentInput(await readJson(c));
  const ct = await getContract(db, c.get('company').id, c.req.param('id'));
  if (ct.status !== 'ATIVO') throw new HttpError(400, 'Este contrato já está quitado.');
  if (ct.in_agreement) throw new HttpError(400, IN_AGREEMENT_MSG);
  await atomic(db, settleStmts(db, ct, { amount_cents, channel, notes, date: paid_on, user: c.get('user'), today: paid_on, label: 'Quitação (baixa manual)' }), CONFLICT_MSG);
  return c.json({ ok: true });
});

// ----- Quebrar juros (amortização) -----
// O cliente antecipa um valor que abate o principal; os juros do ciclo passam a ser calculados sobre o novo principal.
// O vencimento não muda.
function amortizeStmts(db, ct, { amount_cents, channel, notes, date, user, label }) {
  const newPrincipal = ct.principal_cents - amount_cents;
  const oldInterest = Math.round(ct.principal_cents * ct.rate / 100);
  const newInterest = Math.round(newPrincipal * ct.rate / 100);
  return [
    db.prepare(`UPDATE contracts SET principal_cents = ? WHERE id = ? AND status = 'ATIVO' AND in_agreement = 0 AND principal_cents = ?`)
      .bind(newPrincipal, ct.id, ct.principal_cents),
    guard(db),
    db.prepare(`INSERT INTO ledger (company_id, contract_id, date, type, description, amount_cents, principal_cents, revenue_cents, channel, notes, user_id)
      VALUES (?, ?, ?, 'AMORTIZACAO', ?, ?, ?, 0, ?, ?, ?)`)
      .bind(ct.company_id, ct.id, date, `Quebra de juros ${ct.code} (${ct.client_name})`, amount_cents, amount_cents, channel, notes, user.id),
    occurrenceStmt(db, ct.id, null,
      `${label} por ${user.name}: recebido ${brl(amount_cents)} (${channel})${date !== finance.todayIso() ? ` em ${brDate(date)}` : ''} para abater o principal. ` +
      `Principal: ${brl(ct.principal_cents)} → ${brl(newPrincipal)}. Juros do ciclo: ${brl(oldInterest)} → ${brl(newInterest)}.` +
      (notes ? ` Obs.: ${notes}` : '')),
  ];
}

function checkAmortization(ct, amount_cents) {
  if (ct.status !== 'ATIVO') throw new HttpError(400, 'Este contrato já está quitado.');
  if (ct.in_agreement) throw new HttpError(400, IN_AGREEMENT_MSG);
  if (!amount_cents) throw new HttpError(400, 'Informe o valor recebido.');
  if (amount_cents >= ct.principal_cents) {
    throw new HttpError(400, `O valor (${brl(amount_cents)}) cobre todo o principal (${brl(ct.principal_cents)}). Use "Quitar contrato".`);
  }
}

company.post('/contracts/:id/amortize', managerOnly, async c => {
  const db = c.get('db');
  const { channel, notes, amount_cents, paid_on } = paymentInput(await readJson(c));
  const ct = await getContract(db, c.get('company').id, c.req.param('id'));
  checkAmortization(ct, amount_cents);
  await atomic(db, amortizeStmts(db, ct, { amount_cents, channel, notes, date: paid_on, user: c.get('user'), label: 'Quebra de juros' }), CONFLICT_MSG);
  return c.json({ ok: true, new_principal_cents: ct.principal_cents - amount_cents });
});

// ----- Acordos -----
const MAX_INSTALLMENTS = 120;

function agreementInput(b) {
  const total = moneyToCents(b.total, 'Valor total acordado');
  if (!Array.isArray(b.installments) || !b.installments.length) throw new HttpError(400, 'Informe ao menos 1 parcela.');
  if (b.installments.length > MAX_INSTALLMENTS) throw new HttpError(400, `Máximo de ${MAX_INSTALLMENTS} parcelas.`);
  const installments = b.installments.map((it, i) => {
    if (!finance.isValidIsoDate(it && it.due_date)) throw new HttpError(400, `Data inválida na parcela ${i + 1}.`);
    return { due_date: it.due_date, amount_cents: moneyToCents(it.amount, `parcela ${i + 1}`) };
  }).sort((a, b2) => a.due_date.localeCompare(b2.due_date));
  const sum = installments.reduce((t, it) => t + it.amount_cents, 0);
  if (sum !== total) {
    throw new HttpError(400, `A soma das parcelas (${brl(sum)}) precisa ser igual ao valor acordado (${brl(total)}).`);
  }
  return { total, installments, notes: str(b.notes, { field: 'Condições do acordo', max: 2000 }) };
}

function installmentInserts(db, contractId, installments) {
  return installments.map((it, i) => db.prepare(`INSERT INTO agreement_installments (agreement_id, number, due_date, amount_cents)
    SELECT id, ?, ?, ? FROM agreements WHERE contract_id = ? AND status = 'ATIVO'`).bind(i + 1, it.due_date, it.amount_cents, contractId));
}

function scheduleText(installments) {
  const n = installments.length;
  const first = installments[0];
  return `${n} parcela${n > 1 ? 's' : ''}, 1ª em ${brDate(first.due_date)}` + (n > 1 ? `, última em ${brDate(installments[n - 1].due_date)}` : '');
}

// Cria um acordo, ou renegocia (substitui) o acordo ativo do contrato
company.post('/contracts/:id/agreement', managerOnly, async c => {
  const db = c.get('db');
  const user = c.get('user');
  const cid = c.get('company').id;
  const today = finance.todayIso();
  const { total, installments, notes } = agreementInput(await readJson(c));
  const ct = await getContract(db, cid, c.req.param('id'));
  if (ct.status !== 'ATIVO') throw new HttpError(400, 'Este contrato já está quitado.');

  const stmts = [];
  let debtAt;
  let principalAt;
  let replacesId = null;
  let label;

  if (!ct.in_agreement) {
    const debt = finance.calculateDebt(ct, today);
    debtAt = debt.totalToSettle;
    principalAt = ct.principal_cents;
    label = 'Acordo firmado';
    stmts.push(
      db.prepare("UPDATE contracts SET in_agreement = 1 WHERE id = ? AND status = 'ATIVO' AND in_agreement = 0 AND due_date = ?").bind(ct.id, ct.due_date),
      guard(db),
    );
  } else {
    // Renegociação: o acordo atual é substituído; a referência de dívida é o que faltava pagar dele
    const old = (await agreementSummaries(db, cid, today, ct.id)).get(ct.id);
    if (!old) throw new HttpError(409, CONFLICT_MSG);
    debtAt = old.debt_at_agreement_cents - old.paid_cents;
    principalAt = old.principal_pending_cents;
    replacesId = old.id;
    label = 'Acordo renegociado';
    stmts.push(
      db.prepare("UPDATE agreements SET status = 'CANCELADO', closed_at = ? WHERE id = ? AND status = 'ATIVO'").bind(today, old.id),
      guard(db),
    );
  }

  stmts.push(
    db.prepare(`INSERT INTO agreements (company_id, contract_id, total_cents, debt_at_agreement_cents, principal_at_agreement_cents, notes, replaces_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(cid, ct.id, total, debtAt, principalAt, notes, replacesId, user.id),
    ...installmentInserts(db, ct.id, installments),
    occurrenceStmt(db, ct.id, null,
      `${label} por ${user.name}: ${brl(total)} em ${scheduleText(installments)}. Dívida de referência: ${brl(debtAt)}` +
      (debtAt > total ? ` (desconto de ${brl(debtAt - total)})` : '') + '.' + (notes ? ` Condições: ${notes}` : '')),
  );
  await atomic(db, stmts, CONFLICT_MSG);
  return c.json({ ok: true }, 201);
});

async function getActiveAgreement(db, companyId, agreementId) {
  const a = await db.prepare("SELECT * FROM agreements WHERE id = ? AND company_id = ?").bind(Number(agreementId), companyId).first();
  if (!a) throw new HttpError(404, 'Acordo não encontrado.');
  if (a.status !== 'ATIVO') throw new HttpError(400, 'Este acordo não está mais ativo.');
  return a;
}

// Comandos para registrar o recebimento de uma parcela (e concluir o acordo se for a última)
function payInstallmentStmts(db, a, ct, inst, { paid, channel, notes, date, user, label }) {
  const diff = paid - inst.amount_cents;
  return [
    db.prepare(`UPDATE agreement_installments SET status = 'PAGO', paid_cents = ?, paid_at = ?, channel = ?, notes = ?, received_by = ?
      WHERE id = ? AND status = 'PENDENTE' AND EXISTS (SELECT 1 FROM agreements WHERE id = ? AND status = 'ATIVO')`)
      .bind(paid, date, channel, notes, user.id, inst.id, a.id),
    guard(db),
    // O valor recebido abate primeiro o principal ainda não recuperado; o restante é receita
    db.prepare(`WITH x AS (
        SELECT MAX(0, MIN(?1, a.principal_at_agreement_cents - COALESCE((SELECT SUM(principal_cents) FROM ledger WHERE agreement_id = a.id), 0))) AS p
        FROM agreements a WHERE a.id = ?2)
      INSERT INTO ledger (company_id, contract_id, agreement_id, date, type, description, amount_cents, principal_cents, revenue_cents, channel, notes, user_id)
      SELECT ?3, ?4, ?2, ?5, 'PARCELA_ACORDO', ?6, ?1, x.p, ?1 - x.p, ?7, ?8, ?9 FROM x`)
      .bind(paid, a.id, a.company_id, ct.id, date, `Parcela ${inst.number} do acordo ${ct.code} (${ct.client_name})`, channel, notes, user.id),
    occurrenceStmt(db, ct.id, null,
      `${label} por ${user.name}: parcela ${inst.number} (vencimento ${brDate(inst.due_date)}), recebido ${brl(paid)} (${channel})${date !== finance.todayIso() ? ` em ${brDate(date)}` : ''}.` +
      (diff !== 0 ? ` Atenção: valor da parcela era ${brl(inst.amount_cents)}.` : '') + (notes ? ` Obs.: ${notes}` : '')),
    db.prepare(`UPDATE agreements SET status = 'CONCLUIDO', closed_at = ? WHERE id = ? AND status = 'ATIVO'
      AND NOT EXISTS (SELECT 1 FROM agreement_installments WHERE agreement_id = ? AND status = 'PENDENTE')`).bind(date, a.id, a.id),
    db.prepare(`UPDATE contracts SET status = 'QUITADO', in_agreement = 0, settled_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM agreements WHERE id = ? AND status = 'CONCLUIDO')`).bind(date, ct.id, a.id),
    db.prepare(`INSERT INTO occurrences (contract_id, author_name, author_role, text)
      SELECT ?, 'Sistema', 'SISTEMA', 'Acordo concluído: todas as parcelas foram pagas. Contrato QUITADO.'
      WHERE EXISTS (SELECT 1 FROM agreements WHERE id = ? AND status = 'CONCLUIDO')`).bind(ct.id, a.id),
  ];
}

company.post('/agreements/:aid/installments/:iid/pay', managerOnly, async c => {
  const db = c.get('db');
  const cid = c.get('company').id;
  const b = await readJson(c);
  const a = await getActiveAgreement(db, cid, c.req.param('aid'));
  const inst = await db.prepare('SELECT * FROM agreement_installments WHERE id = ? AND agreement_id = ?').bind(Number(c.req.param('iid')), a.id).first();
  if (!inst) throw new HttpError(404, 'Parcela não encontrada.');
  if (inst.status !== 'PENDENTE') throw new HttpError(400, 'Esta parcela já foi paga.');
  const paid = b.amount === undefined || b.amount === '' ? inst.amount_cents : moneyToCents(b.amount, 'Valor recebido');
  const { channel, notes, paid_on } = paymentInput(b);
  const ct = await getContract(db, cid, a.contract_id);
  await atomic(db, payInstallmentStmts(db, a, ct, inst, { paid, channel, notes, date: paid_on, user: c.get('user'), label: 'Parcela de acordo recebida' }),
    'Esta parcela já foi registrada por outra pessoa. Atualize a página e confira.');
  const after = await db.prepare('SELECT status FROM agreements WHERE id = ?').bind(a.id).first();
  return c.json({ ok: true, concluded: after.status === 'CONCLUIDO' });
});

// Cancelar só é permitido se nenhuma parcela foi paga (serve para desfazer um acordo lançado por engano)
company.post('/agreements/:aid/cancel', managerOnly, async c => {
  const db = c.get('db');
  const user = c.get('user');
  const a = await getActiveAgreement(db, c.get('company').id, c.req.param('aid'));
  const paidCount = await db.prepare("SELECT COUNT(*) AS n FROM agreement_installments WHERE agreement_id = ? AND status = 'PAGO'").bind(a.id).first();
  if (paidCount.n > 0) throw new HttpError(400, 'Este acordo já tem parcela paga e não pode ser cancelado. Use "Renegociar" para refazer as condições.');
  if (a.replaces_id) throw new HttpError(400, 'Este acordo é uma renegociação e não pode ser cancelado. Use "Renegociar" para refazer as condições.');
  await atomic(db, [
    db.prepare(`UPDATE agreements SET status = 'CANCELADO', closed_at = ? WHERE id = ? AND status = 'ATIVO'
      AND NOT EXISTS (SELECT 1 FROM agreement_installments WHERE agreement_id = ? AND status = 'PAGO')`).bind(finance.todayIso(), a.id, a.id),
    guard(db),
    db.prepare('UPDATE contracts SET in_agreement = 0 WHERE id = ?').bind(a.contract_id),
    occurrenceStmt(db, a.contract_id, null, `Acordo cancelado por ${user.name}. O contrato voltou às condições originais.`),
  ], 'Este acordo foi alterado por outra pessoa. Atualize a página e confira.');
  return c.json({ ok: true });
});

// ----- Relatório de inadimplência -----
company.get('/report/overdue', async c => {
  const today = finance.todayIso();
  const db = c.get('db');
  const cid = c.get('company').id;
  const rows = (await db.prepare("SELECT * FROM contracts WHERE company_id = ? AND status = 'ATIVO'").bind(cid).all()).results;
  const list = rows.filter(x => !x.in_agreement)
    .map(x => contractView(x, today))
    .filter(x => x.debt.overdueDays > 0)
    .sort((a, b) => b.debt.overdueDays - a.debt.overdueDays);

  // Parcelas de acordo vencidas e não pagas
  const agr = await agreementSummaries(db, cid, today);
  const byId = new Map(rows.map(x => [x.id, x]));
  const installments = [];
  for (const a of agr.values()) {
    const ct = byId.get(a.contract_id);
    if (!ct) continue;
    for (const i of a.installments) {
      if (i.status === 'PENDENTE' && i.overdue_days > 0) {
        installments.push({
          contract_id: ct.id, code: ct.code, client_name: ct.client_name, cpf: ct.cpf, phone: ct.phone, address: ct.address,
          agreement_id: a.id, installment_id: i.id, number: i.number, of: a.installments_count,
          due_date: i.due_date, amount_cents: i.amount_cents, overdue_days: i.overdue_days,
          agreement_remaining_cents: a.remaining_cents,
        });
      }
    }
  }
  installments.sort((x, y) => y.overdue_days - x.overdue_days);

  return c.json({
    contracts: list,
    agreement_installments: installments,
    total_diarias_cents: list.reduce((a, x) => a + x.debt.lateFee, 0),
    total_em_risco_cents: list.reduce((a, x) => a + x.debt.totalToSettle, 0),
    total_parcelas_atrasadas_cents: installments.reduce((a, x) => a + x.amount_cents, 0),
    today,
  });
});

// ----- Conciliação bancária (OFX) -----
company.get('/bank', managerOnly, async c => {
  const db = c.get('db');
  const cid = c.get('company').id;
  const today = finance.todayIso();
  const [cr, tr] = await db.batch([
    db.prepare('SELECT * FROM contracts WHERE company_id = ?').bind(cid),
    db.prepare('SELECT * FROM bank_transactions WHERE company_id = ? ORDER BY date DESC, id DESC').bind(cid),
  ]);
  const agr = await agreementSummaries(db, cid, today);
  // Para contratos em acordo, a sugestão compara com a próxima parcela pendente
  const contracts = cr.results.map(x => {
    const a = x.in_agreement ? agr.get(x.id) : null;
    return a && a.next_installment ? { ...x, next_installment_cents: a.next_installment.amount_cents } : x;
  });
  const txs = tr.results;
  const byId = new Map(contracts.map(x => [x.id, x]));

  const out = txs.map(tx => {
    let s = { contract_id: tx.contract_id, action: tx.action };
    if (tx.status === 'PENDENTE') {
      const auto = suggestMatch(tx, contracts, today);
      s = {
        contract_id: tx.contract_id ?? auto.contract_id,
        action: tx.action ?? (tx.contract_id && tx.contract_id !== auto.contract_id ? null : auto.action),
      };
    }
    const ct = s.contract_id ? byId.get(s.contract_id) : null;
    return {
      id: tx.id, fitid: tx.fitid, date: tx.date, description: tx.description, amount_cents: tx.amount_cents,
      status: tx.status, contract_id: s.contract_id, action: s.action,
      contract: ct ? {
        id: ct.id, code: ct.code, client_name: ct.client_name, cpf: ct.cpf, debt: finance.calculateDebt(ct, today), status: ct.status,
        in_agreement: !!ct.in_agreement,
        next_installment: ct.in_agreement && agr.get(ct.id) ? agr.get(ct.id).next_installment : null,
      } : null,
    };
  });

  const entradas = txs.filter(t => t.amount_cents > 0).reduce((a, t) => a + t.amount_cents, 0);
  const saidas = txs.filter(t => t.amount_cents < 0).reduce((a, t) => a - t.amount_cents, 0);
  return c.json({
    transactions: out,
    active_contracts: contracts.filter(x => x.status === 'ATIVO').map(x => ({ id: x.id, code: x.code, client_name: x.client_name, in_agreement: !!x.in_agreement })),
    totals: { entradas_cents: entradas, saidas_cents: saidas, liquido_cents: entradas - saidas, pendentes: txs.filter(t => t.status === 'PENDENTE').length },
  });
});

company.post('/bank/import', managerOnly, async c => {
  const db = c.get('db');
  const b = await readJson(c);
  const content = typeof b.content === 'string' ? b.content : '';
  if (!content.trim()) throw new HttpError(400, 'Arquivo vazio.');
  if (content.length > 3_000_000) throw new HttpError(413, 'Arquivo muito grande.');
  const parsed = parseOfx(content);
  if (!parsed.length) throw new HttpError(400, 'Não encontrei movimentações neste arquivo. Confira se é um extrato OFX.');
  const cid = c.get('company').id;
  let imported = 0;
  // Lotes de até 50 comandos
  for (let i = 0; i < parsed.length; i += 50) {
    const res = await db.batch(parsed.slice(i, i + 50).map(t =>
      db.prepare('INSERT OR IGNORE INTO bank_transactions (company_id, fitid, date, description, amount_cents) VALUES (?, ?, ?, ?, ?)')
        .bind(cid, t.fitid, t.date, t.description, t.amount_cents)));
    imported += res.reduce((n, r) => n + (r.meta.changes || 0), 0);
  }
  return c.json({ imported, duplicates: parsed.length - imported });
});

const CREDIT_ACTIONS = ['ROLAR', 'QUITAR', 'AMORTIZACAO', 'PARCELA_ACORDO', 'OUTRA_ENTRADA'];
const DEBIT_ACTIONS = ['DESEMBOLSO', 'DESPESA'];

company.post('/bank/:txid/validate', managerOnly, async c => {
  const db = c.get('db');
  const user = c.get('user');
  const cid = c.get('company').id;
  const b = await readJson(c);
  const today = finance.todayIso();

  const tx = await db.prepare('SELECT * FROM bank_transactions WHERE id = ? AND company_id = ?').bind(Number(c.req.param('txid')), cid).first();
  if (!tx) throw new HttpError(404, 'Transação não encontrada.');
  if (tx.status === 'CONCILIADO') throw new HttpError(400, 'Esta transação já foi validada.');

  const isCredit = tx.amount_cents > 0;
  const action = b.action;
  if (!(isCredit ? CREDIT_ACTIONS : DEBIT_ACTIONS).includes(action)) throw new HttpError(400, 'Escolha a natureza da transação.');

  let ct = null;
  if (b.contract_id) ct = await getContract(db, cid, b.contract_id);
  if ((action === 'ROLAR' || action === 'QUITAR' || action === 'PARCELA_ACORDO') && !ct) throw new HttpError(400, 'Vincule um contrato antes de validar.');
  if ((action === 'ROLAR' || action === 'QUITAR' || action === 'PARCELA_ACORDO') && ct.status !== 'ATIVO') throw new HttpError(400, 'O contrato vinculado já está quitado.');
  if ((action === 'ROLAR' || action === 'QUITAR') && ct.in_agreement) throw new HttpError(400, 'O contrato está em acordo: escolha "Parcela de acordo".');
  if (action === 'PARCELA_ACORDO' && !ct.in_agreement) throw new HttpError(400, 'O contrato vinculado não tem acordo ativo.');

  // 1º: marca a transação como conciliada (só se ainda estiver pendente)
  const stmts = [
    db.prepare(`UPDATE bank_transactions SET status = 'CONCILIADO', action = ?, contract_id = ?, validated_by = ?, validated_at = datetime('now')
      WHERE id = ? AND status = 'PENDENTE'`).bind(action, ct ? ct.id : null, user.id, tx.id),
    guard(db),
  ];
  const opts = { amount_cents: tx.amount_cents, channel: 'OFX', notes: `Extrato: ${tx.description}`, date: tx.date, user, today };
  let message = 'Transação validada.';

  if (action === 'ROLAR') {
    const r = rolloverStmts(db, ct, { ...opts, label: 'Rolagem via conciliação bancária' });
    stmts.push(...r.stmts);
    message = `Rolagem validada. Novo vencimento: ${brDate(r.newDue)}.`;
  } else if (action === 'QUITAR') {
    stmts.push(...settleStmts(db, ct, { ...opts, label: 'Quitação via conciliação bancária' }));
    message = `Contrato ${ct.code} quitado.`;
  } else if (action === 'AMORTIZACAO') {
    if (!ct) throw new HttpError(400, 'Vincule um contrato antes de validar.');
    checkAmortization(ct, tx.amount_cents);
    stmts.push(...amortizeStmts(db, ct, {
      amount_cents: tx.amount_cents, channel: 'OFX', notes: `Extrato: ${tx.description}`, date: tx.date, user, label: 'Quebra de juros via conciliação bancária',
    }));
    message = `Quebra de juros registrada. Novo principal: ${brl(ct.principal_cents - tx.amount_cents)}.`;
  } else if (action === 'PARCELA_ACORDO') {
    const a = await db.prepare("SELECT * FROM agreements WHERE contract_id = ? AND status = 'ATIVO'").bind(ct.id).first();
    const inst = a && await db.prepare("SELECT * FROM agreement_installments WHERE agreement_id = ? AND status = 'PENDENTE' ORDER BY number LIMIT 1").bind(a.id).first();
    if (!inst) throw new HttpError(400, 'O acordo deste contrato não tem parcela pendente.');
    stmts.push(...payInstallmentStmts(db, a, ct, inst, {
      paid: tx.amount_cents, channel: 'OFX', notes: `Extrato: ${tx.description}`, date: tx.date, user, label: 'Parcela de acordo recebida via conciliação bancária',
    }));
    message = `Parcela ${inst.number} do acordo registrada.`;
  } else if (action === 'OUTRA_ENTRADA') {
    stmts.push(db.prepare(`INSERT INTO ledger (company_id, contract_id, date, type, description, amount_cents, channel, user_id)
      VALUES (?, ?, ?, 'OUTRA_ENTRADA', ?, ?, 'OFX', ?)`).bind(cid, ct ? ct.id : null, tx.date, tx.description, tx.amount_cents, user.id));
  } else if (action === 'DESPESA') {
    stmts.push(db.prepare(`INSERT INTO ledger (company_id, date, type, description, amount_cents, channel, user_id)
      VALUES (?, ?, 'DESPESA', ?, ?, 'OFX', ?)`).bind(cid, tx.date, tx.description, tx.amount_cents, user.id));
  } else if (action === 'DESEMBOLSO' && ct) {
    // A concessão já foi lançada no cadastro do contrato; aqui só confirmamos a saída no banco.
    stmts.push(occurrenceStmt(db, ct.id, null, `Desembolso confirmado no extrato bancário por ${user.name} (${brl(-tx.amount_cents)} em ${brDate(tx.date)}).`));
  }

  await atomic(db, stmts, 'Esta transação ou o contrato foram alterados por outra pessoa. Atualize a página e confira.');
  return c.json({ ok: true, message });
});

company.delete('/bank/:txid', managerOnly, async c => {
  const r = await c.get('db').prepare("DELETE FROM bank_transactions WHERE id = ? AND company_id = ? AND status = 'PENDENTE'")
    .bind(Number(c.req.param('txid')), c.get('company').id).run();
  if (!r.meta.changes) throw new HttpError(400, 'Só é possível descartar transações pendentes.');
  return c.json({ ok: true });
});

app.route('/api/companies/:cid', company);

app.all('/api/*', c => c.json({ error: 'Rota não encontrada.' }, 404));

// Qualquer outra rota: entrega as telas (arquivos da pasta public/, empacotados no código)
const decoded = new Map();
function staticFile(p) {
  if (!decoded.has(p)) {
    const f = STATIC_FILES[p];
    if (!f) return null;
    const bin = atob(f.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    decoded.set(p, { type: f.type, bytes });
  }
  return decoded.get(p);
}

app.on(['GET', 'HEAD'], '*', c => {
  let p = new URL(c.req.url).pathname;
  if (p === '/') p = '/index.html';
  // Rotas desconhecidas abrem a tela principal (o app decide o que mostrar)
  const file = staticFile(p) || (p.includes('.') ? null : staticFile('/index.html'));
  if (!file) return c.text('Não encontrado', 404);
  return new Response(c.req.method === 'HEAD' ? null : file.bytes, {
    headers: {
      'Content-Type': file.type,
      'Cache-Control': p.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
    },
  });
});

export default app;
