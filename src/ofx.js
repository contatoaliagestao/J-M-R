import { calculateDebt } from './finance.js';

// Lê um campo de um bloco OFX. Funciona tanto no formato SGML (OFX 1.x, sem tag de fechamento)
// quanto no XML (OFX 2.x).
// Hash simples e estável (FNV-1a, 2 × 32 bits) para gerar um identificador quando o banco não envia FITID
function stableHash(text) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function readTag(block, tag) {
  const re = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

export function parseAmountToCents(raw) {
  let s = String(raw).trim();
  if (!s) return null;
  // Aceita "1234.56", "-1234,56" e "1.234,56"
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function decodeEntities(s) {
  return s.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'");
}

/** Converte o conteúdo de um arquivo OFX em uma lista de transações. */
export function parseOfx(raw) {
  const text = String(raw || '');
  const blocks = text.split(/<STMTTRN>/i).slice(1).map(b => b.split(/<\/STMTTRN>/i)[0]);
  const result = [];

  for (const block of blocks) {
    const dt = readTag(block, 'DTPOSTED');
    const amount = parseAmountToCents(readTag(block, 'TRNAMT'));
    if (!/^\d{8}/.test(dt) || amount === null || amount === 0) continue;

    const date = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
    const memo = readTag(block, 'MEMO');
    const name = readTag(block, 'NAME');
    const description = decodeEntities([name, memo].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' - ') || 'Sem descrição').slice(0, 300);

    let fitid = readTag(block, 'FITID');
    if (!fitid) {
      // Sem identificador do banco: gera um estável a partir do conteúdo para evitar duplicidade
      fitid = 'H-' + stableHash(`${date}|${amount}|${description}`);
    }

    result.push({ fitid: fitid.slice(0, 100), date, amount_cents: amount, description });
  }
  return result;
}

function normalize(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

/** Quantas palavras do nome do cliente (com 3+ letras) aparecem na descrição do banco. */
function nameScore(description, clientName) {
  const desc = normalize(description);
  return normalize(clientName).split(/\s+/).filter(w => w.length >= 3 && desc.includes(w)).length;
}

const TOLERANCE_CENTS = 5;

/**
 * Sugere o contrato e a ação para uma transação do extrato.
 * Entradas: compara com juros do ciclo / juros + diárias (rolagem) e total de quitação.
 * Saídas: compara com o principal de contratos (desembolso); senão, despesa.
 */
export function suggestMatch(tx, contracts, today) {
  if (tx.amount_cents < 0) {
    const abs = -tx.amount_cents;
    const candidates = contracts
      .filter(c => Math.abs(c.principal_cents - abs) <= TOLERANCE_CENTS)
      .sort((a, b) => nameScore(tx.description, b.client_name) - nameScore(tx.description, a.client_name));
    if (candidates.length) return { contract_id: candidates[0].id, action: 'DESEMBOLSO' };
    return { contract_id: null, action: 'DESPESA' };
  }

  const matches = [];
  for (const c of contracts) {
    if (c.status !== 'ATIVO') continue;
    const debt = calculateDebt(c, today);
    let action = null;
    if (Math.abs(tx.amount_cents - debt.totalToSettle) <= TOLERANCE_CENTS) action = 'QUITAR';
    else if (Math.abs(tx.amount_cents - debt.totalToRollover) <= TOLERANCE_CENTS) action = 'ROLAR';
    else if (Math.abs(tx.amount_cents - debt.cycleInterest) <= TOLERANCE_CENTS) action = 'ROLAR';
    if (action) matches.push({ contract: c, action, score: nameScore(tx.description, c.client_name) });
  }

  if (!matches.length) {
    // Sem valor batendo: tenta pelo nome do cliente na descrição
    const byName = contracts
      .filter(c => c.status === 'ATIVO')
      .map(c => ({ c, score: nameScore(tx.description, c.client_name) }))
      .filter(x => x.score >= 2)
      .sort((a, b) => b.score - a.score);
    if (byName.length === 1 || (byName.length > 1 && byName[0].score > byName[1].score)) {
      return { contract_id: byName[0].c.id, action: null };
    }
    return { contract_id: null, action: null };
  }

  matches.sort((a, b) => b.score - a.score);
  return { contract_id: matches[0].contract.id, action: matches[0].action };
}
