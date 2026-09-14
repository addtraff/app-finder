// K4. Новые отзывы по каждому языку гео, до первого известного review_id.
// Страна не заявляется — только lang (гео-атрибуция отзывов через язык, риск в ТЗ 16).
import { play } from '../lib/play.js';
import { db, startRun, finishRun } from '../lib/db.js';
import { config, geoConf } from '../lib/config.js';

// A4 (дополнение к ТЗ): review_lang_mismatch считается только для уровня A, у которого
// сняты все языки набора. Ниже — объединение языков отзывов по всем 30 гео.
function allReviewLangs() {
  const set = new Set();
  for (const g of config().geos.geos) for (const l of g.review_langs) set.add(l);
  return [...set];
}
import { log } from '../lib/util.js';

export async function run({ geo, date, runId, cycle = 'discovery', limit = null, force = false }) {
  const d = db();
  startRun(runId, 'enrich-reviews', geo, cycle, date);
  const g = geoConf(geo);
  const budget = config().budget;
  const disc = budget.discovery;

  // Принудительный сбор (--force): трёхдневное окно B и полное исключение C/D не
  // действуют — берём A/B/C без лимита. Та же логика, что у enrich-apps: расписание
  // по умолчанию бережёт RPM-бюджет, force жертвует им ради полного снимка сегодня.
  // watch_level здесь общий для приложения, а не per-geo, поэтому эта стадия
  // при --force вызывается один раз на каждое из 30 гео за тот же список app_id —
  // без отсечки «уже собрано сегодня» это 30-кратный повтор одного и того же запроса.
  // Отсечка по дате (а не по review_id) даёт языку первого прошедшего гео забрать
  // приложение целиком — точность по языку здесь приносится в жертву тому же RPM.
  const targets = cycle === 'daily' && force
    ? d.prepare(
        `SELECT app_id, watch_level FROM apps
          WHERE watch_level IN ('A','B','C')
            AND app_id NOT IN (SELECT DISTINCT app_id FROM raw_reviews WHERE fetched_at=?)
          ORDER BY CASE watch_level WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END`
      ).all(date)
    : cycle === 'daily'
    ? d.prepare(
        `SELECT app_id, watch_level FROM apps
          WHERE watch_level='A'
             OR (watch_level='B' AND app_id NOT IN (
                   SELECT DISTINCT app_id FROM raw_reviews WHERE fetched_at > date(?, '-3 day')))
          ORDER BY CASE watch_level WHEN 'A' THEN 0 ELSE 1 END`
      ).all(date)
    : d.prepare(
        `SELECT a.app_id, a.watch_level FROM apps a
          WHERE a.watch_level IN ('A','B','C')
          ORDER BY CASE a.watch_level WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END
          LIMIT ?`
      ).all(disc.max_review_apps);

  const todo = limit ? targets.slice(0, limit) : targets;
  const ins = d.prepare(`INSERT OR IGNORE INTO raw_reviews
    (review_id, app_id, geo, lang, review_date, rating, text, version, thumbs_up, reply_present, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const known = d.prepare(`SELECT 1 FROM raw_reviews WHERE review_id=?`);

  let apps = 0, saved = 0, errors = 0;
  const langsA = allReviewLangs();
  for (const t of todo) {
    const first = !d.prepare(`SELECT 1 FROM raw_reviews WHERE app_id=? LIMIT 1`).get(t.app_id);
    const num = cycle === 'daily'
      ? budget.daily.reviews_per_app
      : (t.watch_level === 'C' ? disc.reviews_screen_snapshot : (first ? disc.reviews_first_snapshot : budget.daily.reviews_per_app));

    // Уровень A — все языки набора; B и C — только языки гео.
    const langs = t.watch_level === 'A' ? langsA : g.review_langs;
    for (const lang of langs) {
      let list = [];
      try {
        list = await play.reviews(t.app_id, geo, lang, num);
      } catch (e) {
        errors++;
        log(`  отзывы ${t.app_id}/${lang}: ${e.message}`);
        continue;
      }
      let stop = false;
      const write = d.transaction(() => {
        for (const r of list) {
          if (!first && known.get(r.id)) { stop = true; break; } // до первого известного review_id
          ins.run(r.id, t.app_id, geo, lang, r.date ? String(r.date).slice(0, 10) : null,
            r.score ?? null, r.text ?? null, r.version ?? null, r.thumbsUp ?? 0,
            r.replyText ? 1 : 0, date);
          saved++;
        }
      });
      write();
      if (stop) { /* дошли до известного — дальше не листаем */ }
    }
    apps++;
    if (apps % 20 === 0) log(`  отзывы: ${apps}/${todo.length} приложений, строк ${saved}`);
  }

  finishRun(runId, 'enrich-reviews', geo, { requests: apps * g.review_langs.length, errors, notes: `${saved} отзывов по ${apps} приложениям` });
  log(`  ${geo}: отзывов ${saved} по ${apps} приложениям, ошибок ${errors}`);
  return { apps, saved, errors };
}
