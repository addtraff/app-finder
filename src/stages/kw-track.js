// kw-track: история позиций по словам своих приложений и избранному (раздел 7).
// Ошибка в позиции напрямую переносится в оценку объёма, поэтому позиция нужна за тот же день,
// что и строка Console. Слово, уже снятое сегодня радаром (raw_search), повторно не снимается.
import { play, CaptchaStop } from '../lib/play.js';
import { primaryHl } from '../lib/config.js';
import { log, warn, daysAgoUTC } from '../lib/util.js';
import { kwDb, kwConfig } from '../lib/kw/schema.js';

export async function run({ geo, date, limit = null }) {
  const d = kwDb();
  const cfg = kwConfig();
  const hl = primaryHl(geo);
  const from = daysAgoUTC(cfg.calibration.window_days - 1, new Date(`${date}T12:00:00Z`));
  const terms = d.prepare(
    `SELECT term FROM kw_watch WHERE geo=?
     UNION
     SELECT DISTINCT term FROM console_search_terms WHERE geo=? AND day>=? AND is_censored=0`).all(geo, geo, from).map((r) => r.term);
  const snapped = d.prepare(
    `SELECT 1 FROM kw_track_serp WHERE geo=? AND term=? AND snapshot_date=?
     UNION ALL SELECT 1 FROM raw_search WHERE geo=? AND keyword=? AND snapshot_date=? LIMIT 1`);
  const todo = terms.filter((t) => !snapped.get(geo, t, date, geo, t, date));
  const queue = limit ? todo.slice(0, limit) : todo;
  if (!terms.length) {
    log(`  ${geo}: отслеживать нечего — нет ни избранного, ни слов из Console`);
    return { done: 0 };
  }
  const ins = d.prepare(`INSERT OR REPLACE INTO kw_track_serp (snapshot_date, geo, term, position, app_id) VALUES (?,?,?,?,?)`);
  let done = 0, errors = 0, empty = 0;
  for (const term of queue) {
    let res;
    try {
      res = await play.search(term, geo, hl, 50);
    } catch (e) {
      if (e instanceof CaptchaStop) { warn(`  ${geo}: ${e.message}`); break; }
      errors++;
      continue;
    }
    if (!res.length) empty++;
    d.transaction(() => res.forEach((app, i) => ins.run(date, geo, term, i + 1, app.appId)))();
    done++;
  }
  const emptyShare = queue.length ? empty / queue.length : 0;
  if (emptyShare > cfg.health.serp_empty_share_max) {
    warn(`  ${geo}: пустых срезов ${(emptyShare * 100).toFixed(1)} % — возможен дрейф парсера выдачи (раздел 10)`);
  }
  log(`  ${geo}: позиции сняты по ${done} словам из ${terms.length} (уже были сегодня: ${terms.length - todo.length}), ошибок ${errors}, пустых ${empty}`);
  return { done, errors, empty };
}
