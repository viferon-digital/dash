/**
 * Чтение листа GEO-трекинга из Google Таблицы.
 *
 * Лист «Data» — журнал замеров: одна строка = один ответ одной модели на один
 * запрос, плюс 14 колонок-отметок «упомянут ли препарат».
 *
 *   Дата | Текст | Модель | Запрос | Анаферон | Арбидол | Виферон | …
 *
 * Колонку «Текст» сюда не берём намеренно: полные ответы моделей весят около
 * четырёх мегабайт, и возить их в браузер ради таблицы незачем. Текст
 * догружается по одному, когда его открывают, — этим занимается /api/answer.
 *
 * Отметки брендов пакуются в битовую маску: 14 колонок нулей и единиц — это
 * один int вместо четырнадцати полей. Весь журнал целиком уезжает в браузер
 * компактным, и фильтры пересчитывают всё мгновенно и без похода на сервер.
 */

/** Колонки листа: A — дата, C — модель, D — запрос, E…R — препараты. */
const GRID = 'select A, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R';

export async function loadGeo(sheetId, sheetName) {
  const table = await query(sheetId, sheetName, GRID);

  const labels = (table.cols || []).map((col) => text(col && (col.label || col.id)));
  const brands = labels.slice(3);

  const dates = new Index();
  const models = new Index();
  const queries = new Index();
  const rows = [];

  let scoredCount = 0;
  let mentions = 0;

  (table.rows || []).forEach((row, position) => {
    const cells = (row.c || []).map((cell) => (cell ? (cell.v != null ? cell.v : cell.f) : null));
    const date = normalizeDate(text(cells[0]));
    const model = text(cells[1]);
    const q = text(cells[2]);
    if (!date && !model && !q) return; // пустой хвост листа

    // Размечена ли строка. Пустые ячейки — это «ещё не разметили», а не «ноль»:
    // считать их нулями значило бы записать свежий замер в провал.
    let mask = 0;
    let scored = false;
    for (let i = 0; i < brands.length; i += 1) {
      const raw = cells[3 + i];
      if (raw === null || raw === undefined || raw === '') continue;
      scored = true;
      if (Number(raw) > 0) {
        mask |= 1 << i;
        mentions += 1;
      }
    }
    if (scored) scoredCount += 1;

    rows.push([dates.of(date), models.of(model), queries.of(q), mask, scored ? 1 : 0, position]);
  });

  return {
    ok: true,
    source: 'google-sheets',
    sheet: sheetName,
    fetchedAt: new Date().toISOString(),
    brands,
    dates: dates.values,
    models: models.values,
    queries: queries.values,
    rows,
    totals: {
      answers: rows.length,
      scored: scoredCount,
      unscored: rows.length - scoredCount,
      mentions,
    },
  };
}

/** Текст одного ответа. Отдельным запросом — он тяжёлый и нужен по одному. */
export async function loadAnswer(sheetId, sheetName, position) {
  const table = await query(sheetId, sheetName, 'select B limit 1 offset ' + Math.max(0, Math.trunc(position)));
  const row = (table.rows || [])[0];
  const cell = row && (row.c || [])[0];
  return cell ? text(cell.v != null ? cell.v : cell.f) : '';
}

/* --- Словари ---------------------------------------------------------------- */

/** Строка → номер в словаре. Так журнал ссылается на значения числами. */
class Index {
  constructor() {
    this.values = [];
    this.map = new Map();
  }

  of(value) {
    if (this.map.has(value)) return this.map.get(value);
    const at = this.values.length;
    this.values.push(value);
    this.map.set(value, at);
    return at;
  }
}

/* --- gviz ------------------------------------------------------------------- */

export async function query(sheetId, sheetName, tq) {
  const src =
    'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(sheetId) + '/gviz/tq' +
    '?tqx=out:json&headers=1' +
    (sheetName ? '&sheet=' + encodeURIComponent(sheetName) : '') +
    '&tq=' + encodeURIComponent(tq);

  const res = await fetch(src, {
    headers: { 'user-agent': 'viferon-geo/1.0' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) {
    throw new Error('Google Sheets ответил ' + res.status + ' (лист «' + sheetName + '»)');
  }
  return parseGviz(await res.text(), sheetName);
}

/** gviz отдаёт JS-обёртку `/*O_o*\/google.visualization.Query.setResponse({...});` */
function parseGviz(body, sheetName) {
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Неожиданный формат ответа gviz');

  const data = JSON.parse(body.slice(start, end + 1));
  if (data.status === 'error') {
    const reason = (data.errors || []).map((e) => e.detailed_message || e.message).join('; ');
    throw new Error((reason || 'gviz вернул ошибку') + ' (лист «' + sheetName + '»)');
  }
  if (!data.table) throw new Error('В ответе gviz нет таблицы (лист «' + sheetName + '»)');
  return data.table;
}

/* --- Мелочи ----------------------------------------------------------------- */

/** «08.04.2026» → «2026-04-08». Строки в таком виде сортируются как даты. */
function normalizeDate(value) {
  const parts = String(value).trim().split(/[.\-/]/);
  if (parts.length === 3 && parts[0].length <= 2) {
    const [d, m, y] = parts;
    return y.padStart(4, '20') + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
  }
  return String(value).trim();
}

function text(value) {
  return value == null ? '' : String(value).trim();
}
