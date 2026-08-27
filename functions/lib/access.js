/**
 * Список доступа — лист Google Таблицы. Одна строка = один человек:
 *
 *   Имя | Email | Пароль | Роль | Проекты | Активен | Комментарий
 *
 * Колонка «Пароль» хранит не пароль, а его хэш PBKDF2 —
 * `pbkdf2$sha256$<итераций>$<соль>$<хэш>`; хэш делает `npm run hash`.
 * Открытый текст разрешён только при ALLOW_PLAINTEXT=1 и только для отладки:
 * в таблице, доступной «по ссылке», это равносильно раздаче паролей.
 *
 * Правильная конфигурация: таблица доступа закрыта и расшарена на сервисный
 * аккаунт (GOOGLE_SA_EMAIL / GOOGLE_SA_KEY), а не открыта по ссылке.
 */

import { readSheet, mapRows, b64urlBytes, fromB64url } from './sheets.js';
import { timingSafeEqual } from './session.js';

const DEFAULT_ITERATIONS = 210000;
const DEFAULT_TTL = 60;

const SCHEMA = {
  name:     { match: ['имя', 'фио', 'сотрудник', 'name'], at: 0 },
  email:    { match: ['email', 'почт', 'логин', 'mail'],  at: 1 },
  password: { match: ['пароль', 'хэш', 'хеш', 'password'], at: 2 },
  role:     { match: ['роль', 'role'],                     at: 3 },
  projects: { match: ['проект', 'дашборд', 'project'],     at: 4 },
  active:   { match: ['актив', 'включ', 'статус'],         at: 5 },
  note:     { match: ['коммент', 'примеч', 'note'],        at: 6 },
};

/** Все, кому разрешён вход. Кэшируется на ACCESS_TTL секунд в памяти изолята. */
let cache = null;

export async function loadUsers(env, { refresh = false } = {}) {
  const ttl = clamp(env.ACCESS_TTL, DEFAULT_TTL, 10, 900) * 1000;
  const sheetId = env.ACCESS_SHEET_ID || env.SHEET_ID;
  const sheetName = env.ACCESS_SHEET || 'Доступ';
  const key = sheetId + '/' + sheetName;

  if (!refresh && cache && cache.key === key && cache.expires > Date.now()) return cache.users;

  const sheet = await readSheet(env, sheetId, sheetName);
  const users = mapRows(sheet, SCHEMA)
    .map((row) => ({
      name: row.name,
      email: row.email.toLowerCase(),
      password: row.password,
      role: (row.role || 'user').toLowerCase(),
      projects: list(row.projects),
      active: isActive(row.active),
      note: row.note,
    }))
    .filter((user) => user.email.includes('@'));

  cache = { key, users, expires: Date.now() + ttl };
  return users;
}

export function findUser(users, email) {
  const needle = String(email || '').trim().toLowerCase();
  return users.find((user) => user.email === needle) || null;
}

/** Полезная нагрузка сессии: только то, что нужно для проверки доступа. */
export function sessionPayload(user, ttlSeconds, method) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: user.email,
    name: user.name || user.email,
    role: user.role,
    prj: user.projects,
    via: method,
    iat: now,
    exp: now + ttlSeconds,
  };
}

/**
 * Видит ли пользователь проект. Доступ двусторонний и должен сойтись с обеих
 * сторон: в реестре у проекта есть колонка «Доступ» (кому он виден), а в списке
 * доступа у человека — колонка «Проекты» (что ему открыто). Роль `admin` видит
 * всё.
 */
export function canSee(session, project) {
  if (!session) return false;
  if (session.role === 'admin') return true;

  const mine = session.prj || [];
  const byUser = mine.length === 0 || mine.some(isEveryone) || mine.includes(project.slug);
  if (!byUser) return false;

  const audience = project.access || [];
  if (audience.length === 0 || audience.some(isEveryone)) return true;
  return audience.some(
    (entry) => entry === session.role || entry === String(session.sub || '').toLowerCase()
  );
}

/* --- Пароли ---------------------------------------------------------------- */

/** Проверка пароля. Формат хэша — `pbkdf2$sha256$<итераций>$<соль>$<хэш>`. */
export async function verifyPassword(stored, candidate, env) {
  const value = String(stored || '');
  if (!value) return false;

  if (!value.startsWith('pbkdf2$')) {
    if (String(env && env.ALLOW_PLAINTEXT) !== '1') return false;
    return constantEqualText(value, String(candidate || ''));
  }

  const [, algorithm, iterations, salt, expected] = value.split('$');
  if (algorithm !== 'sha256') return false;

  const actual = await pbkdf2(String(candidate || ''), fromB64url(salt), Number(iterations));
  return timingSafeEqual(new Uint8Array(actual), fromB64url(expected));
}

/** Генерация хэша для колонки «Пароль». Используется скриптом `npm run hash`. */
export async function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return ['pbkdf2', 'sha256', iterations, b64urlBytes(salt), b64urlBytes(new Uint8Array(hash))].join('$');
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: clampIterations(iterations) },
    key,
    256
  );
}

function clampIterations(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_ITERATIONS;
  return Math.min(Math.max(Math.trunc(parsed), 10000), 1000000);
}

function constantEqualText(a, b) {
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

/* --- Ограничение перебора --------------------------------------------------- */

/**
 * Счётчик неудачных попыток в памяти изолята. Это не защита от
 * распределённого перебора — изолятов много и они живут недолго, — но обычную
 * «прогоню словарь по одному аккаунту» атаку он гасит. Настоящий лимит,
 * если понадобится, ставится правилом Cloudflare WAF на /api/auth/*.
 */
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const LIMIT = 8;

export function tooManyAttempts(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (entry.until < Date.now()) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= LIMIT;
}

export function noteFailure(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.until < now) {
    attempts.set(key, { count: 1, until: now + WINDOW });
    return;
  }
  entry.count += 1;
}

export function resetAttempts(key) {
  attempts.delete(key);
}

/* --- Мелочи ---------------------------------------------------------------- */

export function list(value) {
  return String(value || '')
    .split(/[,;\n]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function isEveryone(value) {
  return ['*', 'все', 'всем', 'any', 'all'].includes(String(value).trim().toLowerCase());
}

function isActive(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return true; // пустая ячейка — считаем, что доступ есть
  return ['да', 'yes', 'true', '1', 'вкл', 'активен', 'активна', '+', 'ok'].includes(raw);
}

function clamp(raw, fallback, min, max) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}
