// D3. Граф похожих: от семян и топ-10 по головным ключам, глубина 2.
// Останов: категория вне семян; установки выше p95 ниши/гео.
import { play } from '../lib/play.js';
import { db, startRun, finishRun } from '../lib/db.js';
import { config, primaryHl } from '../lib/config.js';
import { qv } from './quantiles.js';
import { registerApp } from '../lib/registry.js';
import { log } from '../lib/util.js';

export async function run({ geo, date, runId, cycle = 'discovery' }) {
  const d = db();
  startRun(runId, 'similar-graph', geo, cycle, date);
  const hl = primaryHl(geo);
  const budget = config().budget.discovery;
  const seedCats = new Set(d.prepare(`SELECT category FROM seed_categories WHERE geo=?`).all(geo).map((r) => r.category));
  const p95 = qv(null, geo, 'installs', date, 'p95', { nicheFirst: false });

  // Старт: семена + топ-10 по головным ключам (или по ключам с наибольшим весом подсказок).
  const start = d.prepare(
    `SELECT DISTINCT r.app_id FROM raw_search r
       JOIN disc_keywords k ON k.geo=r.geo AND k.keyword=r.keyword
      WHERE r.geo=? AND r.position<=10 AND k.is_brand=0
      ORDER BY k.suggest_score DESC LIMIT ?`
  ).all(geo, budget.similar_seeds).map((r) => r.app_id);
  const seedApps = d.prepare(`SELECT app_id FROM seed_apps WHERE geo=?`).all(geo).map((r) => r.app_id);

  const insEdge = d.prepare(`INSERT OR REPLACE INTO disc_similar_edges (geo, src, dst, depth) VALUES (?,?,?,?)`);
  const insSim = d.prepare(`INSERT OR REPLACE INTO raw_similar (snapshot_date, geo, app_id, similar_app_id, position) VALUES (?,?,?,?,?)`);
  const known = new Set(d.prepare(`SELECT app_id FROM disc_apps WHERE geo=?`).all(geo).map((r) => r.app_id));

  let frontier = [...new Set([...seedApps, ...start])];
  const visited = new Set();
  let found = 0, requests = 0, errors = 0;

  for (let depth = 1; depth <= budget.similar_depth; depth++) {
    const next = [];
    for (const src of frontier) {
      if (visited.has(src)) continue;
      visited.add(src);
      let sim = [];
      try {
        sim = await play.similar(src, geo, hl);
        requests++;
      } catch (e) {
        errors++;
        continue;
      }
      d.transaction(() => {
        sim.forEach((a, i) => {
          insSim.run(date, geo, src, a.appId, i + 1);
          insEdge.run(geo, src, a.appId, depth);
          if (!known.has(a.appId)) {
            registerApp(a.appId, geo, `similar:${src}`, date, a);
            known.add(a.appId);
            found++;
          }
        });
      })();
      // Останов обхода вглубь
      for (const a of sim) {
        const card = d.prepare(`SELECT genre_id, max_installs FROM raw_app_page WHERE app_id=? AND geo=? ORDER BY snapshot_date DESC LIMIT 1`).get(a.appId, geo);
        const outOfCat = seedCats.size && card?.genre_id && !seedCats.has(card.genre_id);
        const tooBig = p95 != null && card?.max_installs != null && card.max_installs > p95;
        if (!outOfCat && !tooBig) next.push(a.appId);
      }
    }
    frontier = [...new Set(next)].slice(0, budget.similar_seeds * 2);
  }

  // Приёмка v1.5: D3 находит >= 15 % вне выдачи.
  const outsideSerp = d.prepare(
    `SELECT COUNT(*) c FROM disc_apps da WHERE da.geo=? AND da.first_seen_via LIKE 'similar:%'
       AND NOT EXISTS (SELECT 1 FROM raw_search s WHERE s.geo=da.geo AND s.app_id=da.app_id)`
  ).get(geo).c;
  const total = d.prepare(`SELECT COUNT(*) c FROM disc_apps WHERE geo=?`).get(geo).c;

  finishRun(runId, 'similar-graph', geo, {
    requests, errors, notes: `+${found} приложений, вне выдачи ${outsideSerp} (${total ? ((outsideSerp / total) * 100).toFixed(1) : 0}%)`,
  });
  log(`  ${geo}: граф похожих +${found}, вне выдачи ${outsideSerp} из ${total}`);
  return { found, outsideSerp, total };
}
