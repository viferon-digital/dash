/**
 * GEO-дашборд: кого языковые модели называют в ответах на запросы про
 * противовирусные препараты.
 *
 * Данные идут по цепочке Google Таблица → /api/geo → браузер. Прослойка отдаёт
 * журнал в компактном виде: отметки упоминаний упакованы в битовую маску, и
 * весь журнал целиком весит десятки килобайт. Поэтому фильтры ничего не
 * запрашивают заново — всё пересчитывается на месте.
 *
 * Метрики считаются по методике из листа «Пояснения»:
 *   доля голоса — сколько упоминаний препарата от всех упоминаний;
 *   лояльность модели — то же в пределах одной модели;
 *   соседство — сколько раз два препарата названы в одном ответе.
 * К ним добавлен охват ответов: в какой доле ответов препарат вообще появился.
 * Это разные вопросы, и на дашборде они разведены.
 *
 * Неразмеченные ответы (в листе пустые ячейки препаратов) не участвуют ни в
 * одном знаменателе: пустая ячейка — это «ещё не смотрели», а не «не упомянут».
 */

const API = '/api/geo';
const SNAPSHOT = 'data/fallback.json';
const ANSWER = '/api/answer';
const AUTO_REFRESH_MS = 15 * 60 * 1000;
const TABLE_PAGE = 50;
const DEFAULT_BRAND = 'Виферон';

const el = (id) => document.getElementById(id);
const ui = {
  status: el('status'), banner: el('banner'), refresh: el('refresh'), theme: el('theme'),
  brand: el('f-brand'), from: el('f-from'), to: el('f-to'), model: el('f-model'),
  query: el('f-query'), hit: el('f-hit'),
  kpis: el('kpis'),
  rank: el('rank'), rankNote: el('rank-note'), mShare: el('m-share'), mReach: el('m-reach'),
  queries: el('queries'), queriesNote: el('queries-note'),
  models: el('models'), modelsLegend: el('models-legend'),
  neighbors: el('neighbors'), neighborsNote: el('neighbors-note'),
  timeline: el('timeline'), timelineNote: el('timeline-note'),
  tbody: el('tbody'), tableNote: el('table-note'), tableMore: el('table-more'), csv: el('csv'),
  footSource: el('foot-source'), footUpdated: el('foot-updated'),
  tip: el('tip'), modal: el('modal'), modalTitle: el('modal-title'),
  modalBody: el('modal-body'), modalClose: el('modal-close'),
};

const state = { data: null, focus: 0, metric: 'share', shown: TABLE_PAGE };

/* --- Загрузка -------------------------------------------------------------- */

async function load({ force = false, quiet = false } = {}) {
  if (!quiet) ui.status.textContent = force ? 'Обновляем…' : 'Загрузка данных…';
  ui.refresh.disabled = true;

  try {
    const res = await fetch(API + (force ? '?refresh=1' : ''), { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('Прослойка ответила ' + res.status);

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Прослойка вернула ошибку');
    apply(data, res.headers.get('x-cache'));
  } catch (err) {
    await loadSnapshot(err);
  } finally {
    ui.refresh.disabled = false;
  }
}

/** Резерв: снапшот в статике. Дашборд работает даже без прослойки. */
async function loadSnapshot(cause) {
  try {
    const res = await fetch(SNAPSHOT, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('Снапшот недоступен (' + res.status + ')');
    const data = await res.json();
    apply({ ...data, source: 'snapshot' }, 'SNAPSHOT');
    banner('Показан снапшот из репозитория — прослойка сейчас недоступна (' + message(cause) + '). Тексты ответов в этом режиме не открываются.');
  } catch (err) {
    ui.status.textContent = 'Данные не загрузились';
    banner('Данные не загрузились: ' + message(cause) + '. Снапшот тоже недоступен: ' + message(err), true);
  }
}

function apply(data, cacheState) {
  state.data = data;
  fillControls(data);
  render();

  const stamp = data.fetchedAt ? new Date(data.fetchedAt) : null;
  ui.status.textContent = stamp
    ? 'Обновлено в ' + stamp.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : 'Готово';
  ui.footSource.textContent = data.source === 'snapshot'
    ? 'Источник: снапшот в репозитории'
    : 'Источник: Google Таблица, лист «' + (data.sheet || 'Data') + '»';
  ui.footUpdated.textContent = stamp ? 'Прочитано: ' + stamp.toLocaleString('ru-RU') : '';

  if (cacheState === 'STALE') {
    banner('Google Таблица не отвечает — показан последний удачно прочитанный замер.');
  } else if (data.source !== 'snapshot') {
    unscoredBanner(data);
  }
}

/** Неразмеченные ответы — не мелочь: без предупреждения их примут за провал. */
function unscoredBanner(data) {
  const left = data.totals.unscored;
  if (!left) return hideBanner();

  const dates = new Set();
  for (const row of data.rows) if (!row[4]) dates.add(data.dates[row[0]]);
  const list = [...dates].sort();
  const span = list.length > 1 ? human(list[0]) + ' — ' + human(list[list.length - 1]) : human(list[0]);

  banner(
    'Ещё не размечено ' + left + ' из ' + data.totals.answers + ' ответов (' + span + '): ' +
    'в таблице у них пустые колонки препаратов. Такие ответы не входят ни в один расчёт — ' +
    'иначе свежий замер выглядел бы как обвал видимости. В таблице внизу они помечены.'
  );
}

/* --- Выборка --------------------------------------------------------------- */

/** Строки под фильтрами. Неразмеченные помечены — метрики их не считают. */
function selection() {
  const d = state.data;
  const from = ui.from.value;
  const to = ui.to.value;
  const model = ui.model.value === '' ? -1 : Number(ui.model.value);
  const query = ui.query.value === '' ? -1 : Number(ui.query.value);
  const onlyHit = ui.hit.checked;
  const bit = 1 << state.focus;

  return d.rows.filter((row) => {
    const date = d.dates[row[0]];
    if (from && date < from) return false;
    if (to && date > to) return false;
    if (model !== -1 && row[1] !== model) return false;
    if (query !== -1 && row[2] !== query) return false;
    if (onlyHit && !(row[4] && row[3] & bit)) return false;
    return true;
  });
}

/** Счётчики по выборке: упоминания каждого препарата и знаменатели. */
function tally(rows) {
  const d = state.data;
  const mentions = new Array(d.brands.length).fill(0);
  let scored = 0;
  let total = 0;

  for (const row of rows) {
    if (!row[4]) continue;
    scored += 1;
    for (let i = 0; i < d.brands.length; i += 1) {
      if (row[3] & (1 << i)) {
        mentions[i] += 1;
        total += 1;
      }
    }
  }
  return { mentions, scored, total, unscored: rows.length - scored };
}

/* --- Отрисовка ------------------------------------------------------------- */

function render() {
  state.shown = TABLE_PAGE;
  const rows = selection();
  const stats = tally(rows);

  renderKpis(rows, stats);
  renderRank(stats);
  renderQueries(rows);
  renderModels(rows);
  renderNeighbors(rows, stats);
  renderTimeline(rows);
  renderTable(rows, stats);
}

function renderKpis(rows, stats) {
  const d = state.data;
  const focus = state.focus;
  const name = d.brands[focus];

  const share = stats.total ? stats.mentions[focus] / stats.total : 0;
  const reach = stats.scored ? stats.mentions[focus] / stats.scored : 0;
  const order = [...stats.mentions.keys()].sort((a, b) => stats.mentions[b] - stats.mentions[a]);
  const place = order.indexOf(focus) + 1;

  const cards = [
    ['Доля голоса', percent(share), name + ' среди всех упоминаний', 'kpi--focus'],
    ['Место в рейтинге', place + ' из ' + d.brands.length, 'по числу упоминаний', ''],
    ['Охват ответов', percent(reach), 'в стольких ответах его назвали', 'kpi--focus'],
    ['Ответов в расчёте', String(stats.scored), stats.unscored ? '+ ' + stats.unscored + ' ждут разметки' : 'все размечены', ''],
    ['Моделей · запросов', countDistinct(rows, 1) + ' · ' + countDistinct(rows, 2), 'под наблюдением', ''],
  ];

  ui.kpis.replaceChildren(...cards.map(([label, value, note, mod]) => {
    const box = node('div', 'kpi' + (mod ? ' ' + mod : ''));
    box.append(node('div', 'kpi__value', value), node('div', 'kpi__label', label), node('div', 'kpi__note', note));
    return box;
  }));
}

/** Рейтинг: одна серия, фокусный препарат выделен заливкой и начертанием. */
function renderRank(stats) {
  const d = state.data;
  const byShare = state.metric === 'share';
  const denom = byShare ? stats.total : stats.scored;

  ui.rankNote.textContent = byShare
    ? 'Доля от всех ' + stats.total + ' упоминаний в выборке. Так считает лист «Доля голоса».'
    : 'В какой доле из ' + stats.scored + ' размеченных ответов препарат вообще назван. Сумма больше 100%: в одном ответе называют несколько.';

  const order = [...d.brands.keys()].sort((a, b) => stats.mentions[b] - stats.mentions[a]);
  const max = Math.max(...stats.mentions, 1);

  ui.rank.replaceChildren(...order.map((i) => bar({
    name: d.brands[i],
    value: denom ? stats.mentions[i] / denom : 0,
    width: stats.mentions[i] / max,
    count: stats.mentions[i],
    focus: i === state.focus,
    tip: d.brands[i] + ': ' + stats.mentions[i] + ' упоминаний' +
         (denom ? ' · ' + percent(stats.mentions[i] / denom) : ''),
  })));
}

/**
 * Общее начало всех запросов. Все восемнадцать начинаются одинаково
 * («Топ 10 противовирусных …»), и в узкой подписи от запроса оставалось бы
 * ровно это общее начало — то есть ничего. Считаем общий префикс по словам и
 * убираем его из подписей, полный текст остаётся в подсказке.
 */
function commonPrefix(queries) {
  const split = queries.map((q) => String(q).replace(/\s+/g, ' ').trim().split(' '));
  if (split.length < 2) return '';
  let take = 0;
  while (take < split[0].length - 1) {
    const word = split[0][take];
    if (!split.every((words) => words[take] === word)) break;
    take += 1;
  }
  return split[0].slice(0, take).join(' ');
}

/** Запросы: где фокусный препарат выпадает. Худшие сверху — это список задач. */
function renderQueries(rows) {
  const d = state.data;
  const bit = 1 << state.focus;
  const per = d.queries.map(() => ({ n: 0, hit: 0 }));

  for (const row of rows) {
    if (!row[4]) continue;
    per[row[2]].n += 1;
    if (row[3] & bit) per[row[2]].hit += 1;
  }

  const present = [...d.queries.keys()].filter((i) => per[i].n > 0);
  const prefix = commonPrefix(d.queries);
  // Пробелы приводим к одному: в одном из запросов их два подряд, и без
  // нормализации общее начало у него не отрезалось бы.
  const short = (q) => {
    const flat = String(q).replace(/\s+/g, ' ').trim();
    return prefix && flat.startsWith(prefix) ? flat.slice(prefix.length).trim() : flat;
  };

  ui.queriesNote.textContent = present.length
    ? 'Доля ответов с «' + d.brands[state.focus] + '» по каждому запросу, реже всего — сверху.' +
      (prefix ? ' Общее начало «' + prefix + '» в подписях убрано.' : '')
    : 'Под фильтры не попал ни один размеченный ответ.';

  const order = present.sort((a, b) => per[a].hit / per[a].n - per[b].hit / per[b].n);
  ui.queries.replaceChildren(...order.map((i) => bar({
    name: short(d.queries[i]),
    full: d.queries[i],
    value: per[i].hit / per[i].n,
    width: per[i].hit / per[i].n,
    count: per[i].hit + '/' + per[i].n,
    focus: false,
    zero: per[i].hit === 0,
    tip: d.queries[i] + '\n' + per[i].hit + ' из ' + per[i].n + ' ответов',
  })));
}

/** Лояльность моделей: тепловая карта модель × препарат. */
function renderModels(rows) {
  const d = state.data;
  const per = d.models.map(() => ({ mentions: new Array(d.brands.length).fill(0), total: 0, answers: 0 }));

  for (const row of rows) {
    if (!row[4]) continue;
    const m = per[row[1]];
    m.answers += 1;
    for (let i = 0; i < d.brands.length; i += 1) {
      if (row[3] & (1 << i)) { m.mentions[i] += 1; m.total += 1; }
    }
  }

  const used = [...d.models.keys()].filter((i) => per[i].answers > 0);
  const table = node('table');
  const head = node('tr');
  head.append(node('th', '', 'Модель'), ...d.brands.map((b, i) => {
    const th = node('th', i === state.focus ? 'col-focus' : '', b);
    return th;
  }));
  table.append(node('thead', '', '', {}, [head]));

  const body = node('tbody');
  // Модели сверху вниз — от самой щедрой к фокусному препарату.
  const order = used.sort((a, b) =>
    (per[b].mentions[state.focus] / (per[b].total || 1)) - (per[a].mentions[state.focus] / (per[a].total || 1))
  );

  for (const m of order) {
    const tr = node('tr');
    tr.append(node('th', '', d.models[m], { title: d.models[m] + ' · ' + per[m].answers + ' ответов' }));
    for (let i = 0; i < d.brands.length; i += 1) {
      const value = per[m].total ? per[m].mentions[i] / per[m].total : 0;
      // Ненулевая доля, которая округляется в ноль, — это «<1», а не «0»:
      // иначе редкое упоминание не отличить от полного отсутствия.
      const shown = !value ? '·' : value * 100 < 0.5 ? '<1' : String(Math.round(value * 100));
      const td = node('td', i === state.focus ? 'col-focus' : '', shown);
      if (value) {
        const step = rampStep(value);
        td.style.background = 'var(--s' + step + ')';
        td.style.color = step >= 5 ? 'var(--s-ink-hi)' : 'var(--s-ink-lo)';
      } else {
        td.className += ' is-empty';
      }
      tipOn(td, d.models[m] + '\n' + d.brands[i] + ': ' + per[m].mentions[i] + ' упом. · ' + percent(value) + ' от упоминаний модели');
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  ui.models.replaceChildren(table);

  ui.modelsLegend.replaceChildren(
    node('span', '', 'Реже'),
    node('div', 'legend__steps', '', {}, [0, 1, 2, 3, 4, 5, 6].map((s) => {
      const box = node('div', 'legend__step');
      box.style.background = 'var(--s' + s + ')';
      return box;
    })),
    node('span', '', 'Чаще'),
    node('span', '', '· числа в ячейках — проценты от упоминаний модели')
  );
}

/** Соседство: с кем фокусный препарат чаще всего называют в одном ответе. */
function renderNeighbors(rows, stats) {
  const d = state.data;
  const bit = 1 << state.focus;
  const together = new Array(d.brands.length).fill(0);
  let own = 0;

  for (const row of rows) {
    if (!row[4] || !(row[3] & bit)) continue;
    own += 1;
    for (let i = 0; i < d.brands.length; i += 1) {
      if (i !== state.focus && row[3] & (1 << i)) together[i] += 1;
    }
  }

  ui.neighborsNote.textContent = own
    ? 'В ' + own + ' ответах с «' + d.brands[state.focus] + '» рядом называли:'
    : 'В выборке нет ответов с «' + d.brands[state.focus] + '».';

  const order = [...d.brands.keys()]
    .filter((i) => i !== state.focus)
    .sort((a, b) => together[b] - together[a]);
  const max = Math.max(...together, 1);

  ui.neighbors.replaceChildren(...order.map((i) => bar({
    name: d.brands[i],
    value: own ? together[i] / own : 0,
    width: together[i] / max,
    count: together[i],
    focus: false,
    zero: together[i] === 0,
    tip: 'Вместе с «' + d.brands[state.focus] + '» — ' + together[i] + ' раз' +
         (own ? ' (' + percent(together[i] / own) + ' его ответов)' : ''),
  })));
}

/**
 * Динамика: столбец на замер. Высота столбца — сколько ответов размечено в этот
 * день, заливка — сколько из них с фокусным препаратом. Так виден и результат,
 * и то, на скольких ответах он держится: замеры разного размера.
 */
function renderTimeline(rows) {
  const d = state.data;
  const bit = 1 << state.focus;
  const per = d.dates.map(() => ({ n: 0, hit: 0, pending: 0 }));

  for (const row of rows) {
    if (row[4]) {
      per[row[0]].n += 1;
      if (row[3] & bit) per[row[0]].hit += 1;
    } else {
      per[row[0]].pending += 1;
    }
  }

  const used = [...d.dates.keys()].filter((i) => per[i].n + per[i].pending > 0).sort((a, b) => d.dates[a] < d.dates[b] ? -1 : 1);
  const max = Math.max(...used.map((i) => per[i].n + per[i].pending), 1);

  ui.timelineNote.textContent =
    'Высота столбца — сколько ответов в замере, заливка — доля с «' + d.brands[state.focus] + '». ' +
    'Штриховка — замер ещё не размечен.';

  ui.timeline.replaceChildren(...used.map((i) => {
    const item = per[i];
    const total = item.n + item.pending;
    const box = node('div', 'tl');
    const col = node('div', 'tl__col' + (item.n === 0 ? ' tl__col--empty' : ''));
    col.style.height = Math.round((total / max) * 150) + 'px';

    if (item.n) {
      const fill = node('div', 'tl__fill');
      fill.style.height = Math.round((item.hit / item.n) * 100) + '%';
      col.append(fill);
    }
    tipOn(col, human(d.dates[i]) + '\n' + (item.n
      ? item.hit + ' из ' + item.n + ' ответов · ' + percent(item.hit / item.n)
      : total + ' ответов, ещё не размечены'));

    box.append(col, node('div', 'tl__label', human(d.dates[i]).slice(0, 5)));
    return box;
  }));
}

function renderTable(rows, stats) {
  const d = state.data;
  const shown = rows.slice(0, state.shown);

  ui.tableNote.textContent =
    'Показано ' + shown.length + ' из ' + rows.length + ' ответов в выборке' +
    (stats.unscored ? ' · неразмеченных среди них ' + stats.unscored : '') + '.';

  ui.tbody.replaceChildren(...shown.map((row) => {
    const tr = node('tr');
    tr.append(node('td', 'nowrap', human(d.dates[row[0]])));
    tr.append(node('td', 'nowrap', d.models[row[1]]));
    tr.append(node('td', '', d.queries[row[2]]));

    const chips = node('div', 'chips');
    if (!row[4]) {
      chips.append(node('span', 'chip chip--none', 'не размечено'));
    } else {
      const named = [...d.brands.keys()].filter((i) => row[3] & (1 << i));
      if (!named.length) chips.append(node('span', 'chip chip--none', 'никого'));
      for (const i of named) {
        chips.append(node('span', 'chip' + (i === state.focus ? ' chip--focus' : ''), d.brands[i]));
      }
    }
    tr.append(node('td', '', '', {}, [chips]));

    const open = node('button', 'btn', 'Текст', { type: 'button' });
    open.addEventListener('click', () => showAnswer(row));
    tr.append(node('td', 'nowrap', '', {}, [open]));
    return tr;
  }));

  ui.tableMore.replaceChildren();
  if (rows.length > shown.length) {
    const left = rows.length - shown.length;
    const more = node('button', 'btn', 'Показать ещё ' + Math.min(TABLE_PAGE, left), { type: 'button' });
    more.addEventListener('click', () => {
      state.shown += TABLE_PAGE;
      renderTable(selection(), tally(selection()));
    });
    ui.tableMore.append(more, node('span', 'muted', ' Осталось ' + left + '. Вся выборка — в выгрузке CSV.'));
  }
}

/* --- Текст ответа ---------------------------------------------------------- */

async function showAnswer(row) {
  const d = state.data;
  ui.modalTitle.replaceChildren(
    node('b', '', d.queries[row[2]]),
    document.createTextNode(d.models[row[1]] + ' · ' + human(d.dates[row[0]]))
  );
  ui.modalBody.textContent = 'Загружаем текст ответа…';
  ui.modal.hidden = false;
  document.body.style.overflow = 'hidden';
  ui.modalClose.focus();

  try {
    const res = await fetch(ANSWER + '?row=' + row[5], { headers: { accept: 'application/json' } });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'ответ ' + res.status);
    ui.modalBody.textContent = data.text || '(в таблице пусто)';
  } catch (err) {
    ui.modalBody.textContent = 'Не удалось загрузить текст: ' + message(err);
  }
}

function closeModal() {
  ui.modal.hidden = true;
  document.body.style.overflow = '';
}

/* --- CSV ------------------------------------------------------------------- */

function exportCsv() {
  const d = state.data;
  const rows = selection();
  const head = ['Дата', 'Модель', 'Запрос', 'Размечено', ...d.brands];
  const lines = [head, ...rows.map((row) => [
    human(d.dates[row[0]]), d.models[row[1]], d.queries[row[2]], row[4] ? 'да' : 'нет',
    ...d.brands.map((_, i) => (row[4] ? (row[3] & (1 << i) ? '1' : '0') : '')),
  ])];

  const csv = '﻿' + lines.map((line) => line.map(csvCell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'geo-' + new Date().toISOString().slice(0, 10) + '.csv';
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value);
  return /[";\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/* --- Элементы -------------------------------------------------------------- */

/** Одна полоса: имя, дорожка с заливкой, подпись значением. */
function bar({ name, full, value, width, count, focus, zero, tip }) {
  const box = node('div', 'bar' + (focus ? ' bar--focus' : '') + (zero ? ' bar--zero' : ''));
  const track = node('div', 'bar__track');
  const fill = node('div', 'bar__fill');
  fill.style.width = Math.max(0, Math.min(1, width || 0)) * 100 + '%';
  track.append(fill);

  box.append(
    node('div', 'bar__name', name, { title: full || name }),
    track,
    node('div', 'bar__value', percent(value) + ' · ' + count)
  );
  if (tip) tipOn(box, tip);
  return box;
}

function fillControls(data) {
  const keep = (select, values, labels, current) => {
    select.replaceChildren(...values.map((v, i) => node('option', '', labels[i], { value: String(v) })));
    if (current !== null && values.map(String).includes(String(current))) select.value = String(current);
  };

  const before = ui.brand.value;
  keep(ui.brand, data.brands.map((_, i) => i), data.brands, before || data.brands.indexOf(DEFAULT_BRAND));
  if (ui.brand.value === '') ui.brand.value = String(Math.max(0, data.brands.indexOf(DEFAULT_BRAND)));
  state.focus = Number(ui.brand.value) || 0;

  const dates = [...data.dates].sort();
  const fromBefore = ui.from.value;
  const toBefore = ui.to.value;
  keep(ui.from, dates, dates.map(human), fromBefore || dates[0]);
  keep(ui.to, dates, dates.map(human), toBefore || dates[dates.length - 1]);

  ui.model.replaceChildren(node('option', '', 'Все', { value: '' }),
    ...data.models.map((m, i) => node('option', '', m, { value: String(i) })));
  ui.query.replaceChildren(node('option', '', 'Все', { value: '' }),
    ...data.queries.map((q, i) => node('option', '', q, { value: String(i) })));
}

function node(tag, className, textContent, attrs, children) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (textContent !== undefined && textContent !== null && textContent !== '') element.textContent = textContent;
  for (const [key, value] of Object.entries(attrs || {})) element.setAttribute(key, value);
  for (const child of children || []) element.append(child);
  return element;
}

/* --- Подсказка ------------------------------------------------------------- */

function tipOn(element, text) {
  element.addEventListener('pointerenter', (event) => {
    ui.tip.textContent = text;
    ui.tip.hidden = false;
    moveTip(event);
  });
  element.addEventListener('pointermove', moveTip);
  element.addEventListener('pointerleave', () => { ui.tip.hidden = true; });
}

function moveTip(event) {
  const pad = 14;
  const box = ui.tip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + box.width > innerWidth - 8) x = event.clientX - box.width - pad;
  if (y + box.height > innerHeight - 8) y = event.clientY - box.height - pad;
  ui.tip.style.left = Math.max(8, x) + 'px';
  ui.tip.style.top = Math.max(8, y) + 'px';
}

/* --- Мелочи ---------------------------------------------------------------- */

/** Значение 0…1 → ступень последовательной шкалы. Шкала кончается на 30%:
 *  выше этого доли почти не встречаются, и весь верх был бы одного цвета. */
function rampStep(value) {
  const steps = [0.02, 0.05, 0.09, 0.14, 0.20, 0.28];
  let step = 0;
  while (step < steps.length && value > steps[step]) step += 1;
  return step;
}

function percent(value) {
  if (!Number.isFinite(value)) return '—';
  const pct = value * 100;
  return (pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10) + '%';
}

function countDistinct(rows, at) {
  return new Set(rows.map((row) => row[at])).size;
}

/** «2026-04-08» → «08.04.2026» */
function human(iso) {
  const parts = String(iso || '').split('-');
  return parts.length === 3 ? parts[2] + '.' + parts[1] + '.' + parts[0] : String(iso || '');
}

function banner(text, isError = false) {
  ui.banner.textContent = text;
  ui.banner.className = 'banner' + (isError ? ' banner--error' : '');
  ui.banner.hidden = false;
}

function hideBanner() { ui.banner.hidden = true; }

function message(err) { return String(err && err.message ? err.message : err); }

/* --- Запуск ---------------------------------------------------------------- */

ui.brand.addEventListener('change', () => { state.focus = Number(ui.brand.value) || 0; render(); });
for (const control of [ui.from, ui.to, ui.model, ui.query, ui.hit]) {
  control.addEventListener('change', render);
}
ui.mShare.addEventListener('click', () => setMetric('share'));
ui.mReach.addEventListener('click', () => setMetric('reach'));

function setMetric(metric) {
  state.metric = metric;
  ui.mShare.setAttribute('aria-pressed', String(metric === 'share'));
  ui.mReach.setAttribute('aria-pressed', String(metric === 'reach'));
  renderRank(tally(selection()));
}

ui.refresh.addEventListener('click', () => load({ force: true }));
ui.csv.addEventListener('click', exportCsv);
ui.modalClose.addEventListener('click', closeModal);
ui.modal.addEventListener('click', (event) => { if (event.target === ui.modal) closeModal(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !ui.modal.hidden) closeModal(); });
window.bindThemeToggle(ui.theme);

load();
setInterval(() => load({ quiet: true }), AUTO_REFRESH_MS);
