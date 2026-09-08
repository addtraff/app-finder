// Разовый добор title_hash / short_desc_hash для карточек, снятых до правки A1.
import { db } from '../src/lib/db.js';
import { md5 } from '../src/lib/util.js';

const d = db();
const rows = d.prepare(
  `SELECT app_id, geo, hl, snapshot_date, title, summary FROM raw_app_page WHERE title_hash IS NULL`
).all();
const up = d.prepare(
  `UPDATE raw_app_page SET title_hash=?, short_desc_hash=?
    WHERE app_id=? AND geo=? AND hl=? AND snapshot_date=?`
);
d.transaction(() => {
  for (const r of rows) {
    up.run(md5(String(r.title || '').trim().toLowerCase()),
           md5(String(r.summary || '').trim().toLowerCase()),
           r.app_id, r.geo, r.hl, r.snapshot_date);
  }
})();
console.log(`хеши добраны: ${rows.length} карточек`);
