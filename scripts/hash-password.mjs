/**
 * Хэш пароля для колонки «Пароль» в листе доступа.
 *
 *   npm run hash -- 'пароль'
 *   npm run hash              (спросит пароль и не покажет его в истории команд)
 *
 * В таблицу вставляется вся строка целиком, вместе с `pbkdf2$sha256$…`.
 * Открытый пароль в таблице не хранится: её видят все, у кого есть доступ
 * к файлу, а хэш без пароля бесполезен.
 */

import { createInterface } from 'node:readline/promises';
import { hashPassword } from '../functions/lib/access.js';

const fromArgs = process.argv.slice(2).join(' ').trim();
const password = fromArgs || (await ask());

if (!password) {
  console.error('Пустой пароль — нечего хэшировать.');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Слишком короткий пароль: нужно хотя бы 10 символов.');
  process.exit(1);
}

console.log(await hashPassword(password));

async function ask() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Пароль: ');
  rl.close();
  return answer.trim();
}
