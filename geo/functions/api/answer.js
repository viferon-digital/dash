/**
 * Полный текст одного ответа модели.
 *
 *   GET /api/answer?row=123
 *
 * `row` — порядковый номер строки в листе, он приходит вместе с журналом из
 * /api/geo. Тексты весят четыре мегабайта на всех, поэтому они не едут в
 * браузер пачкой: сюда ходят по одному, когда ответ раскрывают.
 *
 * Кэшируется надолго: текст уже сделанного замера не меняется.
 */

import { loadAnswer } from '../lib/geo.js';

const DEFAULT_SHEET_ID = '1SNZk25KdIKaeughg1SBqKBmmhQKuwJ9Nl115ZNAkxR8';
const DEFAULT_SHEET = 'Data';

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);

  const row = Number(url.searchParams.get('row'));
  if (!Number.isInteger(row) || row < 0 || row > 1000000) {
    return json({ ok: false, error: 'Нужен параметр row — номер строки' }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}${url.pathname}?row=${row}`, { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const text = await loadAnswer(
      env.SHEET_ID || DEFAULT_SHEET_ID,
      env.SHEET_NAME || DEFAULT_SHEET,
      row
    );
    const res = json({ ok: true, row, text }, 200, { 'cache-control': 'public, max-age=86400' });
    waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) }, 502);
  }
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}
