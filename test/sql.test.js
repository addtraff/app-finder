// Каждый SQL в коде должен готовиться на пустой схеме.
//
// Ловит опечатки в именах таблиц и колонок — самую частую ошибку этого проекта. За один
// день 26.09 их было три: «no such table: stage_runs» (таблица называется runs), «no such
// column: difficulty» (в raw_external_keyword_planner она competition_index) и «no such
// column: installs» (в raw_app_page она max_installs). Каждая находилась только запуском
// стадии, то есть через минуты ожидания, а иногда — через сутки, если стадия редкая.
//
// Проверяются только statically известные запросы: шаблонные строки с подстановкой ${}
// пропускаются, потому что их текст зависит от данных. Это не полное покрытие, но именно
// на статических запросах и случались все три сегодняшние ошибки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, read, sourceFiles } from './helpers.js';

// Модуль объёма поиска держит свои таблицы в отдельной схеме (src/lib/kw/schema.js) и
// поднимает их сам — на основной схеме его запросы законно не готовятся.
const SKIP = ['src/lib/kw/', 'src/kw', 'src/stages/kw-', 'tools/selftest-kw.js'];
const SQL_START = /^\s*(WITH|SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i;

function statements(src) {
  const out = [];
  const re = /`([^`\\]*(?:\\.[^`\\]*)*)`/gs;
  let m;
  while ((m = re.exec(src))) {
    const body = m[1];
    if (body.includes('${')) continue;            // текст зависит от данных — не проверяем
    if (!SQL_START.test(body)) continue;
    out.push({ sql: body, at: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

test('все статические SQL готовятся на чистой схеме', () => {
  const d = freshDb();
  const bad = [];
  let checked = 0;
  for (const file of sourceFiles('src', SKIP).concat(sourceFiles('tools', SKIP))) {
    for (const { sql, at } of statements(read(file))) {
      checked++;
      try { d.prepare(sql).columns; } catch (e) {
        // .columns бросает на не-SELECT — это не ошибка запроса
        if (/not a statement that returns data|does not return data/i.test(e.message)) continue;
        bad.push(`${file}:${at} — ${e.message}\n      ${sql.trim().replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
  }
  assert.ok(checked > 150, `проверено всего ${checked} запросов — похоже, разбор сломался`);
  assert.deepEqual(bad, [], `запросы не готовятся (${bad.length} из ${checked}):\n  ${bad.join('\n  ')}`);
});

test('нет обращений к таблицам, которых нет в схеме', () => {
  const d = freshDb();
  const known = new Set(d.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`).all().map((r) => r.name));
  const bad = new Set();
  for (const file of sourceFiles('src', SKIP).concat(sourceFiles('tools', SKIP))) {
    const src = read(file);
    for (const m of src.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi)) {
      const name = m[1];
      // Псевдотаблицы SQLite и табличные функции — не наши таблицы, их в схеме и не должно быть.
      if (/^(json_each|pragma_|sqlite_)/i.test(name) || ['select', 'values', 'set'].includes(name.toLowerCase())) continue;
      if (/^[a-z_]+$/.test(name) && !known.has(name) && name.includes('_')) bad.add(`${file}: ${name}`);
    }
  }
  assert.deepEqual([...bad], [], `упоминаются таблицы, которых нет в схеме: ${[...bad].join(', ')}`);
});
