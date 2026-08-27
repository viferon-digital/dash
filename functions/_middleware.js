/**
 * Ворота сайта. Через них проходит вообще всё — и страницы, и статика, и API, —
 * поэтому здесь же вешаются заголовки безопасности.
 *
 * Что открыто без входа: страница входа с её скриптами и стилями, `/api/auth/*`,
 * иконка и robots.txt. Остальное требует сессии: HTML уводится на `/login`,
 * а API отвечает 401, чтобы фронтенд не разбирал HTML вместо JSON.
 *
 * AUTH_MODE=off снимает проверку целиком — только для локальной разработки.
 */

import { currentUser } from './lib/session.js';

const PUBLIC_EXACT = new Set([
  '/login',
  '/login.html',
  '/robots.txt',
  '/favicon.ico',
  '/assets/styles.css',
  '/assets/theme.js',
  '/assets/login.js',
]);

const PUBLIC_PREFIX = ['/api/auth/'];

export async function onRequest(context) {
  return harden(await route(context), context.env);
}

async function route(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // Смена состояния — только со своего домена. SameSite=Lax закрывает основное,
  // проверка Origin — остаток (форма с чужой страницы, старый браузер). Стоит
  // выше всех прочих веток: вход и выход тоже меняют состояние, и подсунуть
  // человеку чужую сессию с постороннего сайта не должно получаться.
  if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOrigin(request, url)) {
    return json({ ok: false, error: 'Запрос с чужого источника' }, 403);
  }

  // Страница входа живёт по /login без расширения.
  if (path === '/login') return serveLogin(context);

  if (String(env.AUTH_MODE || 'sheet') === 'off') return next();
  if (isPublic(path)) return next();

  const session = await currentUser(request, env).catch(() => null);
  if (!session) {
    if (path.startsWith('/api/')) return json({ ok: false, error: 'Нужен вход' }, 401);
    const back = url.pathname + url.search;
    return Response.redirect(new URL('/login?next=' + encodeURIComponent(back), url).toString(), 302);
  }

  return next();
}

/**
 * Страница входа. Сам файл отдаёт Pages (он сам сопоставляет `/login` и
 * `login.html`) — нам остаётся не пустить сюда того, кто уже вошёл: иначе
 * человек видит форму входа, будучи залогиненным, и не понимает, что не так.
 */
async function serveLogin(context) {
  const { request, env, next } = context;

  if (String(env.AUTH_MODE || 'sheet') !== 'off') {
    const session = await currentUser(request, env).catch(() => null);
    if (session) return Response.redirect(new URL('/', request.url).toString(), 302);
  }

  return next();
}

function isPublic(path) {
  return PUBLIC_EXACT.has(path) || PUBLIC_PREFIX.some((prefix) => path.startsWith(prefix));
}

function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // не браузерная форма — обычный fetch со своего же скрипта
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

/**
 * Заголовки безопасности. CSP разрешает ровно то, что нужно: свои скрипты,
 * Google Identity Services на странице входа и iframe с дашбордами по https —
 * дашборды живут на соседних поддоменах.
 */
function harden(response, env) {
  const out = new Response(response.body, response);
  const google = env.GOOGLE_CLIENT_ID ? ' https://accounts.google.com' : '';

  out.headers.set(
    'content-security-policy',
    [
      "default-src 'self'",
      "script-src 'self'" + google,
      "connect-src 'self'" + google,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "frame-src 'self' https:" + google,
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ')
  );
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  out.headers.set('x-frame-options', 'SAMEORIGIN');
  out.headers.set('permissions-policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  out.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return out;
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
