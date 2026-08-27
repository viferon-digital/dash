/**
 * Реестр проектов — лист Google Таблицы. Одна строка = одна плитка на главной:
 *
 *   Слаг | Название | Описание | Ссылка | Категория | Иконка | Статус |
 *   Порядок | Доступ | Теги | Владелец | Репозиторий | Встраивание | Обновлён
 *
 * Обязательны только «Название» и «Ссылка»: остального либо нет на плитке,
 * либо оно достраивается само (слаг из названия, порядок — из позиции строки).
 * Колонки ищутся по подстроке в заголовке, поэтому их можно переименовывать и
 * переставлять; если заголовок не распознан, берётся позиция колонки.
 */

import { readSheet, mapRows } from './sheets.js';

const SCHEMA = {
  slug:        { match: ['слаг', 'slug', 'код', 'ключ'],                 at: 0 },
  title:       { match: ['назван', 'title', 'дашборд'],                  at: 1 },
  description: { match: ['опис', 'что показ', 'descr'],                  at: 2 },
  url:         { match: ['ссыл', 'url', 'link', 'адрес'],                at: 3 },
  category:    { match: ['категор', 'раздел', 'группа'],                 at: 4 },
  icon:        { match: ['иконк', 'значок', 'эмодзи', 'icon', 'emoji'],  at: 5 },
  status:      { match: ['статус', 'состоян', 'state'],                  at: 6 },
  order:       { match: ['порядок', 'сортир', 'order', '№'],             at: 7 },
  access:      { match: ['доступ', 'кому', 'видно'],                     at: 8 },
  tags:        { match: ['тег', 'метк', 'tag'],                          at: 9 },
  owner:       { match: ['владел', 'ответств', 'owner'],                 at: 10 },
  repo:        { match: ['репозит', 'github', 'исходн', 'repo'],         at: 11 },
  embed:       { match: ['встраив', 'iframe', 'embed'],                  at: 12 },
  updated:     { match: ['обнов', 'дата', 'updated'],                    at: 13 },
};

/**
 * Статусы приводим к трём: работает, в разработке, приостановлен. Порядок
 * важен: «в разработке» проверяется раньше «работает», иначе «разРАБОТке»
 * поймается подстрокой «работ». Короткие слова сверяются целиком — подстрокой
 * они цепляют что попало.
 */
const STATUS = [
  {
    key: 'dev',
    label: 'В разработке',
    match: ['разраб', 'бета', 'beta', 'тест', 'test'],
    equals: ['dev', 'wip', 'draft', 'черновик'],
  },
  {
    key: 'paused',
    label: 'Приостановлен',
    match: ['пауз', 'останов', 'архив', 'archive', 'заморож'],
    equals: ['off', 'выкл', 'stop', 'нет'],
  },
  {
    key: 'live',
    label: 'Работает',
    match: ['работ', 'рабоч', 'продакш', 'боев'],
    equals: ['live', 'prod', 'ок', 'ok', 'да', 'on', 'вкл', 'активен', 'активна', 'активный'],
  },
];

/** Читает лист реестра и приводит его к схеме ответа `/api/projects`. */
export async function loadProjects(env) {
  const sheetId = env.SHEET_ID;
  const sheetName = env.PROJECTS_SHEET || 'Проекты';
  const sheet = await readSheet(env, sheetId, sheetName);

  return {
    ok: true,
    source: 'google-sheets',
    sheet: sheetName,
    fetchedAt: new Date().toISOString(),
    projects: normalize(mapRows(sheet, SCHEMA)),
  };
}

/** Общая нормализация: одинаково работает и для листа, и для снапшота. */
export function normalize(rows) {
  return rows
    .map((row, position) => {
      const title = row.title || row.slug;
      const url = row.url;
      if (!title || !url) return null;
      if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) return null;

      return {
        slug: slugify(row.slug || title),
        title,
        description: row.description,
        url,
        category: row.category || 'Дашборды',
        icon: row.icon || '📊',
        status: status(row.status),
        order: Number.isFinite(Number(row.order)) && row.order !== '' ? Number(row.order) : position + 1,
        access: split(row.access),
        tags: split(row.tags, false),
        owner: row.owner,
        repo: row.repo,
        embed: yes(row.embed),
        updated: row.updated,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ru'));
}

export function statusLabel(key) {
  const found = STATUS.find((item) => item.key === key);
  return found ? found.label : 'Неизвестно';
}

function status(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return 'live';
  const found = STATUS.find(
    (item) =>
      (item.equals || []).includes(value) ||
      (item.match || []).some((needle) => value.includes(needle))
  );
  return found ? found.key : 'live';
}

/**
 * Слаг из произвольного названия: латиница из кириллицы, всё остальное — дефис.
 * Нужен, чтобы строку в таблице можно было завести, не придумывая идентификатор.
 */
export function slugify(value) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
    э: 'e', ю: 'yu', я: 'ya',
  };
  return String(value)
    .toLowerCase()
    .split('')
    .map((ch) => (map[ch] != null ? map[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'project';
}

function split(value, lower = true) {
  return String(value || '')
    .split(/[,;\n]/)
    .map((item) => (lower ? item.trim().toLowerCase() : item.trim()))
    .filter(Boolean);
}

function yes(value) {
  return ['да', 'yes', 'true', '1', '+', 'вкл'].includes(String(value || '').trim().toLowerCase());
}
