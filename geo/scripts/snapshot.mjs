/**
 * Обновление снапшота `public/data/fallback.json`.
 *
 *   npm run snapshot
 *
 * Снапшот — резерв: его показывает дашборд, когда прослойка недоступна.
 * Код переиспользуется тот же, что в Pages Function, поэтому снапшот и живой
 * ответ всегда одной формы. Тексты ответов в снапшот не попадают — они
 * догружаются только через прослойку.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGeo } from '../functions/lib/geo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sheetId = process.env.SHEET_ID || '1SNZk25KdIKaeughg1SBqKBmmhQKuwJ9Nl115ZNAkxR8';
const sheetName = process.env.SHEET_NAME || 'Data';

const data = await loadGeo(sheetId, sheetName);
await writeFile(join(root, 'public', 'data', 'fallback.json'), JSON.stringify(data), 'utf8');

console.log(
  'Снапшот обновлён: ' + data.rows.length + ' ответов, ' +
  data.totals.scored + ' размечено, ' + data.totals.unscored + ' ждут разметки'
);
