'use strict';

// ===================== CONFIGURAÇÕES =====================
const COLOR_THEMES = {
  amber:   { hex: '#f59e0b', rgb: '245, 158, 11', name: 'Dourado' },
  emerald: { hex: '#10b981', rgb: '16, 185, 129', name: 'Esmeralda' },
  blue:    { hex: '#3b82f6', rgb: '59, 130, 246', name: 'Azul' },
  rose:    { hex: '#f43f5e', rgb: '244, 63, 94', name: 'Rubi' },
  purple:  { hex: '#a855f7', rgb: '168, 85, 247', name: 'Violeta' },
  cyan:    { hex: '#06b6d4', rgb: '6, 182, 212', name: 'Ciano' },
  orange:  { hex: '#f97316', rgb: '249, 115, 22', name: 'Laranja' },
};
const ROLE_LABEL = { ADMIN: 'Administrador', GESTOR: 'Gestor', OPERADOR: 'Operador', SISTEMA: 'Sistema' };
const PAGE_HEADERS = {
  dash: { title: 'Dashboard', subtitle: 'INDICADORES GERAIS & HORIZONTE DE RECEBÍVEIS' },
  contratos: { title: 'Contratos', subtitle: 'GESTÃO DE CARTEIRA & CICLOS DE JUROS' },
  cobranca: { title: 'Cobrança & Atrasos', subtitle: 'PAINEL DE INADIMPLÊNCIA & DIÁRIAS' },
  conciliacao: { title: 'Conciliação Bancária (OFX)', subtitle: 'EXTRATO BANCÁRIO & VALIDAÇÃO MANUAL' },
};
const ACTION_LABELS = {
  ROLAR: 'Rolagem (juros + diárias)',
  QUITAR: 'Quitação do contrato',
  AMORTIZACAO: 'Quebrar juros (abate principal)',
  PARCELA_ACORDO: 'Parcela de acordo',
  OUTRA_ENTRADA: 'Outra entrada (sem contrato)',
  DESEMBOLSO: 'Desembolso de empréstimo',
  DESPESA: 'Despesa / tarifa',
};

const state = {
  me: null,
  companies: [],
  maxCompanies: 3,
  today: null,
  activeCompanyId: null,
  tab: 'contratos',
  contracts: [],
  bank: null,
  paymentContract: null,
  dossierContractId: null,
  users: [],
};

// ===================== UTILIDADES =====================
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const money = cents => ((Number(cents) || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brDate = iso => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '--/--/----';
const brDateTime = sqlUtc => {
  if (!sqlUtc) return '';
  const d = new Date(sqlUtc.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('pt-BR') + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};
const isManager = () => state.me && (state.me.role === 'ADMIN' || state.me.role === 'GESTOR');
const isAdmin = () => state.me && state.me.role === 'ADMIN';
const activeCompany = () => state.companies.find(c => c.id === state.activeCompanyId);
const initials = name => String(name || '').split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'US';

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function whatsappLink(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const full = digits.length <= 11 ? '55' + digits : digits;
  return `https://wa.me/${full}`;
}

function formatPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return phone;
}

async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (res.status === 401 && url !== '/api/login' && url !== '/api/me') {
    showScreen('login');
    toast('Sua sessão expirou. Entre novamente.', 'warning');
    throw new Error('401');
  }
  if (!res.ok) {
    const err = new Error(data.error || 'Erro ao comunicar com o servidor.');
    err.status = res.status;
    throw err;
  }
  return data;
}

const companyApi = (method, path, body) => api(method, `/api/companies/${state.activeCompanyId}${path}`, body);

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed'; el.style.left = '-9999px';
    document.body.appendChild(el); el.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    el.remove();
  }
  toast(message, 'success');
}

function toast(message, type = 'info') {
  const styles = {
    success: ['border-emerald-500/40 text-emerald-300', 'fa-circle-check text-emerald-400'],
    warning: ['border-amber-500/40 text-amber-300', 'fa-triangle-exclamation text-amber-400'],
    error: ['border-red-500/40 text-red-300', 'fa-circle-xmark text-red-400'],
    info: ['border-slate-700', 'fa-circle-info text-blue-400'],
  }[type] || [];
  const el = document.createElement('div');
  el.className = `bg-slate-900 border ${styles[0]} px-4 py-3 rounded-xl shadow-2xl flex items-center space-x-3 text-xs text-slate-200 transition-all duration-300 opacity-0 translate-y-2 pointer-events-auto max-w-sm`;
  el.innerHTML = `<i class="fa-solid ${styles[1]} text-base"></i><span></span>`;
  el.querySelector('span').textContent = message;
  $('#toastContainer').appendChild(el);
  requestAnimationFrame(() => el.classList.remove('opacity-0', 'translate-y-2'));
  setTimeout(() => { el.classList.add('opacity-0'); setTimeout(() => el.remove(), 300); }, 4500);
}

const handleError = err => { if (err.message !== '401') toast(err.message, 'error'); };

function openModal(id) {
  const m = $('#' + id);
  // Move para o fim da página: a janela aberta por último fica sempre por cima das outras
  document.body.appendChild(m);
  m.classList.remove('hidden');
}
function closeModal(id) { $('#' + id).classList.add('hidden'); }

function formData(form) {
  const out = {};
  new FormData(form).forEach((v, k) => { out[k] = typeof v === 'string' ? v.trim() : v; });
  return out;
}

async function withBusy(button, fn) {
  if (button) button.disabled = true;
  try { return await fn(); } finally { if (button) button.disabled = false; }
}

// ===================== TEMA E TELAS =====================
function applyTheme(colorKey) {
  const t = COLOR_THEMES[colorKey] || COLOR_THEMES.amber;
  const root = document.documentElement.style;
  root.setProperty('--theme-primary', t.hex);
  root.setProperty('--theme-primary-rgb', t.rgb);
  root.setProperty('--theme-glow', `rgba(${t.rgb}, 0.2)`);
}

function showScreen(name) {
  ['bootScreen', 'setupScreen', 'loginScreen', 'appContainer'].forEach(id => $('#' + id).classList.add('hidden'));
  const id = { boot: 'bootScreen', setup: 'setupScreen', login: 'loginScreen', app: 'appContainer' }[name];
  $('#' + id).classList.remove('hidden');
  if (name === 'app') $('#appContainer').classList.add('flex');
  else $('#appContainer').classList.remove('flex');
  $('#mobileNav').classList.toggle('hidden', name !== 'app');
  if (name === 'login') {
    applyTheme('amber');
    setTimeout(() => $('#loginForm [name=login]').focus(), 50);
  }
}

function renderColorPicker(container, selected, onPick) {
  container.innerHTML = '';
  Object.entries(COLOR_THEMES).forEach(([key, t]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = t.name;
    b.className = `h-9 rounded-xl flex items-center justify-center transition-all border-2 ${selected === key ? 'border-white scale-105' : 'border-transparent opacity-80 hover:opacity-100'}`;
    b.style.backgroundColor = t.hex;
    if (selected === key) b.innerHTML = '<i class="fa-solid fa-check text-slate-950 text-xs"></i>';
    b.addEventListener('click', () => { onPick(key); renderColorPicker(container, key, onPick); });
    container.appendChild(b);
  });
}

function renderLogo(container, company) {
  container.innerHTML = '';
  const fallback = () => {
    container.innerHTML = `<div class="w-full h-full rounded-full flex items-center justify-center bg-slate-950">
      <span class="text-white font-black text-xl tracking-tighter">${esc(initials(company.short_name))}</span></div>`;
  };
  if (company.logo_url) {
    const img = document.createElement('img');
    img.className = 'w-full h-full object-cover rounded-full';
    img.alt = company.short_name;
    img.onerror = fallback;
    img.src = company.logo_url;
    container.appendChild(img);
  } else {
    fallback();
  }
}

// ===================== INICIALIZAÇÃO =====================
async function boot() {
  showScreen('boot');
  try {
    const setup = await api('GET', '/api/setup');
    if (setup.needsSetup) {
      $('#setupCodeRow').classList.toggle('hidden', !setup.needsSetupCode);
      $('#setupForm [name=setup_code]').required = !!setup.needsSetupCode;
      return startSetup();
    }
    try {
      const me = await api('GET', '/api/me');
      return enterApp(me);
    } catch (e) {
      if (e.status === 401) return showScreen('login');
      throw e;
    }
  } catch (e) {
    $('#bootScreen').textContent = 'Não foi possível conectar ao servidor. Recarregue a página.';
  }
}

let setupColor = 'amber';
function startSetup() {
  applyTheme(setupColor);
  renderColorPicker($('[data-color-picker=setup]'), setupColor, k => { setupColor = k; applyTheme(k); });
  showScreen('setup');
}

$('#setupForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = formData(e.target);
  const btn = e.target.querySelector('[type=submit]');
  await withBusy(btn, async () => {
    try {
      await api('POST', '/api/setup', {
        setup_code: f.setup_code, name: f.name, email: f.email, password: f.password,
        company: { official_name: f.official_name, short_name: f.short_name, cnpj: f.cnpj, tagline: f.tagline, color_theme: setupColor },
      });
      const me = await api('GET', '/api/me');
      toast('Configuração concluída! Bem-vindo(a).', 'success');
      enterApp(me);
    } catch (err) { handleError(err); }
  });
});

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = formData(e.target);
  const btn = e.target.querySelector('[type=submit]');
  await withBusy(btn, async () => {
    try {
      await api('POST', '/api/login', { login: f.login, password: f.password, remember: !!f.remember });
      e.target.password.value = '';
      const me = await api('GET', '/api/me');
      toast(`Bem-vindo(a), ${me.user.name}!`, 'success');
      enterApp(me);
    } catch (err) { handleError(err); }
  });
});

$('#togglePasswordBtn').addEventListener('click', () => {
  const input = $('#loginForm [name=password]');
  const icon = $('#togglePasswordBtn i');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  icon.className = show ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
});

$('#forgotPasswordBtn').addEventListener('click', () => {
  toast('Peça ao administrador do sistema para redefinir sua senha.', 'info');
});

function enterApp(me) {
  state.me = me.user;
  state.companies = me.companies;
  state.maxCompanies = me.maxCompanies;
  state.today = me.today;

  $('#userNameTop').textContent = me.user.name;
  $('#userRoleTop').textContent = ROLE_LABEL[me.user.role];
  $('#userAvatar').textContent = initials(me.user.name);
  $('#todayDisplay').textContent = brDate(me.today);
  $$('[data-admin]').forEach(el => el.classList.toggle('hidden', !isAdmin()));
  $$('[data-manager]').forEach(el => el.classList.toggle('hidden', !isManager()));
  $$('[data-operator-only]').forEach(el => el.classList.toggle('hidden', isManager()));
  $('#mobileAvatar').textContent = initials(me.user.name);
  $('#mobileMenuAvatar').textContent = initials(me.user.name);
  $('#mobileMenuName').textContent = me.user.name;
  $('#mobileMenuRole').textContent = ROLE_LABEL[me.user.role];

  showScreen('app');

  if (!state.companies.length) {
    state.activeCompanyId = null;
    $('#activeCompanyName').textContent = 'Nenhuma empresa liberada';
    $('#sidebarCompanyName').textContent = '';
    toast('Seu usuário ainda não tem empresa liberada. Fale com o administrador.', 'warning');
    return;
  }

  const saved = Number(localStorage.getItem(`jmr_empresa_${me.user.id}`));
  const company = state.companies.find(c => c.id === saved) || state.companies[0];
  selectCompany(company.id, { silent: true });
  navigate(isManager() ? 'dash' : 'contratos');
}

async function logout() {
  try { await api('POST', '/api/logout', {}); } catch { /* ignore */ }
  state.me = null;
  $$('.modal').forEach(m => m.classList.add('hidden'));
  showScreen('login');
  toast('Sessão encerrada.', 'info');
}

// ===================== EMPRESA ATIVA =====================
function selectCompany(id, { silent = false } = {}) {
  const company = state.companies.find(c => c.id === id);
  if (!company) return;
  state.activeCompanyId = id;
  localStorage.setItem(`jmr_empresa_${state.me.id}`, String(id));
  applyTheme(company.color_theme);
  $('#activeCompanyName').textContent = company.official_name;
  $('#sidebarCompanyName').textContent = company.short_name;
  $('#sidebarCompanyTagline').textContent = company.tagline || '';
  renderLogo($('#sidebarLogo'), company);
  renderLogo($('#mobileLogo'), company);
  $('#mobileCompanyName').textContent = company.short_name;
  $('#companyDropdownMenu').classList.add('hidden');
  state.bank = null;
  if (!silent) {
    toast(`Empresa ativa: ${company.short_name}`, 'info');
    refresh();
  }
}

function renderCompanyDropdown() {
  $('#companyDropdownCount').textContent = `EMPRESAS (${state.companies.length}/${state.maxCompanies})`;
  const list = $('#companyDropdownList');
  list.innerHTML = state.companies.map(c => {
    const t = COLOR_THEMES[c.color_theme] || COLOR_THEMES.amber;
    const current = c.id === state.activeCompanyId;
    return `<div data-company-id="${c.id}" class="px-4 py-3 cursor-pointer flex items-center justify-between text-xs hover:bg-slate-800/80 ${current ? 'bg-slate-800/60 font-bold' : 'text-slate-300'}">
      <div class="flex items-center space-x-3 truncate">
        <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background-color:${t.hex}"></span>
        <div class="truncate"><span class="block text-white truncate">${esc(c.official_name)}</span>
        <span class="text-[10px] text-slate-500 font-mono">${esc(c.cnpj || c.tagline)}</span></div>
      </div>
      ${current ? `<i class="fa-solid fa-check text-xs ml-3" style="color:${t.hex}"></i>` : ''}
    </div>`;
  }).join('');
  const btn = $('#companyDropdownMenu [data-action=new-company]');
  if (btn) btn.classList.toggle('hidden', !isAdmin() || state.companies.length >= state.maxCompanies);
}

$('#companyDropdownBtn').addEventListener('click', e => {
  e.stopPropagation();
  renderCompanyDropdown();
  $('#companyDropdownMenu').classList.toggle('hidden');
});
$('#companyDropdownList').addEventListener('click', e => {
  const item = e.target.closest('[data-company-id]');
  if (item) selectCompany(Number(item.dataset.companyId));
});
document.addEventListener('click', e => {
  if (!e.target.closest('#companyDropdownMenu') && !e.target.closest('#companyDropdownBtn')) {
    $('#companyDropdownMenu').classList.add('hidden');
  }
});

// ===================== NAVEGAÇÃO =====================
function navigate(tab) {
  if (!isManager() && (tab === 'dash' || tab === 'conciliacao')) tab = 'contratos';
  state.tab = tab;
  const h = PAGE_HEADERS[tab];
  $('#pageTitle').textContent = h.title;
  $('#pageSubtitle').textContent = h.subtitle;
  $('#breadcrumb').textContent = h.title;
  Object.keys(PAGE_HEADERS).forEach(t => $('#view-' + t).classList.toggle('hidden', t !== tab));
  $$('.sidebar-btn[data-tab], .mnav-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#mobileTitle').textContent = h.title;
  window.scrollTo(0, 0);
  refresh();
}

async function refresh() {
  if (!state.activeCompanyId) return;
  try {
    const tasks = [loadContracts()];
    if (isManager()) {
      if (state.tab === 'dash') tasks.push(loadDashboard());
      tasks.push(loadBank());
    }
    await Promise.all(tasks);
  } catch (err) { handleError(err); }
}

// ===================== DASHBOARD =====================
async function loadDashboard() {
  const { dashboard: d } = await companyApi('GET', '/dashboard');
  $('#kpiCapital').textContent = money(d.capital_alocado_cents);
  $('#kpiReceita').textContent = money(d.receita_realizada_cents);
  $('#kpiAEntrar').textContent = money(d.receita_a_entrar_cents);
  $('#kpiAtivos').textContent = d.contratos_ativos;
  $('#kpiTaxaAtraso').textContent = `${d.taxa_atraso}% em atraso`;
  $('#kpiUltimoVenc').textContent = d.ultimo_vencimento ? brDate(d.ultimo_vencimento) : 'Nenhum ativo';
  $('#kpiRolagens').textContent = `${d.total_rolagens} rolagens`;
  $('#kpiDespesas').textContent = money(d.despesas_cents);
  $('#kpiLucro').textContent = money(d.lucro_liquido_cents);
  $('#kpiLucro').className = `text-lg font-black font-mono ${d.lucro_liquido_cents >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
  const total = (d.ciclo15 + d.ciclo30) || 1;
  $('#countCiclo15').textContent = `${d.ciclo15} contratos`;
  $('#countCiclo30').textContent = `${d.ciclo30} contratos`;
  $('#barCiclo15').style.width = `${d.ciclo15 / total * 100}%`;
  $('#barCiclo30').style.width = `${d.ciclo30 / total * 100}%`;
  const a = d.acordos;
  $('#acordoResumo').textContent = `${a.ativos} ativo${a.ativos === 1 ? '' : 's'} • ${a.concluidos} concluído${a.concluidos === 1 ? '' : 's'}`;
  $('#acordoTotal').textContent = money(a.total_acordado_cents);
  $('#acordoRecebido').textContent = money(a.recebido_cents);
  $('#acordoAReceber').textContent = money(a.a_receber_cents);
  $('#acordoAtrasado').textContent = `${money(a.atrasado_cents)}${a.parcelas_atrasadas ? ` (${a.parcelas_atrasadas})` : ''}`;
  $('#acordoProx30').textContent = money(a.proximos_30d_cents);
  $('#acordoReceita').textContent = money(a.receita_cents);
  $('#acordoDesconto').textContent = money(a.desconto_concedido_cents);
}

// ===================== CONTRATOS =====================
async function loadContracts() {
  const data = await companyApi('GET', '/contracts');
  state.contracts = data.contracts;
  state.today = data.today;
  renderContracts();
  renderOverdue();
}

function statusBadge(c) {
  if (c.situation === 'QUITADO') return '<span class="px-2 py-0.5 rounded-full text-[10px] bg-slate-800 text-slate-400 font-bold border border-slate-700">Quitado</span>';
  if (c.situation === 'ACORDO') {
    const a = c.agreement;
    const late = a && a.overdue_count > 0;
    return `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${late ? 'bg-red-500/20 text-red-300 border-red-500/30' : 'bg-amber-500/20 text-amber-300 border-amber-500/30'}"><i class="fa-solid fa-handshake mr-1"></i>Acordo${a ? ` ${a.paid_count}/${a.installments_count}` : ''}${late ? ' • atrasado' : ''}</span>`;
  }
  if (c.situation === 'ATRASADO') return `<span class="px-2 py-0.5 rounded-full text-[10px] bg-red-500/20 text-red-400 font-bold border border-red-500/30 whitespace-nowrap"><i class="fa-solid fa-clock mr-1"></i>${c.debt.overdueDays}d atraso</span>`;
  return '<span class="px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/20 text-emerald-400 font-bold border border-emerald-500/30">Em dia</span>';
}

function renderContracts() {
  const term = $('#searchContracts').value.trim().toLowerCase();
  const cycle = $('#filterCycle').value;
  const status = $('#filterStatus').value;
  const digits = term.replace(/\D/g, '');

  const list = state.contracts.filter(c => {
    const matchesTerm = !term
      || c.client_name.toLowerCase().includes(term)
      || c.code.toLowerCase().includes(term)
      || c.address.toLowerCase().includes(term)
      || c.cpf.toLowerCase().includes(term)
      || (digits.length >= 3 && (c.cpf.replace(/\D/g, '').includes(digits) || c.phone.includes(digits)));
    return matchesTerm
      && (cycle === 'ALL' || String(c.cycle_days) === cycle)
      && (status === 'ALL' || c.situation === status);
  });

  renderContractCards(list);
  const tbody = $('#contractsTableBody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-10 text-slate-500">${state.contracts.length ? 'Nenhum contrato encontrado com esses filtros.' : 'Nenhum contrato cadastrado nesta empresa ainda.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(c => {
    if (c.situation === 'ACORDO') return agreementRow(c);
    const late = c.situation === 'ATRASADO';
    return `<tr class="hover:bg-slate-800/40 ${late ? 'bg-red-500/5' : ''}">
      <td class="py-3 px-4">
        <button data-action="dossier" data-id="${c.id}" class="font-bold text-white hover:underline text-left">${esc(c.client_name)}</button>
        <div class="text-[11px] text-slate-500"><span class="font-mono theme-accent-text font-semibold">${esc(c.code)}</span> • CPF: ${esc(c.cpf)}</div>
        <div class="text-[10px] text-slate-400 truncate max-w-[220px]" title="${esc(c.address)}"><i class="fa-solid fa-location-dot text-rose-400 mr-1"></i>${esc(c.address)}</div>
      </td>
      <td class="py-3 px-4 font-mono font-bold text-slate-200">${money(c.principal_cents)}</td>
      <td class="py-3 px-4"><div class="font-mono text-emerald-400 font-bold">${money(c.debt.cycleInterest)}</div>
        <div class="text-[10px] text-slate-400">${c.rate}% a cada ${c.cycle_days}d</div></td>
      <td class="py-3 px-4"><div class="font-mono ${late ? 'text-red-400 font-bold' : 'text-slate-300'}">${c.situation === 'QUITADO' ? '—' : brDate(c.due_date)}</div>
        <div class="text-[10px] text-slate-500">${c.rollover_count > 0 ? `${c.rollover_count} rolagens` : 'Ciclo inicial'}</div></td>
      <td class="py-3 px-4">${late
        ? `<div class="font-mono text-red-400 font-bold">${money(c.debt.lateFee)}</div><div class="text-[10px] text-red-300/80">${c.debt.overdueDays} dias (${money(c.debt.dailyFee)}/dia)</div>`
        : '<span class="text-slate-500 text-[11px]">Sem atraso</span>'}</td>
      <td class="py-3 px-4 font-mono font-bold ${late ? 'text-amber-400' : 'text-emerald-400'}">${c.situation === 'QUITADO' ? '—' : money(c.debt.totalToSettle)}</td>
      <td class="py-3 px-4">${statusBadge(c)}</td>
      <td class="py-3 px-4"><div class="flex items-center justify-center gap-1.5">
        <button data-action="dossier" data-id="${c.id}" class="bg-blue-600/90 hover:bg-blue-500 text-white px-2 py-1.5 rounded-lg text-xs font-semibold"><i class="fa-solid fa-folder-open text-[11px] mr-1"></i>Ficha</button>
        ${c.status === 'ATIVO' && isManager() ? `<button data-action="payment" data-id="${c.id}" class="bg-emerald-600/90 hover:bg-emerald-500 text-white px-2 py-1.5 rounded-lg text-xs font-semibold"><i class="fa-solid fa-money-bill-wave text-[11px] mr-1"></i>Baixa</button>` : ''}
        <a href="${esc(whatsappLink(c.phone))}" target="_blank" rel="noopener" title="Abrir WhatsApp" class="bg-slate-800 hover:bg-slate-700 text-emerald-400 p-1.5 rounded-lg text-xs border border-slate-700"><i class="fa-brands fa-whatsapp"></i></a>
      </div></td>
    </tr>`;
  }).join('');
}

// Cartões de contrato para o celular (mesmos dados da tabela, em formato fácil de tocar)
function renderContractCards(list) {
  const box = $('#contractsCards');
  if (!list.length) {
    box.innerHTML = `<div class="panel p-6 text-center text-slate-400 text-sm">${state.contracts.length ? 'Nenhum contrato encontrado.' : 'Nenhum contrato cadastrado ainda.<br>Toque em <b>+</b> para lançar o primeiro.'}</div>`;
    return;
  }
  box.innerHTML = list.map(c => {
    const a = c.agreement;
    const inAgreement = c.situation === 'ACORDO' && a;
    const late = c.situation === 'ATRASADO' || (inAgreement && a.overdue_count > 0);
    let dueLine;
    let amountLabel;
    let amount;
    if (c.situation === 'QUITADO') {
      dueLine = `Quitado em ${brDate(c.settled_at)}`; amountLabel = 'Principal'; amount = c.principal_cents;
    } else if (inAgreement) {
      const n = a.next_installment;
      dueLine = n ? `Parcela ${n.number}/${a.installments_count}: ${brDate(n.due_date)} • ${money(n.amount_cents)}` : 'Acordo';
      amountLabel = 'Saldo do acordo'; amount = a.remaining_cents;
    } else {
      dueLine = `Vence ${brDate(c.due_date)}${c.debt.overdueDays ? ` • ${c.debt.overdueDays}d de atraso` : ''}`;
      amountLabel = 'Para quitar'; amount = c.debt.totalToSettle;
    }
    const canPay = c.status === 'ATIVO' && isManager() && !inAgreement;
    return `<div class="ccard ${late ? 'border-red-500/40' : ''}">
      <button data-action="dossier" data-id="${c.id}" class="w-full text-left">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="text-[15px] font-bold text-white truncate">${esc(c.client_name)}</div>
            <div class="text-[11px] text-slate-400"><span class="font-mono theme-accent-text font-semibold">${esc(c.code)}</span> • ${money(c.principal_cents)} a ${c.rate}%/${c.cycle_days}d</div>
          </div>
          <div class="flex-shrink-0">${statusBadge(c)}</div>
        </div>
        <div class="flex items-end justify-between gap-2 mt-3">
          <div class="text-xs ${late ? 'text-red-300' : 'text-slate-300'} font-mono">${dueLine}</div>
          <div class="text-right">
            <div class="text-[10px] text-slate-400 uppercase">${amountLabel}</div>
            <div class="font-mono font-black text-base ${late ? 'text-amber-400' : (c.situation === 'QUITADO' ? 'text-slate-400' : 'text-emerald-400')}">${money(amount)}</div>
          </div>
        </div>
      </button>
      <div class="grid ${canPay ? 'grid-cols-3' : 'grid-cols-2'} gap-2 mt-3">
        <button data-action="dossier" data-id="${c.id}" class="ccard-btn bg-blue-600 text-white"><i class="fa-solid fa-folder-open"></i>Ficha</button>
        <a href="${esc(whatsappLink(c.phone))}" target="_blank" rel="noopener" class="ccard-btn bg-emerald-700 text-white"><i class="fa-brands fa-whatsapp"></i>WhatsApp</a>
        ${canPay ? `<button data-action="payment" data-id="${c.id}" class="ccard-btn bg-emerald-500 text-slate-950"><i class="fa-solid fa-money-bill-wave"></i>Baixa</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

// Linha de contrato em acordo: mostra a próxima parcela e o saldo do acordo
function agreementRow(c) {
  const a = c.agreement || { remaining_cents: 0, overdue_count: 0, next_installment: null, total_cents: 0 };
  const next = a.next_installment;
  const late = a.overdue_count > 0;
  return `<tr class="hover:bg-slate-800/40 ${late ? 'bg-red-500/5' : 'bg-amber-500/[0.03]'}">
    <td class="py-3 px-4">
      <button data-action="dossier" data-id="${c.id}" class="font-bold text-white hover:underline text-left">${esc(c.client_name)}</button>
      <div class="text-[11px] text-slate-500"><span class="font-mono theme-accent-text font-semibold">${esc(c.code)}</span> • CPF: ${esc(c.cpf)}</div>
      <div class="text-[10px] text-slate-400 truncate max-w-[220px]" title="${esc(c.address)}"><i class="fa-solid fa-location-dot text-rose-400 mr-1"></i>${esc(c.address)}</div>
    </td>
    <td class="py-3 px-4 font-mono font-bold text-slate-200">${money(c.principal_cents)}</td>
    <td class="py-3 px-4"><div class="font-mono text-amber-300 font-bold">${money(a.total_cents)}</div><div class="text-[10px] text-slate-400">valor acordado</div></td>
    <td class="py-3 px-4">${next
      ? `<div class="font-mono ${late ? 'text-red-400 font-bold' : 'text-slate-300'}">${brDate(next.due_date)}</div><div class="text-[10px] text-slate-500">parcela ${next.number} • ${money(next.amount_cents)}</div>`
      : '—'}</td>
    <td class="py-3 px-4">${late
      ? `<div class="font-mono text-red-400 font-bold">${a.overdue_count} parcela${a.overdue_count > 1 ? 's' : ''}</div><div class="text-[10px] text-red-300/80">${money(a.overdue_cents)} vencido</div>`
      : '<span class="text-slate-500 text-[11px]">Sem diárias (acordo)</span>'}</td>
    <td class="py-3 px-4"><div class="font-mono font-bold text-amber-400">${money(a.remaining_cents)}</div><div class="text-[10px] text-slate-500">saldo do acordo</div></td>
    <td class="py-3 px-4">${statusBadge(c)}</td>
    <td class="py-3 px-4"><div class="flex items-center justify-center gap-1.5">
      <button data-action="dossier" data-id="${c.id}" class="bg-amber-500/90 hover:bg-amber-400 text-slate-950 px-2 py-1.5 rounded-lg text-xs font-bold"><i class="fa-solid fa-handshake text-[11px] mr-1"></i>Acordo</button>
      <a href="${esc(whatsappLink(c.phone))}" target="_blank" rel="noopener" title="Abrir WhatsApp" class="bg-slate-800 hover:bg-slate-700 text-emerald-400 p-1.5 rounded-lg text-xs border border-slate-700"><i class="fa-brands fa-whatsapp"></i></a>
    </div></td>
  </tr>`;
}

['#searchContracts', '#filterCycle', '#filterStatus'].forEach(sel => {
  $(sel).addEventListener(sel === '#searchContracts' ? 'input' : 'change', renderContracts);
});

// ===================== COBRANÇA =====================
function debtSummaryText(c) {
  return `REGULARIZAÇÃO DE CONTRATO\n` +
    `Cliente: ${c.client_name} (CPF: ${c.cpf})\n` +
    `Contrato: ${c.code}\n` +
    `Vencimento: ${brDate(c.due_date)} (${c.debt.overdueDays} dias em atraso)\n` +
    `-----------------------------------------\n` +
    `Principal: ${money(c.debt.principal)}\n` +
    `Juros do ciclo: ${money(c.debt.cycleInterest)}\n` +
    `Diárias de atraso: ${money(c.debt.lateFee)}\n` +
    `-----------------------------------------\n` +
    `PARA ROLAR (+${c.cycle_days} dias): ${money(c.debt.totalToRollover)}\n` +
    `PARA QUITAR: ${money(c.debt.totalToSettle)}`;
}

function agreementDebtText(c) {
  const a = c.agreement;
  const overdue = a.installments.filter(i => i.status === 'PENDENTE' && i.overdue_days > 0);
  return `ACORDO EM ATRASO\n` +
    `Cliente: ${c.client_name} (CPF: ${c.cpf})\n` +
    `Contrato: ${c.code}\n` +
    `-----------------------------------------\n` +
    overdue.map(i => `Parcela ${i.number}/${a.installments_count} - venc. ${brDate(i.due_date)} (${i.overdue_days} dias): ${money(i.amount_cents)}`).join('\n') + '\n' +
    `-----------------------------------------\n` +
    `TOTAL VENCIDO: ${money(a.overdue_cents)}\n` +
    `SALDO DO ACORDO: ${money(a.remaining_cents)}`;
}

function agreementOverdueCard(c) {
  const a = c.agreement;
  const overdue = a.installments.filter(i => i.status === 'PENDENTE' && i.overdue_days > 0);
  const maxDays = Math.max(...overdue.map(i => i.overdue_days));
  return `
    <div class="bg-slate-900 border border-amber-500/40 rounded-2xl p-5 flex flex-col justify-between">
      <div>
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <span class="text-[10px] font-mono theme-accent-text font-bold">${esc(c.code)}</span>
            <span class="ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300"><i class="fa-solid fa-handshake mr-0.5"></i>ACORDO</span>
            <button data-action="dossier" data-id="${c.id}" class="block text-sm font-bold text-white hover:underline text-left">${esc(c.client_name)}</button>
            <p class="text-xs text-slate-400 font-mono">${esc(formatPhone(c.phone))} • CPF: ${esc(c.cpf)}</p>
            <p class="text-[10px] text-slate-400 truncate mt-0.5"><i class="fa-solid fa-location-dot text-rose-400 mr-1"></i>${esc(c.address)}</p>
          </div>
          <span class="px-2 py-0.5 rounded-full text-[10px] bg-red-500 text-white font-bold whitespace-nowrap">${maxDays}d atrasado</span>
        </div>
        <div class="my-3 p-3 bg-slate-950 rounded-xl border border-slate-800 space-y-1.5 text-xs">
          ${overdue.map(i => `<div class="flex justify-between text-slate-400"><span>Parcela ${i.number}/${a.installments_count} (${brDate(i.due_date)}):</span><strong class="text-red-400 font-mono">${money(i.amount_cents)}</strong></div>`).join('')}
          <div class="pt-1.5 border-t border-slate-800 flex justify-between font-bold text-white"><span>Saldo do acordo:</span><strong class="text-amber-400 font-mono">${money(a.remaining_cents)}</strong></div>
        </div>
      </div>
      <div class="space-y-2">
        <div class="grid grid-cols-2 gap-2">
          <button data-action="copy-agreement-debt" data-id="${c.id}" class="bg-slate-800 hover:bg-slate-700 text-slate-200 py-2 rounded-xl text-xs font-bold border border-slate-700"><i class="fa-regular fa-copy text-emerald-400 mr-1"></i>Copiar cobrança</button>
          <a href="${esc(whatsappLink(c.phone))}" target="_blank" rel="noopener" class="bg-emerald-700 hover:bg-emerald-600 text-white py-2 rounded-xl text-xs font-bold text-center"><i class="fa-brands fa-whatsapp mr-1"></i>WhatsApp</a>
        </div>
        <button data-action="dossier" data-id="${c.id}" class="w-full bg-amber-500/90 hover:bg-amber-400 text-slate-950 py-2 rounded-xl text-xs font-bold"><i class="fa-solid fa-handshake mr-1"></i>Ver acordo${isManager() ? ' / receber parcela' : ''}</button>
      </div>
    </div>`;
}

function renderOverdue() {
  const list = state.contracts.filter(c => c.situation === 'ATRASADO').sort((a, b) => b.debt.overdueDays - a.debt.overdueDays);
  const agreementsLate = state.contracts.filter(c => c.situation === 'ACORDO' && c.agreement && c.agreement.overdue_count > 0);
  const badge = $('#overdueBadge');
  badge.textContent = list.length + agreementsLate.length;
  badge.classList.toggle('hidden', list.length + agreementsLate.length === 0);
  $('#mobileOverdueBadge').textContent = list.length + agreementsLate.length;
  $('#mobileOverdueBadge').classList.toggle('hidden', list.length + agreementsLate.length === 0);

  const box = $('#overdueCards');
  if (!list.length && !agreementsLate.length) {
    box.innerHTML = `<div class="col-span-full panel p-8 text-center text-slate-400">
      <i class="fa-solid fa-circle-check text-4xl text-emerald-400 mb-3"></i>
      <h4 class="text-white font-bold">Nenhum contrato em atraso nesta empresa!</h4></div>`;
    return;
  }
  box.innerHTML = list.map(c => `
    <div class="bg-slate-900 border border-red-500/30 rounded-2xl p-5 flex flex-col justify-between">
      <div>
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <span class="text-[10px] font-mono theme-accent-text font-bold">${esc(c.code)}</span>
            <button data-action="dossier" data-id="${c.id}" class="block text-sm font-bold text-white hover:underline text-left">${esc(c.client_name)}</button>
            <p class="text-xs text-slate-400 font-mono">${esc(formatPhone(c.phone))} • CPF: ${esc(c.cpf)}</p>
            <p class="text-[10px] text-slate-400 truncate mt-0.5"><i class="fa-solid fa-location-dot text-rose-400 mr-1"></i>${esc(c.address)}</p>
          </div>
          <span class="px-2 py-0.5 rounded-full text-[10px] bg-red-500 text-white font-bold whitespace-nowrap">${c.debt.overdueDays}d atrasado</span>
        </div>
        <div class="my-3 p-3 bg-slate-950 rounded-xl border border-slate-800 space-y-1.5 text-xs">
          <div class="flex justify-between text-slate-400"><span>Vencimento:</span><strong class="text-red-400 font-mono">${brDate(c.due_date)}</strong></div>
          <div class="flex justify-between text-slate-400"><span>Diárias acumuladas:</span><strong class="text-amber-400 font-mono">${money(c.debt.lateFee)}</strong></div>
          <div class="flex justify-between text-slate-400"><span>Rolar (+${c.cycle_days}d):</span><strong class="text-teal-400 font-mono">${money(c.debt.totalToRollover)}</strong></div>
          <div class="pt-1.5 border-t border-slate-800 flex justify-between font-bold text-white"><span>Quitação:</span><strong class="text-emerald-400 font-mono">${money(c.debt.totalToSettle)}</strong></div>
        </div>
      </div>
      <div class="space-y-2">
        <div class="grid grid-cols-2 gap-2">
          <button data-action="copy-debt" data-id="${c.id}" class="bg-slate-800 hover:bg-slate-700 text-slate-200 py-2 rounded-xl text-xs font-bold border border-slate-700"><i class="fa-regular fa-copy text-emerald-400 mr-1"></i>Copiar cobrança</button>
          <a href="${esc(whatsappLink(c.phone))}" target="_blank" rel="noopener" class="bg-emerald-700 hover:bg-emerald-600 text-white py-2 rounded-xl text-xs font-bold text-center"><i class="fa-brands fa-whatsapp mr-1"></i>WhatsApp</a>
        </div>
        <div class="grid ${isManager() ? 'grid-cols-2' : 'grid-cols-1'} gap-2">
          <button data-action="dossier" data-id="${c.id}" class="bg-blue-600 hover:bg-blue-500 text-white py-2 rounded-xl text-xs font-bold"><i class="fa-solid fa-clipboard-list mr-1"></i>Ficha</button>
          ${isManager() ? `<button data-action="payment" data-id="${c.id}" class="bg-emerald-600 hover:bg-emerald-500 text-white py-2 rounded-xl text-xs font-bold"><i class="fa-solid fa-hand-holding-dollar mr-1"></i>Baixa</button>` : ''}
        </div>
      </div>
    </div>`).join('') + agreementsLate.map(agreementOverdueCard).join('');
}

// ===================== NOVO EMPRÉSTIMO =====================
function updateLoanPreview() {
  const f = formData($('#loanForm'));
  const principal = Math.round((Number(f.principal) || 0) * 100);
  const juros = Math.round(principal * (Number(f.rate) || 0) / 100);
  const diaria = Math.round((principal + juros) * (Number(f.late_fee_rate) || 0) / 100);
  $('#previewJuros').textContent = money(juros);
  $('#previewDiaria').textContent = `${money(diaria)} / dia`;
  $('#previewVenc').textContent = f.start_date ? brDate(addDays(f.start_date, Number(f.cycle_days) || 30)) : '--';
}
$('#loanForm').addEventListener('input', updateLoanPreview);

function openLoanModal(prefillClient = null) {
  const form = $('#loanForm');
  form.reset();
  form.start_date.value = state.today;
  hideClientSuggestions();
  $('#clientSelected').classList.add('hidden');
  updateLoanPreview();
  openModal('loanModal');
  if (prefillClient) {
    fillClient(prefillClient);
  } else {
    setTimeout(() => form.client_name.focus(), 50);
  }
}

// ----- Clientes já cadastrados (puxar dados no novo empréstimo) -----
const digitsOnly = v => String(v || '').replace(/\D/g, '');
const normalizeText = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// Junta os contratos da empresa por cliente (CPF; sem CPF válido, pelo nome) usando os dados do contrato mais recente
function clientIndex() {
  const map = new Map();
  [...state.contracts].sort((a, b) => b.id - a.id).forEach(c => {
    const cpf = digitsOnly(c.cpf);
    const key = cpf.length >= 11 ? 'cpf:' + cpf : 'nome:' + normalizeText(c.client_name);
    let cl = map.get(key);
    if (!cl) {
      cl = { key, client_name: c.client_name, cpf: c.cpf, phone: c.phone, address: c.address, social_media: c.social_media,
        ativos: 0, atrasados: 0, acordos: 0, quitados: 0 };
      map.set(key, cl);
    }
    if (c.situation === 'QUITADO') cl.quitados++;
    else {
      cl.ativos++;
      if (c.situation === 'ATRASADO' || (c.situation === 'ACORDO' && c.agreement && c.agreement.overdue_count > 0)) cl.atrasados++;
      if (c.situation === 'ACORDO') cl.acordos++;
    }
  });
  return [...map.values()];
}

function clientStatusLine(cl) {
  const parts = [];
  if (cl.atrasados) parts.push(`<span class="text-red-400 font-bold">${cl.atrasados} em atraso</span>`);
  if (cl.acordos) parts.push(`<span class="text-amber-300">${cl.acordos} em acordo</span>`);
  if (cl.ativos - cl.atrasados > 0) parts.push(`<span class="text-emerald-400">${cl.ativos} ativo${cl.ativos > 1 ? 's' : ''}</span>`);
  if (cl.quitados) parts.push(`<span class="text-slate-400">${cl.quitados} quitado${cl.quitados > 1 ? 's' : ''}</span>`);
  return parts.join(' • ');
}

function hideClientSuggestions() {
  $('#clientSuggestions').classList.add('hidden');
  $('#clientSuggestions').innerHTML = '';
}

function showClientSuggestions(query) {
  const q = normalizeText(query);
  const qd = digitsOnly(query);
  if (q.length < 2 && qd.length < 3) return hideClientSuggestions();
  const list = clientIndex().filter(cl =>
    (q.length >= 2 && normalizeText(cl.client_name).includes(q)) || (qd.length >= 3 && digitsOnly(cl.cpf).includes(qd))).slice(0, 5);
  if (!list.length) return hideClientSuggestions();
  state.clientSuggestions = list;
  const box = $('#clientSuggestions');
  box.innerHTML = list.map((cl, i) => `
    <button type="button" data-action="pick-client" data-id="${i}" class="w-full text-left bg-slate-950 hover:bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5">
      <div class="flex items-center justify-between gap-2">
        <span class="font-bold text-white text-sm truncate"><i class="fa-solid fa-user-check theme-accent-text mr-1.5"></i>${esc(cl.client_name)}</span>
        <span class="text-[10px] theme-accent-text font-bold whitespace-nowrap">USAR DADOS</span>
      </div>
      <div class="text-[11px] text-slate-400 font-mono mt-0.5">CPF ${esc(cl.cpf)} • ${esc(formatPhone(cl.phone))}</div>
      <div class="text-[11px] mt-0.5">${clientStatusLine(cl)}</div>
    </button>`).join('');
  box.classList.remove('hidden');
}

function fillClient(cl) {
  const f = $('#loanForm');
  f.client_name.value = cl.client_name;
  f.cpf.value = cl.cpf;
  f.phone.value = formatPhone(cl.phone);
  f.address.value = cl.address;
  f.social_media.value = cl.social_media || '';
  hideClientSuggestions();
  const full = clientIndex().find(x => x.key === cl.key) || cl;
  const warn = full.atrasados > 0;
  const box = $('#clientSelected');
  box.innerHTML = `<div class="rounded-xl px-3 py-2 text-xs border ${warn ? 'bg-red-500/10 border-red-500/40 text-red-200' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'}">
    <i class="fa-solid ${warn ? 'fa-triangle-exclamation' : 'fa-circle-check'} mr-1"></i>
    Dados de cliente já cadastrado preenchidos. ${clientStatusLine(full) ? 'Situação: ' + clientStatusLine(full) + '.' : ''}
    ${warn ? '<br><b>Atenção:</b> este cliente tem contrato em atraso.' : ''}
    <span class="block text-[10px] text-slate-400 mt-0.5">Confira o telefone e o endereço, e altere se mudaram.</span></div>`;
  box.classList.remove('hidden');
  setTimeout(() => f.principal.focus(), 50);
}

$('#loanForm').client_name.addEventListener('input', e => { $('#clientSelected').classList.add('hidden'); showClientSuggestions(e.target.value); });
$('#loanForm').cpf.addEventListener('input', e => {
  const d = digitsOnly(e.target.value);
  if (d.length >= 3) showClientSuggestions(e.target.value);
});

$('#loanForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = formData(e.target);
  await withBusy(e.target.querySelector('[type=submit]'), async () => {
    try {
      const { contract } = await companyApi('POST', '/contracts', {
        ...f, cycle_days: Number(f.cycle_days), principal: Number(f.principal),
        rate: Number(f.rate), late_fee_rate: Number(f.late_fee_rate),
      });
      closeModal('loanModal');
      toast(`Contrato ${contract.code} registrado para ${contract.client_name}.`, 'success');
      refresh();
    } catch (err) { handleError(err); }
  });
});

// ===================== BAIXA MANUAL =====================
function openPayment(id) {
  const c = state.contracts.find(x => x.id === id);
  if (!c) return;
  state.paymentContract = c;
  $('#paymentSub').textContent = `${c.client_name} (${c.code})`;
  $('#paymentNotes').value = '';
  $('#payAmortizeAmount').value = '';
  $('#payDate').value = state.today;
  setPaymentDate(state.today);
  openModal('paymentModal');
}

// Calcula a dívida numa data (mesma regra do servidor): diárias contam até o dia do pagamento
function debtOn(c, iso) {
  const d = c.debt;
  const days = c.status === 'ATIVO' && !c.in_agreement
    ? Math.max(0, Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(c.due_date + 'T00:00:00Z')) / 864e5)) : 0;
  const lateFee = days * d.dailyFee;
  return { ...d, overdueDays: days, lateFee, totalToRollover: d.cycleInterest + lateFee, totalToSettle: d.initialTotal + lateFee };
}

function setPaymentDate(iso) {
  const c = state.paymentContract;
  const d = debtOn(c, iso);
  state.paymentDebt = d;
  const other = iso !== state.today;
  $('#paymentSummary').innerHTML = `
    ${other ? `<div class="text-[11px] text-amber-300 font-semibold pb-1"><i class="fa-regular fa-calendar mr-1"></i>Valores calculados para ${brDate(iso)}</div>` : ''}
    <div class="flex justify-between text-slate-400"><span>Principal:</span><span class="font-mono text-white">${money(d.principal)}</span></div>
    <div class="flex justify-between text-slate-400"><span>Juros do ciclo:</span><span class="font-mono text-emerald-400">${money(d.cycleInterest)}</span></div>
    <div class="flex justify-between text-slate-400"><span>Dias em atraso:</span><span class="font-mono text-amber-400 font-bold">${d.overdueDays} dias</span></div>
    <div class="flex justify-between text-slate-400"><span>Diárias (${c.late_fee_rate}%/dia):</span><span class="font-mono text-red-400 font-bold">${money(d.lateFee)}</span></div>
    <div class="pt-2 border-t border-slate-800 flex justify-between text-sm font-bold"><span class="text-white">Total para quitação:</span><span class="font-mono text-emerald-400">${money(d.totalToSettle)}</span></div>
    <div class="flex justify-between font-semibold text-slate-300"><span>Total para rolar (juros + diárias):</span><span class="font-mono text-teal-400">${money(d.totalToRollover)}</span></div>`;
  $('#payRolloverAmount').value = (d.totalToRollover / 100).toFixed(2);
  $('#paySettleAmount').value = (d.totalToSettle / 100).toFixed(2);
  $('#lateDiscountBox').classList.toggle('hidden', d.lateFee <= 0);
  applyLateDiscount(0);
  updatePaymentDiscounts();
  updateAmortizePreview();
}

// ----- Desconto nas diárias -----
function applyLateDiscount(cents, { fromInput = false } = {}) {
  const d = state.paymentDebt;
  if (!d) return;
  const disc = Math.max(0, Math.min(Math.round(cents), d.lateFee));
  state.lateDiscount = disc;
  $('#payRolloverAmount').value = ((d.totalToRollover - disc) / 100).toFixed(2);
  $('#paySettleAmount').value = ((d.totalToSettle - disc) / 100).toFixed(2);
  if (!fromInput) $('#lateDiscountValue').value = disc ? (disc / 100).toFixed(2) : '';
  const pct = d.lateFee ? Math.round(disc / d.lateFee * 100) : 0;
  $$('#lateDiscountBox .ld-btn').forEach(b => b.classList.toggle('active', !fromInput && Number(b.dataset.pct) === pct));
  $('#lateDiscountInfo').textContent = disc ? `Desconto: ${money(disc)} de ${money(d.lateFee)}` : `Diárias: ${money(d.lateFee)}`;
  updatePaymentDiscounts();
}
$('#lateDiscountValue').addEventListener('input', e => {
  const v = Math.round((Number(e.target.value) || 0) * 100);
  if (state.paymentDebt && v > state.paymentDebt.lateFee) toast(`O desconto não pode passar do valor das diárias (${money(state.paymentDebt.lateFee)}).`, 'warning');
  applyLateDiscount(v, { fromInput: true });
});

// ----- Quebrar juros: prévia de como ficam principal e juros -----
function updateAmortizePreview() {
  const c = state.paymentContract;
  if (!c) return;
  const v = Math.round((Number($('#payAmortizeAmount').value) || 0) * 100);
  const el = $('#payAmortizePreview');
  if (!v) { el.className = 'text-[11px] font-mono text-slate-400 min-h-[16px]'; el.textContent = 'O valor é abatido do principal; os juros diminuem. O vencimento não muda.'; return; }
  if (v >= c.principal_cents) { el.className = 'text-[11px] font-mono text-red-400 min-h-[16px]'; el.textContent = `Cobre todo o principal (${money(c.principal_cents)}): use "Quitar Contrato".`; return; }
  const np = c.principal_cents - v;
  const oi = Math.round(c.principal_cents * c.rate / 100);
  const ni = Math.round(np * c.rate / 100);
  el.className = 'text-[11px] font-mono text-sky-300 min-h-[16px]';
  el.textContent = `Principal: ${money(c.principal_cents)} → ${money(np)} • Juros do ciclo: ${money(oi)} → ${money(ni)}`;
}
$('#payAmortizeAmount').addEventListener('input', updateAmortizePreview);

async function doAmortize(button) {
  const c = state.paymentContract;
  if (!c) return;
  const v = Math.round((Number($('#payAmortizeAmount').value) || 0) * 100);
  if (!v) return toast('Informe o valor que o cliente antecipou.', 'warning');
  if (v >= c.principal_cents) return toast('Esse valor cobre todo o principal: use "Quitar Contrato".', 'warning');
  const paidOn = $('#payDate').value || state.today;
  const np = c.principal_cents - v;
  const msg = `Confirmar QUEBRA DE JUROS do contrato ${c.code}, recebendo ${money(v)}${paidOn !== state.today ? ` em ${brDate(paidOn)}` : ''}?\n\n` +
    `Principal: ${money(c.principal_cents)} → ${money(np)}\nJuros do ciclo: ${money(Math.round(c.principal_cents * c.rate / 100))} → ${money(Math.round(np * c.rate / 100))}\n` +
    `O vencimento (${brDate(c.due_date)}) não muda.` +
    (c.debt.overdueDays > 0 ? `\n\nAtenção: o contrato está em atraso; as diárias passam a ser calculadas sobre o novo principal.` : '') +
    paidOnWarning(paidOn, c.start_date);
  if (!confirm(msg)) return;
  await withBusy(button, async () => {
    try {
      await companyApi('POST', `/contracts/${c.id}/amortize`, {
        amount: v / 100, channel: $('input[name=paymentChannel]:checked').value, notes: $('#paymentNotes').value, paid_on: paidOn,
      });
      closeModal('paymentModal');
      toast(`Quebra de juros registrada. Novo principal: ${money(np)}.`, 'success');
      refresh();
    } catch (err) { handleError(err); }
  });
}

$('#payDate').addEventListener('change', e => {
  const c = state.paymentContract;
  let v = e.target.value;
  if (!v) return;
  setPaymentDate(v);
});

// Aviso (não bloqueia) quando a data do recebimento parece fora do comum
function paidOnWarning(iso, startDate) {
  if (iso > state.today) return `\n\nAtenção: a data do recebimento (${brDate(iso)}) é uma data FUTURA.`;
  if (startDate && iso < startDate) return `\n\nAtenção: a data do recebimento (${brDate(iso)}) é anterior à concessão do empréstimo (${brDate(startDate)}).`;
  return '';
}

const paymentAmountCents = kind => Math.round((Number($(kind === 'rollover' ? '#payRolloverAmount' : '#paySettleAmount').value) || 0) * 100);

// Mostra na hora o desconto (ou valor a mais) em relação ao valor cheio calculado
function updatePaymentDiscounts() {
  const c = state.paymentContract;
  if (!c) return;
  const d = state.paymentDebt || c.debt;
  [['rollover', d.totalToRollover, '#payRolloverDiscount'], ['settle', d.totalToSettle, '#paySettleDiscount']].forEach(([kind, full, sel]) => {
    const paid = paymentAmountCents(kind);
    const el = $(sel);
    if (!paid) { el.className = 'text-[11px] font-mono min-h-[16px] text-red-400'; el.textContent = 'Informe o valor recebido.'; return; }
    const diff = full - paid;
    if (diff > 0) { el.className = 'text-[11px] font-mono min-h-[16px] text-amber-300'; el.textContent = `Desconto: ${money(diff)} (cheio: ${money(full)})`; }
    else if (diff < 0) { el.className = 'text-[11px] font-mono min-h-[16px] text-sky-300'; el.textContent = `${money(-diff)} a mais que o calculado`; }
    else { el.className = 'text-[11px] font-mono min-h-[16px] text-slate-500'; el.textContent = 'Valor cheio, sem desconto'; }
  });
}
$('#payRolloverAmount').addEventListener('input', updatePaymentDiscounts);
$('#paySettleAmount').addEventListener('input', updatePaymentDiscounts);

async function doPayment(kind, button) {
  const c = state.paymentContract;
  if (!c) return;
  const d = state.paymentDebt || c.debt;
  const full = kind === 'rollover' ? d.totalToRollover : d.totalToSettle;
  const paidOn = $('#payDate').value || state.today;
  const value = paymentAmountCents(kind);
  if (value <= 0) return toast('Informe o valor recebido.', 'warning');
  const diff = full - value;
  const question = (kind === 'rollover'
    ? `Confirmar ROLAGEM do contrato ${c.code}, recebendo ${money(value)}${paidOn !== state.today ? ` em ${brDate(paidOn)}` : ''}?`
    : `Confirmar QUITAÇÃO do contrato ${c.code}, recebendo ${money(value)}${paidOn !== state.today ? ` em ${brDate(paidOn)}` : ''}?`) +
    (diff > 0 ? `\n\nDesconto concedido: ${money(diff)} (valor cheio: ${money(full)}).` : '') +
    (diff < 0 ? `\n\nAtenção: ${money(-diff)} a mais que o valor calculado (${money(full)}).` : '');
  if (!confirm(question + paidOnWarning(paidOn, c.start_date))) return;
  await withBusy(button, async () => {
    try {
      const body = { channel: $('input[name=paymentChannel]:checked').value, notes: [state.lateDiscount && value === full - state.lateDiscount ? `Desconto nas diárias: ${money(state.lateDiscount)}` : '', $('#paymentNotes').value.trim()].filter(Boolean).join(' • '), amount: value / 100, paid_on: paidOn };
      const r = await companyApi('POST', `/contracts/${c.id}/${kind === 'rollover' ? 'rollover' : 'settle'}`, body);
      closeModal('paymentModal');
      toast(kind === 'rollover' ? `Rolagem registrada. Novo vencimento: ${brDate(r.new_due_date)}.` : `Contrato ${c.code} quitado.`, 'success');
      refresh();
    } catch (err) { handleError(err); }
  });
}

// ===================== ACORDO =====================
const agreementState = { contract: null, rows: [], renegotiation: false };

function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function addMonths(iso, months, anchorDay) {
  const [y, m] = iso.split('-').map(Number);
  const total = (m - 1) + months;
  const year = y + Math.floor(total / 12);
  const month = (total % 12 + 12) % 12 + 1;
  const day = Math.min(anchorDay, lastDayOfMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const toCents = v => Math.round((Number(String(v).replace(',', '.')) || 0) * 100);
const centsToInput = c => (c / 100).toFixed(2);

function agreementInterval() {
  const f = $('#agreementForm');
  if (f.interval.value === 'CUSTOM') return Math.max(1, Number(f.custom_days.value) || 1);
  return f.interval.value === 'MENSAL' ? 'MENSAL' : Number(f.interval.value);
}

// Gera as parcelas a partir do total, quantidade, 1ª data e intervalo (a diferença de centavos vai para a última)
function generateInstallments() {
  const f = $('#agreementForm');
  const total = toCents(f.total.value);
  const count = Math.min(120, Math.max(1, Number(f.count.value) || 1));
  const first = f.first_date.value || state.today;
  const interval = agreementInterval();
  const base = Math.floor(total / count);
  const anchor = Number(first.slice(8, 10));
  agreementState.rows = Array.from({ length: count }, (_, i) => ({
    due_date: interval === 'MENSAL' ? addMonths(first, i, anchor) : addDays(first, i * interval),
    amount_cents: i === count - 1 ? total - base * (count - 1) : base,
  }));
  renderInstallmentsEditor();
}

function renderInstallmentsEditor() {
  const rows = agreementState.rows;
  $('#installmentsEditor').innerHTML = rows.map((r, i) => `
    <tr class="border-b border-slate-800/60">
      <td class="p-2 font-mono text-slate-400">${i + 1}</td>
      <td class="p-1.5"><input type="date" data-inst-date="${i}" value="${esc(r.due_date)}" class="field-input py-1 font-mono"></td>
      <td class="p-1.5"><input type="number" step="0.01" min="0.01" data-inst-amount="${i}" value="${centsToInput(r.amount_cents)}" class="field-input py-1 font-mono"></td>
      <td class="p-1.5 text-center">${rows.length > 1 ? `<button type="button" data-action="remove-installment" data-id="${i}" class="text-slate-500 hover:text-red-400" title="Remover"><i class="fa-solid fa-trash"></i></button>` : ''}</td>
    </tr>`).join('');
  updateInstallmentsSum();
}

function updateInstallmentsSum() {
  const total = toCents($('#agreementForm').total.value);
  const sum = agreementState.rows.reduce((t, r) => t + r.amount_cents, 0);
  const diff = total - sum;
  const el = $('#installmentsSum');
  el.className = `text-[11px] font-mono text-right ${diff === 0 ? 'text-emerald-400' : 'text-red-400'}`;
  el.textContent = diff === 0
    ? `Soma das parcelas: ${money(sum)} ✓`
    : `Soma das parcelas: ${money(sum)} — ${diff > 0 ? 'faltam' : 'sobram'} ${money(Math.abs(diff))} para fechar ${money(total)}`;
}

function openAgreementModal(contract, renegotiation) {
  agreementState.contract = contract;
  agreementState.renegotiation = renegotiation;
  const f = $('#agreementForm');
  f.reset();
  const a = contract.agreement;
  const reference = renegotiation && a ? a.remaining_cents : contract.debt.totalToSettle;
  $('#agreementTitle').innerHTML = `<i class="fa-solid fa-handshake text-amber-400 mr-2"></i>${renegotiation ? 'Renegociar acordo' : 'Novo acordo de pagamento'}`;
  $('#agreementSub').textContent = `${contract.client_name} (${contract.code})`;
  $('#agreementDebtInfo').innerHTML = renegotiation && a ? `
      <div><span class="text-slate-400 text-[11px] block">Acordo atual</span><strong class="font-mono text-white">${money(a.total_cents)}</strong></div>
      <div><span class="text-slate-400 text-[11px] block">Já recebido</span><strong class="font-mono text-emerald-400">${money(a.paid_cents)}</strong></div>
      <div><span class="text-slate-400 text-[11px] block">Saldo a renegociar</span><strong class="font-mono text-amber-400">${money(a.remaining_cents)}</strong></div>`
    : `
      <div><span class="text-slate-400 text-[11px] block">Principal + juros</span><strong class="font-mono text-white">${money(contract.debt.initialTotal)}</strong></div>
      <div><span class="text-slate-400 text-[11px] block">Diárias (${contract.debt.overdueDays} dias)</span><strong class="font-mono text-red-400">${money(contract.debt.lateFee)}</strong></div>
      <div><span class="text-slate-400 text-[11px] block">Dívida total hoje</span><strong class="font-mono text-amber-400">${money(contract.debt.totalToSettle)}</strong></div>`;
  f.total.value = centsToInput(reference);
  f.count.value = 3;
  f.first_date.value = state.today;
  f.interval.value = 'MENSAL';
  $('#customDaysBox').classList.add('hidden');
  generateInstallments();
  closeModal('paymentModal');
  openModal('agreementModal');
}

// Mudanças nos campos que definem o parcelamento regeneram as parcelas
$('#agreementForm').addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.instDate !== undefined) { agreementState.rows[Number(t.dataset.instDate)].due_date = t.value; return; }
  if (t.dataset.instAmount !== undefined) { agreementState.rows[Number(t.dataset.instAmount)].amount_cents = toCents(t.value); return updateInstallmentsSum(); }
  if (['total', 'count', 'first_date', 'custom_days'].includes(t.name)) generateInstallments();
});
$('#agreementForm').interval.addEventListener('change', e => {
  $('#customDaysBox').classList.toggle('hidden', e.target.value !== 'CUSTOM');
  generateInstallments();
});

$('#agreementForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const c = agreementState.contract;
  const total = toCents(f.total.value);
  const rows = agreementState.rows;
  if (rows.some(r => !r.due_date || r.amount_cents <= 0)) return toast('Confira as datas e valores de todas as parcelas.', 'warning');
  if (rows.reduce((t, r) => t + r.amount_cents, 0) !== total) return toast('A soma das parcelas precisa ser igual ao valor acordado.', 'warning');
  const msg = `${agreementState.renegotiation ? 'Renegociar' : 'Gravar acordo'} para ${c.client_name}: ${money(total)} em ${rows.length} parcela${rows.length > 1 ? 's' : ''}?` +
    (agreementState.renegotiation ? '\n\nO acordo atual será substituído por este.' : '\n\nO contrato para de acumular diárias.');
  if (!confirm(msg)) return;
  await withBusy(f.querySelector('[type=submit]'), async () => {
    try {
      await companyApi('POST', `/contracts/${c.id}/agreement`, {
        total: total / 100,
        installments: rows.map(r => ({ due_date: r.due_date, amount: r.amount_cents / 100 })),
        notes: f.notes.value.trim(),
      });
      closeModal('agreementModal');
      toast(agreementState.renegotiation ? 'Acordo renegociado.' : 'Acordo gravado.', 'success');
      await refresh();
      openDossier(c.id);
    } catch (err) { handleError(err); }
  });
});

// Receber parcela
const installmentPayState = { agreementId: null, installmentId: null };
function openInstallmentPay(agreementId, installmentId) {
  const c = state.dossierContract;
  const inst = c && c.agreement && c.agreement.installments.find(i => i.id === installmentId);
  if (!inst) return;
  installmentPayState.agreementId = agreementId;
  installmentPayState.installmentId = installmentId;
  const f = $('#installmentPayForm');
  f.reset();
  f.amount.value = centsToInput(inst.amount_cents);
  f.paid_on.value = state.today;
  $('#installmentPaySub').textContent = `${c.client_name} — parcela ${inst.number}/${c.agreement.installments_count}, vencimento ${brDate(inst.due_date)}`;
  openModal('installmentPayModal');
}

$('#installmentPayForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = formData(e.target);
  const warn = paidOnWarning(f.paid_on, state.dossierContract && state.dossierContract.start_date);
  if (warn && !confirm('Confirmar o recebimento desta parcela?' + warn)) return;
  await withBusy(e.target.querySelector('[type=submit]'), async () => {
    try {
      const r = await companyApi('POST', `/agreements/${installmentPayState.agreementId}/installments/${installmentPayState.installmentId}/pay`,
        { amount: Number(f.amount), channel: f.channel, notes: f.notes, paid_on: f.paid_on });
      closeModal('installmentPayModal');
      toast(r.concluded ? 'Última parcela recebida: acordo concluído e contrato quitado!' : 'Parcela recebida.', 'success');
      await refresh();
      openDossier(state.dossierContractId);
    } catch (err) { handleError(err); }
  });
});

async function cancelAgreement(agreementId) {
  if (!confirm('Cancelar este acordo? O contrato volta às condições originais e as diárias voltam a contar desde o vencimento.')) return;
  try {
    await companyApi('POST', `/agreements/${agreementId}/cancel`, {});
    toast('Acordo cancelado.', 'info');
    await refresh();
    openDossier(state.dossierContractId);
  } catch (err) { handleError(err); }
}

// ===================== DOSSIÊ =====================
async function openDossier(id) {
  state.dossierContractId = id;
  try {
    const { contract: c, occurrences, agreements_history: history } = await companyApi('GET', `/contracts/${id}`);
    state.dossierContract = c;
    $('#dossierName').textContent = c.client_name;
    $('#dossierCode').textContent = c.code;
    $('#dossierInfo').innerHTML = `
      <div><span class="text-slate-500 text-[10px] uppercase font-bold block">CPF</span><span class="text-slate-200 font-mono font-semibold">${esc(c.cpf)}</span></div>
      <div><span class="text-slate-500 text-[10px] uppercase font-bold block">Telefone / WhatsApp</span>
        <span class="text-emerald-400 font-mono font-bold">${esc(formatPhone(c.phone))}</span>
        <button data-action="copy-phone" data-phone="${esc(c.phone)}" class="text-slate-400 hover:text-white text-xs ml-1" title="Copiar"><i class="fa-regular fa-copy"></i></button>
        <a href="${esc(whatsappLink(c.phone))}" target="_blank" rel="noopener" class="text-emerald-400 hover:text-emerald-300 ml-1" title="WhatsApp"><i class="fa-brands fa-whatsapp"></i></a></div>
      <div><span class="text-slate-500 text-[10px] uppercase font-bold block">Endereço</span><span class="text-slate-300"><i class="fa-solid fa-location-dot text-rose-400 mr-1"></i>${esc(c.address)}</span></div>
      <div><span class="text-slate-500 text-[10px] uppercase font-bold block">Rede social</span><span class="text-blue-400">${esc(c.social_media || 'Não informada')}</span></div>
      <div class="sm:col-span-2 pt-1 flex flex-col sm:flex-row gap-2">
        <button data-action="loan-for-client" class="w-full sm:w-auto theme-accent-bg font-bold px-4 py-2.5 rounded-xl text-xs"><i class="fa-solid fa-plus mr-1"></i>Novo empréstimo para este cliente</button>
        ${isAdmin() ? '<button data-action="edit-contract" class="w-full sm:w-auto bg-slate-800 hover:bg-slate-700 text-white font-bold px-4 py-2.5 rounded-xl text-xs border border-slate-700"><i class="fa-solid fa-pen-to-square mr-1"></i>Editar contrato</button>' : ''}
      </div>`;
    $('#dossierDebt').innerHTML = `
      <div><span class="text-slate-400 text-[11px]">Principal / taxa</span><div class="font-mono font-bold text-white">${money(c.principal_cents)} (${c.rate}% / ${c.cycle_days}d)</div></div>
      <div><span class="text-slate-400 text-[11px]">Situação</span><div class="mt-0.5">${statusBadge(c)}</div></div>
      <div><span class="text-slate-400 text-[11px]">Vencimento</span><div class="font-mono font-bold text-slate-300">${c.status === 'QUITADO' ? 'Quitado em ' + brDate(c.settled_at) : (c.in_agreement ? 'Em acordo' : brDate(c.due_date))}</div></div>
      <div><span class="text-slate-400 text-[11px]">${c.in_agreement ? 'Saldo do acordo' : 'Total p/ quitar'}</span><div class="font-mono font-bold ${c.in_agreement ? 'text-amber-400' : 'text-emerald-400'}">${c.status === 'QUITADO' ? '—' : money(c.in_agreement && c.agreement ? c.agreement.remaining_cents : c.debt.totalToSettle)}</div></div>`;
    renderDossierAgreement(c, history || []);
    $('#dossierDanger').classList.toggle('hidden', !isManager());
    $('#occurrenceInput').value = '';
    $('#occurrencesList').innerHTML = occurrences.length ? occurrences.map(o => {
      const color = o.author_role === 'SISTEMA' ? 'bg-slate-700 text-slate-300' : (o.author_role === 'OPERADOR' ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400');
      return `<div class="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1 text-xs">
        <div class="flex items-center gap-1.5 text-[10px] text-slate-500">
          <span class="font-mono text-slate-400 font-semibold">${esc(brDateTime(o.created_at))}</span><span>•</span>
          <span class="px-1.5 py-0.5 rounded text-[9px] font-bold ${color}">${esc(o.author_role === 'SISTEMA' ? 'SISTEMA' : o.author_name)}</span>
        </div>
        <p class="text-slate-200 whitespace-pre-wrap leading-relaxed">${esc(o.text)}</p></div>`;
    }).join('') : '<div class="p-4 rounded-xl bg-slate-950/60 border border-slate-800 text-center text-slate-500 text-xs">Nenhuma ocorrência registrada.</div>';
    openModal('dossierModal');
  } catch (err) { handleError(err); }
}

function renderDossierAgreement(c, history) {
  const box = $('#dossierAgreement');
  const a = c.agreement;
  const past = history.filter(h => !a || h.id !== a.id);
  if (!a && !past.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const statusLabel = { ATIVO: 'Ativo', CONCLUIDO: 'Concluído', CANCELADO: 'Cancelado / substituído' };
  let html = '';
  if (a) {
    const canCancel = isManager() && a.paid_count === 0 && !a.renegotiated;
    html += `
      <div class="bg-amber-500/5 border border-amber-500/30 rounded-xl p-4 space-y-3 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="font-bold text-amber-300 uppercase tracking-wider"><i class="fa-solid fa-handshake mr-1"></i>Acordo ${a.renegotiated ? '(renegociado)' : ''} — firmado em ${esc(brDateTime(a.created_at).split(' às')[0])}</h4>
          ${isManager() ? `<div class="flex gap-2">
            <button data-action="renegotiate" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold"><i class="fa-solid fa-rotate mr-1"></i>Renegociar</button>
            ${canCancel ? `<button data-action="cancel-agreement" data-id="${a.id}" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-red-500/20 text-slate-400 hover:text-red-300 font-semibold"><i class="fa-solid fa-ban mr-1"></i>Cancelar acordo</button>` : ''}
          </div>` : ''}
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div><span class="text-slate-400 text-[11px]">Valor acordado</span><div class="font-mono font-bold text-white">${money(a.total_cents)}</div></div>
          <div><span class="text-slate-400 text-[11px]">Recebido</span><div class="font-mono font-bold text-emerald-400">${money(a.paid_cents)} (${a.paid_count}/${a.installments_count})</div></div>
          <div><span class="text-slate-400 text-[11px]">Falta receber</span><div class="font-mono font-bold text-amber-400">${money(a.remaining_cents)}</div></div>
          <div><span class="text-slate-400 text-[11px]">Dívida de referência / desconto</span><div class="font-mono font-bold text-slate-300">${money(a.debt_at_agreement_cents)}${a.discount_cents ? ` <span class="text-rose-300">(-${money(a.discount_cents)})</span>` : ''}</div></div>
        </div>
        ${a.notes ? `<div class="bg-slate-950/70 border border-slate-800 rounded-lg p-2.5 text-slate-300 whitespace-pre-wrap"><span class="text-slate-500 text-[10px] uppercase font-bold block mb-0.5">Condições</span>${esc(a.notes)}</div>` : ''}
        <table class="w-full text-xs">
          <thead><tr class="text-slate-400 border-b border-slate-800"><th class="py-1.5 text-left">Parcela</th><th class="text-left">Vencimento</th><th class="text-left">Valor</th><th class="text-left">Situação</th><th></th></tr></thead>
          <tbody class="divide-y divide-slate-800/60">
            ${a.installments.map(i => {
              const paid = i.status === 'PAGO';
              const late = !paid && i.overdue_days > 0;
              const sit = paid
                ? `<span class="text-emerald-400 font-semibold"><i class="fa-solid fa-circle-check mr-1"></i>Pago em ${brDate(i.paid_at)} (${money(i.paid_cents)})</span>`
                : (late ? `<span class="text-red-400 font-semibold">${i.overdue_days}d em atraso</span>` : '<span class="text-slate-400">A vencer</span>');
              return `<tr class="${late ? 'bg-red-500/5' : ''}">
                <td class="py-1.5 font-mono">${i.number}/${a.installments_count}</td>
                <td class="font-mono ${late ? 'text-red-400 font-bold' : 'text-slate-300'}">${brDate(i.due_date)}</td>
                <td class="font-mono text-white">${money(i.amount_cents)}</td>
                <td>${sit}</td>
                <td class="text-right">${!paid && isManager() ? `<button data-action="pay-installment" data-agreement="${a.id}" data-id="${i.id}" class="px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold">Receber</button>` : ''}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }
  if (past.length) {
    html += `<div class="text-[11px] text-slate-500 mt-2 space-y-0.5"><span class="font-bold uppercase">Acordos anteriores:</span>
      ${past.map(h => `<div>• ${esc(brDateTime(h.created_at).split(' às')[0])}: ${money(h.total_cents)} — ${statusLabel[h.status]}${h.closed_at ? ` em ${brDate(h.closed_at)}` : ''}</div>`).join('')}</div>`;
  }
  box.innerHTML = html;
  box.classList.remove('hidden');
}

function openContractEdit() {
  const c = state.dossierContract;
  if (!c) return;
  const f = $('#contractEditForm');
  f.reset();
  $('#contractEditSub').textContent = `${c.code} — ${c.client_name}`;
  f.client_name.value = c.client_name;
  f.cpf.value = c.cpf;
  f.phone.value = formatPhone(c.phone);
  f.address.value = c.address;
  f.social_media.value = c.social_media || '';
  f.principal.value = (c.principal_cents / 100).toFixed(2);
  f.rate.value = c.rate;
  f.late_fee_rate.value = c.late_fee_rate;
  f.cycle_days.value = c.cycle_days;
  f.start_date.value = c.start_date;
  f.due_date.value = c.due_date;
  const locked = c.status !== 'ATIVO' ? 'Contrato quitado: as condições do empréstimo não podem mais ser alteradas.'
    : (c.in_agreement ? 'Contrato em acordo: as condições ficam por conta do acordo. Para mudar valores, use "Renegociar" na ficha.' : '');
  $('#contractEditFinancial').disabled = !!locked;
  $('#contractEditFinancial').classList.toggle('opacity-40', !!locked);
  $('#contractEditLocked').textContent = locked;
  $('#contractEditLocked').classList.toggle('hidden', !locked);
  openModal('contractEditModal');
}

$('#contractEditForm').addEventListener('submit', async e => {
  e.preventDefault();
  const c = state.dossierContract;
  const f = e.target;
  const body = {
    client_name: f.client_name.value.trim(), cpf: f.cpf.value.trim(), phone: f.phone.value.trim(),
    address: f.address.value.trim(), social_media: f.social_media.value.trim(),
  };
  if (!$('#contractEditFinancial').disabled) {
    Object.assign(body, {
      principal: Number(f.principal.value), rate: Number(f.rate.value), late_fee_rate: Number(f.late_fee_rate.value),
      cycle_days: Number(f.cycle_days.value), start_date: f.start_date.value, due_date: f.due_date.value,
    });
  }
  await withBusy(f.querySelector('[type=submit]'), async () => {
    try {
      const r = await companyApi('PUT', `/contracts/${c.id}`, body);
      closeModal('contractEditModal');
      toast(r.changed ? 'Contrato atualizado. A alteração ficou registrada no histórico.' : 'Nada foi alterado.', r.changed ? 'success' : 'info');
      await refresh();
      openDossier(c.id);
    } catch (err) { handleError(err); }
  });
});

async function deleteContract(button) {
  const c = state.dossierContract;
  if (!c) return;
  const reason = prompt(`Excluir o contrato ${c.code} de ${c.client_name}?\n\nEssa ação não pode ser desfeita. Informe o motivo da exclusão:`);
  if (reason === null) return;
  if (!reason.trim()) return toast('Informe o motivo para excluir.', 'warning');
  if (!confirm(`Confirma a EXCLUSÃO do contrato ${c.code} (${c.client_name})?`)) return;
  await withBusy(button, async () => {
    try {
      await companyApi('DELETE', `/contracts/${c.id}`, { reason: reason.trim() });
      closeModal('dossierModal');
      toast(`Contrato ${c.code} excluído.`, 'success');
      refresh();
    } catch (err) { handleError(err); }
  });
}

async function addOccurrence(button) {
  const text = $('#occurrenceInput').value.trim();
  if (!text) return toast('Digite o texto da ocorrência.', 'warning');
  await withBusy(button, async () => {
    try {
      await companyApi('POST', `/contracts/${state.dossierContractId}/occurrences`, { text });
      toast('Ocorrência gravada.', 'success');
      openDossier(state.dossierContractId);
    } catch (err) { handleError(err); }
  });
}

// ===================== RELATÓRIO =====================
async function openReport() {
  if (!state.activeCompanyId) return;
  try {
    const r = await companyApi('GET', '/report/overdue');
    const comp = activeCompany();
    $('#reportSub').textContent = `${comp.official_name} — posição em ${brDate(r.today)}`;
    $('#repTotal').textContent = `${r.contracts.length} clientes`;
    $('#repDiarias').textContent = money(r.total_diarias_cents);
    $('#repRisco').textContent = money(r.total_em_risco_cents);
    $('#reportTableBody').innerHTML = r.contracts.length ? r.contracts.map(c => `
      <tr class="text-slate-300">
        <td class="p-2"><strong class="text-white">${esc(c.client_name)}</strong><br><span class="text-slate-500">${esc(c.code)} - ${esc(c.cpf)}</span></td>
        <td class="p-2">${esc(formatPhone(c.phone))}</td>
        <td class="p-2 text-red-400 font-bold">${brDate(c.due_date)}</td>
        <td class="p-2 text-amber-400 font-bold">${c.debt.overdueDays} dias</td>
        <td class="p-2 text-amber-400">${money(c.debt.lateFee)}</td>
        <td class="p-2 text-emerald-400 font-bold">${money(c.debt.totalToSettle)}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="p-6 text-center text-slate-500">Nenhum contrato em atraso.</td></tr>';
    const ai = r.agreement_installments || [];
    $('#reportAgreementsBox').classList.toggle('hidden', !ai.length);
    $('#repAcordoTotal').textContent = money(r.total_parcelas_atrasadas_cents || 0);
    $('#reportAgreementsBody').innerHTML = ai.map(x => `
      <tr class="text-slate-300">
        <td class="p-2"><strong class="text-white">${esc(x.client_name)}</strong><br><span class="text-slate-500">${esc(x.code)} - ${esc(x.cpf)}</span></td>
        <td class="p-2">${esc(formatPhone(x.phone))}</td>
        <td class="p-2">${x.number}/${x.of}</td>
        <td class="p-2 text-red-400 font-bold">${brDate(x.due_date)}</td>
        <td class="p-2 text-amber-400 font-bold">${x.overdue_days} dias</td>
        <td class="p-2 text-emerald-400 font-bold">${money(x.amount_cents)}</td>
      </tr>`).join('');
    openModal('reportModal');
  } catch (err) { handleError(err); }
}

// ===================== CONCILIAÇÃO =====================
async function loadBank() {
  state.bank = await companyApi('GET', '/bank');
  const t = state.bank.totals;
  $('#ofxEntradas').textContent = money(t.entradas_cents);
  $('#ofxSaidas').textContent = money(t.saidas_cents);
  $('#ofxLiquido').textContent = money(t.liquido_cents);
  $('#ofxLiquido').className = t.liquido_cents >= 0 ? 'text-emerald-400' : 'text-rose-400';
  $('#ofxPendentes').textContent = `${t.pendentes} pendentes`;
  const badge = $('#pendingOfxBadge');
  badge.textContent = `${t.pendentes} OFX`;
  badge.classList.toggle('hidden', t.pendentes === 0);
  renderBank();
}

function renderBank() {
  const tbody = $('#bankTableBody');
  const { transactions, active_contracts } = state.bank;
  if (!transactions.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-10 text-slate-500"><i class="fa-solid fa-file-arrow-up text-3xl mb-2 block text-slate-600"></i>Nenhum extrato importado nesta empresa.</td></tr>`;
    return;
  }
  tbody.innerHTML = transactions.map(tx => {
    const credit = tx.amount_cents > 0;
    const done = tx.status === 'CONCILIADO';
    const actions = credit ? ['ROLAR', 'QUITAR', 'AMORTIZACAO', 'PARCELA_ACORDO', 'OUTRA_ENTRADA'] : ['DESEMBOLSO', 'DESPESA'];

    let contractCell;
    if (done) {
      contractCell = tx.contract ? `<div class="font-bold text-slate-200">${esc(tx.contract.client_name)}</div><div class="text-[11px] text-slate-400 font-mono">${esc(tx.contract.code)}</div>`
        : '<span class="text-[11px] text-slate-500">—</span>';
    } else {
      const opts = active_contracts.map(c => `<option value="${c.id}" ${c.id === tx.contract_id ? 'selected' : ''}>${esc(c.code)} - ${esc(c.client_name)}${c.in_agreement ? ' (acordo)' : ''}</option>`).join('');
      contractCell = `<select data-tx-contract="${tx.id}" class="field-input py-1 text-xs max-w-[220px]"><option value="">Sem vínculo</option>${opts}</select>`;
      if (tx.contract && tx.contract.status === 'ATIVO' && tx.contract.in_agreement) {
        const ni = tx.contract.next_installment;
        contractCell += `<div class="text-[10px] text-amber-300/80 mt-1 font-mono">${ni ? `Próx. parcela ${ni.number}: ${money(ni.amount_cents)} (${brDate(ni.due_date)})` : 'Acordo sem parcelas pendentes'}</div>`;
      } else if (tx.contract && tx.contract.status === 'ATIVO') {
        const d = tx.contract.debt;
        contractCell += `<div class="text-[10px] text-slate-500 mt-1 font-mono">Rolar: ${money(d.totalToRollover)} • Quitar: ${money(d.totalToSettle)}</div>`;
      }
    }

    const actionCell = done
      ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-800 text-slate-300">${esc(ACTION_LABELS[tx.action] || tx.action)}</span>`
      : `<select data-tx-action="${tx.id}" class="field-input py-1 text-xs max-w-[200px]"><option value="">Escolha...</option>${actions.map(a => `<option value="${a}" ${a === tx.action ? 'selected' : ''}>${ACTION_LABELS[a]}</option>`).join('')}</select>`;

    return `<tr class="hover:bg-slate-800/40 ${done ? 'opacity-50' : ''}">
      <td class="py-3 px-4 font-mono text-slate-300">${brDate(tx.date)}</td>
      <td class="py-3 px-4"><div class="font-bold text-white">${esc(tx.description)}</div><div class="text-[10px] text-slate-500 font-mono">ID: ${esc(tx.fitid)}</div></td>
      <td class="py-3 px-4 font-mono font-bold text-sm whitespace-nowrap ${credit ? 'text-emerald-400' : 'text-rose-400'}">${credit ? '+' : ''}${money(tx.amount_cents)}</td>
      <td class="py-3 px-4">${contractCell}</td>
      <td class="py-3 px-4">${actionCell}</td>
      <td class="py-3 px-4 text-center">${done
        ? '<span class="text-emerald-400 font-bold text-[11px]"><i class="fa-solid fa-circle-check mr-1"></i>Validado</span>'
        : `<div class="flex items-center justify-center gap-1.5">
            <button data-action="validate-tx" data-id="${tx.id}" class="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold"><i class="fa-solid fa-check mr-1"></i>Validar</button>
            <button data-action="discard-tx" data-id="${tx.id}" title="Descartar" class="bg-slate-800 hover:bg-red-500/20 text-slate-400 hover:text-red-300 px-2 py-1.5 rounded-lg text-xs border border-slate-700"><i class="fa-solid fa-trash"></i></button>
          </div>`}</td>
    </tr>`;
  }).join('');
}

$('#ofxFileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 2_500_000) return toast('Arquivo muito grande (máx. 2,5 MB).', 'warning');
  try {
    // Extratos de bancos brasileiros costumam vir em ISO-8859-1
    const buf = await file.arrayBuffer();
    let content = new TextDecoder('utf-8').decode(buf);
    if (content.includes('�') || /CHARSET:\s*1252|ENCODING:\s*USASCII/i.test(content)) {
      content = new TextDecoder('windows-1252').decode(buf);
    }
    const r = await companyApi('POST', '/bank/import', { content });
    toast(`${r.imported} movimentações importadas${r.duplicates ? ` (${r.duplicates} já existiam)` : ''}.`, 'success');
    await loadBank();
  } catch (err) { handleError(err); }
});

async function validateTx(id, button) {
  const tx = state.bank.transactions.find(t => t.id === id);
  const action = $(`[data-tx-action="${id}"]`).value;
  const contractId = Number($(`[data-tx-contract="${id}"]`).value) || null;
  if (!action) return toast('Escolha a natureza da transação.', 'warning');
  if ((action === 'ROLAR' || action === 'QUITAR' || action === 'PARCELA_ACORDO' || action === 'AMORTIZACAO') && !contractId) return toast('Vincule um contrato.', 'warning');
  if (action === 'PARCELA_ACORDO') {
    const c = state.contracts.find(x => x.id === contractId);
    const ni = c && c.agreement && c.agreement.next_installment;
    if (ni && Math.abs(ni.amount_cents - tx.amount_cents) > 5) {
      const ok = confirm(`Atenção: o valor recebido (${money(tx.amount_cents)}) é diferente da próxima parcela do acordo (${money(ni.amount_cents)}).\n\nDeseja registrar mesmo assim?`);
      if (!ok) return;
    }
  }

  if (contractId && (action === 'ROLAR' || action === 'QUITAR')) {
    const c = state.contracts.find(x => x.id === contractId);
    const expected = c ? (action === 'ROLAR' ? c.debt.totalToRollover : c.debt.totalToSettle) : tx.amount_cents;
    if (Math.abs(expected - tx.amount_cents) > 5) {
      const ok = confirm(`Atenção: o valor recebido (${money(tx.amount_cents)}) é diferente do esperado para ${action === 'ROLAR' ? 'rolagem' : 'quitação'} (${money(expected)}).\n\nDeseja validar mesmo assim?`);
      if (!ok) return;
    }
  }
  await withBusy(button, async () => {
    try {
      const r = await companyApi('POST', `/bank/${id}/validate`, { action, contract_id: contractId });
      toast(r.message, 'success');
      refresh();
    } catch (err) { handleError(err); }
  });
}

async function discardTx(id) {
  if (!confirm('Descartar esta transação do extrato? (Ela poderá ser importada novamente.)')) return;
  try {
    await companyApi('DELETE', `/bank/${id}`, {});
    await loadBank();
  } catch (err) { handleError(err); }
}

// ===================== EMPRESAS (ADMIN) =====================
function renderCompaniesList() {
  $('#companiesLimitText').textContent = `${state.companies.length} de ${state.maxCompanies} empresas cadastradas`;
  $('#newCompanyBtn').classList.toggle('hidden', state.companies.length >= state.maxCompanies);
  $('#companiesList').innerHTML = state.companies.map(c => {
    const t = COLOR_THEMES[c.color_theme] || COLOR_THEMES.amber;
    return `<div class="p-4 rounded-xl border border-slate-800 bg-slate-950/70 flex items-center justify-between gap-3">
      <div class="flex items-center gap-3 min-w-0">
        <span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${t.hex}"></span>
        <div class="min-w-0"><div class="font-bold text-white text-xs truncate">${esc(c.official_name)}</div>
          <div class="text-[11px] text-slate-400">${esc(c.short_name)} • Código: <span class="font-mono">${esc(c.code_prefix)}</span>${c.cnpj ? ' • ' + esc(c.cnpj) : ''}</div></div>
      </div>
      <button data-action="edit-company" data-id="${c.id}" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-semibold"><i class="fa-solid fa-pen text-[10px] mr-1"></i>Editar</button>
    </div>`;
  }).join('');
}

let companyColor = 'amber';
function openCompanyForm(company) {
  if (!company && state.companies.length >= state.maxCompanies) {
    return toast(`Limite de ${state.maxCompanies} empresas atingido.`, 'warning');
  }
  $('#companyDropdownMenu').classList.add('hidden');
  const form = $('#companyForm');
  form.reset();
  form.record_id.value = company ? company.id : '';
  $('#companyModalTitle').textContent = company ? 'Editar empresa' : 'Cadastrar nova empresa';
  ['official_name', 'short_name', 'cnpj', 'tagline'].forEach(k => { form[k].value = company ? company[k] : ''; });
  form.logo_url.value = company && !company.logo_url.startsWith('data:') ? company.logo_url : '';
  form.dataset.logoData = company && company.logo_url.startsWith('data:') ? company.logo_url : '';
  companyColor = company ? company.color_theme : 'amber';
  renderColorPicker($('[data-color-picker=company]'), companyColor, k => { companyColor = k; });
  updateLogoPreview();
  openModal('companyModal');
}

function currentLogoValue() {
  const form = $('#companyForm');
  return form.logo_url.value.trim() || form.dataset.logoData || '';
}

function updateLogoPreview() {
  const box = $('#logoPreview');
  const url = currentLogoValue();
  box.innerHTML = '';
  if (!url) { box.textContent = 'LOGO'; return; }
  const img = document.createElement('img');
  img.className = 'w-full h-full object-cover';
  img.onerror = () => { box.textContent = 'ERRO'; };
  img.src = url;
  box.appendChild(img);
}

$('#companyForm').logo_url.addEventListener('input', () => { $('#companyForm').dataset.logoData = ''; updateLogoPreview(); });
$('#logoFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 500_000) return toast('Imagem muito grande (máx. 500 KB).', 'warning');
  const reader = new FileReader();
  reader.onload = () => {
    const form = $('#companyForm');
    form.logo_url.value = '';
    form.dataset.logoData = reader.result;
    updateLogoPreview();
  };
  reader.readAsDataURL(file);
});

$('#companyForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = formData(e.target);
  const body = { official_name: f.official_name, short_name: f.short_name, cnpj: f.cnpj, tagline: f.tagline, color_theme: companyColor, logo_url: currentLogoValue() };
  await withBusy(e.target.querySelector('[type=submit]'), async () => {
    try {
      const editing = !!f.record_id;
      const { company } = editing
        ? await api('PUT', `/api/companies/${f.record_id}`, body)
        : await api('POST', '/api/companies', body);
      const me = await api('GET', '/api/me');
      state.companies = me.companies;
      closeModal('companyModal');
      toast(editing ? 'Empresa atualizada.' : `Empresa "${company.short_name}" cadastrada.`, 'success');
      if (!$('#companiesModal').classList.contains('hidden')) renderCompaniesList();
      if (editing) selectCompany(state.activeCompanyId, { silent: true });
      else selectCompany(company.id);
    } catch (err) { handleError(err); }
  });
});

// ===================== USUÁRIOS (ADMIN) =====================
async function openUsers() {
  try {
    const { users } = await api('GET', '/api/users');
    state.users = users;
    $('#usersList').innerHTML = users.map(u => {
      const comps = state.companies.filter(c => u.company_ids.includes(c.id));
      const roleColor = u.role === 'ADMIN' ? 'bg-purple-500/20 text-purple-300' : (u.role === 'GESTOR' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400');
      return `<div class="p-4 rounded-xl border ${u.active ? 'border-slate-800 bg-slate-950/70' : 'border-slate-800/50 bg-slate-950/30 opacity-60'}">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-black text-xs text-white">${esc(initials(u.name))}</div>
            <div>
              <div class="flex items-center gap-2"><span class="font-bold text-white text-xs">${esc(u.name)}</span>
                ${u.id === state.me.id ? '<span class="px-2 py-0.5 rounded-full text-[9px] bg-emerald-500/20 text-emerald-400 font-bold">VOCÊ</span>' : ''}
                ${!u.active ? '<span class="px-2 py-0.5 rounded-full text-[9px] bg-red-500/20 text-red-400 font-bold">DESATIVADO</span>' : ''}</div>
              <span class="text-[11px] text-slate-400 font-mono">${esc(u.username || u.email)}</span>
              <span class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${roleColor}">${ROLE_LABEL[u.role]}</span>
            </div>
          </div>
          <button data-action="edit-user" data-id="${u.id}" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-semibold"><i class="fa-solid fa-pen text-[10px] mr-1"></i>Editar</button>
        </div>
        <div class="mt-3 pt-3 border-t border-slate-900 flex flex-wrap items-center gap-1.5">
          <span class="text-[10px] text-slate-500 font-semibold uppercase mr-1">Acesso:</span>
          ${u.role === 'ADMIN' ? '<span class="text-[10px] text-slate-300">Todas as empresas</span>' : comps.map(c => `<span class="px-2 py-0.5 rounded-lg text-[10px] bg-slate-900 border border-slate-800 text-slate-300">${esc(c.short_name)}</span>`).join('')}
        </div>
      </div>`;
    }).join('');
    openModal('usersModal');
  } catch (err) { handleError(err); }
}

function openUserForm(user) {
  const form = $('#userForm');
  form.reset();
  const isAdminUser = user && user.role === 'ADMIN';
  form.record_id.value = user ? user.id : '';
  form.name.value = user ? user.name : '';
  form.username.value = user ? (user.username || user.email) : '';
  form.username.disabled = isAdminUser; // o administrador entra pelo e-mail, que não muda aqui
  form.role.value = user && !isAdminUser ? user.role : 'OPERADOR';
  form.role.disabled = isAdminUser;
  form.active.checked = user ? user.active : true;
  form.password.required = !user;
  $('#userPasswordLabel').textContent = user ? 'Nova senha (deixe em branco para manter)' : 'Senha (mín. 8 caracteres) *';
  $('#userModalTitle').textContent = user ? `Editar usuário: ${user.name}` : 'Novo usuário';
  $('#userActiveRow').classList.toggle('hidden', !user || isAdminUser);
  const box = $('#userCompaniesBox');
  box.closest('div.space-y-2').classList.toggle('hidden', isAdminUser);
  box.innerHTML = state.companies.map(c => `
    <label class="flex items-center gap-2.5 p-2 bg-slate-900 rounded-lg border border-slate-800/80 cursor-pointer">
      <input type="checkbox" name="company_ids" value="${c.id}" ${!user || user.company_ids.includes(c.id) ? 'checked' : ''}>
      <span class="text-white text-xs">${esc(c.official_name)}</span>
    </label>`).join('');
  closeModal('usersModal');
  openModal('userModal');
}

$('#userForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const id = form.record_id.value;
  const target = id ? state.users.find(u => String(u.id) === id) : null;
  const companyIds = $$('#userCompaniesBox input:checked').map(i => Number(i.value));
  const body = { name: form.name.value.trim() };
  if (form.password.value) body.password = form.password.value;
  if (!target || target.role !== 'ADMIN') {
    body.role = form.role.value;
    body.company_ids = companyIds;
    if (target) body.active = form.active.checked;
    if (!companyIds.length) return toast('Selecione ao menos 1 empresa.', 'warning');
  }
  if (!target || target.role !== 'ADMIN') body.username = form.username.value.trim();

  await withBusy(form.querySelector('[type=submit]'), async () => {
    try {
      if (id) await api('PUT', `/api/users/${id}`, body);
      else await api('POST', '/api/users', body);
      closeModal('userModal');
      toast(id ? 'Usuário atualizado.' : `Usuário "${body.username}" criado. Passe o login e a senha para a pessoa.`, 'success');
      openUsers();
    } catch (err) { handleError(err); }
  });
});

// ===================== MINHA SENHA =====================
$('#passwordForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = formData(e.target);
  await withBusy(e.target.querySelector('[type=submit]'), async () => {
    try {
      await api('PUT', '/api/me/password', f);
      closeModal('passwordModal');
      toast('Senha alterada com sucesso.', 'success');
    } catch (err) { handleError(err); }
  });
});

// ===================== MENU (CELULAR) =====================
function openMobileMenu() {
  $('#mobileCompanyList').innerHTML = state.companies.map(c => {
    const t = COLOR_THEMES[c.color_theme] || COLOR_THEMES.amber;
    const current = c.id === state.activeCompanyId;
    return `<button data-mobile-company="${c.id}" class="menu-item" ${current ? `style="border-color:${t.hex}"` : ''}>
      <span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${t.hex}"></span>
      <span class="flex-1 min-w-0 truncate">${esc(c.short_name)}</span>
      ${current ? `<i class="fa-solid fa-check" style="color:${t.hex}"></i>` : ''}
    </button>`;
  }).join('') || '<p class="text-xs text-slate-400">Nenhuma empresa liberada.</p>';
  openModal('mobileMenuModal');
}

// ===================== CLIQUES (DELEGAÇÃO) =====================
document.addEventListener('click', e => {
  const closer = e.target.closest('[data-close]');
  if (closer) return closer.closest('.modal').classList.add('hidden');
  if (e.target.classList.contains('modal')) return e.target.classList.add('hidden');

  // No menu do celular: troca de empresa, e qualquer opção fecha o menu antes de agir
  const mc = e.target.closest('[data-mobile-company]');
  if (mc) { closeModal('mobileMenuModal'); return selectCompany(Number(mc.dataset.mobileCompany)); }
  if (e.target.closest('#mobileMenuModal') && e.target.closest('[data-tab], [data-action]')) closeModal('mobileMenuModal');

  const tabBtn = e.target.closest('[data-tab], [data-tab-link]');
  if (tabBtn) return navigate(tabBtn.dataset.tab || tabBtn.dataset.tabLink);

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = Number(el.dataset.id);
  switch (el.dataset.action) {
    case 'logout': return logout();
    case 'open-mobile-menu': return openMobileMenu();
    case 'new-loan': return openLoanModal();
    case 'pick-client': return state.clientSuggestions && fillClient(state.clientSuggestions[id]);
    case 'loan-for-client': {
      const c = state.dossierContract;
      if (!c) return;
      closeModal('dossierModal');
      const cpf = digitsOnly(c.cpf);
      const key = cpf.length >= 11 ? 'cpf:' + cpf : 'nome:' + normalizeText(c.client_name);
      return openLoanModal(clientIndex().find(x => x.key === key) || { ...c, key });
    }
    case 'dossier': return openDossier(id);
    case 'payment': return openPayment(id);
    case 'do-rollover': return doPayment('rollover', el);
    case 'do-settle': return doPayment('settle', el);
    case 'do-amortize': return doAmortize(el);
    case 'late-discount': return state.paymentDebt && applyLateDiscount(state.paymentDebt.lateFee * Number(el.dataset.pct) / 100);
    case 'open-agreement': return state.paymentContract && openAgreementModal(state.paymentContract, false);
    case 'renegotiate': return state.dossierContract && openAgreementModal(state.dossierContract, true);
    case 'regen-installments': return generateInstallments();
    case 'add-installment': {
      const rows = agreementState.rows;
      const last = rows[rows.length - 1];
      const interval = agreementInterval();
      rows.push({ due_date: last ? (interval === 'MENSAL' ? addMonths(last.due_date, 1, Number(last.due_date.slice(8, 10))) : addDays(last.due_date, interval)) : state.today, amount_cents: 0 });
      return renderInstallmentsEditor();
    }
    case 'remove-installment': agreementState.rows.splice(id, 1); return renderInstallmentsEditor();
    case 'pay-installment': return openInstallmentPay(Number(el.dataset.agreement), id);
    case 'cancel-agreement': return cancelAgreement(id);
    case 'delete-contract': return deleteContract(el);
    case 'edit-contract': return openContractEdit();
    case 'copy-agreement-debt': {
      const c = state.contracts.find(x => x.id === id);
      return c && c.agreement && copyText(agreementDebtText(c), `Cobrança do acordo de ${c.client_name} copiada.`);
    }
    case 'add-occurrence': return addOccurrence(el);
    case 'copy-debt': {
      const c = state.contracts.find(x => x.id === id);
      return c && copyText(debtSummaryText(c), `Cobrança de ${c.client_name} copiada.`);
    }
    case 'copy-phone': return copyText(el.dataset.phone, 'Telefone copiado.');
    case 'open-report': return openReport();
    case 'print': return window.print();
    case 'upload-ofx': return $('#ofxFileInput').click();
    case 'validate-tx': return validateTx(id, el);
    case 'discard-tx': return discardTx(id);
    case 'open-companies': renderCompaniesList(); return openModal('companiesModal');
    case 'new-company': return openCompanyForm(null);
    case 'edit-company': return openCompanyForm(state.companies.find(c => c.id === id));
    case 'clear-logo': { const f = $('#companyForm'); f.logo_url.value = ''; f.dataset.logoData = ''; return updateLogoPreview(); }
    case 'open-users': return openUsers();
    case 'new-user': return openUserForm(null);
    case 'edit-user': return openUserForm(state.users.find(u => u.id === id));
    case 'change-password': $('#passwordForm').reset(); return openModal('passwordModal');
  }
});

// Ao mudar o contrato vinculado no extrato, limpa a ação sugerida para o gestor escolher de novo
document.addEventListener('change', e => {
  const sel = e.target.closest('[data-tx-contract]');
  if (!sel) return;
  const actionSel = $(`[data-tx-action="${sel.dataset.txContract}"]`);
  if (actionSel && ['ROLAR', 'QUITAR'].includes(actionSel.value)) actionSel.value = '';
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $$('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
});

boot();
