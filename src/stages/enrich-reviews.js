// K4. Новые отзывы по каждому языку гео, до первого известного review_id.
// Страна не заявляется — только lang (гео-атрибуция отзывов через язык, риск в ТЗ 16).
import { play } from '../lib/play.js';
import { db, startRun, finishRun } from '../lib/db.js';
import { config, geoConf } from '../lib/config.js';
import { screenAsOf } from '../lib/snapshots.js';

// A4 (дополнение к ТЗ): review_lang_mismatch считается только для уровня A, у которого
// сняты все языки набора. Ниже — объединение языков отзывов по всем 30 гео.
function allReviewLangs() {
  const set = new Set();
  for (const g of config().geos.geos) for (const l of g.review_langs) set.add(l);
  return [...set];
}
import { log } from '../lib/util.js';

export async function run({ geo, date, runId, cycle = 'discovery', limit = null, force = false, scope = null }) {
  const d = db();
  startRun(runId, 'enrich-reviews', geo, cycle, date);
  const g = geoConf(geo);
  const budget = config().budget;
  const disc = budget.discovery;
  if (scope === 'funnel') return runFunnel({ d, geo, date, runId, g, disc, limit });

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

// --scope funnel: добор отзывов для приложений, прошедших воронку в гео, у которых на языках
// гео меньше 20 отзывов — порог, ниже которого score не считает src_ads_pct, жалобы и рост.
// Язык проверяется по каждому языку отдельно: если отзывов на нём ещё нет, берётся полная
// порция, а не «до первого известного».
async function runFunnel({ d, geo, date, runId, g, disc, limit }) {
  const langs = g.review_langs;
  const langIn = `lang IN (${langs.map(() => '?').join(',')})`;
  const md = d.prepare(`SELECT MAX(snapshot_date) m FROM metrics_app_geo WHERE geo=?`).get(geo)?.m;
  const targets = md ? d.prepare(
    `SELECT m.app_id FROM metrics_app_geo m ${screenAsOf('s', 'm', 'JOIN')}
      WHERE m.geo=? AND m.snapshot_date=? AND s.reject_reason IS NULL
        AND (SELECT COUNT(*) FROM raw_reviews r WHERE r.app_id=m.app_id AND r.${langIn}) < 20
      ORDER BY m.prescore DESC`
  ).all(geo, md, ...langs) : [];
  const todo = limit ? targets.slice(0, limit) : targets;
  const ins = d.prepare(`INSERT OR IGNORE INTO raw_reviews
    (review_id, app_id, geo, lang, review_date, rating, text, version, thumbs_up, reply_present, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const known = d.prepare(`SELECT 1 FROM raw_reviews WHERE review_id=?`);
  const hasLang = d.prepare(`SELECT 1 FROM raw_reviews WHERE app_id=? AND lang=? LIMIT 1`);
  let apps = 0, saved = 0, errors = 0;
  log(`  ${geo}: отзывы для воронки — ${targets.length} приложений с < 20 отзывами на ${langs.join('/')}`);
  for (const t of todo) {
    for (const lang of langs) {
      const first = !hasLang.get(t.app_id, lang);
      let list = [];
      try {
        list = await play.reviews(t.app_id, geo, lang, disc.reviews_first_snapshot);
      } catch (e) {
        errors++;
        log(`  отзывы ${t.app_id}/${lang}: ${e.message}`);
        continue;
      }
      d.transaction(() => {
        for (const r of list) {
          if (!first && known.get(r.id)) break;
          ins.run(r.id, t.app_id, geo, lang, r.date ? String(r.date).slice(0, 10) : null,
            r.score ?? null, r.text ?? null, r.version ?? null, r.thumbsUp ?? 0, r.replyText ? 1 : 0, date);
          saved++;
        }
      })();
    }
    apps++;
    if (apps % 20 === 0) log(`  отзывы воронки: ${apps}/${todo.length}, строк ${saved}`);
  }
  finishRun(runId, 'enrich-reviews', geo, { requests: apps * langs.length, errors, notes: `воронка: ${saved} отзывов по ${apps} приложениям` });
  log(`  ${geo}: отзывы воронки — ${saved} строк по ${apps} приложениям, ошибок ${errors}`);
  return { apps, saved, errors };
}
