/**
 * Охранник дашборда: страницу открывает только тот, кто вошёл на
 * https://viferon.digital.
 *
 * Один файл без импортов и зависимостей — его можно положить в любой проект на
 * Cloudflare Pages: в проект с папкой `functions/` как `functions/_middleware.js`
 * (сработает `onRequest`), в проект с одним `_worker.js` — импортом функции
 * `guard()` в самое начало обработчика.
 *
 * Как это работает. Главная страница при входе выдаёт куку `vd_session` на весь
 * домен (`Domain=.viferon.digital`), поэтому браузер сам присылает её и на
 * поддомены. Внутри куки лежит подписанная HMAC-SHA256 полезная нагрузка: почта,
 * роль, список разрешённых проектов и срок. Охранник проверяет подпись тем же
 * секретом и решает сам — по сети ходить не нужно. Ни одного лишнего запроса,
 * и дашборд не зависит от того, жив ли сейчас сервис входа.
 *
 * Переменные проекта:
 *
 *   SESSION_SECRET  секрет, тот же, что на главной. Обязателен: без него
 *                   охранник закрывает всё, а не открывает.
 *   AUTH_ORIGIN     где живёт вход, по умолчанию https://viferon.digital
 *   PROJECT_SLUG    слаг проекта из реестра: у человека в колонке «Проекты»
 *                   должен быть он, «все» или пусто. Роль admin видит всё.
 *   PUBLIC_PATHS    что открыто без входа, через запятую (например «/health»).
 *   AUTH_MODE       off снимает проверку целиком — только для отладки.
 */

const COOKIE = 'vd_session';
const DEFAULT_AUTH_ORIGIN = 'https://viferon.digital';
const DEFAULT_PUBLIC = '/favicon.ico,/robots.txt';
const EVERYONE = ['*', 'все', 'всем', 'any', 'all'];

/**
 * Для проекта с папкой `functions/`: положить файл как `functions/_middleware.js`.
 */
export async function onRequest(context) {
  const { request, env, next, data } = context;
  const denied = await guard(request, env);
  if (denied) return denied;

  const session = await currentUser(request, env).catch(() => null);
  if (session && data) data.user = session;
  return next();
}

/**
 * Для проекта с одним `_worker.js`: вызвать первой строкой обработчика.
 * Возвращает готовый ответ, если пускать нельзя, и null, если можно.
 */
export async function guard(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (String(env.AUTH_MODE || 'on') === 'off') return null;
  if (isPublic(path, env)) return null;

  // Без секрета проверить подпись нечем. Закрываем, а не открываем: ошибка в
  // настройке не должна молча выставлять внутренний дашборд наружу.
  if (!env.SESSION_SECRET) {
    return message(
      request,
      503,
      'Дашборд не настроен',
      'В проекте не задан SESSION_SECRET — проверить вход нечем, поэтому доступ закрыт.'
    );
  }

  const session = await currentUser(request, env).catch(() => null);
  if (!session) return challenge(url, env);
  if (!canSeeProject(session, env)) return denied(request, session, env);
  return null;
}

/** Сессия запроса или null. Годится и для собственных функций проекта. */
export async function currentUser(request, env) {
  // Кук с одним именем может прилететь несколько: старая, выданная только на
  // viferon.digital, и новая — на весь домен. Браузер шлёт обе и не говорит,
  // какая откуда, поэтому проверяем все и принимаем первую годную.
  for (const token of readCookies(request, COOKIE)) {
    const payload = await verify(env, token);
    if (payload) return payload;
  }
  return null;
}

async function verify(env, token) {
  if (!token || typeof token !== 'string') return null;

  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;

  const body = token.slice(0, dot);
  const expected = new Uint8Array(await hmac(env, body));
  const actual = fromB64url(token.slice(dot + 1));
  if (!timingSafeEqual(expected, actual)) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/**
 * Видит ли человек этот дашборд. Пустой список и «все» означают «всё открыто»:
 * так строку в таблице можно завести, не перечисляя дашборды поимённо.
 */
export function canSeeProject(session, env) {
  const slug = String(env.PROJECT_SLUG || '').trim().toLowerCase();
  if (!slug) return true;
  if (session.role === 'admin') return true;

  const mine = session.prj || [];
  if (mine.length === 0) return true;
  return mine.some((item) => {
    const value = String(item).trim().toLowerCase();
    return value === slug || EVERYONE.includes(value);
  });
}

/* --- Ответы ----------------------------------------------------------------- */

/** Нет сессии: страницу уводим на вход, API отвечаем 401 — ему HTML не нужен. */
function challenge(url, env) {
  if (url.pathname.startsWith('/api/')) {
    return json({ ok: false, error: 'Нужен вход на ' + authOrigin(env) }, 401);
  }
  const back = url.origin + url.pathname + url.search;
  const login = authOrigin(env) + '/login?next=' + encodeURIComponent(back);
  return new Response(null, { status: 302, headers: { location: login, 'cache-control': 'no-store' } });
}

/** Сессия есть, но дашборд человеку не открыт. Гонять его на вход бессмысленно. */
function denied(request, session, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return json({ ok: false, error: 'Этот дашборд вам не открыт' }, 403);
  }
  return message(
    request,
    403,
    'Нет доступа',
    'Вы вошли как ' + session.sub + ', но этот дашборд вам не открыт. Попросите добавить его ' +
      'в колонку «Проекты» вашей строки в листе доступа.',
    env
  );
}

function message(request, status, title, text, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return json({ ok: false, error: text }, status);

  const html =
    '<!doctype html><html lang="ru"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<style>body{font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:16vh auto;' +
    'max-width:34rem;padding:0 24px;color:#161513;background:#fbfaf9}' +
    'h1{font-size:20px;margin:0 0 10px}p{color:#57534e;margin:0 0 12px}a{color:#2a78d6}' +
    '@media (prefers-color-scheme:dark){body{background:#131211;color:#f3f1ee}p{color:#a8a29d}}</style>' +
    '<h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(text) + '</p>' +
    '<p><a href="' + authOrigin(env) + '/">Вернуться к каталогу дашбордов</a></p></html>';

  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* --- Мелочи ----------------------------------------------------------------- */

function isPublic(path, env) {
  const list = env.PUBLIC_PATHS == null ? DEFAULT_PUBLIC : String(env.PUBLIC_PATHS);
  return list
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .some((item) => path === item || (item.endsWith('*') && path.startsWith(item.slice(0, -1))));
}

function authOrigin(env) {
  return String((env && env.AUTH_ORIGIN) || DEFAULT_AUTH_ORIGIN).replace(/\/+$/, '');
}

function readCookies(request, name) {
  const out = [];
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

let keyCache = null;

async function hmac(env, message) {
  if (!keyCache || keyCache.secret !== env.SESSION_SECRET) {
    keyCache = {
      secret: env.SESSION_SECRET,
      key: await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(env.SESSION_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      ),
    };
  }
  return crypto.subtle.sign('HMAC', keyCache.key, new TextEncoder().encode(message));
}

function fromB64url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
