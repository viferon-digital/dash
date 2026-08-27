/**
 * Вход по почте и паролю из листа доступа.
 *
 *   POST /api/auth/login   { "email": "...", "password": "..." }
 *
 * Ответ всегда одинаково скуп: «неверная почта или пароль». Разные тексты для
 * «нет такой почты» и «пароль не тот» позволили бы перебором собрать список
 * сотрудников, а он и есть половина взлома.
 */

import { loadUsers, findUser, verifyPassword, sessionPayload,
         tooManyAttempts, noteFailure, resetAttempts } from '../../lib/access.js';
import { sign, cookieHeader, ttlSeconds } from '../../lib/session.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (String(env.AUTH_MODE || 'sheet') === 'off') {
    return json({ ok: false, error: 'Вход выключен: AUTH_MODE=off' }, 400);
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

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return json({ ok: false, error: 'Заполните почту и пароль' }, 400);

  const throttleKey = email + '|' + (request.headers.get('cf-connecting-ip') || '');
  if (tooManyAttempts(throttleKey)) {
    return json({ ok: false, error: 'Слишком много попыток. Попробуйте через 15 минут.' }, 429);
  }

  let user;
  try {
    user = findUser(await loadUsers(env), email);
  } catch (err) {
           console.error('SHEET_READ_FAIL ' + message(err));
    return json({ ok: false, error: 'Список доступа недоступен: ' + message(err) }, 502);
  }

  const ok = user && user.active && (await verifyPassword(user.password, password, env));
  if (!ok) {
    noteFailure(throttleKey);
    // Ровно одна формулировка на все случаи: нет такой почты, доступ выключен,
    // пароль не подошёл, пароль в таблице пуст.
    return json({ ok: false, error: 'Неверная почта или пароль' }, 401);
  }

  resetAttempts(throttleKey);
  const ttl = ttlSeconds(env);
  const token = await sign(env, sessionPayload(user, ttl, 'password'));

  return json(
    { ok: true, user: { email: user.email, name: user.name || user.email, role: user.role } },
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
