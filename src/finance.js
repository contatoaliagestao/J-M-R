// Regras financeiras dos contratos.
// Todos os valores monetários são inteiros em CENTAVOS para evitar erros de arredondamento.

export const TIMEZONE = 'America/Sao_Paulo';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Data de hoje (AAAA-MM-DD) no fuso da empresa. */
export function todayIso(now = new Date()) {
  // en-CA formata como AAAA-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function isValidIsoDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

export function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDaysIso(a, b) {
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
export function calculateDebt(contract, today = todayIso()) {
  const principal = Number(contract.principal_cents);
  const cycleInterest = Math.round(principal * Number(contract.rate) / 100);
  const initialTotal = principal + cycleInterest;
  const dailyFee = Math.round(initialTotal * Number(contract.late_fee_rate) / 100);
  // Contrato em acordo não acumula diárias: a dívida passa a ser controlada pelas parcelas do acordo
  const overdueDays = contract.status === 'ATIVO' && !contract.in_agreement
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
export function nextDueDateAfterRollover(contract, today = todayIso()) {
  const base = contract.due_date < today ? today : contract.due_date;
  return addDaysIso(base, Number(contract.cycle_days));
}

/** Último dia do mês (1–12) do ano informado. */
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Soma meses mantendo o dia (ajusta para o último dia quando o mês é mais curto, ex.: 31/01 + 1 mês = 28/02). */
export function addMonthsIso(iso, months, anchorDay) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (m - 1) + months;
  const year = y + Math.floor(total / 12);
  const month = (total % 12 + 12) % 12 + 1;
  const day = Math.min(anchorDay || d, lastDayOfMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Gera as parcelas de um acordo.
 * interval: 'MENSAL' ou número de dias entre parcelas (ex.: 15, 10, 7).
 * O valor é dividido igualmente; a diferença de centavos vai para a última parcela.
 */
export function buildInstallments(totalCents, count, firstDate, interval) {
  const base = Math.floor(totalCents / count);
  const out = [];
  const anchor = Number(firstDate.slice(8, 10));
  for (let i = 0; i < count; i++) {
    const due = interval === 'MENSAL' ? addMonthsIso(firstDate, i, anchor) : addDaysIso(firstDate, i * Number(interval));
    out.push({ due_date: due, amount_cents: i === count - 1 ? totalCents - base * (count - 1) : base });
  }
  return out;
}

