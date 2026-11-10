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
  // Operador pode lançar empréstimo (aqui sem dados, então o servidor recusa por validação, não por permissão)
  assert.strictEqual((await operador('POST', `/api/companies/${empresa1}/contracts`, {})).status, 400);
  // ...mas não pode lançar em empresa que não é dele
  assert.strictEqual((await operador('POST', `/api/companies/${empresa2}/contracts`, {})).status, 403);
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

  // Operador lança empréstimo
  const opLoan = await operador('POST', `/api/companies/${empresa1}/contracts`, {
    client_name: 'Cliente do Operador', cpf: '999', phone: '11977776666', address: 'Rua O', principal: 300, rate: 20, cycle_days: 15,
  });
  assert.strictEqual(opLoan.status, 201);

  // Operador registra ocorrência, mas não dá baixa
  assert.strictEqual((await operador('POST', `/api/companies/${empresa1}/contracts/${c.id}/occurrences`, { text: 'Liguei, paga amanhã.' })).status, 201);
  assert.strictEqual((await operador('POST', `/api/companies/${empresa1}/contracts/${c.id}/rollover`, { channel: 'DINHEIRO' })).status, 403);

  const roll = await admin('POST', `/api/companies/${empresa1}/contracts/${c.id}/rollover`, { channel: 'DINHEIRO', notes: 'Recebido no escritório' });
  assert.strictEqual(roll.status, 200);
  assert.strictEqual(roll.data.new_due_date, addDaysIso(todayIso(), 30));

  const dash = await admin('GET', `/api/companies/${empresa1}/dashboard`);
  assert.strictEqual(dash.data.dashboard.receita_realizada_cents, 136000);
  assert.strictEqual(dash.data.dashboard.capital_alocado_cents, 200000 + 30000); // + empréstimo do operador
  assert.strictEqual(dash.data.dashboard.em_atraso, 0);

  const settle = await admin('POST', `/api/companies/${empresa1}/contracts/${c.id}/settle`, { channel: 'PIX_MANUAL' });
  assert.strictEqual(settle.status, 200);
  assert.strictEqual((await admin('POST', `/api/companies/${empresa1}/contracts/${c.id}/settle`, { channel: 'PIX_MANUAL' })).status, 400);

  const dash2 = await admin('GET', `/api/companies/${empresa1}/dashboard`);
  assert.strictEqual(dash2.data.dashboard.receita_realizada_cents, 136000 + 40000); // + juros da quitação
  assert.strictEqual(dash2.data.dashboard.contratos_ativos, 1); // resta o empréstimo do operador

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

test('administrador edita o nome de usuário', async () => {
  const users = (await admin('GET', '/api/users')).data.users;
  const renata = users.find(u => u.username === 'renata');
  const r = await admin('PUT', `/api/users/${renata.id}`, { username: 'Renata.Gestora' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.user.username, 'renata.gestora');

  assert.strictEqual((await client()('POST', '/api/login', { login: 'renata', password: 'senha-renata-1' })).status, 401);
  assert.strictEqual((await client()('POST', '/api/login', { login: 'renata.gestora', password: 'senha-renata-1' })).status, 200);
  // A sessão que já estava aberta continua valendo
  assert.strictEqual((await gestor('GET', '/api/me')).status, 200);

  assert.strictEqual((await admin('PUT', `/api/users/${renata.id}`, { username: 'lucas.cobranca' })).status, 409);
  assert.strictEqual((await admin('PUT', `/api/users/${renata.id}`, { username: 'com espaço' })).status, 400);
  // Salvar sem mudar o nome não dá erro
  assert.strictEqual((await admin('PUT', `/api/users/${renata.id}`, { username: 'renata.gestora', name: 'Renata' })).status, 200);
});

test('acordo: criação, parcelas, extrato, renegociação, conclusão e dashboard', async () => {
  const today = todayIso();
  const base = `/api/companies/${empresa1}`;
  const dash = async () => (await admin('GET', `${base}/dashboard`)).data.dashboard;
  const before = await dash();

  // Contrato de R$ 2.000 a 20%, vencido há 4 dias: dívida para quitar = R$ 3.360
  const r = await admin('POST', `${base}/contracts`, {
    client_name: 'Jose Acordo Silva', cpf: '321', phone: '11955554444', address: 'Rua Acordo', principal: 2000, rate: 20,
    late_fee_rate: 10, cycle_days: 30, start_date: addDaysIso(today, -34),
  });
  const id = r.data.contract.id;
  assert.strictEqual(r.data.contract.debt.totalToSettle, 336000);

  const parcelas = [
    { due_date: today, amount: 1000 },
    { due_date: addDaysIso(today, 10), amount: 1000 },
    { due_date: addDaysIso(today, 20), amount: 1000 },
  ];

  // Operador não faz acordo; soma diferente do total é recusada
  assert.strictEqual((await operador('POST', `${base}/contracts/${id}/agreement`, { total: 3000, installments: parcelas })).status, 401); // operador foi desativado antes
  assert.strictEqual((await admin('POST', `${base}/contracts/${id}/agreement`, { total: 3100, installments: parcelas })).status, 400);

  const ag = await admin('POST', `${base}/contracts/${id}/agreement`, { total: 3000, installments: parcelas, notes: 'Pagamento a cada 10 dias' });
  assert.strictEqual(ag.status, 201);
  // Não pode ter dois acordos ativos ao mesmo tempo sem ser renegociação controlada (o 2º substitui o 1º)

  let ct = (await admin('GET', `${base}/contracts/${id}`)).data;
  assert.strictEqual(ct.contract.situation, 'ACORDO');
  assert.strictEqual(ct.contract.debt.lateFee, 0); // parou de acumular diárias
  assert.strictEqual(ct.contract.agreement.remaining_cents, 300000);
  assert.strictEqual(ct.contract.agreement.discount_cents, 36000);
  assert.strictEqual(ct.contract.agreement.installments.length, 3);

  // Rolagem/quitação normais ficam bloqueadas
  assert.strictEqual((await admin('POST', `${base}/contracts/${id}/rollover`, { channel: 'DINHEIRO' })).status, 400);

  let d = await dash();
  assert.strictEqual(d.acordos.ativos, before.acordos.ativos + 1);
  assert.strictEqual(d.acordos.a_receber_cents - before.acordos.a_receber_cents, 300000);
  assert.strictEqual(d.acordos.desconto_concedido_cents - before.acordos.desconto_concedido_cents, 36000);
  assert.strictEqual(d.capital_alocado_cents - before.capital_alocado_cents, 200000); // principal ainda na rua

  // Recebe a 1ª parcela em dinheiro: abate o principal primeiro
  const aid = ct.contract.agreement.id;
  const i1 = ct.contract.agreement.installments[0].id;
  assert.strictEqual((await admin('POST', `${base}/agreements/${aid}/installments/${i1}/pay`, { channel: 'DINHEIRO' })).status, 200);
  assert.strictEqual((await admin('POST', `${base}/agreements/${aid}/installments/${i1}/pay`, { channel: 'DINHEIRO' })).status, 400);
  d = await dash();
  assert.strictEqual(d.acordos.recebido_cents - before.acordos.recebido_cents, 100000);
  assert.strictEqual(d.capital_alocado_cents - before.capital_alocado_cents, 100000);
  assert.strictEqual(d.receita_realizada_cents, before.receita_realizada_cents); // ainda é devolução de principal

  // 2ª parcela chega pelo extrato: sugestão automática "Parcela de acordo"
  const dt = today.replace(/-/g, '');
  await admin('POST', `${base}/bank/import`, { content: `<OFX><STMTTRN><DTPOSTED>${dt}<TRNAMT>1000.00<FITID>AC1<MEMO>PIX JOSE ACORDO SILVA</STMTTRN></OFX>` });
  const tx = (await admin('GET', `${base}/bank`)).data.transactions.find(t => t.fitid === 'AC1');
  assert.strictEqual(tx.contract_id, id);
  assert.strictEqual(tx.action, 'PARCELA_ACORDO');
  assert.strictEqual((await admin('POST', `${base}/bank/${tx.id}/validate`, { action: 'ROLAR', contract_id: id })).status, 400);
  assert.strictEqual((await admin('POST', `${base}/bank/${tx.id}/validate`, { action: 'PARCELA_ACORDO', contract_id: id })).status, 200);

  ct = (await admin('GET', `${base}/contracts/${id}`)).data;
  assert.strictEqual(ct.contract.agreement.paid_count, 2);
  assert.strictEqual(ct.contract.agreement.remaining_cents, 100000);

  // Cliente não paga a 3ª; renegocia o saldo para R$ 900 em parcela única
  const reneg = await admin('POST', `${base}/contracts/${id}/agreement`, { total: 900, installments: [{ due_date: addDaysIso(today, 5), amount: 900 }] });
  assert.strictEqual(reneg.status, 201);
  ct = (await admin('GET', `${base}/contracts/${id}`)).data;
  assert.strictEqual(ct.contract.agreement.debt_at_agreement_cents, 136000); // 3.360 - 2.000 já pagos
  assert.strictEqual(ct.contract.agreement.renegotiated, true);
  assert.strictEqual(ct.agreements_history.filter(a => a.status === 'CANCELADO').length, 1);
  // Renegociação não pode ser simplesmente cancelada
  assert.strictEqual((await admin('POST', `${base}/agreements/${ct.contract.agreement.id}/cancel`, {})).status, 400);

  // Paga a parcela única: o principal já foi recuperado, então tudo é receita; acordo concluído e contrato quitado
  const pay = await admin('POST', `${base}/agreements/${ct.contract.agreement.id}/installments/${ct.contract.agreement.installments[0].id}/pay`, { channel: 'PIX_MANUAL' });
  assert.strictEqual(pay.data.concluded, true);
  ct = (await admin('GET', `${base}/contracts/${id}`)).data;
  assert.strictEqual(ct.contract.status, 'QUITADO');
  assert.strictEqual(ct.contract.situation, 'QUITADO');
  assert.ok(ct.occurrences.some(o => /Acordo concluído/.test(o.text)));

  d = await dash();
  assert.strictEqual(d.receita_realizada_cents - before.receita_realizada_cents, 90000);
  assert.strictEqual(d.acordos.concluidos - before.acordos.concluidos, 1);
  assert.strictEqual(d.acordos.desconto_concedido_cents - before.acordos.desconto_concedido_cents, 46000); // 3.360 - 2.000 - 900
  assert.strictEqual(d.capital_alocado_cents, before.capital_alocado_cents);
});

test('acordo: parcela vencida vai para a cobrança; acordo sem pagamento pode ser cancelado', async () => {
  const today = todayIso();
  const base = `/api/companies/${empresa1}`;
  const r = await admin('POST', `${base}/contracts`, {
    client_name: 'Maria Parcela', cpf: '654', phone: '11944443333', address: 'Rua P', principal: 1000, rate: 10, cycle_days: 15, start_date: addDaysIso(today, -20),
  });
  const id = r.data.contract.id;
  await admin('POST', `${base}/contracts/${id}/agreement`, {
    total: 1200, installments: [{ due_date: addDaysIso(today, -3), amount: 600 }, { due_date: addDaysIso(today, 27), amount: 600 }],
  });
  const rep = (await admin('GET', `${base}/report/overdue`)).data;
  const item = rep.agreement_installments.find(x => x.contract_id === id);
  assert.ok(item);
  assert.strictEqual(item.overdue_days, 3);
  assert.strictEqual(item.number, 1);
  assert.ok(!rep.contracts.some(x => x.id === id)); // não aparece duplicado como contrato atrasado

  const ct = (await admin('GET', `${base}/contracts/${id}`)).data.contract;
  assert.strictEqual(ct.agreement.overdue_count, 1);
  assert.strictEqual((await admin('POST', `${base}/agreements/${ct.agreement.id}/cancel`, {})).status, 200);
  const after = (await admin('GET', `${base}/contracts/${id}`)).data.contract;
  assert.strictEqual(after.situation, 'ATRASADO');
  assert.strictEqual(after.agreement, null);
});

test('excluir contrato: gestor exclui; operador não; bloqueado se houver recebimento', async () => {
  const base = `/api/companies/${empresa2}`;
  const today = todayIso();
  const g = client();
  assert.strictEqual((await g('POST', '/api/login', { login: 'renata.gestora', password: 'senha-renata-1' })).status, 200);
  await admin('POST', '/api/users', { name: 'Op Dois', username: 'op.dois', password: 'senha-op-dois', role: 'OPERADOR', company_ids: [empresa2] });
  const op = client();
  assert.strictEqual((await op('POST', '/api/login', { login: 'op.dois', password: 'senha-op-dois' })).status, 200);

  const novo = async (nome, extra = {}) => (await g('POST', `${base}/contracts`, {
    client_name: nome, cpf: '1', phone: '11900001111', address: 'Rua X', principal: 500, rate: 10, cycle_days: 30, ...extra,
  })).data.contract;
  const dashBefore = (await g('GET', `${base}/dashboard`)).data.dashboard;

  // Lançado por engano: gestor exclui (motivo obrigatório); operador não pode
  const errado = await novo('Lancado Por Engano');
  assert.strictEqual((await op('DELETE', `${base}/contracts/${errado.id}`, { reason: 'teste' })).status, 403);
  assert.strictEqual((await g('DELETE', `${base}/contracts/${errado.id}`, {})).status, 400);
  assert.strictEqual((await g('DELETE', `${base}/contracts/${errado.id}`, { reason: 'Valor digitado errado' })).status, 200);
  assert.strictEqual((await g('GET', `${base}/contracts/${errado.id}`)).status, 404);
  const dashAfter = (await g('GET', `${base}/dashboard`)).data.dashboard;
  assert.strictEqual(dashAfter.capital_alocado_cents, dashBefore.capital_alocado_cents);

  // Com recebimento (rolagem): não pode excluir
  const pago = await novo('Ja Pagou Juros');
  assert.strictEqual((await g('POST', `${base}/contracts/${pago.id}/rollover`, { channel: 'DINHEIRO' })).status, 200);
  const r = await g('DELETE', `${base}/contracts/${pago.id}`, { reason: 'teste' });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /recebimentos/);

  // Com acordo ainda sem pagamento: pode excluir (acordo e parcelas vão junto)
  const ac = await novo('Acordo Sem Pagamento', { start_date: addDaysIso(today, -40) });
  assert.strictEqual((await g('POST', `${base}/contracts/${ac.id}/agreement`, { total: 600, installments: [{ due_date: today, amount: 600 }] })).status, 201);
  assert.strictEqual((await g('DELETE', `${base}/contracts/${ac.id}`, { reason: 'Cadastro duplicado' })).status, 200);
  assert.strictEqual((await g('GET', `${base}/dashboard`)).data.dashboard.acordos.ativos, dashBefore.acordos.ativos);

  // Gestor não exclui contrato de empresa que não é dele
  const outro = (await admin('POST', `/api/companies/${empresa1}/contracts`, {
    client_name: 'Outra Empresa', cpf: '1', phone: '11900001111', address: 'Rua Y', principal: 100, rate: 10, cycle_days: 30,
  })).data.contract;
  assert.strictEqual((await g('DELETE', `/api/companies/${empresa1}/contracts/${outro.id}`, { reason: 'x' })).status, 403);
});

test('editar contrato: só administrador; dados do cliente sempre; condições só em contrato ativo fora de acordo', async () => {
  const base = `/api/companies/${empresa1}`;
  const today = todayIso();
  const ct = (await admin('POST', `${base}/contracts`, {
    client_name: 'Nome Errado', cpf: '111', phone: '11900000000', address: 'Rua Velha', principal: 1000, rate: 20, cycle_days: 30, start_date: today,
  })).data.contract;
  const dashBefore = (await admin('GET', `${base}/dashboard`)).data.dashboard;

  // Gestor não edita
  const g = client();
  await g('POST', '/api/login', { login: 'renata.gestora', password: 'senha-renata-1' });
  await admin('PUT', '/api/users/' + (await admin('GET', '/api/users')).data.users.find(u => u.username === 'renata.gestora').id, { company_ids: [empresa1, empresa2] });
  assert.strictEqual((await g('PUT', `${base}/contracts/${ct.id}`, { client_name: 'X' })).status, 403);

  // Admin corrige cliente e condições
  const r = await admin('PUT', `${base}/contracts/${ct.id}`, {
    client_name: 'Nome Certo', phone: '(11) 98888-7777', address: 'Rua Nova, 10', principal: 1500, rate: 15, due_date: addDaysIso(today, 20),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.changed, 6);
  const d = (await admin('GET', `${base}/contracts/${ct.id}`)).data;
  assert.strictEqual(d.contract.client_name, 'Nome Certo');
  assert.strictEqual(d.contract.phone, '11988887777');
  assert.strictEqual(d.contract.principal_cents, 150000);
  assert.strictEqual(d.contract.debt.cycleInterest, 22500);
  assert.strictEqual(d.contract.due_date, addDaysIso(today, 20));
  assert.ok(d.occurrences.some(o => /Contrato editado/.test(o.text) && /Principal: R\$\s?1\.000,00 → R\$\s?1\.500,00/.test(o.text)));
  // Lançamento de concessão acompanha o novo principal
  assert.strictEqual(d.payments.find(p => p.type === 'CONCESSAO').amount_cents, -150000);
  const dashAfter = (await admin('GET', `${base}/dashboard`)).data.dashboard;
  assert.strictEqual(dashAfter.capital_alocado_cents - dashBefore.capital_alocado_cents, 50000);

  // Salvar sem mudanças
  assert.strictEqual((await admin('PUT', `${base}/contracts/${ct.id}`, { client_name: 'Nome Certo' })).data.changed, 0);
  // Dados inválidos
  assert.strictEqual((await admin('PUT', `${base}/contracts/${ct.id}`, { due_date: '31/12/2026' })).status, 400);

  // Em acordo: só dados do cliente
  await admin('PUT', `${base}/contracts/${ct.id}`, { due_date: addDaysIso(today, -5) });
  assert.strictEqual((await admin('POST', `${base}/contracts/${ct.id}/agreement`, { total: 1700, installments: [{ due_date: today, amount: 1700 }] })).status, 201);
  assert.strictEqual((await admin('PUT', `${base}/contracts/${ct.id}`, { rate: 10 })).status, 400);
  assert.strictEqual((await admin('PUT', `${base}/contracts/${ct.id}`, { address: 'Rua Mais Nova' })).status, 200);
});

test('baixa com desconto: valor recebido editável na rolagem e na quitação', async () => {
  const base = `/api/companies/${empresa1}`;
  const today = todayIso();
  // R$ 1.000 a 20%, vencido há 3 dias: rolar = 200 + 3 × 120 = R$ 560; quitar = R$ 1.560
  const ct = (await admin('POST', `${base}/contracts`, {
    client_name: 'Desconto Diarias', cpf: '9', phone: '11911112222', address: 'Rua D', principal: 1000, rate: 20, cycle_days: 30,
    start_date: addDaysIso(today, -33),
  })).data.contract;
  assert.strictEqual(ct.debt.totalToRollover, 56000);
  const before = (await admin('GET', `${base}/dashboard`)).data.dashboard.receita_realizada_cents;

  // Negociou: paga só R$ 300 na rolagem (desconto de R$ 260 nas diárias)
  assert.strictEqual((await admin('POST', `${base}/contracts/${ct.id}/rollover`, { channel: 'DINHEIRO', amount: 0 })).status, 400);
  const r = await admin('POST', `${base}/contracts/${ct.id}/rollover`, { channel: 'DINHEIRO', amount: 300 });
  assert.strictEqual(r.status, 200);
  let d = (await admin('GET', `${base}/contracts/${ct.id}`)).data;
  assert.strictEqual(d.payments.find(p => p.type === 'ROLAGEM').amount_cents, 30000);
  assert.ok(d.occurrences.some(o => /Desconto concedido: R\$\s?260,00/.test(o.text)));
  assert.strictEqual((await admin('GET', `${base}/dashboard`)).data.dashboard.receita_realizada_cents - before, 30000);

  // Quitação com desconto: R$ 1.100 (cheio seria R$ 1.200, sem atraso)
  const s = await admin('POST', `${base}/contracts/${ct.id}/settle`, { channel: 'PIX_MANUAL', amount: 1100 });
  assert.strictEqual(s.status, 200);
  d = (await admin('GET', `${base}/contracts/${ct.id}`)).data;
  assert.strictEqual(d.contract.status, 'QUITADO');
  assert.ok(d.occurrences.some(o => /Desconto concedido: R\$\s?100,00/.test(o.text)));
  // R$ 1.000 volta como principal; R$ 100 é receita
  assert.strictEqual((await admin('GET', `${base}/dashboard`)).data.dashboard.receita_realizada_cents - before, 40000);

  // Sem informar valor: continua usando o valor cheio
  const ct2 = (await admin('POST', `${base}/contracts`, {
    client_name: 'Valor Cheio', cpf: '8', phone: '11911113333', address: 'Rua E', principal: 500, rate: 10, cycle_days: 30,
  })).data.contract;
  await admin('POST', `${base}/contracts/${ct2.id}/rollover`, { channel: 'DINHEIRO' });
  const d2 = (await admin('GET', `${base}/contracts/${ct2.id}`)).data;
  assert.strictEqual(d2.payments.find(p => p.type === 'ROLAGEM').amount_cents, 5000);
});

test('data do recebimento: diárias e novo vencimento calculados na data informada', async () => {
  const base = `/api/companies/${empresa1}`;
  const today = todayIso();
  // R$ 1.000 a 20%, venceu há 5 dias (diária = R$ 120)
  const ct = (await admin('POST', `${base}/contracts`, {
    client_name: 'Pagou Antes', cpf: '7', phone: '11922223333', address: 'Rua F', principal: 1000, rate: 20, cycle_days: 30,
    start_date: addDaysIso(today, -35),
  })).data.contract;
  const due = ct.due_date;
  assert.strictEqual(ct.debt.overdueDays, 5);

  // Data em formato inválido é recusada (a data em si é livre)
  assert.strictEqual((await admin('POST', `${base}/contracts/${ct.id}/rollover`, { channel: 'DINHEIRO', paid_on: '14/10/2026' })).status, 400);

  // Pagou 2 dias depois do vencimento (e só foi lançado hoje): diárias de 2 dias, novo vencimento = data do pagamento + 30
  const paidOn = addDaysIso(due, 2);
  const r = await admin('POST', `${base}/contracts/${ct.id}/rollover`, { channel: 'DINHEIRO', paid_on: paidOn });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.new_due_date, addDaysIso(paidOn, 30));
  const d = (await admin('GET', `${base}/contracts/${ct.id}`)).data;
  const roll = d.payments.find(p => p.type === 'ROLAGEM');
  assert.strictEqual(roll.amount_cents, 20000 + 2 * 12000);
  assert.strictEqual(roll.date, paidOn);
  assert.ok(d.occurrences.some(o => o.text.includes(`em ${paidOn.split('-').reverse().join('/')}`)));

  // Quitação com data anterior
  const ct2 = (await admin('POST', `${base}/contracts`, {
    client_name: 'Quitou Ontem', cpf: '6', phone: '11922224444', address: 'Rua G', principal: 500, rate: 10, cycle_days: 30, start_date: addDaysIso(today, -10),
  })).data.contract;
  assert.strictEqual((await admin('POST', `${base}/contracts/${ct2.id}/settle`, { channel: 'PIX_MANUAL', paid_on: addDaysIso(today, -1) })).status, 200);
  const d2 = (await admin('GET', `${base}/contracts/${ct2.id}`)).data;
  assert.strictEqual(d2.contract.settled_at, addDaysIso(today, -1));

  // Parcela de acordo com data anterior
  const ct3 = (await admin('POST', `${base}/contracts`, {
    client_name: 'Parcela Ontem', cpf: '5', phone: '11922225555', address: 'Rua H', principal: 500, rate: 10, cycle_days: 30, start_date: addDaysIso(today, -40),
  })).data.contract;
  await admin('POST', `${base}/contracts/${ct3.id}/agreement`, { total: 600, installments: [{ due_date: addDaysIso(today, -2), amount: 300 }, { due_date: addDaysIso(today, 10), amount: 300 }] });
  const a = (await admin('GET', `${base}/contracts/${ct3.id}`)).data.contract.agreement;
  assert.strictEqual((await admin('POST', `${base}/agreements/${a.id}/installments/${a.installments[0].id}/pay`, { channel: 'DINHEIRO', paid_on: addDaysIso(today, -2) })).status, 200);
  const a2 = (await admin('GET', `${base}/contracts/${ct3.id}`)).data.contract.agreement;
  assert.strictEqual(a2.installments[0].paid_at, addDaysIso(today, -2));
});

test('data do recebimento livre: aceita data futura e anterior à concessão', async () => {
  const base = `/api/companies/${empresa1}`;
  const today = todayIso();
  const novo = async nome => (await admin('POST', `${base}/contracts`, {
    client_name: nome, cpf: '4', phone: '11933334444', address: 'Rua I', principal: 200, rate: 10, cycle_days: 30, start_date: addDaysIso(today, -5),
  })).data.contract;
  const a = await novo('Data Futura');
  assert.strictEqual((await admin('POST', `${base}/contracts/${a.id}/rollover`, { channel: 'DINHEIRO', paid_on: addDaysIso(today, 3) })).status, 200);
  const b = await novo('Data Antes Concessao');
  assert.strictEqual((await admin('POST', `${base}/contracts/${b.id}/settle`, { channel: 'DINHEIRO', paid_on: addDaysIso(today, -30) })).status, 200);
  const d = (await admin('GET', `${base}/contracts/${b.id}`)).data;
  assert.strictEqual(d.contract.settled_at, addDaysIso(today, -30));
});

test('quebrar juros: abate o principal, reduz os juros e mantém o vencimento', async () => {
  const base = `/api/companies/${empresa1}`;
  const today = todayIso();
  const ct = (await admin('POST', `${base}/contracts`, {
    client_name: 'Quebra Juros', cpf: '3', phone: '11944445555', address: 'Rua J', principal: 600, rate: 45, cycle_days: 30, start_date: addDaysIso(today, -10),
  })).data.contract;
  assert.strictEqual(ct.debt.cycleInterest, 27000);
  const dashBefore = (await admin('GET', `${base}/dashboard`)).data.dashboard;

  // Operador não pode; valor que cobre todo o principal é recusado
  const op = client();
  await op('POST', '/api/login', { login: 'op.dois', password: 'senha-op-dois' });
  assert.strictEqual((await admin('POST', `${base}/contracts/${ct.id}/amortize`, { channel: 'DINHEIRO', amount: 600 })).status, 400);
  assert.strictEqual((await admin('POST', `${base}/contracts/${ct.id}/amortize`, { channel: 'DINHEIRO' })).status, 400);

  const r = await admin('POST', `${base}/contracts/${ct.id}/amortize`, { channel: 'PIX_MANUAL', amount: 200 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.new_principal_cents, 40000);
  const d = (await admin('GET', `${base}/contracts/${ct.id}`)).data;
  assert.strictEqual(d.contract.principal_cents, 40000);
  assert.strictEqual(d.contract.debt.cycleInterest, 18000); // 45% de R$ 400
  assert.strictEqual(d.contract.due_date, ct.due_date);
  assert.ok(d.occurrences.some(o => /Juros do ciclo: R\$\s?270,00 → R\$\s?180,00/.test(o.text)));

  // Dashboard: dinheiro na rua cai R$ 200; não é receita
  const dashAfter = (await admin('GET', `${base}/dashboard`)).data.dashboard;
  assert.strictEqual(dashBefore.capital_alocado_cents - dashAfter.capital_alocado_cents, 20000);
  assert.strictEqual(dashAfter.receita_realizada_cents, dashBefore.receita_realizada_cents);

  // Depois, a rolagem cobra os juros menores; contrato com amortização não pode ser excluído
  const roll = await admin('POST', `${base}/contracts/${ct.id}/rollover`, { channel: 'DINHEIRO' });
  assert.strictEqual(roll.status, 200);
  const d2 = (await admin('GET', `${base}/contracts/${ct.id}`)).data;
  assert.strictEqual(d2.payments.find(p => p.type === 'ROLAGEM').amount_cents, 18000);
  assert.strictEqual((await admin('DELETE', `${base}/contracts/${ct.id}`, { reason: 'x' })).status, 400);

  // Editar o principal mantém a concessão = principal + amortizado
  await admin('PUT', `${base}/contracts/${ct.id}`, { principal: 450 });
  const d3 = (await admin('GET', `${base}/contracts/${ct.id}`)).data;
  assert.strictEqual(d3.payments.find(p => p.type === 'CONCESSAO').amount_cents, -65000);

  // Pela conciliação bancária
  const ct2 = (await admin('POST', `${base}/contracts`, {
    client_name: 'Quebra Via Pix', cpf: '2', phone: '11944446666', address: 'Rua K', principal: 1000, rate: 20, cycle_days: 30,
  })).data.contract;
  await admin('POST', `${base}/bank/import`, { content: `<OFX><STMTTRN><DTPOSTED>${today.replace(/-/g, '')}<TRNAMT>300.00<FITID>AMZ1<MEMO>PIX QUEBRA VIA PIX</STMTTRN></OFX>` });
  const tx = (await admin('GET', `${base}/bank`)).data.transactions.find(t => t.fitid === 'AMZ1');
  assert.strictEqual((await admin('POST', `${base}/bank/${tx.id}/validate`, { action: 'AMORTIZACAO', contract_id: ct2.id })).status, 200);
  assert.strictEqual((await admin('GET', `${base}/contracts/${ct2.id}`)).data.contract.principal_cents, 70000);
});
