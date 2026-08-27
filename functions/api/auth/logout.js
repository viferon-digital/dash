/** Выход: гасим куку сессии. Ничего серверного чистить не нужно — состояния нет. */

import { clearedCookie } from '../../lib/session.js';

export function onRequestPost() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': clearedCookie(),
    },
  });
}
