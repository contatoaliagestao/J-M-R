'use strict';

// Regras financeiras dos contratos.
// Todos os valores monetários são inteiros em CENTAVOS para evitar erros de arredondamento.

const TIMEZONE = process.env.TZ_EMPRESA || 'America/Sao_Paulo';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Data de hoje (AAAA-MM-DD) no fuso da empresa. */
function todayIso(now = new Date()) {
  // en-CA formata como AAAA-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function isValidIsoDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDaysIso(a, b) {
  // a - b em dias
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / DAY_MS);
}

/**
 * Calcula a posição da dívida de um contrato.
 * - Juros do ciclo = principal × taxa
 * - Diária de atraso = (principal + juros) × taxa de diária, por dia de atraso
 * - Rolar = juros + diárias (principal continua em aberto, vencimento avança 1 ciclo)
 * - Quitar = principal + juros + diárias
 */
function calculateDebt(contract, today = todayIso()) {
  const principal = Number(contract.principal_cents);
  const cycleInterest = Math.round(principal * Number(contract.rate) / 100);
  const initialTotal = principal + cycleInterest;
  const dailyFee = Math.round(initialTotal * Number(contract.late_fee_rate) / 100);
  const overdueDays = contract.status === 'ATIVO'
    ? Math.max(0, diffDaysIso(today, contract.due_date))
    : 0;
  const lateFee = overdueDays * dailyFee;

  return {
    principal,
    cycleInterest,
    initialTotal,
    dailyFee,
    overdueDays,
    lateFee,
    totalToRollover: cycleInterest + lateFee,
    totalToSettle: initialTotal + lateFee,
  };
}

/** Novo vencimento após uma rolagem: a partir do vencimento atual, ou de hoje se já venceu. */
function nextDueDateAfterRollover(contract, today = todayIso()) {
  const base = contract.due_date < today ? today : contract.due_date;
  return addDaysIso(base, Number(contract.cycle_days));
}

module.exports = {
  todayIso,
  isValidIsoDate,
  addDaysIso,
  diffDaysIso,
  calculateDebt,
  nextDueDateAfterRollover,
};
