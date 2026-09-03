/**
 * Сессии на подписанной куке. Состояния на сервере нет: всё, что нужно для
 * проверки доступа (почта, роль, список разрешённых проектов, срок), лежит
 * в самой куке, а подпись HMAC-SHA256 не даёт её подделать.
 *
 * Кука HttpOnly + Secure + SameSite=Lax: JavaScript страницы её не видит,
 * по HTTP она не уедет, и на сторонние POST-запросы браузер её не приложит.
 */

import { b64url, b64urlBytes, fromB64url } from './sheets.js';

export const COOKIE = 'vd_session';

/**
 * Кука выдаётся на весь домен, а не только на viferon.digital: соседние
 * дашборды живут на поддоменах (ba, geo, social-pubmed и прочие) и проверяют
 * эту же куку тем же секретом. Точка в начале — это и есть «весь домен вместе
 * с поддоменами».
 */
const COOKIE_DOMAIN = '.viferon.digital';

const DEFAULT_TTL_HOURS = 12;

/** Пакует полезную нагрузку в `payload.signature`. */
export async function sign(env, payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = await hmac(env, body);
  return body + '.' + b64urlBytes(new Uint8Array(mac));
}

/** Разбирает и проверяет куку. Возвращает payload или null. */
export async function verify(env, token) {
  if (!token || typeof token !== 'string') return null;

  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;

  const body = token.slice(0, dot);
  const expected = await hmac(env, body);
  const actual = fromB64url(token.slice(dot + 1));
  if (!timingSafeEqual(new Uint8Array(expected), actual)) return null;

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

/** Session cookie на срок жизни сессии. */
export function cookieHeader(token, maxAgeSeconds) {
  return [
    COOKIE + '=' + token,
    'Domain=' + COOKIE_DOMAIN,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=' + Math.max(0, Math.trunc(maxAgeSeconds)),
  ].join('; ');
}

export function clearedCookie() {
  return COOKIE + '=; Domain=' + COOKIE_DOMAIN + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

export function readCookie(request, name = COOKIE) {
  return readCookies(request, name)[0] || null;
}

/**
 * Все куки с этим именем. Их может оказаться несколько: старая, выданная
 * когда-то только на viferon.digital, и новая — на весь домен. Браузер шлёт
 * обе и не говорит, какая откуда, а разбирать нужно обе: иначе просроченная
 * старая перекроет живую новую, и человек будет ходить по кругу через вход.
 */
export function readCookies(request, name = COOKIE) {
  const out = [];
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

export function ttlSeconds(env) {
  const hours = Number(env && env.SESSION_TTL_HOURS);
  const safe = Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 24 * 30) : DEFAULT_TTL_HOURS;
  return Math.trunc(safe * 3600);
}

/** Текущий пользователь запроса или null. */
export async function currentUser(request, env) {
  for (const token of readCookies(request)) {
    const payload = await verify(env, token);
    if (payload) return payload;
  }
  return null;
}

/* --- Внутреннее ------------------------------------------------------------ */

let keyCache = null;

async function hmac(env, message) {
  const secret = env.SESSION_SECRET;
  if (!secret) {
    // Без секрета подпись бессмысленна: любой смог бы выпустить себе сессию.
    throw new Error('Не задан SESSION_SECRET — сессии выпускать нельзя');
  }
  if (!keyCache || keyCache.secret !== secret) {
    keyCache = {
      secret,
      key: await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      ),
    };
  }
  return crypto.subtle.sign('HMAC', keyCache.key, new TextEncoder().encode(message));
}

/** Сравнение за постоянное время: длина ответа не должна зависеть от подписи. */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}
