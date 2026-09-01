/**
 * Прослойка между дашбордом и Google Таблицей GEO-трекинга.
 *
 *   GET /api/geo            — журнал замеров в компактном виде
 *   GET /api/geo?refresh=1  — принудительно мимо кэша (кнопка «Обновить»)
 *
 * Зачем прослойка — то же, что и у соседних дашбордов:
 *  1. id таблицы не уезжает в браузер, он живёт в переменных окружения Pages;
 *  2. ответ кэшируется на edge (Google отдаёт no-store, поэтому кэшируем сами);
 *  3. последний удачный ответ хранится отдельно и отдаётся как stale, если
 *     Google недоступен, — дашборд не белеет;
 *  4. колонка с полными текстами ответов остаётся на сервере: в браузер едут
 *     только отметки упоминаний, 31 КБ вместо 7,6 МБ.
 */

import { loadGeo } from '../lib/geo.js';

const DEFAULT_SHEET_ID = '1SNZk25KdIKaeughg1SBqKBmmhQKuwJ9Nl115ZNAkxR8';
const DEFAULT_SHEET = 'Data';
const DEFAULT_TTL = 900;
const LAST_GOOD_KEY = 'https://cache.internal/geo/last-good';

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);
  const bypass = url.searchParams.has('refresh');

  const sheetId = env.SHEET_ID || DEFAULT_SHEET_ID;
  const sheetName = env.SHEET_NAME || DEFAULT_SHEET;
  const ttl = clampTtl(env.CACHE_TTL);

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });

  if (!bypass) {
    const hit = await cache.match(cacheKey);
    if (hit) return withHeaders(hit, { 'x-cache': 'HIT' });
  }

  try {
    const payload = await loadGeo(sheetId, sheetName);
    const fresh = json(payload, {
      'cache-control': `public, max-age=60, s-maxage=${ttl}`,
      'x-cache': bypass ? 'BYPASS' : 'MISS',
      'x-data-source': 'google-sheets',
    });

    waitUntil(cache.put(cacheKey, fresh.clone()));
    waitUntil(
      cache.put(
        new Request(LAST_GOOD_KEY, { method: 'GET' }),
        json(payload, { 'cache-control': 'public, max-age=86400' })
      )
    );
    return fresh;
  } catch (err) {
    const stale = await cache.match(new Request(LAST_GOOD_KEY, { method: 'GET' }));
    if (stale) {
      return withHeaders(stale, {
        'x-cache': 'STALE',
        'x-data-source': 'google-sheets-stale',
        'cache-control': 'no-store',
      });
    }
    return json(
      { ok: false, error: String(err && err.message ? err.message : err) },
      { 'cache-control': 'no-store' },
      502
    );
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}

function clampTtl(raw) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL;
  return Math.min(Math.max(Math.trunc(parsed), 60), 3600);
}

function json(payload, headers = {}, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...headers,
    },
  });
}

function withHeaders(response, headers) {
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) next.headers.set(key, value);
  return next;
}
