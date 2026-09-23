// Снимает находки трекера, которые держались только на голых словах Adjust / Branch /
// Singular. Это обычные английские слова: «Adjust the line size», «Branch office»,
// «you may adjust your settings» — последнее стоит в каждом втором шаблоне privacy policy.
//
// Почему found = NULL, а не 0. Ноль означал бы «проверили, трекера нет» — но мы этого не
// проверяли: старая улика просто оказалась негодной. NULL честно говорит «не проверено»,
// и radar-v2 оставляет такому приложению ступень «не проверялось», а не выдаёт его за
// органику. Текст политики в базе не хранится, поэтому пересверка требует повторной
// загрузки страницы — её делает обычный прогон analyze-tracking.
//
//   node tools/invalidate-weak-tracking.js          — только посчитать
//   node tools/invalidate-weak-tracking.js --apply  — снять
import { db } from '../src/lib/db.js';

const apply = process.argv.includes('--apply');
const d = db();
const AMB = new Set(['adjust', 'branch', 'singular']);

const rows = d.prepare(`SELECT app_id, matched_names, matched_in, note FROM raw_tracking_scan WHERE found=1`).all();
const weak = [];
for (const r of rows) {
  let names = [];
  try { names = JSON.parse(r.matched_names || '[]'); } catch { names = String(r.matched_names || '').split(/[,\s]+/).filter(Boolean); }
  names = names.map((x) => String(x).trim()).filter(Boolean);
  if (!names.length) continue;
  if (names.every((n) => AMB.has(n.toLowerCase()))) weak.push({ ...r, names });
}

const byName = new Map();
for (const w of weak) byName.set(w.names.join('+'), (byName.get(w.names.join('+')) || 0) + 1);
console.log(`находок трекера: ${rows.length}, держатся только на голом слове: ${weak.length}`);
console.log('разбивка:', [...byName].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', '));

if (!apply) { console.log('это был подсчёт. Чтобы снять: --apply'); process.exit(0); }

const upd = d.prepare(`UPDATE raw_tracking_scan SET found=NULL, note=? WHERE app_id=?`);
const now = new Date().toISOString().slice(0, 10);
d.transaction(() => {
  for (const w of weak) {
    upd.run(JSON.stringify({ invalidated: now, was: w.names, where: w.matched_in, why: 'улика держалась на голом слове, нужна пересверка' }), w.app_id);
  }
})();
// Метка «покупает» из organic_labels тоже снимается: она ссылалась на ту же улику.
const delLabel = d.prepare(`DELETE FROM organic_labels WHERE app_id=? AND evidence='tracking_scan'`);
let labels = 0;
d.transaction(() => { for (const w of weak) labels += delLabel.run(w.app_id).changes; })();
console.log(`снято находок: ${weak.length}, убрано меток «покупает»: ${labels}`);
console.log('дальше нужен пересчёт radar-v2, чтобы ступени канала обновились');
