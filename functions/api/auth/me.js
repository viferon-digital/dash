/**
 * Кто вошёл и какие способы входа доступны.
 *
 *   GET /api/auth/me
 *
 * Отвечает и без сессии — страница входа спрашивает отсюда, показывать ли
 * кнопку Google. GOOGLE_CLIENT_ID не секрет: он и так уходит в браузер.
 */

import { currentUser } from '../../lib/session.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const authMode = String(env.AUTH_MODE || 'sheet');
  const session = authMode === 'off' ? null : await currentUser(request, env);

  return new Response(
    JSON.stringify({
      ok: true,
      authMode,
      authenticated: authMode === 'off' ? true : Boolean(session),
      google: { enabled: Boolean(env.GOOGLE_CLIENT_ID), clientId: env.GOOGLE_CLIENT_ID || null },
      password: { enabled: true },
      user: session
        ? { email: session.sub, name: session.name, role: session.role, via: session.via || null,
            expiresAt: new Date(session.exp * 1000).toISOString() }
        : null,
    }),
    { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
  );
}
