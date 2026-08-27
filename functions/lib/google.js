/**
 * Проверка Google ID-токена — вход кнопкой «Войти через Google».
 *
 * Браузер получает от Google подписанный JWT и присылает его сюда; мы
 * проверяем подпись ключами Google, издателя, срок и то, что токен выписан
 * именно нашему приложению (aud === GOOGLE_CLIENT_ID). Только после этого
 * почта из токена считается подтверждённой — и уже она ищется в листе доступа.
 *
 * Пароль при таком входе не нужен и в таблице может быть пустым: Google
 * подтверждает личность, таблица — право доступа.
 */

import { fromB64url } from './sheets.js';

const CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

let jwks = null;

/** Возвращает разобранный payload токена или бросает ошибку с причиной. */
export async function verifyIdToken(token, clientId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Токен Google неразборчив');

  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (header.alg !== 'RS256') throw new Error('Неподдерживаемая подпись токена: ' + header.alg);

  const key = await publicKey(header.kid);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    fromB64url(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  if (!ok) throw new Error('Подпись токена Google не сходится');

  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.includes(payload.iss)) throw new Error('Токен выпущен не Google');
  if (payload.aud !== clientId) throw new Error('Токен выпущен другому приложению');
  if (!payload.exp || payload.exp < now - 60) throw new Error('Токен Google просрочен');
  if (payload.email_verified === false) throw new Error('Google не подтвердил эту почту');
  if (!payload.email) throw new Error('В токене Google нет почты');

  return payload;
}

/** Публичные ключи Google. Живут долго, поэтому держим их в памяти изолята. */
async function publicKey(kid) {
  if (!jwks || jwks.expires < Date.now() || !jwks.keys.has(kid)) await refreshKeys();

  const key = jwks.keys.get(kid);
  if (!key) throw new Error('Google подписал токен неизвестным ключом');
  return key;
}

async function refreshKeys() {
  const res = await fetch(CERTS, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error('Не удалось получить ключи Google: ' + res.status);

  const data = await res.json();
  const keys = new Map();
  for (const jwk of data.keys || []) {
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      )
    );
  }
  jwks = { keys, expires: Date.now() + maxAge(res.headers.get('cache-control')) };
}

function maxAge(header) {
  const match = /max-age=(\d+)/.exec(header || '');
  const seconds = match ? Number(match[1]) : 3600;
  return Math.min(Math.max(seconds, 300), 86400) * 1000;
}

function decodeJson(part) {
  return JSON.parse(new TextDecoder().decode(fromB64url(part)));
}
