'use strict';

// ---------- Утилиты ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login')) {
    state.me = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

let toastTimer;
function toast(text, isError) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2600);
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

const SYMBOLS = { KZT: '₸', USD: '$', EUR: '€', RUB: '₽', CNY: '¥' };
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nfCompact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const money = (n, cur, compact) => (n == null ? '' : `${(compact ? nfCompact : nf).format(n)} ${SYMBOLS[cur] || cur}`);

function sumByCurrency(list, compact) {
  const sums = {};
  for (const p of list) if (p.amount != null) sums[p.currency] = (sums[p.currency] || 0) + p.amount;
  const parts = Object.entries(sums).sort((a, b) => (a[0] === 'KZT' ? -1 : b[0] === 'KZT' ? 1 : 0));
  return parts.map(([c, n]) => money(n, c, compact)).join(' + ');
}

const today = () => new Date().toISOString().slice(0, 10);
function daysUntil(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(today() + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = (s) => dateFmt.format(new Date(s + 'T00:00:00')).replace('.', '');
const fmtStamp = (s) => dateTimeFmt.format(new Date(s.replace(' ', 'T') + 'Z'));

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

// Свой оттенок у каждого человека, чтобы Рамазан и Расул не путались по одной букве.
function avatar(userId, name, cls = '') {
  const hue = userId ? (userId * 137) % 360 : 40;
  return h('span', { class: 'avatar ' + cls, title: name || '', style: `--hue:${hue}` }, initials(name));
}

const isActive = (p) => p.stage !== 'done' && p.stage !== 'lost';
const isLate = (p) => isActive(p) && p.deadline && daysUntil(p.deadline) < 0;

// ---------- Состояние ----------

const state = {
  meta: null,
  me: null,
  users: [],
  projects: [],
  view: store.get('view', 'board'),
  q: '',
  client: store.get('client', ''),
  owner: store.get('owner', ''),
  showLost: store.get('showLost', false),
  sort: store.get('sort', { key: 'updated_at', dir: -1 }),
};

const stageIndex = (id) => state.meta.stages.findIndex((s) => s.id === id);
const stageName = (id) => state.meta.stages.find((s) => s.id === id)?.name || id;
const userName = (id) => state.users.find((u) => u.id === id)?.name || '';
const pipelineStages = () => state.meta.stages.filter((s) => s.id !== 'lost');

function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.projects.filter((p) => {
    if (state.client && p.client !== state.client) return false;
    if (state.owner && String(p.owner_id) !== state.owner) return false;
    if (!state.showLost && p.stage === 'lost') return false;
    if (q && !`${p.title} ${p.client} ${p.next_step} ${p.notes}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function clients() {
  const set = new Set(state.meta.defaultClients);
  for (const p of state.projects) if (p.client) set.add(p.client);
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
}

async function loadData() {
  const [users, projects] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/projects')]);
  state.users = users;
  state.projects = projects;
}

function upsert(p) {
  const i = state.projects.findIndex((x) => x.id === p.id);
  if (i >= 0) state.projects[i] = p; else state.projects.unshift(p);
}

// ---------- Вход и первичная настройка ----------

function authScreen(mode) {
  const err = h('div', { class: 'form-error' });
  const setup = mode === 'setup';
  const fields = setup
    ? [
      h('label', { class: 'field' }, h('span', {}, 'Ваше имя'), h('input', { class: 'input', name: 'name', required: true, autocomplete: 'name' })),
      h('label', { class: 'field' }, h('span', {}, 'Логин'), h('input', { class: 'input', name: 'login', required: true, autocomplete: 'username', autocapitalize: 'off', placeholder: 'ramazan' })),
      h('label', { class: 'field' }, h('span', {}, 'Пароль'), h('input', { class: 'input', name: 'password', type: 'password', required: true, minlength: 6, autocomplete: 'new-password' })),
    ]
    : [
      h('label', { class: 'field' }, h('span', {}, 'Логин'), h('input', { class: 'input', name: 'login', required: true, autocomplete: 'username', autocapitalize: 'off', autofocus: true })),
      h('label', { class: 'field' }, h('span', {}, 'Пароль'), h('input', { class: 'input', name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    ];
  const form = h('form', {
    class: 'auth-card',
    async onsubmit(e) {
      e.preventDefault();
      err.textContent = '';
      const body = Object.fromEntries(new FormData(form));
      try {
        const { me } = await api('POST', setup ? '/api/setup' : '/api/login', body);
        state.me = me;
        state.meta.needsSetup = false;
        await loadData();
        render();
      } catch (ex) { err.textContent = ex.message; }
    },
  },
  h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), 'Поставки'),
  h('h1', {}, setup ? 'Первый запуск' : 'Вход'),
  setup && h('p', {}, 'Создайте аккаунт администратора. Остальных — Расула и команду — добавите потом.'),
  fields,
  err,
  h('button', { class: 'btn btn-primary', type: 'submit' }, setup ? 'Создать и войти' : 'Войти'));
  return h('main', { class: 'auth' }, form);
}

// ---------- Верхняя панель и сводка ----------

function topBar() {
  const viewBtn = (id, label) => h('button', {
    type: 'button', 'aria-pressed': String(state.view === id),
    onclick() { state.view = id; store.set('view', id); renderMain(); },
  }, label);

  const search = h('input', {
    class: 'input search', type: 'search', placeholder: 'Поиск по проектам', value: state.q, 'aria-label': 'Поиск',
    oninput(e) { state.q = e.target.value; renderContent(); },
  });

  const clientSel = h('select', {
    class: 'select', 'aria-label': 'Заказчик',
    onchange(e) { state.client = e.target.value; store.set('client', state.client); renderContent(); },
  }, h('option', { value: '' }, 'Все заказчики'), clients().map((c) => h('option', { value: c, selected: c === state.client }, c)));

  const ownerSel = h('select', {
    class: 'select hide-sm', 'aria-label': 'Ответственный',
    onchange(e) { state.owner = e.target.value; store.set('owner', state.owner); renderContent(); },
  }, h('option', { value: '' }, 'Все ответственные'), state.users.map((u) => h('option', { value: String(u.id), selected: String(u.id) === state.owner }, u.name)));

  return h('header', { class: 'top' },
    h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), h('span', {}, 'Поставки')),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Вид' }, viewBtn('board', 'Доска'), viewBtn('list', 'Список')),
    search,
    clientSel,
    ownerSel,
    h('div', { class: 'grow hide-sm' }),
    h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Команда и аккаунт', 'aria-label': 'Команда и аккаунт', onclick: teamDialog },
      avatar(state.me.id, state.me.name)),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => newProjectDialog('lead') }, '+ Проект'));
}

function statsBar(list) {
  const active = list.filter(isActive);
  const late = active.filter(isLate);
  const monthStart = today().slice(0, 7);
  const doneMonth = list.filter((p) => p.stage === 'done' && p.stage_changed_at.slice(0, 7) === monthStart);
  const stat = (value, label, cls) => h('div', { class: 'stat ' + (cls || '') }, h('b', {}, value), h('span', {}, label));
  return h('section', { class: 'stats', 'aria-label': 'Сводка' },
    stat(String(active.length), 'в работе'),
    stat(sumByCurrency(active, true) || '—', 'сумма в работе'),
    stat(String(late.length), 'просрочено', late.length ? 'alert' : ''),
    stat(String(doneMonth.length), 'поставлено в этом месяце'),
    h('label', { class: 'stat', style: 'margin-left:auto;align-self:center;display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-2)' },
      h('input', { type: 'checkbox', checked: state.showLost, onchange(e) { state.showLost = e.target.checked; store.set('showLost', state.showLost); renderContent(); } }),
      'Показывать отказы'));
}

// ---------- Карточка и доска ----------

function deadlinePill(p) {
  if (!p.deadline) return null;
  if (!isActive(p)) return h('span', { class: 'pill' }, fmtDate(p.deadline));
  const d = daysUntil(p.deadline);
  const cls = d < 0 ? 'late' : d <= 3 ? 'soon' : '';
  const label = d < 0 ? `просрочено ${-d} дн` : d === 0 ? 'сегодня' : d === 1 ? 'завтра' : fmtDate(p.deadline);
  return h('span', { class: 'pill ' + cls, title: `Срок: ${p.deadline}` }, label);
}

function rail(p) {
  const idx = p.stage === 'lost' ? -1 : stageIndex(p.stage);
  return h('div', { class: 'rail' + (p.stage === 'lost' ? ' lost' : ''), 'aria-hidden': 'true' },
    pipelineStages().map((_, i) => h('i', { class: i <= idx ? 'on' : '' })));
}

function card(p) {
  return h('button', {
    class: 'card', type: 'button', draggable: 'true', dataset: { id: p.id },
    onclick: () => openProject(p.id),
    ondragstart(e) { e.dataTransfer.setData('text/plain', String(p.id)); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); },
    ondragend(e) { e.currentTarget.classList.remove('dragging'); },
  },
  p.client && h('div', { class: 'card-client' }, p.client),
  h('div', { class: 'card-title' }, p.title),
  p.next_step && isActive(p) && h('div', { class: 'card-next' }, p.next_step),
  rail(p),
  h('div', { class: 'card-foot' },
    p.amount != null && h('span', { class: 'amount' }, money(p.amount, p.currency)),
    h('span', { class: 'right' },
      p.comments ? h('span', { class: 'faint num', style: 'white-space:nowrap', title: 'Комментарии' }, `💬\u00a0${p.comments}`) : null,
      deadlinePill(p),
      p.owner_id && avatar(p.owner_id, userName(p.owner_id)))));
}

async function moveProject(id, stage) {
  const p = state.projects.find((x) => x.id === id);
  if (!p || p.stage === stage) return;
  const prev = p.stage;
  p.stage = stage;
  renderContent();
  try {
    upsert(await api('PATCH', `/api/projects/${id}`, { stage }));
    toast(`«${p.title}» → ${stageName(stage)}`);
  } catch (e) {
    p.stage = prev;
    toast(e.message, true);
  }
  renderContent();
  if (drawerId === id) renderDrawer();
}

function board(list) {
  const stages = state.showLost ? state.meta.stages : pipelineStages();
  return h('section', { class: 'board', 'aria-label': 'Доска проектов' }, stages.map((s) => {
    const items = list.filter((p) => p.stage === s.id)
      .sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || b.updated_at.localeCompare(a.updated_at));
    const col = h('div', {
      class: 'col', dataset: { stage: s.id },
      ondragover(e) { e.preventDefault(); col.classList.add('drop'); },
      ondragleave(e) { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); },
      ondrop(e) { e.preventDefault(); col.classList.remove('drop'); moveProject(Number(e.dataTransfer.getData('text/plain')), s.id); },
    },
    h('div', { class: 'col-head' },
      h('h2', {}, s.name), h('span', { class: 'count' }, items.length),
      h('span', { class: 'sum' }, sumByCurrency(items, true))),
    items.length ? items.map(card) : h('div', { class: 'col-empty' }, 'Пусто'),
    s.id !== 'done' && s.id !== 'lost' && h('button', { class: 'btn btn-ghost col-add', type: 'button', onclick: () => newProjectDialog(s.id) }, '+ Добавить'));
    return col;
  }));
}

// ---------- Список ----------

function listView(list) {
  const { key, dir } = state.sort;
  const val = {
    title: (p) => p.title.toLowerCase(),
    client: (p) => p.client.toLowerCase(),
    stage: (p) => (p.stage === 'lost' ? 99 : stageIndex(p.stage)),
    amount: (p) => p.amount ?? -1,
    owner_id: (p) => userName(p.owner_id),
    deadline: (p) => p.deadline || '9999',
    updated_at: (p) => p.updated_at,
  }[key];
  const rows = [...list].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * dir);
  const th = (k, label, cls) => h('th', { class: cls, 'aria-sort': key === k ? (dir > 0 ? 'ascending' : 'descending') : null },
    h('button', {
      type: 'button',
      onclick() { state.sort = { key: k, dir: key === k ? -dir : 1 }; store.set('sort', state.sort); renderContent(); },
    }, label, key === k ? (dir > 0 ? ' ↑' : ' ↓') : ''));
  const total = pipelineStages().length - 1;
  return h('section', { class: 'list-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {},
      th('title', 'Проект'), th('client', 'Заказчик', 'hide-sm'), th('stage', 'Стадия'),
      th('amount', 'Сумма', 'r hide-sm'), th('owner_id', 'Ответственный', 'hide-sm'), th('deadline', 'Срок'))),
    h('tbody', {}, rows.map((p) => h('tr', { onclick: () => openProject(p.id), tabindex: '0', onkeydown(e) { if (e.key === 'Enter') openProject(p.id); } },
      h('td', {}, h('div', { class: 't-title' }, p.title), p.next_step && isActive(p) && h('div', { class: 'faint', style: 'font-size:12px' }, '→ ' + p.next_step)),
      h('td', { class: 'hide-sm muted' }, p.client),
      h('td', {}, h('span', { class: 'stage-tag', style: `--o:${p.stage === 'lost' ? 0.25 : 0.3 + 0.7 * stageIndex(p.stage) / total}` }, stageName(p.stage))),
      h('td', { class: 'r num hide-sm' }, money(p.amount, p.currency)),
      h('td', { class: 'hide-sm muted' }, userName(p.owner_id)),
      h('td', {}, deadlinePill(p) || h('span', { class: 'faint' }, '—')))))));
}

function emptyState() {
  const hasAny = state.projects.length > 0;
  return h('div', { class: 'empty-state' },
    h('h3', {}, hasAny ? 'Ничего не найдено' : 'Пока нет проектов'),
    h('div', {}, hasAny ? 'Измените фильтры или поиск.' : 'Добавьте первую поставку — например, для ERG или Integra Construction.'),
    hasAny
      ? h('button', { class: 'btn', type: 'button', onclick() { state.q = ''; state.client = ''; state.owner = ''; store.set('client', ''); store.set('owner', ''); renderMain(); } }, 'Сбросить фильтры')
      : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => newProjectDialog('lead') }, '+ Новый проект'));
}

// ---------- Отрисовка ----------

const app = document.getElementById('app');
let contentEl;

function render() {
  app.replaceChildren();
  if (state.meta.needsSetup) return app.append(authScreen('setup'));
  if (!state.me) return app.append(authScreen('login'));
  renderMain();
}

function renderMain() {
  contentEl = h('div');
  app.replaceChildren(topBar(), contentEl);
  renderContent();
}

function renderContent() {
  if (!contentEl) return;
  const list = filtered();
  const body = state.projects.length === 0 || (list.length === 0 && state.view === 'list')
    ? emptyState()
    : state.view === 'board' ? board(list) : listView(list);
  contentEl.replaceChildren(statsBar(list), body);
}

// ---------- Панель проекта ----------

let drawerId = null;
let drawerEl = null;

function openProject(id) {
  drawerId = id;
  if (location.hash !== `#p${id}`) history.replaceState(null, '', `#p${id}`);
  renderDrawer();
}

function closeDrawer() {
  drawerId = null;
  drawerEl?.remove();
  drawerEl = null;
  history.replaceState(null, '', location.pathname);
}

async function saveField(id, patch, note) {
  try {
    upsert(await api('PATCH', `/api/projects/${id}`, patch));
    renderContent();
    if (note) { note.textContent = 'Сохранено'; setTimeout(() => (note.textContent = ''), 1500); }
    loadEvents(id);
  } catch (e) { toast(e.message, true); }
}

let eventsEl;
async function loadEvents(id) {
  if (!eventsEl || drawerId !== id) return;
  try {
    const events = await api('GET', `/api/projects/${id}/events`);
    if (drawerId !== id) return;
    eventsEl.replaceChildren(...events.map(eventItem));
  } catch { /* история не критична */ }
}

const FIELD_NAMES = { title: 'название', client: 'заказчика', amount: 'сумму', currency: 'валюту', owner_id: 'ответственного', deadline: 'срок', next_step: 'следующий шаг', notes: 'заметки' };

function eventItem(e) {
  const who = e.user_name || 'Кто-то';
  let text;
  if (e.kind === 'created') text = 'создал(а) проект';
  else if (e.kind === 'stage') text = `${stageName(e.data.from)} → ${stageName(e.data.to)}`;
  else if (e.kind === 'edit') text = 'изменил(а) ' + e.data.fields.map((f) => FIELD_NAMES[f] || f).join(', ');
  return h('li', {},
    avatar(e.user_id, who),
    h('div', {},
      h('div', { class: 'ev-meta' }, `${who} · ${fmtStamp(e.created_at)}`),
      e.kind === 'comment'
        ? h('div', { class: 'ev-text ev-comment' }, e.data.text)
        : h('div', { class: 'ev-text muted' }, text)));
}

function renderDrawer() {
  const p = state.projects.find((x) => x.id === drawerId);
  drawerEl?.remove();
  if (!p) { drawerEl = null; return; }
  const note = h('span', { class: 'saved', 'aria-live': 'polite' });
  const save = (patch) => saveField(p.id, patch, note);
  const onText = (field) => ({ onchange: (e) => save({ [field]: e.target.value }) });

  const idx = stageIndex(p.stage);
  const stepper = h('div', { class: 'stepper', role: 'group', 'aria-label': 'Стадия' }, pipelineStages().map((s, i) =>
    h('button', {
      type: 'button',
      class: p.stage === s.id ? 'current' : (p.stage !== 'lost' && i < idx ? 'past' : ''),
      'aria-pressed': String(p.stage === s.id),
      onclick: () => moveProject(p.id, s.id),
    }, s.name)));

  const comment = h('textarea', { class: 'textarea', placeholder: 'Комментарий, договорённость, номер счёта…', 'aria-label': 'Комментарий',
    onkeydown(e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendComment(); } });
  async function sendComment() {
    const text = comment.value.trim();
    if (!text) return;
    try {
      await api('POST', `/api/projects/${p.id}/comments`, { text });
      comment.value = '';
      p.comments = (p.comments || 0) + 1;
      renderContent();
      loadEvents(p.id);
    } catch (e) { toast(e.message, true); }
  }

  eventsEl = h('ol', { class: 'timeline' });

  const canDelete = state.me.role === 'admin' || p.created_by === state.me.id;
  const drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': p.title },
    h('div', { class: 'drawer-head' },
      h('div', { class: 'crumb' }, [p.client, `№${p.id}`].filter(Boolean).join(' · ')),
      note,
      h('button', { class: 'btn btn-ghost', type: 'button', title: 'Скопировать ссылку',
        onclick() { navigator.clipboard?.writeText(location.href).then(() => toast('Ссылка скопирована'), () => {}); } }, 'Ссылка'),
      canDelete && h('button', { class: 'btn btn-ghost btn-danger', type: 'button',
        async onclick() {
          if (!confirm(`Удалить «${p.title}»? Это нельзя отменить.`)) return;
          try {
            await api('DELETE', `/api/projects/${p.id}`);
            state.projects = state.projects.filter((x) => x.id !== p.id);
            closeDrawer(); renderContent(); toast('Проект удалён');
          } catch (e) { toast(e.message, true); }
        } }, 'Удалить'),
      h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': 'Закрыть', onclick: closeDrawer }, '✕')),
    h('div', { class: 'drawer-body' },
      h('textarea', { class: 'title-input', rows: 1, value: p.title, 'aria-label': 'Название', ...onText('title'),
        oninput: (e) => autosize(e.target),
        onkeydown(e) { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } } }),
      h('div', {},
        stepper,
        h('div', { class: 'stage-extra', style: 'margin-top:8px' },
          h('span', {}, p.stage === 'lost' ? 'Проект в отказе' : `В стадии с ${fmtStamp(p.stage_changed_at)}`),
          p.stage === 'lost'
            ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => moveProject(p.id, 'lead') }, 'Вернуть в работу')
            : h('button', { class: 'btn btn-ghost btn-danger', type: 'button', onclick: () => moveProject(p.id, 'lost') }, 'Отказ'))),
      h('label', { class: 'field' }, h('span', {}, 'Следующий шаг'),
        h('input', { class: 'input', value: p.next_step, placeholder: 'Например: отправить КП до пятницы', ...onText('next_step') })),
      h('div', { class: 'grid-2' },
        h('label', { class: 'field' }, h('span', {}, 'Заказчик'),
          h('input', { class: 'input', value: p.client, list: 'clients-list', ...onText('client') })),
        h('label', { class: 'field' }, h('span', {}, 'Сумма'),
          h('div', { class: 'money' },
            h('input', { class: 'input num', inputmode: 'decimal', value: p.amount ?? '', placeholder: '0', ...onText('amount') }),
            h('select', { class: 'select', 'aria-label': 'Валюта', onchange: (e) => save({ currency: e.target.value }) },
              state.meta.currencies.map((c) => h('option', { value: c, selected: c === p.currency }, c))))),
        h('label', { class: 'field' }, h('span', {}, 'Ответственный'),
          h('select', { class: 'select', onchange: (e) => save({ owner_id: e.target.value ? Number(e.target.value) : null }) },
            h('option', { value: '' }, '—'),
            state.users.map((u) => h('option', { value: String(u.id), selected: u.id === p.owner_id }, u.name)))),
        h('label', { class: 'field' }, h('span', {}, 'Срок'),
          h('input', { class: 'input', type: 'date', value: p.deadline || '', onchange: (e) => save({ deadline: e.target.value }) }))),
      h('label', { class: 'field' }, h('span', {}, 'Заметки'),
        h('textarea', { class: 'textarea', value: p.notes, placeholder: 'Позиции, объёмы, контакты, условия…', ...onText('notes') })),
      h('section', {},
        h('h4', { class: 'section-title' }, 'История и комментарии'),
        h('div', { class: 'comment-box' }, comment,
          h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: sendComment }, 'Отправить'))),
        h('div', { style: 'margin-top:16px' }, eventsEl))));

  const scrim = h('div', { class: 'scrim', onclick: closeDrawer });
  drawerEl = h('div', {}, scrim, drawer, clientsDatalist());
  document.body.append(drawerEl);
  autosize(drawerEl.querySelector('.title-input'));
  loadEvents(p.id);
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function clientsDatalist() {
  return h('datalist', { id: 'clients-list' }, clients().map((c) => h('option', { value: c })));
}

// ---------- Диалоги ----------

function dialog(title, content, onSubmit, submitLabel = 'Сохранить') {
  const err = h('div', { class: 'form-error' });
  const form = h('form', {
    method: 'dialog',
    async onsubmit(e) {
      e.preventDefault();
      err.textContent = '';
      try { await onSubmit(new FormData(form), dlg); } catch (ex) { err.textContent = ex.message; }
    },
  }, h('h3', {}, title), content, err,
  h('div', { class: 'actions' },
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dlg.close() }, 'Отмена'),
    submitLabel && h('button', { class: 'btn btn-primary', type: 'submit' }, submitLabel)));
  const dlg = h('dialog', { onclose: () => dlg.remove() }, form, clientsDatalist());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function newProjectDialog(stage) {
  const content = [
    h('label', { class: 'field' }, h('span', {}, 'Что поставляем'), h('input', { class: 'input', name: 'title', required: true, autofocus: true, placeholder: 'Кабель ВВГ 3×2.5, 5 км' })),
    h('label', { class: 'field' }, h('span', {}, 'Заказчик'), h('input', { class: 'input', name: 'client', list: 'clients-list', value: state.client, placeholder: 'ERG, Integra Construction…' })),
    h('div', { class: 'field' }, h('span', {}, 'Сумма'),
      h('div', { class: 'money' },
        h('input', { class: 'input num', name: 'amount', inputmode: 'decimal', placeholder: '0', 'aria-label': 'Сумма' }),
        h('select', { class: 'select', name: 'currency', 'aria-label': 'Валюта' }, state.meta.currencies.map((c) => h('option', { value: c }, c))))),
    h('div', { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', {}, 'Ответственный'),
        h('select', { class: 'select', name: 'owner_id' }, state.users.map((u) => h('option', { value: String(u.id), selected: u.id === state.me.id }, u.name)))),
      h('label', { class: 'field' }, h('span', {}, 'Срок'), h('input', { class: 'input', type: 'date', name: 'deadline' }))),
  ];
  dialog(`Новый проект · ${stageName(stage)}`, content, async (fd, dlg) => {
    const body = Object.fromEntries(fd);
    body.stage = stage;
    if (!body.amount) delete body.amount;
    const p = await api('POST', '/api/projects', body);
    upsert(p);
    dlg.close();
    renderMain();
    openProject(p.id);
  }, 'Создать');
}

function teamDialog() {
  const isAdmin = state.me.role === 'admin';
  const list = h('ul', { class: 'people' });
  const draw = () => list.replaceChildren(...state.users.map((u) => h('li', {},
    avatar(u.id, u.name, 'lg'),
    h('div', { class: 'who' }, u.name, h('small', {}, `${u.login}${u.role === 'admin' ? ' · админ' : ''}`)),
    isAdmin && u.id !== state.me.id && h('button', { class: 'btn btn-ghost btn-danger', type: 'button',
      async onclick() {
        if (!confirm(`Удалить доступ для ${u.name}?`)) return;
        try { await api('DELETE', `/api/users/${u.id}`); state.users = state.users.filter((x) => x.id !== u.id); draw(); } catch (e) { toast(e.message, true); }
      } }, 'Удалить'))));
  draw();

  const content = [
    list,
    isAdmin && h('details', {},
      h('summary', { style: 'cursor:pointer;font-weight:500' }, 'Добавить человека'),
      h('div', { style: 'display:grid;gap:10px;margin-top:10px' },
        h('input', { class: 'input', name: 'name', placeholder: 'Имя, например Расул', 'aria-label': 'Имя' }),
        h('input', { class: 'input', name: 'login', placeholder: 'Логин, например rasul', autocapitalize: 'off', 'aria-label': 'Логин' }),
        h('input', { class: 'input', name: 'password', type: 'text', placeholder: 'Пароль (от 6 символов)', autocomplete: 'off', 'aria-label': 'Пароль' }),
        h('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' }, h('input', { type: 'checkbox', name: 'admin' }), 'Права администратора'))),
    h('details', {},
      h('summary', { style: 'cursor:pointer;font-weight:500' }, 'Сменить мой пароль'),
      h('div', { style: 'display:grid;gap:10px;margin-top:10px' },
        h('input', { class: 'input', name: 'current', type: 'password', placeholder: 'Текущий пароль', autocomplete: 'current-password', 'aria-label': 'Текущий пароль' }),
        h('input', { class: 'input', name: 'next', type: 'password', placeholder: 'Новый пароль', autocomplete: 'new-password', 'aria-label': 'Новый пароль' }))),
    h('button', { class: 'btn btn-ghost', type: 'button', style: 'justify-self:start',
      async onclick() { await api('POST', '/api/logout', {}); location.reload(); } }, 'Выйти из аккаунта'),
  ];

  dialog('Команда', content, async (fd, dlg) => {
    const data = Object.fromEntries(fd);
    let did = false;
    if (data.login || data.name) {
      const u = await api('POST', '/api/users', { name: data.name, login: data.login, password: data.password, role: data.admin ? 'admin' : 'member' });
      state.users.push(u);
      toast(`${u.name} добавлен(а). Передайте логин и пароль.`);
      did = true;
    }
    if (data.current || data.next) {
      await api('POST', '/api/me/password', { current: data.current, next: data.next });
      toast('Пароль изменён');
      did = true;
    }
    dlg.close();
    if (did) renderMain();
  });
}

// ---------- Запуск ----------

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerId && !document.querySelector('dialog[open]')) closeDrawer();
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (!typing && state.me && !document.querySelector('dialog[open]')) {
    if (e.key === 'n' || e.key === 'т') { e.preventDefault(); newProjectDialog('lead'); }
    if (e.key === '/') { e.preventDefault(); document.querySelector('.search')?.focus(); }
  }
});

// Фоновое обновление: Расул и команда видят изменения друг друга без перезагрузки.
async function refresh() {
  if (!state.me || document.hidden) return;
  try {
    await loadData();
    renderContent();
    const drawerFocused = drawerEl && drawerEl.contains(document.activeElement);
    if (drawerId && !drawerFocused) {
      if (state.projects.some((p) => p.id === drawerId)) loadEvents(drawerId); else closeDrawer();
    }
  } catch { /* сеть — попробуем позже */ }
}
setInterval(refresh, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

(async function boot() {
  try {
    state.meta = await api('GET', '/api/meta');
    state.me = state.meta.me;
    if (state.me) await loadData();
  } catch (e) {
    app.replaceChildren(h('main', { class: 'auth' }, h('div', { class: 'auth-card' }, h('h1', {}, 'Сервер недоступен'), h('p', {}, e.message),
      h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Повторить'))));
    return;
  }
  render();
  const m = location.hash.match(/^#p(\d+)$/);
  if (m && state.me) openProject(Number(m[1]));
})();
