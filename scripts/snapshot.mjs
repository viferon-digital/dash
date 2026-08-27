/**
 * Обновление снапшота `public/data/projects.json`.
 *
 *   npm run snapshot
 *
 * Снапшот — это резерв: его показывает главная, когда прослойка к таблице
 * недоступна. Код переиспользуется тот же, что в Pages Function, поэтому
 * снапшот и живой ответ всегда одной формы.
 *
 * Переменные берутся из окружения или из `.dev.vars` рядом с wrangler.toml.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadProjects } from '../functions/lib/registry.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'data', 'projects.json');

const env = { ...(await devVars()), ...process.env };
if (!env.SHEET_ID) {
  console.error('Не задан SHEET_ID: положите его в .dev.vars или в переменные окружения.');
  process.exit(1);
}

const registry = await loadProjects(env);
await writeFile(
  target,
  JSON.stringify({ fetchedAt: registry.fetchedAt, projects: registry.projects }, null, 2) + '\n',
  'utf8'
);

console.log('Снапшот обновлён: ' + registry.projects.length + ' проект(ов) → public/data/projects.json');

/** Простейший разбор .dev.vars — те же KEY=value, что понимает wrangler. */
async function devVars() {
  try {
    const raw = await readFile(join(root, '.dev.vars'), 'utf8');
    return Object.fromEntries(
      raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const eq = line.indexOf('=');
          const value = line.slice(eq + 1).trim();
          return [line.slice(0, eq).trim(), value.replace(/^["']|["']$/g, '')];
        })
    );
  } catch {
    return {};
  }
}
