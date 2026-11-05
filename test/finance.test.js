import test from 'node:test';
import assert from 'node:assert';
import { calculateDebt, nextDueDateAfterRollover, addDaysIso, isValidIsoDate } from '../src/finance.js';
import { parseOfx, suggestMatch } from '../src/ofx.js';

const base = { principal_cents: 200000, rate: 20, late_fee_rate: 10, cycle_days: 30, status: 'ATIVO' };

test('contrato em dia: sem diárias', () => {
  const d = calculateDebt({ ...base, due_date: '2026-11-10' }, '2026-11-05');
  assert.strictEqual(d.cycleInterest, 40000);      // 20% de R$ 2.000 = R$ 400
  assert.strictEqual(d.overdueDays, 0);
  assert.strictEqual(d.lateFee, 0);
  assert.strictEqual(d.totalToRollover, 40000);
  assert.strictEqual(d.totalToSettle, 240000);
});

test('contrato com 4 dias de atraso: 10%/dia sobre principal + juros', () => {
  const d = calculateDebt({ ...base, due_date: '2026-11-01' }, '2026-11-05');
  assert.strictEqual(d.overdueDays, 4);
  assert.strictEqual(d.dailyFee, 24000);            // 10% de R$ 2.400
  assert.strictEqual(d.lateFee, 96000);
  assert.strictEqual(d.totalToRollover, 136000);    // 400 + 960
  assert.strictEqual(d.totalToSettle, 336000);      // 2.400 + 960
});

test('vencimento hoje ainda não é atraso', () => {
  assert.strictEqual(calculateDebt({ ...base, due_date: '2026-11-05' }, '2026-11-05').overdueDays, 0);
});

test('contrato quitado não acumula diárias', () => {
  assert.strictEqual(calculateDebt({ ...base, status: 'QUITADO', due_date: '2026-01-01' }, '2026-11-05').lateFee, 0);
});

test('rolagem: em dia avança a partir do vencimento; atrasado avança a partir de hoje', () => {
  assert.strictEqual(nextDueDateAfterRollover({ ...base, due_date: '2026-11-10' }, '2026-11-05'), '2026-12-10');
  assert.strictEqual(nextDueDateAfterRollover({ ...base, due_date: '2026-11-01' }, '2026-11-05'), '2026-12-05');
  assert.strictEqual(nextDueDateAfterRollover({ ...base, cycle_days: 15, due_date: '2026-11-01' }, '2026-11-05'), '2026-11-20');
});

test('datas', () => {
  assert.strictEqual(addDaysIso('2026-01-31', 30), '2026-03-02');
  assert.ok(isValidIsoDate('2026-02-28'));
  assert.ok(!isValidIsoDate('2026-02-30'));
  assert.ok(!isValidIsoDate('30/11/2026'));
});

test('OFX SGML (sem fechamento de tags), valores com vírgula e sem FITID', () => {
  const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261105120000[-3:BRT]
<TRNAMT>680,00
<FITID>ABC123
<MEMO>PIX RECEBIDO - MARCOS VINICIUS SANTOS
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261103
<TRNAMT>-74.50
<MEMO>TARIFA BANCARIA &amp; CESTA
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const txs = parseOfx(ofx);
  assert.strictEqual(txs.length, 2);
  assert.deepStrictEqual(txs[0], { fitid: 'ABC123', date: '2026-11-05', amount_cents: 68000, description: 'PIX RECEBIDO - MARCOS VINICIUS SANTOS' });
  assert.strictEqual(txs[1].amount_cents, -7450);
  assert.strictEqual(txs[1].description, 'TARIFA BANCARIA & CESTA');
  assert.match(txs[1].fitid, /^H-/);
  // Mesmo conteúdo gera o mesmo identificador (evita duplicar na reimportação)
  assert.strictEqual(parseOfx(ofx)[1].fitid, txs[1].fitid);
});

test('sugestão de vínculo: valor de rolagem e desempate pelo nome', () => {
  const contracts = [
    { id: 1, client_name: 'Ana Paula Souza', ...base, due_date: '2026-11-20' },
    { id: 2, client_name: 'Marcos Vinicius Santos', ...base, due_date: '2026-11-20' },
  ];
  const s = suggestMatch({ amount_cents: 40000, description: 'PIX RECEBIDO MARCOS VINICIUS' }, contracts, '2026-11-05');
  assert.deepStrictEqual(s, { contract_id: 2, action: 'ROLAR' });

  const q = suggestMatch({ amount_cents: 240000, description: 'TED' }, contracts, '2026-11-05');
  assert.strictEqual(q.action, 'QUITAR');

  const out = suggestMatch({ amount_cents: -200000, description: 'PIX ENVIADO ANA PAULA' }, contracts, '2026-11-05');
  assert.deepStrictEqual(out, { contract_id: 1, action: 'DESEMBOLSO' });

  assert.deepStrictEqual(suggestMatch({ amount_cents: -7450, description: 'TARIFA' }, contracts, '2026-11-05'), { contract_id: null, action: 'DESPESA' });
});
