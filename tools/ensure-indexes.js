#!/usr/bin/env node
// Индексы, которые дороги в постройке и потому не живут в схеме.
//
// Схема выполняется при каждом открытии базы, а построение индекса на таблице в 554 000
// строк держит блокировку записи секунд двадцать. Ожидание записи у нас 15 секунд, значит
// любой процесс, открывший базу во время сбора, уронил бы полосу по SQLITE_BUSY. Поэтому
// такие индексы строятся отдельным шагом — планировщиком перед отчётами, когда конвейер
// уже свободен, или руками.
import { db } from '../src/lib/db.js';
import { log } from '../src/lib/util.js';

const INDEXES = [
  // Разрешения сняты у 3 391 приложения из 19 385. Без этого индекса поиск последнего
  // известного списка — проход по всей таблице карточек, 12 секунд на каждое гео.
  ['ix_app_page_perms', `CREATE INDEX IF NOT EXISTS ix_app_page_perms ON raw_app_page(app_id, snapshot_date) WHERE permissions IS NOT NULL`],
];

const d = db();
const has = (name) => d.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name=?`).get(name).c > 0;

let made = 0;
for (const [name, sql] of INDEXES) {
  if (has(name)) { log(`  ${name}: уже есть`); continue; }
  const t0 = Date.now();
  d.exec(sql);
  log(`  ${name}: построен за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  made++;
}
log(made ? `готово, новых индексов ${made}` : 'все индексы на месте');
