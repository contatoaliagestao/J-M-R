// Testes da API rodando no simulador local do Cloudflare (wrangler dev + D1 local).
import test from 'node:test';
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { todayIso, addDaysIso } from '../src/finance.js';

const PORT = 8790 + Math.floor(Math.random() * 100);
const baseUrl = `http://127.0.0.1:${PORT}`;
const persistDir = mkdtempSync(path.join(tmpdir(), 'jmr-test-'));
let dev;

test.before(async () => {
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistDir], { stdio: 'ignore' });
  dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persistDir, '--var', 'SETUP_CODE:codigo-teste-123', '--show-interactive-dev-session=false'],
    { stdio: 'ignore', detached: true });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(baseUrl + '/api/setup')).ok) return; } catch { /* ainda subindo */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('wrangler dev não iniciou');
});
test.after(() => {
  try { process.kill(-dev.pid); } catch { /* já encerrado */ }
  rmSync(persistDir, { recursive: true, force: true });
});

// Cliente simples que guarda o cookie de sessão
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(baseUrl + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* vazio */ }
    return { status: res.status, data };
  };
}

const admin = client();
const operador = client();
const gestor = client();
let empresa1;
let empresa2;

test('cadastro inicial do administrador por e-mail (só uma vez)', async () => {
  assert.deepStrictEqual((await admin('GET', '/api/setup')).data.needsSetup, true);

  const bad = await admin('POST', '/api/setup', { name: 'Adm', email: 'adm@x.com', password: '123', company: { official_name: 'A', short_name: 'A' } });
  assert.strictEqual(bad.status, 400);

  const semCodigo = await admin('POST', '/api/setup', {
    name: 'Invasor', email: 'x@x.com', password: 'senha-forte-1', setup_code: 'errado',
    company: { official_name: 'X LTDA', short_name: 'X' },
  });
  assert.strictEqual(semCodigo.status, 403);
  assert.strictEqual((await admin('GET', '/api/setup')).data.needsSetup, true);

  const r = await admin('POST', '/api/setup', {
    setup_code: 'codigo-teste-123',
    name: 'Administradora', email: 'Admin@JMR.com.br', password: 'senha-forte-1',
    company: { official_name: 'JMR Crédito LTDA', short_name: 'JMR Crédito', color_theme: 'amber' },
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.user.role, 'ADMIN');

  const again = await client()('POST', '/api/setup', {
    name: 'Invasor', email: 'x@x.com', password: 'senha-forte-2', company: { official_name: 'B', short_name: 'B' },
  });
  assert.strictEqual(again.status, 409);

  const me = await admin('GET', '/api/me');
  assert.strictEqual(me.data.companies.length, 1);
  empresa1 = me.data.companies[0].id;
  assert.strictEqual(me.data.companies[0].code_prefix, 'JMR');
});

test('login do administrador por e-mail e bloqueio de senha errada', async () => {
  const c = client();
  assert.strictEqual((await c('POST', '/api/login', { login: 'admin@jmr.com.br', password: 'errada' })).status, 401);
  assert.strictEqual((await c('POST', '/api/login', { login: 'admin@jmr.com.br', password: 'senha-forte-1' })).status, 200);
  assert.strictEqual((await c('GET', '/api/me')).status, 200);
  await c('POST', '/api/logout', {});
  assert.strictEqual((await c('GET', '/api/me')).status, 401);
});

test('limite de 3 empresas', async () => {
  const r2 = await admin('POST', '/api/companies', { official_name: 'Segunda LTDA', short_name: 'Segunda', color_theme: 'blue' });
  assert.strictEqual(r2.status, 201);
  empresa2 = r2.data.company.id;
  assert.strictEqual((await admin('POST', '/api/companies', { official_name: 'Terceira LTDA', short_name: 'Terceira' })).status, 201);
  const r4 = await admin('POST', '/api/companies', { official_name: 'Quarta LTDA', short_name: 'Quarta' });
  assert.strictEqual(r4.status, 400);
  assert.match(r4.data.error, /Limite de 3/);
});

test('administrador cria usuários com nome de usuário', async () => {
  const r = await admin('POST', '/api/users', { name: 'Lucas Operador', username: 'lucas.cobranca', password: 'senha-lucas-1', role: 'OPERADOR', company_ids: [empresa1] });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await admin('POST', '/api/users', { name: 'Dup', username: 'LUCAS.cobranca', password: 'senha-lucas-1', role: 'OPERADOR', company_ids: [empresa1] })).status, 409);
  assert.strictEqual((await admin('POST', '/api/users', { name: 'X', username: 'com espaço', password: 'senha-lucas-1', role: 'OPERADOR', company_ids: [empresa1] })).status, 400);
  assert.strictEqual((await admin('POST', '/api/users', { name: 'X', username: 'semempresa', password: 'senha-lucas-1', role: 'OPERADOR', company_ids: [] })).status, 400);
  assert.strictEqual((await admin('POST', '/api/users', { name: 'Gestora', username: 'renata', password: 'senha-renata-1', role: 'GESTOR', company_ids: [empresa2] })).status, 201);

  assert.strictEqual((await operador('POST', '/api/login', { login: 'lucas.cobranca', password: 'senha-lucas-1' })).status, 200);
  assert.strictEqual((await gestor('POST', '/api/login', { login: 'renata', password: 'senha-renata-1' })).status, 200);
  // Usuário comum não entra por e-mail
  assert.strictEqual((await client()('POST', '/api/login', { login: 'lucas@x.com', password: 'senha-lucas-1' })).status, 401);
});

test('permissões: operador e gestor só veem as empresas liberadas', async () => {
  const meOp = await operador('GET', '/api/me');
  assert.deepStrictEqual(meOp.data.companies.map(c => c.id), [empresa1]);

  assert.strictEqual((await operador('GET', `/api/companies/${empresa1}/contracts`)).status, 200);
  assert.strictEqual((await operador('GET', `/api/companies/${empresa2}/contracts`)).status, 403);
  assert.strictEqual((await gestor('GET', `/api/companies/${empresa1}/contracts`)).status, 403);

  // Operador não acessa dashboard, conciliação, nem lança empréstimo
  assert.strictEqual((await operador('GET', `/api/companies/${empresa1}/dashboard`)).status, 403);
  assert.strictEqual((await operador('GET', `/api/companies/${empresa1}/bank`)).status, 403);
  assert.strictEqual((await operador('POST', `/api/companies/${empresa1}/contracts`, {})).status, 403);
  // Nem gerencia usuários/empresas
  assert.strictEqual((await operador('GET', '/api/users')).status, 403);
  assert.strictEqual((await gestor('POST', '/api/companies', { official_name: 'X', short_name: 'X' })).status, 403);
});

test('fluxo de contrato: concessão, rolagem, ocorrência e quitação', async () => {
  const start = addDaysIso(todayIso(), -34); // venceu há 4 dias
  const r = await admin('POST', `/api/companies/${empresa1}/contracts`, {
    client_name: 'Cliente Teste', cpf: '123.456.789-00', phone: '(11) 98888-7777', address: 'Rua A, 1',
    principal: 2000, rate: 20, late_fee_rate: 10, cycle_days: 30, start_date: start,
  });
  assert.strictEqual(r.status, 201);
  const c = r.data.contract;
  assert.strictEqual(c.code, 'JMR-1001');
  assert.strictEqual(c.situation, 'ATRASADO');
  assert.strictEqual(c.debt.overdueDays, 4);
  assert.strictEqual(c.debt.totalToRollover, 136000);

  // Operador registra ocorrência, mas não dá baixa
  assert.strictEqual((await operador('POST', `/api/companies/${empresa1}/contracts/${c.id}/occurrences`, { text: 'Liguei, paga amanhã.' })).status, 201);
  assert.strictEqual((await operador('POST', `/api/companies/${empresa1}/contracts/${c.id}/rollover`, { channel: 'DINHEIRO' })).status, 403);

  const roll = await admin('POST', `/api/companies/${empresa1}/contracts/${c.id}/rollover`, { channel: 'DINHEIRO', notes: 'Recebido no escritório' });
  assert.strictEqual(roll.status, 200);
  assert.strictEqual(roll.data.new_due_date, addDaysIso(todayIso(), 30));

  const dash = await admin('GET', `/api/companies/${empresa1}/dashboard`);
  assert.strictEqual(dash.data.dashboard.receita_realizada_cents, 136000);
  assert.strictEqual(dash.data.dashboard.capital_alocado_cents, 200000);
  assert.strictEqual(dash.data.dashboard.em_atraso, 0);

  const settle = await admin('POST', `/api/companies/${empresa1}/contracts/${c.id}/settle`, { channel: 'PIX_MANUAL' });
  assert.strictEqual(settle.status, 200);
  assert.strictEqual((await admin('POST', `/api/companies/${empresa1}/contracts/${c.id}/settle`, { channel: 'PIX_MANUAL' })).status, 400);

  const dash2 = await admin('GET', `/api/companies/${empresa1}/dashboard`);
  assert.strictEqual(dash2.data.dashboard.receita_realizada_cents, 136000 + 40000); // + juros da quitação
  assert.strictEqual(dash2.data.dashboard.contratos_ativos, 0);

  const dossier = await operador('GET', `/api/companies/${empresa1}/contracts/${c.id}`);
  assert.strictEqual(dossier.data.contract.status, 'QUITADO');
  assert.ok(dossier.data.occurrences.some(o => o.text === 'Liguei, paga amanhã.'));
  assert.ok(dossier.data.occurrences.some(o => o.author_role === 'SISTEMA' && /QUITADO/.test(o.text)));
});

test('conciliação OFX: importação sem duplicar, sugestão e validação', async () => {
  const today = todayIso();
  const r = await admin('POST', `/api/companies/${empresa1}/contracts`, {
    client_name: 'Beatriz Moura', cpf: '567', phone: '11933332222', address: 'Rua B', principal: 1000, rate: 20, cycle_days: 15, start_date: today,
  });
  const c = r.data.contract;
  const d = today.replace(/-/g, '');
  const ofx = `<OFX><STMTTRN><DTPOSTED>${d}<TRNAMT>200.00<FITID>T1<MEMO>PIX RECEBIDO BEATRIZ MOURA</STMTTRN>
    <STMTTRN><DTPOSTED>${d}<TRNAMT>-30.00<FITID>T2<MEMO>TARIFA</STMTTRN></OFX>`;

  const imp = await admin('POST', `/api/companies/${empresa1}/bank/import`, { content: ofx });
  assert.deepStrictEqual(imp.data, { imported: 2, duplicates: 0 });
  assert.deepStrictEqual((await admin('POST', `/api/companies/${empresa1}/bank/import`, { content: ofx })).data, { imported: 0, duplicates: 2 });

  const bank = await admin('GET', `/api/companies/${empresa1}/bank`);
  const credit = bank.data.transactions.find(t => t.fitid === 'T1');
  const debit = bank.data.transactions.find(t => t.fitid === 'T2');
  assert.strictEqual(credit.contract_id, c.id);
  assert.strictEqual(credit.action, 'ROLAR');
  assert.strictEqual(debit.action, 'DESPESA');

  // Gestora de outra empresa não acessa
  assert.strictEqual((await gestor('POST', `/api/companies/${empresa1}/bank/${credit.id}/validate`, { action: 'ROLAR', contract_id: c.id })).status, 403);

  const v1 = await admin('POST', `/api/companies/${empresa1}/bank/${credit.id}/validate`, { action: 'ROLAR', contract_id: c.id });
  assert.strictEqual(v1.status, 200);
  assert.strictEqual((await admin('POST', `/api/companies/${empresa1}/bank/${credit.id}/validate`, { action: 'ROLAR', contract_id: c.id })).status, 400);
  assert.strictEqual((await admin('POST', `/api/companies/${empresa1}/bank/${debit.id}/validate`, { action: 'DESPESA' })).status, 200);

  const contract = await admin('GET', `/api/companies/${empresa1}/contracts/${c.id}`);
  assert.strictEqual(contract.data.contract.rollover_count, 1);
  assert.strictEqual(contract.data.contract.due_date, addDaysIso(today, 30));

  const dash = await admin('GET', `/api/companies/${empresa1}/dashboard`);
  assert.strictEqual(dash.data.dashboard.despesas_cents, 3000);
});

test('administrador desativa usuário e a sessão dele cai', async () => {
  const users = (await admin('GET', '/api/users')).data.users;
  const lucas = users.find(u => u.username === 'lucas.cobranca');
  assert.strictEqual((await admin('PUT', `/api/users/${lucas.id}`, { active: false })).status, 200);
  assert.strictEqual((await operador('GET', '/api/me')).status, 401);
  const relogin = await operador('POST', '/api/login', { login: 'lucas.cobranca', password: 'senha-lucas-1' });
  assert.strictEqual(relogin.status, 401);

  const adminUser = users.find(u => u.role === 'ADMIN');
  assert.strictEqual((await admin('PUT', `/api/users/${adminUser.id}`, { active: false })).status, 400);
});

test('requisições que alteram dados precisam ser JSON (proteção CSRF)', async () => {
  const res = await fetch(baseUrl + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'login=a&password=b',
  });
  assert.strictEqual(res.status, 415);
});

test('quitações simultâneas do mesmo contrato: só uma é gravada', async () => {
  const me = await admin('GET', '/api/me');
  const cid = me.data.companies[0].id;
  const r = await admin('POST', `/api/companies/${cid}/contracts`, {
    client_name: 'Concorrência', cpf: '1', phone: '11900000000', address: 'Rua C', principal: 500, rate: 10, cycle_days: 30,
  });
  const id = r.data.contract.id;
  const results = await Promise.all([1, 2, 3].map(() =>
    admin('POST', `/api/companies/${cid}/contracts/${id}/settle`, { channel: 'DINHEIRO' })));
  // Uma passa; as outras são recusadas (já quitado = 400, ou alterado durante a operação = 409)
  assert.strictEqual(results.filter(x => x.status === 200).length, 1);
  results.filter(x => x.status !== 200).forEach(x => assert.ok([400, 409].includes(x.status)));
  const d = await admin('GET', `/api/companies/${cid}/contracts/${id}`);
  assert.strictEqual(d.data.payments.filter(p => p.type === 'QUITACAO').length, 1);
});
