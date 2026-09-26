// Общее для тестов: свежая база из схемы и доступ к рабочей.
//
// Свежая база строится в дочернем процессе с RADAR_DB на временный файл — путь к базе
// вычисляется один раз при импорте db.js, и внутри одного процесса две базы не открыть.
// Это же делает тест честным: он поднимает схему ровно так, как её поднимает боевой запуск.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROD_DB = process.env.RADAR_DB || path.join(ROOT, 'data', 'radar.db');

let _fresh = null;

// База, поднятая с нуля: то, как выглядела бы схема, если бы её создавали сегодня.
// Сравнение с рабочей отвечает на вопрос, который 26.09 стоил половины дня: не забыли ли
// миграцию для колонки, добавленной в CREATE TABLE уже существующей таблицы.
export function freshDb() {
  if (_fresh) return _fresh;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'radar-test-')), 'fresh.db');
  execFileSync(process.execPath, ['-e', "import('./src/lib/db.js').then(m => m.db())"], {
    cwd: ROOT, env: { ...process.env, RADAR_DB: file }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  _fresh = new Database(file, { readonly: true });
  return _fresh;
}

export function prodDb() {
  if (!fs.existsSync(PROD_DB)) return null;
  return new Database(PROD_DB, { readonly: true });
}

export const tables = (d) => d.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
).all().map((r) => r.name);

export const columns = (d, t) => d.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);

export const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

export function sourceFiles(dir, skip = []) {
  const out = [];
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (skip.some((s) => rel.startsWith(s))) continue;
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) out.push(rel);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}
