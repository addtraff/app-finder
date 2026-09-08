// K5 / D5. Чарты free и grossing по категориям семян.
import { play } from '../lib/play.js';
import { db, startRun, finishRun } from '../lib/db.js';
import { config, primaryHl } from '../lib/config.js';
import { registerApp } from '../lib/registry.js';
import { log } from '../lib/util.js';

export async function run({ geo, date, runId, cycle = 'discovery' }) {
  const d = db();
  startRun(runId, 'collect-charts', geo, cycle, date);
  const hl = primaryHl(geo);
  const cats = d.prepare(`SELECT category FROM seed_categories WHERE geo=?`).all(geo).map((r) => r.category);
  const collections = [play.collections.TOP_FREE, play.collections.GROSSING];
  const num = cycle === 'discovery' ? 100 : 50;

  const insChart = d.prepare(
    `INSERT OR REPLACE INTO raw_charts (snapshot_date, geo, collection, category, position, app_id) VALUES (?,?,?,?,?,?)`
  );
  let rows = 0, errors = 0;

  for (const category of cats) {
    for (const collection of collections) {
      let list = [];
      try {
        list = await play.list(collection, category, geo, hl, num);
      } catch (e) {
        errors++;
        log(`  чарт ${category}/${collection} упал: ${e.message}`);
        continue;
      }
      const write = d.transaction(() => {
        list.forEach((app, i) => {
          insChart.run(date, geo, collection, category, i + 1, app.appId);
          registerApp(app.appId, geo, `chart:${category}:${collection}`, date, app);
          rows++;
        });
      });
      write();
      log(`  чарт ${category}/${collection}: ${list.length}`);
    }
  }

  finishRun(runId, 'collect-charts', geo, { requests: cats.length * collections.length, errors, notes: `${rows} строк` });
  return { rows, errors };
}
