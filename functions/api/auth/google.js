/**
 * Вход через Google: браузер присылает ID-токен от Google Identity Services,
 * мы его проверяем и ищем почту в листе доступа.
 *
 *   POST /api/auth/google   { "credential": "<ID token>" }
 *
 * Разделение обязанностей: Google отвечает на вопрос «кто это», таблица — на
 * вопрос «пускать ли». Пароль такому человеку заводить не нужно.
 */

import { loadUsers, findUser, sessionPayload } from '../../lib/access.js';
import { verifyIdToken } from '../../lib/google.js';
import { sign, cookieHeader, ttlSeconds } from '../../lib/session.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (String(env.AUTH_MODE || 'sheet') === 'off') {
    return json({ ok: false, error: 'Вход выключен: AUTH_MODE=off' }, 400);
  }
  if (!env.GOOGLE_CLIENT_ID) {
    return json({ ok: false, error: 'Вход через Google не настроен: нет GOOGLE_CLIENT_ID' }, 400);
  }
  if (!env.SESSION_SECRET) {
    return json({ ok: false, error: 'Сервер не настроен: не задан SESSION_SECRET' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Ожидался JSON' }, 400);
  }

  let claims;
  try {
    claims = await verifyIdToken(body.credential, env.GOOGLE_CLIENT_ID);
  } catch (err) {
    return json({ ok: false, error: message(err) }, 401);
  }

  const email = String(claims.email).toLowerCase();

  let user;
  try {
    user = findUser(await loadUsers(env), email);
  } catch (err) {
    return json({ ok: false, error: 'Список доступа недоступен: ' + message(err) }, 502);
  }

  if (!user || !user.active) {
    // Здесь личность уже подтверждена Google, скрывать нечего: человек должен
    // понять, что дело не в пароле, а в том, что его не завели в таблице.
    return json({ ok: false, error: 'Для ' + email + ' доступ не открыт. Попросите добавить вас в лист доступа.' }, 403);
  }

  const ttl = ttlSeconds(env);
  const token = await sign(
    env,
    sessionPayload({ ...user, name: user.name || claims.name || email }, ttl, 'google')
  );

  return json(
    { ok: true, user: { email: user.email, name: user.name || claims.name || email, role: user.role } },
    200,
    { 'set-cookie': cookieHeader(token, ttl) }
  );
}

function message(err) {
  return String(err && err.message ? err.message : err);
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}
