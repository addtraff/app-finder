// Схема: не разъехалась ли рабочая база с тем, что написано в коде.
//
// Ловит ошибку, которая 26.09 стоила половины дня и была найдена случайно. В db.js есть
// SCHEMA с CREATE TABLE IF NOT EXISTS и отдельный список MIGRATIONS для добавления колонок.
// Колонка door3 была дописана в CREATE TABLE уже существующей таблицы — и не появилась
// нигде, потому что IF NOT EXISTS на существующую таблицу не действует вовсе. Метрика
// считалась, писалась в никуда и молча отсутствовала в отчёте по всем тридцати гео.
//
// Тест ставит рядом базу, поднятую с нуля, и рабочую. Любая колонка, которая есть в первой
// и отсутствует во второй, — это забытая миграция.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, prodDb, tables, columns, read, sourceFiles } from './helpers.js';

test('схема поднимается с нуля', () => {
  const t = tables(freshDb());
  assert.ok(t.length > 40, `таблиц всего ${t.length} — схема не поднялась`);
  for (const must of ['runs', 'cycles', 'locks', 'metrics_niche_geo', 'metrics_niche_v2', 'niche_entries', 'predictions']) {
    assert.ok(t.includes(must), `нет таблицы ${must}`);
  }
});

test('в рабочей базе есть все таблицы из схемы', (t) => {
  const prod = prodDb();
  if (!prod) return t.skip('рабочей базы нет — нечего сверять');
  const missing = tables(freshDb()).filter((x) => !tables(prod).includes(x));
  assert.deepEqual(missing, [], `таблиц нет в рабочей базе: ${missing.join(', ')}`);
});

test('в рабочей базе есть все колонки из схемы — иначе забыта миграция', (t) => {
  const prod = prodDb();
  if (!prod) return t.skip('рабочей базы нет — нечего сверять');
  const fresh = freshDb();
  const prodTables = new Set(tables(prod));
  const missing = [];
  for (const table of tables(fresh)) {
    if (!prodTables.has(table)) continue;    // об этом отдельный тест
    const have = new Set(columns(prod, table));
    for (const c of columns(fresh, table)) if (!have.has(c)) missing.push(`${table}.${c}`);
  }
  assert.deepEqual(missing, [],
    `колонки объявлены в схеме, но отсутствуют в рабочей базе: ${missing.join(', ')}.\n`
    + 'CREATE TABLE IF NOT EXISTS на существующую таблицу не действует — нужна запись в MIGRATIONS.');
});

// Порядок колонок в рабочей базе и в схеме разошёлся в семи таблицах: миграции дописывают
// поля в конец, а в CREATE TABLE их ставили по смыслу. Это безопасно ровно до тех пор, пока
// ни один INSERT не полагается на порядок. Проверяется именно это, а не сам порядок:
// приводить его в соответствие пришлось бы пересозданием таблиц на пяти гигабайтах данных
// ради риска, которого нет.
test('во всех INSERT перечислены колонки — порядок полей в базе ни на что не влияет', () => {
  const bad = [];
  for (const file of sourceFiles('src', ['src/lib/kw/']).concat(sourceFiles('tools', []))) {
    const src = read(file);
    for (const m of src.matchAll(/INSERT\s+(?:OR\s+(?:REPLACE|IGNORE|ABORT)\s+)?INTO\s+([a-z_][a-z0-9_]*)\s+VALUES/gi)) {
      bad.push(`${file}: INSERT INTO ${m[1]} VALUES — без списка колонок`);
    }
  }
  assert.deepEqual(bad, [], bad.join('; '));
});
