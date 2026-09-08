// K2 / D2. Топ-50 по каждому активному ключу × гео. Пакеты из топ-20 вне реестра -> уровень C.
// Здесь же размечаются навигационные (брендовые) ключи и мёртвые ключи.
import { play } from '../lib/play.js';
import { db, startRun, finishRun } from '../lib/db.js';
import { config, primaryHl } from '../lib/config.js';
import { registerApp } from '../lib/registry.js';
import { log } from '../lib/util.js';

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Навигационные запросы. ТЗ: «название первого результата равно запросу или начинается с него».
// Буквальное применение правила в Play выбрасывает из ядра самые ценные generic-ключи:
// у «voice recorder» первое приложение так и называется — Voice Recorder. Это не бренд,
// а самый общий ключ ниши. Поэтому добавлено одно условие: запрос считается навигационным,
// только если совпадение единичное. Если название запроса встречается в заголовках трёх и
// более приложений топ-10, это категория, а не бренд.
export function markBrandKeywords(d, geo) {
  const rows = d.prepare(
    `SELECT r.keyword, r.position, a.title
       FROM raw_search r
       JOIN (SELECT keyword, MAX(snapshot_date) AS md FROM raw_search WHERE geo=? GROUP BY keyword) f
         ON f.keyword = r.keyword AND f.md = r.snapshot_date
       JOIN apps a ON a.app_id = r.app_id
      WHERE r.geo=? AND r.position <= 10
      ORDER BY r.keyword, r.position`
  ).all(geo, geo);

  const byKw = new Map();
  for (const r of rows) {
    if (!byKw.has(r.keyword)) byKw.set(r.keyword, []);
    byKw.get(r.keyword).push(normTitle(r.title));
  }
  const up = d.prepare(`UPDATE disc_keywords SET is_brand=? WHERE geo=? AND keyword=?`);
  let brands = 0;
  d.transaction(() => {
    for (const [kw, titles] of byKw) {
      const q = normTitle(kw);
      const first = titles[0] || '';
      const looksNavigational = !!first && (first === q || first.startsWith(q));
      const titlesWithQuery = titles.filter((t) => t.includes(q)).length;
      const isBrand = looksNavigational && titlesWithQuery < 3 ? 1 : 0;
      up.run(isBrand, geo, kw);
      if (isBrand) brands++;
    }
  })();
  return brands;
}

export async function run({ geo, date, runId, cycle = 'discovery', limit = null }) {
  const d = db();
  startRun(runId, 'keyword-serp', geo, cycle, date);
  const hl = primaryHl(geo);
  const budget = config().budget[cycle === 'daily' ? 'daily' : 'discovery'];
  const topN = budget.serp_top_n || 50;

  // Ключи, ещё не снятые сегодня. Стадия перезапускаема с места (catchup).
  const kws = d.prepare(
    `SELECT k.keyword FROM disc_keywords k
      WHERE k.geo=? AND k.active=1 AND k.dead=0
        AND NOT EXISTS (SELECT 1 FROM raw_search s WHERE s.geo=k.geo AND s.keyword=k.keyword AND s.snapshot_date=?)
      ORDER BY k.depth ASC, k.suggest_score DESC`
  ).all(geo, date).map((r) => r.keyword);

  const todo = limit ? kws.slice(0, limit) : kws;
  const insSerp = d.prepare(
    `INSERT OR REPLACE INTO raw_search (snapshot_date, geo, keyword, position, app_id, run_id) VALUES (?,?,?,?,?,?)`
  );
  const upDead = d.prepare(`UPDATE disc_keywords SET dead=? WHERE geo=? AND keyword=?`);
  const upAppKw = d.prepare(
    `INSERT INTO disc_app_keyword (geo, keyword, app_id, best_position, snapshot_date) VALUES (?,?,?,?,?)
     ON CONFLICT(geo, keyword, app_id) DO UPDATE SET
       best_position = MIN(best_position, excluded.best_position), snapshot_date = excluded.snapshot_date`
  );

  let done = 0, errors = 0, empty = 0;
  for (const kw of todo) {
    let res = [];
    try {
      res = await play.search(kw, geo, hl, topN);
    } catch (e) {
      errors++;
      log(`  выдача "${kw}" упала: ${e.message}`);
      continue;
    }
    if (!res.length) empty++;

    d.transaction(() => {
      res.forEach((app, i) => {
        insSerp.run(date, geo, kw, i + 1, app.appId, runId);
        upAppKw.run(geo, kw, app.appId, i + 1, date);
        registerApp(app.appId, geo, `serp:${kw}`, date, app);
      });
      upDead.run(res.length === 0 ? 1 : 0, geo, kw);
    })();
    done++;
    if (done % 25 === 0) log(`  выдача: ${done}/${todo.length}`);
  }

  const brands = markBrandKeywords(d, geo);
  const emptyPct = todo.length ? empty / todo.length : 0;
  finishRun(runId, 'keyword-serp', geo, {
    requests: done, errors, emptyPct,
    status: emptyPct > 0.1 ? 'suspect' : 'ok',
    notes: `${done} ключей, пустых ${(emptyPct * 100).toFixed(1)}%, навигационных ${brands}`,
  });
  log(`  ${geo}: снято ${done} ключей, ошибок ${errors}, пустых ${(emptyPct * 100).toFixed(1)}%, навигационных ${brands}`);
  return { done, errors, emptyPct };
}
