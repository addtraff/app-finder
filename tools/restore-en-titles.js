// Возвращает приложениям английские названия из последней английской карточки.
// Нужен один раз после прохода, который шёл на коде, где название перезаписывалось карточкой
// любого гео (после SA названия в отчётах стали арабскими).
//   node tools/restore-en-titles.js
import { db } from '../src/lib/db.js';

const d = db();
const t0 = Date.now();
const rows = d.prepare(
  `SELECT app_id, title, MAX(snapshot_date) AS dt FROM raw_app_page
    WHERE hl LIKE 'en%' AND title IS NOT NULL AND title<>'' GROUP BY app_id`
).all();
const up = d.prepare(`UPDATE apps SET title=? WHERE app_id=? AND (title IS NULL OR title<>?)`);
let changed = 0;
d.transaction(() => { for (const r of rows) changed += up.run(r.title, r.app_id, r.title).changes; }).immediate();
console.log(`английских названий ${rows.length}, исправлено ${changed} за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
