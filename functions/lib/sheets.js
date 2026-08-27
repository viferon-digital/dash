/**
 * Чтение Google Таблиц из Cloudflare Pages Functions. Два способа, оба
 * возвращают одну и ту же форму `{ headers: string[], rows: string[][] }`:
 *
 *  1. gviz — для таблиц с доступом «любой, у кого есть ссылка — читатель».
 *     Ничего настраивать не нужно, но таблицу может прочитать любой, кто знает
 *     её id. Годится для реестра проектов: там нет секретов.
 *
 *  2. Sheets API v4 через сервисный аккаунт — для закрытых таблиц. Таблица
 *     расшарена только на почту сервисного аккаунта, по ссылке недоступна.
 *     Это единственный правильный способ хранить список доступа: он не должен
 *     читаться посторонними.
 *
 * Способ выбирается сам: если в окружении есть GOOGLE_SA_EMAIL и GOOGLE_SA_KEY —
 * идём через сервисный аккаунт, иначе через gviz.
 */

/** Читает лист целиком. Первая строка листа считается заголовками. */
export async function readSheet(env, sheetId, sheetName) {
  if (!sheetId) throw new Error('Не задан id таблицы');
  return hasServiceAccount(env)
    ? readViaServiceAccount(env, sheetId, sheetName)
    : readViaGviz(sheetId, sheetName);
}

export function hasServiceAccount(env) {
  return Boolean(env && env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_KEY);
}

/* --- gviz ----------------------------------------------------------------- */

async function readViaGviz(sheetId, sheetName) {
  const src =
    'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(sheetId) + '/gviz/tq' +
    '?tqx=out:json&headers=1&sheet=' + encodeURIComponent(sheetName);

  const res = await fetch(src, {
    headers: { 'user-agent': 'viferon-dash/1.0' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) {
    throw new Error('Google Sheets ответил ' + res.status + ' (лист «' + sheetName + '»)');
  }

  const table = parseGviz(await res.text(), sheetName);
  const headers = (table.cols || []).map((col) => text(col && (col.label || col.id)));
  const rows = (table.rows || []).map((row) =>
    (row.c || []).map((cell) => text(cell ? (cell.f != null ? cell.f : cell.v) : null))
  );
  return { headers, rows };
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

/* --- Sheets API v4 через сервисный аккаунт --------------------------------- */

async function readViaServiceAccount(env, sheetId, sheetName) {
  const token = await accessToken(env);
  const range = "'" + String(sheetName).replace(/'/g, "''") + "'";
  const src =
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(sheetId) +
    '/values/' + encodeURIComponent(range) +
    '?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE';

  const res = await fetch(src, {
    headers: { authorization: 'Bearer ' + token, 'user-agent': 'viferon-dash/1.0' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      'Sheets API ответил ' + res.status + ' (лист «' + sheetName + '») ' + detail.slice(0, 200)
    );
  }

  const values = (await res.json()).values || [];
  const headers = (values[0] || []).map(text);
  const rows = values.slice(1).map((row) => row.map(text));
  return { headers, rows };
}

/**
 * Токен сервисного аккаунта. Подписываем JWT ключом из GOOGLE_SA_KEY и меняем
 * его на access token. Токен живёт час, поэтому держим его в памяти изолята —
 * это экономит по запросу на каждое чтение.
 */
let tokenCache = null;

async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expires > now + 60 && tokenCache.owner === env.GOOGLE_SA_EMAIL) {
    return tokenCache.value;
  }

  const claim = {
    iss: env.GOOGLE_SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned =
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(claim));

  const key = await importPrivateKey(env.GOOGLE_SA_KEY);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const assertion = unsigned + '.' + b64urlBytes(new Uint8Array(signature));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body:
      'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' + encodeURIComponent(assertion),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('Google не выдал токен сервисному аккаунту: ' + res.status + ' ' + detail.slice(0, 200));
  }

  const data = await res.json();
  tokenCache = {
    value: data.access_token,
    expires: now + Number(data.expires_in || 3600),
    owner: env.GOOGLE_SA_EMAIL,
  };
  return tokenCache.value;
}

/**
 * PEM (PKCS#8) → CryptoKey. В переменных окружения перевод строки часто
 * приходит как литеральные «\n» — разворачиваем оба варианта.
 */
async function importPrivateKey(pem) {
  const raw = String(pem).trim();
  const body = String(raw.charCodeAt(0) === 123 ? JSON.parse(raw).private_key : raw)
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/* --- Общее ---------------------------------------------------------------- */

/**
 * Строки листа → объекты. `schema` описывает, какими подстроками искать колонку
 * в заголовке (`match`) и на какой позиции она лежит, если заголовок распознать
 * не удалось (`at`). Так лист можно переименовывать и переставлять, не трогая
 * код.
 *
 * Два прохода, и порядок между ними важен. Сначала по всем полям ищем колонки
 * по заголовкам, и только потом раздаём позиции — тем, кому колонка не нашлась,
 * и только из колонок, которые никто не занял. Наоборот нельзя: позиционная
 * подстановка захватила бы чужую колонку, и всё, что ищется после неё, съехало
 * бы на соседнюю — молча и с правдоподобным результатом.
 */
export function mapRows(sheet, schema) {
  const lower = sheet.headers.map((header) => header.toLowerCase());
  const claimed = new Set();
  const index = {};

  for (const [field, spec] of Object.entries(schema)) {
    index[field] = -1;
    for (const needle of spec.match || []) {
      const found = lower.findIndex((header, i) => header.includes(needle) && !claimed.has(i));
      if (found !== -1) {
        index[field] = found;
        claimed.add(found);
        break;
      }
    }
  }

  for (const [field, spec] of Object.entries(schema)) {
    if (index[field] !== -1) continue;
    if (!Number.isInteger(spec.at) || spec.at >= sheet.headers.length) continue;
    if (claimed.has(spec.at)) continue;
    index[field] = spec.at;
    claimed.add(spec.at);
  }

  return sheet.rows.map((cells) => {
    const item = {};
    for (const [field, at] of Object.entries(index)) item[field] = at === -1 ? '' : text(cells[at]);
    return item;
  });
}

export function text(value) {
  if (value == null) return '';
  return String(value).trim();
}

export function b64url(value) {
  return b64urlBytes(new TextEncoder().encode(value));
}

export function b64urlBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}
