/**
 * Главная: каталог дашбордов.
 *
 * Данные идут по цепочке Google Таблица → /api/projects → браузер. Если
 * прослойка недоступна (например, каталог открыт как статика), берётся снапшот
 * `data/projects.json`, и об этом честно пишется в баннере.
 *
 * Разметка собирается через DOM API, а не через innerHTML: содержимое таблицы —
 * чужой ввод, и попадать в разметку строкой оно не должно.
 */

const API = '/api/projects';
const SNAPSHOT = '/data/projects.json';
const PINS_KEY = 'viferon-dash-pins';
const AUTO_REFRESH_MS = 5 * 60 * 1000;

const el = {
  status: document.getElementById('status'),
  banner: document.getElementById('banner'),
  kpis: document.getElementById('kpis'),
  catalog: document.getElementById('catalog'),
  search: document.getElementById('f-search'),
  category: document.getElementById('f-category'),
  statusFilter: document.getElementById('f-status'),
  pinned: document.getElementById('f-pinned'),
  refresh: document.getElementById('refresh'),
  theme: document.getElementById('theme'),
  user: document.getElementById('user'),
  userName: document.getElementById('user-name'),
  userRole: document.getElementById('user-role'),
  logout: document.getElementById('logout'),
  footSource: document.getElementById('foot-source'),
  footUpdated: document.getElementById('foot-updated'),
  viewer: document.getElementById('viewer'),
  viewerTitle: document.querySelector('#viewer-title span'),
  viewerFrame: document.getElementById('viewer-frame'),
  viewerOpen: document.getElementById('viewer-open'),
  viewerClose: document.getElementById('viewer-close'),
};

const STATUS_LABEL = { live: 'Работает', dev: 'В разработке', paused: 'Приостановлен' };

let state = { projects: [], meta: null, pins: loadPins() };

/* --- Загрузка -------------------------------------------------------------- */

async function load({ force = false, quiet = false } = {}) {
  if (!quiet) el.status.textContent = force ? 'Обновляем…' : 'Загрузка…';
  el.refresh.disabled = true;

  try {
    const res = await fetch(API + (force ? '?refresh=1' : ''), {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });

    if (res.status === 401) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      return;
    }
    if (!res.ok) throw new Error('Прослойка ответила ' + res.status);

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Прослойка вернула ошибку');

    apply(data, res.headers.get('x-cache'));
  } catch (err) {
    await loadSnapshot(err);
  } finally {
    el.refresh.disabled = false;
  }
}

/** Резерв: снапшот из статики. Так каталог работает даже без прослойки. */
async function loadSnapshot(cause) {
  try {
    const res = await fetch(SNAPSHOT, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('Снапшот недоступен (' + res.status + ')');

    const data = await res.json();
    apply(
      {
        ok: true,
        source: 'snapshot',
        fetchedAt: data.fetchedAt || null,
        projects: data.projects || [],
        categories: [],
        count: (data.projects || []).length,
        hidden: 0,
        user: null,
        stale: true,
        warning: String(cause && cause.message ? cause.message : cause),
      },
      'SNAPSHOT'
    );
  } catch (err) {
    el.status.textContent = 'Данные не загрузились';
    banner('Каталог не загрузился: ' + message(cause) + '. Снапшот тоже недоступен: ' + message(err), true);
  }
}

function apply(data, cacheState) {
  state.projects = data.projects || [];
  state.meta = data;

  showUser(data.user);
  fillCategories(state.projects);
  render();

  const stamp = data.fetchedAt ? new Date(data.fetchedAt) : null;
  el.status.textContent = stamp
    ? 'Обновлено в ' + stamp.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : 'Готово';

  el.footSource.textContent =
    data.source === 'snapshot' ? 'Источник данных: снапшот в репозитории' : 'Источник данных: Google Таблица';
  el.footUpdated.textContent = stamp ? 'Прочитано: ' + stamp.toLocaleString('ru-RU') : '';

  if (data.source === 'snapshot') {
    banner('Показан снапшот из репозитория — прослойка к таблице сейчас недоступна' +
      (data.warning ? ' (' + data.warning + ')' : '') + '.');
  } else if (cacheState === 'STALE' || data.stale) {
    banner('Google Таблица не отвечает — показан последний удачно прочитанный список.');
  } else {
    hideBanner();
  }
}

/* --- Отрисовка ------------------------------------------------------------- */

function render() {
  const visible = filtered();

  renderKpis(visible);
  el.catalog.replaceChildren();

  if (!visible.length) {
    el.catalog.append(state.projects.length ? nothingFound() : emptyCatalog());
    return;
  }

  const pinned = visible.filter((project) => state.pins.includes(project.slug));
  if (pinned.length) el.catalog.append(group('Закреплённые', pinned));

  const rest = visible.filter((project) => !state.pins.includes(project.slug));
  for (const category of order(rest)) {
    el.catalog.append(group(category, rest.filter((project) => project.category === category)));
  }
}

function renderKpis(visible) {
  const counts = {
    all: visible.length,
    live: visible.filter((p) => p.status === 'live').length,
    dev: visible.filter((p) => p.status === 'dev').length,
    categories: new Set(visible.map((p) => p.category)).size,
  };

  const cards = [
    ['Дашбордов', counts.all, ''],
    ['Работают', counts.live, 'kpi--ok'],
    ['В разработке', counts.dev, counts.dev ? 'kpi--warn' : ''],
    ['Категорий', counts.categories, ''],
  ];

  el.kpis.replaceChildren(
    ...cards.map(([label, value, modifier]) => {
      const box = node('div', 'kpi' + (modifier ? ' ' + modifier : ''));
      box.append(node('div', 'kpi__value', String(value)), node('div', 'kpi__label', label));
      return box;
    })
  );
}

function group(title, projects) {
  const section = node('section', 'group');
  const head = node('div', 'group__head');
  head.append(node('h2', '', title), node('span', 'group__count', plural(projects.length)));

  const grid = node('div', 'grid');
  grid.append(...projects.map(card));

  section.append(head, grid);
  return section;
}

function card(project) {
  const box = node('article', 'card' + (project.status === 'paused' ? ' card--paused' : ''));

  const top = node('div', 'card__top');
  top.append(node('div', 'card__icon', project.icon || '📊', { 'aria-hidden': 'true' }));

  const title = node('div', 'card__title');
  const heading = node('h3');
  const link = node('a', 'card__link', project.title, {
    href: safeUrl(project.url) || '#',
    target: '_blank',
    rel: 'noopener noreferrer',
  });
  heading.append(link);
  title.append(heading, node('div', 'card__host', host(project.url)));
  top.append(title);

  const pin = node('button', 'card__pin', state.pins.includes(project.slug) ? '★' : '☆', {
    type: 'button',
    'aria-pressed': String(state.pins.includes(project.slug)),
    'aria-label': 'Закрепить «' + project.title + '»',
    title: 'Закрепить наверху',
  });
  pin.addEventListener('click', (event) => {
    event.preventDefault();
    togglePin(project.slug);
  });

  box.append(top, pin);
  if (project.description) box.append(node('p', 'card__desc', project.description));

  const meta = node('div', 'card__meta');
  meta.append(statusChip(project.status));
  for (const tag of (project.tags || []).slice(0, 4)) meta.append(node('span', 'chip', tag));
  if ((project.access || []).length && !isEveryone(project.access)) {
    meta.append(node('span', 'chip chip--access', 'Доступ: ' + project.access.join(', ')));
  }
  box.append(meta);

  const foot = node('div', 'card__foot');
  if (project.owner) foot.append(node('span', '', 'Ведёт: ' + project.owner));
  if (project.updated) foot.append(node('span', '', 'Обновлён: ' + project.updated));
  if (project.repo && safeUrl(project.repo)) {
    foot.append(node('a', '', 'Исходники', { href: safeUrl(project.repo), target: '_blank', rel: 'noopener noreferrer' }));
  }
  if (project.embed && safeUrl(project.url)) {
    const open = node('button', 'btn', 'Открыть здесь', { type: 'button' });
    open.addEventListener('click', (event) => {
      event.preventDefault();
      openViewer(project);
    });
    foot.append(open);
  }
  if (foot.childNodes.length) box.append(foot);

  return box;
}

function statusChip(status) {
  const chip = node('span', 'chip chip--' + status);
  chip.append(node('span', 'dot', '', { 'aria-hidden': 'true' }), document.createTextNode(STATUS_LABEL[status] || status));
  return chip;
}

function nothingFound() {
  const box = node('div', 'empty');
  box.append(
    node('h2', '', 'Ничего не нашлось'),
    node('p', '', 'Под фильтры не попал ни один дашборд. Сбросьте поиск или выберите другую категорию.')
  );
  return box;
}

/** Пустой каталог — это не ошибка, а инструкция: как завести первый проект. */
function emptyCatalog() {
  const box = node('div', 'empty');
  box.append(node('h2', '', 'Каталог пуст'));
  box.append(node('p', '', 'Дашборды берутся из листа «Проекты» Google Таблицы. Чтобы здесь появилась плитка:'));

  const steps = node('ol');
  for (const step of [
    'откройте таблицу реестра и допишите строку в лист «Проекты»;',
    'заполните хотя бы «Название» и «Ссылка» — остальное подставится само;',
    'нажмите «Обновить» здесь: плитка появится сразу, без деплоя.',
  ]) {
    steps.append(node('li', '', step));
  }
  box.append(steps);

  if (state.meta && state.meta.hidden) {
    box.append(node('p', '', 'Ещё ' + state.meta.hidden + ' проект(ов) скрыто: вам к ним не открыт доступ.'));
  }
  return box;
}

/* --- Фильтры --------------------------------------------------------------- */

function filtered() {
  const query = el.search.value.trim().toLowerCase();
  const category = el.category.value;
  const status = el.statusFilter.value;
  const onlyPinned = el.pinned.checked;

  return state.projects.filter((project) => {
    if (category && project.category !== category) return false;
    if (status && project.status !== status) return false;
    if (onlyPinned && !state.pins.includes(project.slug)) return false;
    if (!query) return true;

    return [project.title, project.description, project.category, project.url, project.owner]
      .concat(project.tags || [])
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
}

function fillCategories(projects) {
  const current = el.category.value;
  const categories = order(projects);

  el.category.replaceChildren(node('option', '', 'Все', { value: '' }));
  for (const category of categories) {
    el.category.append(node('option', '', category, { value: category }));
  }
  if (categories.includes(current)) el.category.value = current;
}

function order(projects) {
  return [...new Set(projects.map((project) => project.category))];
}

/* --- Закладки -------------------------------------------------------------- */

function loadPins() {
  try {
    const raw = JSON.parse(localStorage.getItem(PINS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function togglePin(slug) {
  state.pins = state.pins.includes(slug)
    ? state.pins.filter((item) => item !== slug)
    : [...state.pins, slug];
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(state.pins));
  } catch {}
  render();
}

/* --- Просмотр без ухода со страницы ---------------------------------------- */

function openViewer(project) {
  const url = safeUrl(project.url);
  if (!url) return;

  el.viewerTitle.textContent = project.title;
  el.viewerOpen.href = url;
  el.viewerFrame.src = url;
  el.viewer.hidden = false;
  document.body.style.overflow = 'hidden';
  el.viewerClose.focus();
}

function closeViewer() {
  el.viewer.hidden = true;
  el.viewerFrame.removeAttribute('src');
  document.body.style.overflow = '';
}

/* --- Пользователь ---------------------------------------------------------- */

function showUser(user) {
  if (!user) {
    el.user.hidden = true;
    return;
  }
  el.user.hidden = false;
  el.userName.textContent = user.name || user.email;
  el.userName.title = user.email;
  el.userRole.textContent = user.role === 'admin' ? 'админ' : user.role || '';
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {}
  location.href = '/login';
}

/* --- Мелочи ---------------------------------------------------------------- */

function node(tag, className, textContent, attrs) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (textContent != null && textContent !== '') element.textContent = textContent;
  for (const [key, value] of Object.entries(attrs || {})) element.setAttribute(key, value);
  return element;
}

function banner(text, isError = false) {
  el.banner.textContent = text;
  el.banner.className = 'banner' + (isError ? ' banner--error' : '');
  el.banner.hidden = false;
}

function hideBanner() {
  el.banner.hidden = true;
}

/** В href попадают только http(s) и свои относительные пути — никакого javascript:. */
function safeUrl(raw) {
  const value = String(raw || '').trim();
  if (value.startsWith('/')) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function host(raw) {
  try {
    return new URL(String(raw)).host;
  } catch {
    return String(raw || '');
  }
}

function isEveryone(access) {
  return access.some((item) => ['*', 'все', 'всем', 'all', 'any'].includes(item));
}

function plural(count) {
  const tail = count % 100 >= 11 && count % 100 <= 14 ? 5 : count % 10;
  const word = tail === 1 ? 'дашборд' : tail >= 2 && tail <= 4 ? 'дашборда' : 'дашбордов';
  return count + ' ' + word;
}

function message(err) {
  return String(err && err.message ? err.message : err);
}

/* --- Запуск ---------------------------------------------------------------- */

for (const control of [el.search, el.category, el.statusFilter, el.pinned]) {
  control.addEventListener('input', render);
}
el.refresh.addEventListener('click', () => load({ force: true }));
el.logout.addEventListener('click', logout);
el.viewerClose.addEventListener('click', closeViewer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.viewer.hidden) closeViewer();
});
window.bindThemeToggle(el.theme);

load();
setInterval(() => load({ quiet: true }), AUTO_REFRESH_MS);
