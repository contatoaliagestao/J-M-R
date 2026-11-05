'use strict';

const path = require('path');
const express = require('express');
const { openDatabase } = require('./db');
const auth = require('./auth');
const finance = require('./finance');
const { parseOfx, suggestMatch } = require('./ofx');

const MAX_COMPANIES = Number(process.env.MAX_EMPRESAS || 3);
const COLOR_THEMES = ['amber', 'emerald', 'blue', 'rose', 'purple', 'cyan', 'orange'];
const ROLES_ASSIGNABLE = ['GESTOR', 'OPERADOR'];
const PAYMENT_CHANNELS = ['DINHEIRO', 'PIX_MANUAL'];
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- Utilidades de validação ----------
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
  if (!partial || body.color_theme !== undefined) {
    out.color_theme = COLOR_THEMES.includes(body.color_theme) ? body.color_theme : 'amber';
  }
  if (!partial || body.logo_url !== undefined) out.logo_url = validateLogo(body.logo_url);
  return out;
}

// ---------- Aplicação ----------
function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);

  const cookieSecure = process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production';

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use('/api', express.json({ limit: '3mb' }));

  // Proteção contra CSRF: toda requisição que altera dados precisa ser JSON
  // (formulários de outros sites não conseguem enviar JSON sem permissão do navegador).
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Requisição inválida.' });
    }
    next();
  });

  // Carrega o usuário da sessão
  app.use('/api', (req, res, next) => {
    const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
    req.sessionToken = token;
    req.user = auth.getSessionUser(db, token);
    next();
  });

  function setSessionCookie(res, token, ttlMs) {
    const parts = [
      `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(ttlMs / 1000)}`,
    ];
    if (cookieSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure ? '; Secure' : ''}`);
  }

  const requireAuth = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    next();
  };
  const requireRole = (...roles) => (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Seu perfil não tem permissão para esta ação.' });
    next();
  };
  const isManager = u => u.role === 'ADMIN' || u.role === 'GESTOR';

  function allowedCompanies(user) {
    if (user.role === 'ADMIN') return db.prepare('SELECT * FROM companies ORDER BY id').all();
    return db.prepare(`
      SELECT c.* FROM companies c JOIN user_companies uc ON uc.company_id = c.id
      WHERE uc.user_id = ? ORDER BY c.id`).all(user.id);
  }

  // Garante que o usuário tem acesso à empresa da URL
  const requireCompany = (req, res, next) => {
    const id = Number(req.params.cid);
    const company = allowedCompanies(req.user).find(c => c.id === id);
    if (!company) return res.status(403).json({ error: 'Você não tem acesso a esta empresa.' });
    req.company = company;
    next();
  };

  function publicCompany(c) {
    return {
      id: c.id, official_name: c.official_name, short_name: c.short_name, tagline: c.tagline,
      cnpj: c.cnpj, color_theme: c.color_theme, logo_url: c.logo_url, code_prefix: c.code_prefix,
    };
  }

  function publicUser(u) {
    return { id: u.id, name: u.name, email: u.email || null, username: u.username || null, role: u.role };
  }

  function getContract(companyId, contractId) {
    const c = db.prepare('SELECT * FROM contracts WHERE id = ? AND company_id = ?').get(Number(contractId), companyId);
    if (!c) throw new HttpError(404, 'Contrato não encontrado.');
    return c;
  }

  function contractView(c, today) {
    const debt = finance.calculateDebt(c, today);
    return {
      id: c.id, code: c.code, client_name: c.client_name, cpf: c.cpf, phone: c.phone,
      address: c.address, social_media: c.social_media,
      principal_cents: c.principal_cents, rate: c.rate, late_fee_rate: c.late_fee_rate,
      cycle_days: c.cycle_days, start_date: c.start_date, due_date: c.due_date,
      status: c.status, rollover_count: c.rollover_count, settled_at: c.settled_at,
      situation: c.status === 'QUITADO' ? 'QUITADO' : (debt.overdueDays > 0 ? 'ATRASADO' : 'EM_DIA'),
      debt,
    };
  }

  function addOccurrence(contractId, user, text) {
    db.prepare('INSERT INTO occurrences (contract_id, user_id, author_name, author_role, text) VALUES (?, ?, ?, ?, ?)')
      .run(contractId, user ? user.id : null, user ? user.name : 'Sistema', user ? user.role : 'SISTEMA', text);
  }

  const brl = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const brDate = iso => iso.split('-').reverse().join('/');

  // ===== Configuração inicial (cadastro do administrador por e-mail) =====
  const hasAdmin = () => !!db.prepare("SELECT 1 FROM users WHERE role = 'ADMIN' LIMIT 1").get();

  app.get('/api/setup', (req, res) => {
    res.json({ needsSetup: !hasAdmin(), maxCompanies: MAX_COMPANIES });
  });

  app.post('/api/setup', (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { field: 'Nome do administrador', required: true, max: 100 });
    const email = str(b.email, { field: 'E-mail', required: true, max: 120 }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'E-mail inválido.');
    const pwErr = auth.validatePasswordStrength(b.password);
    if (pwErr) throw new HttpError(400, pwErr);
    const company = companyInput(b.company || {});

    const user = db.transaction(() => {
      if (hasAdmin()) throw new HttpError(409, 'O sistema já foi configurado. Faça login.');
      const u = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'ADMIN')")
        .run(name, email, auth.hashPassword(b.password));
      db.prepare(`INSERT INTO companies (official_name, short_name, tagline, cnpj, color_theme, logo_url, code_prefix)
        VALUES (@official_name, @short_name, @tagline, @cnpj, @color_theme, @logo_url, @code_prefix)`)
        .run({ ...company, code_prefix: makePrefix(company.short_name) });
      return db.prepare('SELECT * FROM users WHERE id = ?').get(u.lastInsertRowid);
    })();

    const { token, ttl } = auth.createSession(db, user.id, false);
    setSessionCookie(res, token, ttl);
    res.status(201).json({ user: publicUser(user) });
  });

  // ===== Login / logout =====
  app.post('/api/login', (req, res) => {
    const b = req.body || {};
    const login = str(b.login, { field: 'Usuário', required: true, max: 120 });
    const password = typeof b.password === 'string' ? b.password : '';
    const ip = req.ip || '';

    if (auth.isLoginBlocked(ip, login)) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
    }

    // Administrador entra com e-mail; demais usuários com nome de usuário
    const user = login.includes('@')
      ? db.prepare("SELECT * FROM users WHERE email = ? AND role = 'ADMIN'").get(login)
      : db.prepare('SELECT * FROM users WHERE username = ?').get(login);

    const ok = auth.verifyPassword(password, user ? user.password_hash : auth.DUMMY_HASH) && !!user;
    if (!ok || !user.active) {
      auth.registerFailedLogin(ip, login);
      return res.status(401).json({ error: user && ok && !user.active ? 'Usuário desativado. Fale com o administrador.' : 'Usuário ou senha incorretos.' });
    }

    auth.clearFailedLogins(ip, login);
    auth.purgeExpiredSessions(db);
    const { token, ttl } = auth.createSession(db, user.id, !!b.remember);
    setSessionCookie(res, token, ttl);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/logout', (req, res) => {
    auth.destroySession(db, req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({
      user: publicUser(req.user),
      companies: allowedCompanies(req.user).map(publicCompany),
      maxCompanies: MAX_COMPANIES,
      today: finance.todayIso(),
    });
  });

  app.put('/api/me/password', requireAuth, (req, res) => {
    const b = req.body || {};
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!auth.verifyPassword(String(b.current_password || ''), row.password_hash)) {
      throw new HttpError(400, 'Senha atual incorreta.');
    }
    const pwErr = auth.validatePasswordStrength(b.new_password);
    if (pwErr) throw new HttpError(400, pwErr);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(b.new_password), req.user.id);
      // Encerra as outras sessões deste usuário
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
        .run(req.user.id, require('crypto').createHash('sha256').update(req.sessionToken).digest('hex'));
    })();
    res.json({ ok: true });
  });

  // ===== Empresas (somente administrador cria/edita) =====
  app.post('/api/companies', requireAuth, requireRole('ADMIN'), (req, res) => {
    const data = companyInput(req.body || {});
    const created = db.transaction(() => {
      const count = db.prepare('SELECT COUNT(*) AS n FROM companies').get().n;
      if (count >= MAX_COMPANIES) throw new HttpError(400, `Limite de ${MAX_COMPANIES} empresas atingido.`);
      const r = db.prepare(`INSERT INTO companies (official_name, short_name, tagline, cnpj, color_theme, logo_url, code_prefix)
        VALUES (@official_name, @short_name, @tagline, @cnpj, @color_theme, @logo_url, @code_prefix)`)
        .run({ ...data, code_prefix: makePrefix(data.short_name) });
      return db.prepare('SELECT * FROM companies WHERE id = ?').get(r.lastInsertRowid);
    })();
    res.status(201).json({ company: publicCompany(created) });
  });

  app.put('/api/companies/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(id)) throw new HttpError(404, 'Empresa não encontrada.');
    const data = companyInput(req.body || {}, { partial: true });
    const keys = Object.keys(data);
    if (keys.length) {
      db.prepare(`UPDATE companies SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...data, id });
    }
    res.json({ company: publicCompany(db.prepare('SELECT * FROM companies WHERE id = ?').get(id)) });
  });

  // ===== Usuários (somente administrador) =====
  function validCompanyIds(ids) {
    if (!Array.isArray(ids)) return [];
    const all = new Set(db.prepare('SELECT id FROM companies').all().map(r => r.id));
    return [...new Set(ids.map(Number))].filter(id => all.has(id));
  }

  function userWithCompanies(u) {
    const company_ids = u.role === 'ADMIN'
      ? db.prepare('SELECT id FROM companies ORDER BY id').all().map(r => r.id)
      : db.prepare('SELECT company_id FROM user_companies WHERE user_id = ? ORDER BY company_id').all(u.id).map(r => r.company_id);
    return { ...publicUser(u), active: !!u.active, created_at: u.created_at, company_ids };
  }

  app.get('/api/users', requireAuth, requireRole('ADMIN'), (req, res) => {
    const users = db.prepare("SELECT * FROM users ORDER BY role = 'ADMIN' DESC, name").all();
    res.json({ users: users.map(userWithCompanies) });
  });

  app.post('/api/users', requireAuth, requireRole('ADMIN'), (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { field: 'Nome', required: true, max: 100 });
    const username = str(b.username, { field: 'Nome de usuário', required: true, max: 30 }).toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'Nome de usuário: use de 3 a 30 letras, números, ponto, hífen ou sublinhado (sem espaços e sem @).');
    }
    if (!ROLES_ASSIGNABLE.includes(b.role)) throw new HttpError(400, 'Perfil inválido.');
    const pwErr = auth.validatePasswordStrength(b.password);
    if (pwErr) throw new HttpError(400, pwErr);
    const companyIds = validCompanyIds(b.company_ids);
    if (!companyIds.length) throw new HttpError(400, 'Selecione ao menos 1 empresa para este usuário.');

    const user = db.transaction(() => {
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        throw new HttpError(409, 'Este nome de usuário já está em uso.');
      }
      const r = db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)')
        .run(name, username, auth.hashPassword(b.password), b.role);
      const ins = db.prepare('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)');
      companyIds.forEach(cid => ins.run(r.lastInsertRowid, cid));
      return db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    })();
    res.status(201).json({ user: userWithCompanies(user) });
  });

  app.put('/api/users/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) throw new HttpError(404, 'Usuário não encontrado.');
    const b = req.body || {};

    db.transaction(() => {
      if (b.name !== undefined) {
        db.prepare('UPDATE users SET name = ? WHERE id = ?').run(str(b.name, { field: 'Nome', required: true, max: 100 }), id);
      }
      if (b.password) {
        const pwErr = auth.validatePasswordStrength(b.password);
        if (pwErr) throw new HttpError(400, pwErr);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(b.password), id);
        if (id !== req.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      if (target.role === 'ADMIN') {
        if (b.role !== undefined || b.active !== undefined || b.company_ids !== undefined) {
          throw new HttpError(400, 'O perfil, o status e as empresas do administrador não podem ser alterados.');
        }
        return;
      }
      if (b.role !== undefined) {
        if (!ROLES_ASSIGNABLE.includes(b.role)) throw new HttpError(400, 'Perfil inválido.');
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id);
      }
      if (b.active !== undefined) {
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, id);
        if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      if (b.company_ids !== undefined) {
        const companyIds = validCompanyIds(b.company_ids);
        if (!companyIds.length) throw new HttpError(400, 'Selecione ao menos 1 empresa para este usuário.');
        db.prepare('DELETE FROM user_companies WHERE user_id = ?').run(id);
        const ins = db.prepare('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)');
        companyIds.forEach(cid => ins.run(id, cid));
      }
    })();
    res.json({ user: userWithCompanies(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
  });

  // ===== Rotas por empresa =====
  const company = express.Router({ mergeParams: true });
  app.use('/api/companies/:cid', requireAuth, requireCompany, company);
  const managerOnly = (req, res, next) => isManager(req.user) ? next()
    : res.status(403).json({ error: 'Acesso restrito ao perfil Gestor.' });

  // ----- Dashboard -----
  company.get('/dashboard', managerOnly, (req, res) => {
    const today = finance.todayIso();
    const active = db.prepare("SELECT * FROM contracts WHERE company_id = ? AND status = 'ATIVO'").all(req.company.id);
    const s = {
      capital_alocado_cents: 0, receita_a_entrar_cents: 0, contratos_ativos: active.length,
      em_atraso: 0, ciclo15: 0, ciclo30: 0, outros_ciclos: 0, total_rolagens: 0, ultimo_vencimento: null,
    };
    for (const c of active) {
      const d = finance.calculateDebt(c, today);
      s.capital_alocado_cents += c.principal_cents;
      s.receita_a_entrar_cents += d.cycleInterest;
      s.total_rolagens += c.rollover_count;
      if (d.overdueDays > 0) s.em_atraso++;
      if (c.cycle_days === 15) s.ciclo15++; else if (c.cycle_days === 30) s.ciclo30++; else s.outros_ciclos++;
      if (!s.ultimo_vencimento || c.due_date > s.ultimo_vencimento) s.ultimo_vencimento = c.due_date;
    }
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type IN ('ROLAGEM','QUITACAO') THEN revenue_cents END), 0) AS receita,
        COALESCE(SUM(CASE WHEN type = 'OUTRA_ENTRADA' THEN amount_cents END), 0) AS outras,
        COALESCE(SUM(CASE WHEN type = 'DESPESA' THEN -amount_cents END), 0) AS despesas
      FROM ledger WHERE company_id = ?`).get(req.company.id);
    s.receita_realizada_cents = totals.receita;
    s.outras_entradas_cents = totals.outras;
    s.despesas_cents = totals.despesas;
    s.lucro_liquido_cents = totals.receita + totals.outras - totals.despesas;
    s.taxa_atraso = active.length ? Math.round(s.em_atraso / active.length * 100) : 0;
    res.json({ dashboard: s, today });
  });

  // ----- Contratos -----
  company.get('/contracts', (req, res) => {
    const today = finance.todayIso();
    const rows = db.prepare('SELECT * FROM contracts WHERE company_id = ? ORDER BY status, due_date').all(req.company.id);
    res.json({ contracts: rows.map(c => contractView(c, today)), today });
  });

  company.post('/contracts', managerOnly, (req, res) => {
    const b = req.body || {};
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

    const created = db.transaction(() => {
      const comp = db.prepare('SELECT code_prefix, next_number FROM companies WHERE id = ?').get(req.company.id);
      const code = `${comp.code_prefix}-${comp.next_number}`;
      db.prepare('UPDATE companies SET next_number = next_number + 1 WHERE id = ?').run(req.company.id);
      const r = db.prepare(`INSERT INTO contracts
        (company_id, code, client_name, cpf, phone, address, social_media, principal_cents, rate, late_fee_rate,
         cycle_days, start_date, due_date, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.company.id, code, client_name, cpf, phone, address, social_media, principal_cents, rate,
          late_fee_rate, cycle_days, start_date, due_date, req.user.id);
      const id = r.lastInsertRowid;
      db.prepare(`INSERT INTO ledger (company_id, contract_id, date, type, description, amount_cents, principal_cents, channel, user_id)
        VALUES (?, ?, ?, 'CONCESSAO', ?, ?, ?, 'SISTEMA', ?)`)
        .run(req.company.id, id, start_date, `Concessão ${code} (${client_name})`, -principal_cents, principal_cents, req.user.id);
      addOccurrence(id, null, `Contrato ${code} cadastrado por ${req.user.name}: ${brl(principal_cents)} a ${rate}% a cada ${cycle_days} dias. 1º vencimento em ${brDate(due_date)}.`);
      return db.prepare('SELECT * FROM contracts WHERE id = ?').get(id);
    })();
    res.status(201).json({ contract: contractView(created, finance.todayIso()) });
  });

  company.get('/contracts/:id', (req, res) => {
    const c = getContract(req.company.id, req.params.id);
    const occurrences = db.prepare('SELECT id, author_name, author_role, text, created_at FROM occurrences WHERE contract_id = ? ORDER BY id DESC').all(c.id);
    const payments = db.prepare("SELECT date, type, amount_cents, channel, notes FROM ledger WHERE contract_id = ? ORDER BY id DESC").all(c.id);
    res.json({ contract: contractView(c, finance.todayIso()), occurrences, payments });
  });

  company.post('/contracts/:id/occurrences', (req, res) => {
    const c = getContract(req.company.id, req.params.id);
    const text = str((req.body || {}).text, { field: 'Ocorrência', required: true, max: 2000 });
    addOccurrence(c.id, req.user, text);
    res.status(201).json({ ok: true });
  });

  function paymentInput(b) {
    const channel = PAYMENT_CHANNELS.includes(b.channel) ? b.channel : null;
    if (!channel) throw new HttpError(400, 'Escolha o método de baixa.');
    return { channel, notes: str(b.notes, { field: 'Observações', max: 300 }) };
  }

  function doRollover(contract, { amount_cents, channel, notes, date, user, today, label }) {
    const debt = finance.calculateDebt(contract, today);
    const newDue = finance.nextDueDateAfterRollover(contract, today);
    const paid = amount_cents ?? debt.totalToRollover;
    db.prepare("UPDATE contracts SET due_date = ?, rollover_count = rollover_count + 1 WHERE id = ?").run(newDue, contract.id);
    db.prepare(`INSERT INTO ledger (company_id, contract_id, date, type, description, amount_cents, revenue_cents, channel, notes, user_id)
      VALUES (?, ?, ?, 'ROLAGEM', ?, ?, ?, ?, ?, ?)`)
      .run(contract.company_id, contract.id, date, `Rolagem ${contract.code} (${contract.client_name})`, paid, paid, channel, notes, user.id);
    const diff = paid - debt.totalToRollover;
    addOccurrence(contract.id, null,
      `${label} por ${user.name}: recebido ${brl(paid)} (${channel}). Novo vencimento: ${brDate(newDue)}.` +
      (diff !== 0 ? ` Atenção: valor esperado era ${brl(debt.totalToRollover)}.` : '') +
      (notes ? ` Obs.: ${notes}` : ''));
    return newDue;
  }

  function doSettle(contract, { amount_cents, channel, notes, date, user, today, label }) {
    const debt = finance.calculateDebt(contract, today);
    const paid = amount_cents ?? debt.totalToSettle;
    const principalPart = Math.min(paid, contract.principal_cents);
    db.prepare("UPDATE contracts SET status = 'QUITADO', settled_at = ? WHERE id = ?").run(date, contract.id);
    db.prepare(`INSERT INTO ledger (company_id, contract_id, date, type, description, amount_cents, principal_cents, revenue_cents, channel, notes, user_id)
      VALUES (?, ?, ?, 'QUITACAO', ?, ?, ?, ?, ?, ?, ?)`)
      .run(contract.company_id, contract.id, date, `Quitação ${contract.code} (${contract.client_name})`, paid,
        principalPart, paid - principalPart, channel, notes, user.id);
    const diff = paid - debt.totalToSettle;
    addOccurrence(contract.id, null,
      `${label} por ${user.name}: recebido ${brl(paid)} (${channel}). Contrato QUITADO.` +
      (diff !== 0 ? ` Atenção: valor esperado era ${brl(debt.totalToSettle)}.` : '') +
      (notes ? ` Obs.: ${notes}` : ''));
  }

  company.post('/contracts/:id/rollover', managerOnly, (req, res) => {
    const { channel, notes } = paymentInput(req.body || {});
    const today = finance.todayIso();
    const newDue = db.transaction(() => {
      const c = getContract(req.company.id, req.params.id);
      if (c.status !== 'ATIVO') throw new HttpError(400, 'Este contrato já está quitado.');
      return doRollover(c, { channel, notes, date: today, user: req.user, today, label: 'Rolagem (baixa manual)' });
    })();
    res.json({ ok: true, new_due_date: newDue });
  });

  company.post('/contracts/:id/settle', managerOnly, (req, res) => {
    const { channel, notes } = paymentInput(req.body || {});
    const today = finance.todayIso();
    db.transaction(() => {
      const c = getContract(req.company.id, req.params.id);
      if (c.status !== 'ATIVO') throw new HttpError(400, 'Este contrato já está quitado.');
      doSettle(c, { channel, notes, date: today, user: req.user, today, label: 'Quitação (baixa manual)' });
    })();
    res.json({ ok: true });
  });

  // ----- Relatório de inadimplência -----
  company.get('/report/overdue', (req, res) => {
    const today = finance.todayIso();
    const list = db.prepare("SELECT * FROM contracts WHERE company_id = ? AND status = 'ATIVO'").all(req.company.id)
      .map(c => contractView(c, today))
      .filter(c => c.debt.overdueDays > 0)
      .sort((a, b) => b.debt.overdueDays - a.debt.overdueDays);
    res.json({
      contracts: list,
      total_diarias_cents: list.reduce((a, c) => a + c.debt.lateFee, 0),
      total_em_risco_cents: list.reduce((a, c) => a + c.debt.totalToSettle, 0),
      today,
    });
  });

  // ----- Conciliação bancária (OFX) -----
  company.get('/bank', managerOnly, (req, res) => {
    const today = finance.todayIso();
    const contracts = db.prepare('SELECT * FROM contracts WHERE company_id = ?').all(req.company.id);
    const byId = new Map(contracts.map(c => [c.id, c]));
    const txs = db.prepare('SELECT * FROM bank_transactions WHERE company_id = ? ORDER BY date DESC, id DESC').all(req.company.id);

    const out = txs.map(tx => {
      let suggestion = { contract_id: tx.contract_id, action: tx.action };
      if (tx.status === 'PENDENTE') {
        const auto = suggestMatch(tx, contracts, today);
        suggestion = {
          contract_id: tx.contract_id ?? auto.contract_id,
          action: tx.action ?? (tx.contract_id && tx.contract_id !== auto.contract_id ? null : auto.action),
        };
      }
      const c = suggestion.contract_id ? byId.get(suggestion.contract_id) : null;
      return {
        id: tx.id, fitid: tx.fitid, date: tx.date, description: tx.description, amount_cents: tx.amount_cents,
        status: tx.status, contract_id: suggestion.contract_id, action: suggestion.action,
        contract: c ? { id: c.id, code: c.code, client_name: c.client_name, cpf: c.cpf, debt: finance.calculateDebt(c, today), status: c.status } : null,
      };
    });

    const entradas = txs.filter(t => t.amount_cents > 0).reduce((a, t) => a + t.amount_cents, 0);
    const saidas = txs.filter(t => t.amount_cents < 0).reduce((a, t) => a - t.amount_cents, 0);
    res.json({
      transactions: out,
      active_contracts: contracts.filter(c => c.status === 'ATIVO').map(c => ({ id: c.id, code: c.code, client_name: c.client_name })),
      totals: { entradas_cents: entradas, saidas_cents: saidas, liquido_cents: entradas - saidas, pendentes: txs.filter(t => t.status === 'PENDENTE').length },
    });
  });

  company.post('/bank/import', managerOnly, (req, res) => {
    const content = typeof (req.body || {}).content === 'string' ? req.body.content : '';
    if (!content.trim()) throw new HttpError(400, 'Arquivo vazio.');
    const parsed = parseOfx(content);
    if (!parsed.length) throw new HttpError(400, 'Não encontrei movimentações neste arquivo. Confira se é um extrato OFX.');
    const ins = db.prepare(`INSERT OR IGNORE INTO bank_transactions (company_id, fitid, date, description, amount_cents)
      VALUES (?, ?, ?, ?, ?)`);
    const imported = db.transaction(() => parsed.reduce((n, t) =>
      n + ins.run(req.company.id, t.fitid, t.date, t.description, t.amount_cents).changes, 0))();
    res.json({ imported, duplicates: parsed.length - imported });
  });

  const CREDIT_ACTIONS = ['ROLAR', 'QUITAR', 'OUTRA_ENTRADA'];
  const DEBIT_ACTIONS = ['DESEMBOLSO', 'DESPESA'];

  company.post('/bank/:txid/validate', managerOnly, (req, res) => {
    const b = req.body || {};
    const today = finance.todayIso();
    const result = db.transaction(() => {
      const tx = db.prepare('SELECT * FROM bank_transactions WHERE id = ? AND company_id = ?').get(Number(req.params.txid), req.company.id);
      if (!tx) throw new HttpError(404, 'Transação não encontrada.');
      if (tx.status === 'CONCILIADO') throw new HttpError(400, 'Esta transação já foi validada.');

      const isCredit = tx.amount_cents > 0;
      const action = b.action;
      if (!(isCredit ? CREDIT_ACTIONS : DEBIT_ACTIONS).includes(action)) throw new HttpError(400, 'Escolha a natureza da transação.');

      let contract = null;
      if (b.contract_id) contract = getContract(req.company.id, b.contract_id);
      if ((action === 'ROLAR' || action === 'QUITAR') && !contract) throw new HttpError(400, 'Vincule um contrato antes de validar.');
      if ((action === 'ROLAR' || action === 'QUITAR') && contract.status !== 'ATIVO') throw new HttpError(400, 'O contrato vinculado já está quitado.');

      const opts = { amount_cents: tx.amount_cents, channel: 'OFX', notes: `Extrato: ${tx.description}`, date: tx.date, user: req.user, today };
      let message = 'Transação validada.';
      if (action === 'ROLAR') {
        const newDue = doRollover(contract, { ...opts, label: 'Rolagem via conciliação bancária' });
        message = `Rolagem validada. Novo vencimento: ${brDate(newDue)}.`;
      } else if (action === 'QUITAR') {
        doSettle(contract, { ...opts, label: 'Quitação via conciliação bancária' });
        message = `Contrato ${contract.code} quitado.`;
      } else if (action === 'OUTRA_ENTRADA') {
        db.prepare(`INSERT INTO ledger (company_id, contract_id, date, type, description, amount_cents, channel, user_id)
          VALUES (?, ?, ?, 'OUTRA_ENTRADA', ?, ?, 'OFX', ?)`).run(req.company.id, contract ? contract.id : null, tx.date, tx.description, tx.amount_cents, req.user.id);
      } else if (action === 'DESPESA') {
        db.prepare(`INSERT INTO ledger (company_id, date, type, description, amount_cents, channel, user_id)
          VALUES (?, ?, 'DESPESA', ?, ?, 'OFX', ?)`).run(req.company.id, tx.date, tx.description, tx.amount_cents, req.user.id);
      } else if (action === 'DESEMBOLSO' && contract) {
        // A concessão já foi lançada no cadastro do contrato; aqui só confirmamos a saída no banco.
        addOccurrence(contract.id, null, `Desembolso confirmado no extrato bancário por ${req.user.name} (${brl(-tx.amount_cents)} em ${brDate(tx.date)}).`);
      }

      db.prepare(`UPDATE bank_transactions SET status = 'CONCILIADO', action = ?, contract_id = ?, validated_by = ?, validated_at = datetime('now') WHERE id = ?`)
        .run(action, contract ? contract.id : null, req.user.id, tx.id);
      return message;
    })();
    res.json({ ok: true, message: result });
  });

  company.delete('/bank/:txid', managerOnly, (req, res) => {
    const r = db.prepare("DELETE FROM bank_transactions WHERE id = ? AND company_id = ? AND status = 'PENDENTE'")
      .run(Number(req.params.txid), req.company.id);
    if (!r.changes) throw new HttpError(400, 'Só é possível descartar transações pendentes.');
    res.json({ ok: true });
  });

  // ---------- Arquivos do site ----------
  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  app.use('/vendor/fontawesome', express.static(path.join(path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json'))), { maxAge: '7d' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
  app.get('/{*caminho}', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // ---------- Erros ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Arquivo muito grande.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Dados inválidos.' });
    console.error(err);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  });

  return app;
}

if (require.main === module) {
  const db = openDatabase();
  const port = Number(process.env.PORT || 3000);
  createApp(db).listen(port, () => {
    console.log(`JMR Gestão rodando em http://localhost:${port}`);
  });
}

module.exports = { createApp };
