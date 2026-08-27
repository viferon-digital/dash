/**
 * Реестр проектов для главной.
 *
 *   GET /api/projects            — список, доступный текущему пользователю
 *   GET /api/projects?refresh=1  — то же, но мимо кэша (кнопка «Обновить»)
 *
 * Кэшируется не ответ, а сам реестр: ответ у каждого свой — из общего списка
 * вырезается то, что человеку не открыто. Поэтому в edge-кэше лежит полный
 * реестр под внутренним ключом, а наружу уходит `cache-control: no-store`.
 *
 * Если Google недоступен, отдаётся последний удачно прочитанный реестр
 * (`x-cache: STALE`), а если и его нет — снапшот `public/data/projects.json`.
 * Главная в любом случае не белеет, но честно пишет, откуда данные.
 */

import { loadProjects, normalize } from '../lib/registry.js';
import { canSee } from '../lib/access.js';
import { currentUser } from '../lib/session.js';

const CACHE_KEY = 'https://cache.internal/dash/projects';
const LAST_GOOD_KEY = 'https://cache.internal/dash/projects/last-good';
const DEFAULT_TTL = 300;

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);
  const refresh = url.searchParams.has('refresh');

  const authOff = String(env.AUTH_MODE || 'sheet') === 'off';
  const session = authOff ? guest() : await currentUser(request, env);
  if (!session) return json({ ok: false, error: 'Нужен вход' }, { 'cache-control': 'no-store' }, 401);

  const ttl = clamp(env.CACHE_TTL, DEFAULT_TTL, 30, 3600);
  const cache = caches.default;
  const key = new Request(CACHE_KEY, { method: 'GET' });

  if (!refresh) {
    const hit = await cache.match(key);
    if (hit) return respond(await hit.json(), session, 'HIT');
  }

  try {
    if (!env.SHEET_ID) throw new Error('Не задан SHEET_ID');

    const registry = await loadProjects(env);
    const body = JSON.stringify(registry);
    waitUntil(cache.put(key, cached(body, ttl)));
    waitUntil(cache.put(new Request(LAST_GOOD_KEY, { method: 'GET' }), cached(body, 86400)));
    return respond(registry, session, refresh ? 'BYPASS' : 'MISS');
  } catch (err) {
    const stale = await cache.match(new Request(LAST_GOOD_KEY, { method: 'GET' }));
    if (stale) return respond(await stale.json(), session, 'STALE');

    const snapshot = await loadSnapshot(context);
    if (snapshot) return respond(snapshot, session, 'SNAPSHOT', message(err));

    return json(
      { ok: false, error: message(err) },
      { 'cache-control': 'no-store' },
      502
    );
  }
}

/** Ответ одного пользователя: реестр минус то, что ему не открыто. */
function respond(registry, session, cacheState, warning) {
  const all = registry.projects || [];
  const projects = all.filter((project) => canSee(session, project));
  const categories = [...new Set(projects.map((project) => project.category))];

  return json(
    {
      ok: true,
      source: registry.source || 'google-sheets',
      fetchedAt: registry.fetchedAt || null,
      stale: cacheState === 'STALE' || cacheState === 'SNAPSHOT',
      warning: warning || null,
      hidden: all.length - projects.length,
      count: projects.length,
      categories,
      projects,
      user: {
        email: session.sub,
        name: session.name,
        role: session.role,
        via: session.via || null,
      },
    },
    {
      'cache-control': 'no-store',
      'x-cache': cacheState,
      'x-data-source': registry.source || 'google-sheets',
    }
  );
}

/**
 * Снапшот из статики. Он же — способ завести проект вообще без таблицы:
 * достаточно дописать объект в `public/data/projects.json` и задеплоить.
 */
async function loadSnapshot(context) {
  try {
    const url = new URL('/data/projects.json', context.request.url);
    const res = context.env.ASSETS
      ? await context.env.ASSETS.fetch(new Request(url))
      : await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const projects = Array.isArray(data) ? data : data.projects || [];
    return {
      ok: true,
      source: 'snapshot',
      fetchedAt: data.fetchedAt || null,
      projects: normalize(projects),
    };
  } catch {
    return null;
  }
}

function guest() {
  return { sub: 'guest@local', name: 'Гость', role: 'admin', prj: ['*'], via: 'auth-off' };
}

function cached(body, maxAge) {
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=' + maxAge,
    },
  });
}

function clamp(raw, fallback, min, max) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function message(err) {
  return String(err && err.message ? err.message : err);
}

function json(payload, headers = {}, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
