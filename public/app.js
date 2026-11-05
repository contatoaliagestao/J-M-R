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

function openModal(id) { $('#' + id).classList.remove('hidden'); }
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
  $$('.sidebar-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
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

  const tbody = $('#contractsTableBody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-10 text-slate-500">${state.contracts.length ? 'Nenhum contrato encontrado com esses filtros.' : 'Nenhum contrato cadastrado nesta empresa ainda.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(c => {
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

function renderOverdue() {
  const list = state.contracts.filter(c => c.situation === 'ATRASADO').sort((a, b) => b.debt.overdueDays - a.debt.overdueDays);
  const badge = $('#overdueBadge');
  badge.textContent = list.length;
  badge.classList.toggle('hidden', list.length === 0);

  const box = $('#overdueCards');
  if (!list.length) {
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
    </div>`).join('');
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

function openLoanModal() {
  const form = $('#loanForm');
  form.reset();
  form.start_date.value = state.today;
  updateLoanPreview();
  openModal('loanModal');
  setTimeout(() => form.client_name.focus(), 50);
}

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
  $('#paymentSummary').innerHTML = `
    <div class="flex justify-between text-slate-400"><span>Principal:</span><span class="font-mono text-white">${money(c.debt.principal)}</span></div>
    <div class="flex justify-between text-slate-400"><span>Juros do ciclo:</span><span class="font-mono text-emerald-400">${money(c.debt.cycleInterest)}</span></div>
    <div class="flex justify-between text-slate-400"><span>Dias em atraso:</span><span class="font-mono text-amber-400 font-bold">${c.debt.overdueDays} dias</span></div>
    <div class="flex justify-between text-slate-400"><span>Diárias (${c.late_fee_rate}%/dia):</span><span class="font-mono text-red-400 font-bold">${money(c.debt.lateFee)}</span></div>
    <div class="pt-2 border-t border-slate-800 flex justify-between text-sm font-bold"><span class="text-white">Total para quitação:</span><span class="font-mono text-emerald-400">${money(c.debt.totalToSettle)}</span></div>
    <div class="flex justify-between font-semibold text-slate-300"><span>Total para rolar (juros + diárias):</span><span class="font-mono text-teal-400">${money(c.debt.totalToRollover)}</span></div>`;
  openModal('paymentModal');
}

async function doPayment(kind, button) {
  const c = state.paymentContract;
  if (!c) return;
  const value = kind === 'rollover' ? c.debt.totalToRollover : c.debt.totalToSettle;
  const question = kind === 'rollover'
    ? `Confirmar ROLAGEM do contrato ${c.code}, recebendo ${money(value)}?`
    : `Confirmar QUITAÇÃO do contrato ${c.code}, recebendo ${money(value)}?`;
  if (!confirm(question)) return;
  await withBusy(button, async () => {
    try {
      const body = { channel: $('input[name=paymentChannel]:checked').value, notes: $('#paymentNotes').value };
      const r = await companyApi('POST', `/contracts/${c.id}/${kind === 'rollover' ? 'rollover' : 'settle'}`, body);
      closeModal('paymentModal');
      toast(kind === 'rollover' ? `Rolagem registrada. Novo vencimento: ${brDate(r.new_due_date)}.` : `Contrato ${c.code} quitado.`, 'success');
      refresh();
    } catch (err) { handleError(err); }
  });
}

// ===================== DOSSIÊ =====================
async function openDossier(id) {
  state.dossierContractId = id;
  try {
    const { contract: c, occurrences } = await companyApi('GET', `/contracts/${id}`);
    $('#dossierName').textContent = c.client_name;
    $('#dossierCode').textContent = c.code;
    $('#dossierInfo').innerHTML = `
      <div><span class="text-slate-500 text-[10px] uppercase font-bold block">CPF</span><span class="text-slate-200 font-mono font-semibold">${esc(c.cpf)}</span></div>
      <div><span class="text-slate-500 text-[10px] uppercase font-bold block">Telefone / WhatsApp</span>
        <span class="text-emerald-400 font-mono font-bold">${esc(formatPhone(c.phone))}</span>
        <button data-action="copy-phone" data-phone="${esc(c.phone)}" class="text-slate-400 hover:text-white text-xs ml-1" title="Copiar"><i class="fa-regular fa-copy"></i></button>
        <a href="${esc(whatsappLink(c.phone))}" target="_blank" rel="noopener" class="text-emerald-400 hover:text-emerald-300 ml-1" title="WhatsApp"><i class="fa-brands fa-whatsapp"></i></a></div>
      <div><span class="text-slate-500 text-[10px] uppercase font-bold block">Endereço</span><span class="text-slate-300"><i class="fa-solid fa-location-dot text-rose-400 mr-1"></i>${esc(c.address)}</span></div>
      <div><span class="text-slate-500 text-[10px] uppercase font-bold block">Rede social</span><span class="text-blue-400">${esc(c.social_media || 'Não informada')}</span></div>`;
    $('#dossierDebt').innerHTML = `
      <div><span class="text-slate-400 text-[11px]">Principal / taxa</span><div class="font-mono font-bold text-white">${money(c.principal_cents)} (${c.rate}% / ${c.cycle_days}d)</div></div>
      <div><span class="text-slate-400 text-[11px]">Situação</span><div class="mt-0.5">${statusBadge(c)}</div></div>
      <div><span class="text-slate-400 text-[11px]">Vencimento</span><div class="font-mono font-bold text-slate-300">${c.status === 'QUITADO' ? 'Quitado em ' + brDate(c.settled_at) : brDate(c.due_date)}</div></div>
      <div><span class="text-slate-400 text-[11px]">Total p/ quitar</span><div class="font-mono font-bold text-emerald-400">${c.status === 'QUITADO' ? '—' : money(c.debt.totalToSettle)}</div></div>`;
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
      </tr>`).join('') : '<tr><td colspan="6" class="p-6 text-center text-slate-500">Nenhum inadimplente.</td></tr>';
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
    const actions = credit ? ['ROLAR', 'QUITAR', 'OUTRA_ENTRADA'] : ['DESEMBOLSO', 'DESPESA'];

    let contractCell;
    if (done) {
      contractCell = tx.contract ? `<div class="font-bold text-slate-200">${esc(tx.contract.client_name)}</div><div class="text-[11px] text-slate-400 font-mono">${esc(tx.contract.code)}</div>`
        : '<span class="text-[11px] text-slate-500">—</span>';
    } else {
      const opts = active_contracts.map(c => `<option value="${c.id}" ${c.id === tx.contract_id ? 'selected' : ''}>${esc(c.code)} - ${esc(c.client_name)}</option>`).join('');
      contractCell = `<select data-tx-contract="${tx.id}" class="field-input py-1 text-xs max-w-[220px]"><option value="">Sem vínculo</option>${opts}</select>`;
      if (tx.contract && tx.contract.status === 'ATIVO') {
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
  if ((action === 'ROLAR' || action === 'QUITAR') && !contractId) return toast('Vincule um contrato.', 'warning');

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
  form.username.disabled = !!user;
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
  if (!id) body.username = form.username.value.trim();

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

// ===================== CLIQUES (DELEGAÇÃO) =====================
document.addEventListener('click', e => {
  const closer = e.target.closest('[data-close]');
  if (closer) return closer.closest('.modal').classList.add('hidden');
  if (e.target.classList.contains('modal')) return e.target.classList.add('hidden');

  const tabBtn = e.target.closest('[data-tab], [data-tab-link]');
  if (tabBtn) return navigate(tabBtn.dataset.tab || tabBtn.dataset.tabLink);

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = Number(el.dataset.id);
  switch (el.dataset.action) {
    case 'logout': return logout();
    case 'new-loan': return openLoanModal();
    case 'dossier': return openDossier(id);
    case 'payment': return openPayment(id);
    case 'do-rollover': return doPayment('rollover', el);
    case 'do-settle': return doPayment('settle', el);
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
