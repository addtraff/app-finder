// K1 / D7. Карточка по каждому hl гео. Одна строка — один снимок; дельты считаются между строками.
import { play } from '../lib/play.js';
import { db, startRun, finishRun, logEvent } from '../lib/db.js';
import { config, geoConf } from '../lib/config.js';
import { ensureRates, toUsd } from '../lib/fx.js';
import { md5, parseSizeMb, parseIapRange, log } from '../lib/util.js';

function pickAppsToRefresh(d, geo, date, cycle, budget, force) {
  if (cycle === 'daily' && force) {
    // Принудительный сбор (--force): недельное окно C-уровня (ТЗ 5.2) не действует —
    // берём всё, что этот гео когда-либо находил и что прошло screen (watch_level
    // проставлен), без разбора уровня и без недельного окна. Нужно, когда требуется
    // свежий снимок сегодня для всех, а не только для A/B по расписанию: без него у
    // C/D копится история с разрывами в неделю, и day-7/day-14 метрики не считаются
    // даже там, где реально прошло 7 дней.
    // watch_level IS NULL — не «C пониже», а вообще не классифицировано (screen.js
    // не входит в DAILY, только в DISCOVERY): таких 70К+ по всем гео, в metrics_app_geo
    // они не попадают, и тратить на их карточки сетевой бюджет незачем.
    return d.prepare(
      `SELECT DISTINCT da.app_id FROM disc_apps da
         JOIN apps a ON a.app_id = da.app_id
        WHERE da.geo=? AND a.status <> 'rejected' AND a.watch_level IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM raw_app_page p WHERE p.app_id=da.app_id AND p.geo=? AND p.snapshot_date=?)
        ORDER BY CASE a.watch_level WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END`
    ).all(geo, geo, date).map((r) => r.app_id);
  }
  if (cycle === 'daily') {
    // Уровни A и B — ежедневно, C — раз в неделю (ТЗ 5.2). Плюс всё, что прошло воронку в
    // этом гео за последние две недели, независимо от уровня: отчёты показывают день гео, и
    // без свежей карточки прошедшее воронку приложение из дня выпадает — в US так пропали
    // 141 из 271 строк.
    return d.prepare(
      `SELECT a.app_id FROM apps a
        WHERE a.status <> 'rejected'
          AND (a.watch_level IN ('A','B')
               OR (a.watch_level='C' AND NOT EXISTS (
                     SELECT 1 FROM raw_app_page p WHERE p.app_id=a.app_id AND p.geo=? AND p.snapshot_date > date(?, '-7 day')))
               OR EXISTS (SELECT 1 FROM screen_result s WHERE s.app_id=a.app_id AND s.geo=?
                            AND s.reject_reason IS NULL AND s.snapshot_date > date(?, '-14 day')))
          AND NOT EXISTS (SELECT 1 FROM raw_app_page p WHERE p.app_id=a.app_id AND p.geo=? AND p.snapshot_date=?)
        ORDER BY CASE a.watch_level WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END`
    ).all(geo, date, geo, date, geo, date).map((r) => r.app_id);
  }
  // Обход: карточки для всего, что найдено в гео и ещё без сегодняшней карточки.
  return d.prepare(
    `SELECT da.app_id FROM disc_apps da
      JOIN apps a ON a.app_id = da.app_id
     WHERE da.geo=?
       AND NOT EXISTS (SELECT 1 FROM raw_app_page p WHERE p.app_id=da.app_id AND p.geo=da.geo AND p.snapshot_date=?)
     ORDER BY da.discovery_paths_count DESC
     LIMIT ?`
  ).all(geo, date, budget.max_apps_cards_per_geo).map((r) => r.app_id);
}

// --scope core-top: карточки для топ-10 выдачи по ключам ядер текущих ниш гео, у которых нет
// карточки ни в одном гео. Без них door ключа и ниши, свобода и чистота пусты: в топ-10 ниш
// 13 тыс. приложений, у 9 тыс. карточки не было нигде — обход брал только реестр и лимит 700.
// Одна карточка на приложение (первый hl гео): установки общие для Play, а в следующих гео
// приложение отсеивается условием «нет карточки нигде».
function pickCoreTop(d, geo) {
  return d.prepare(
    `WITH cur AS (SELECT niche_id FROM metrics_niche_geo WHERE geo=?
                   AND snapshot_date=(SELECT MAX(snapshot_date) FROM metrics_niche_geo WHERE geo=?)),
          latest AS (SELECT keyword, MAX(snapshot_date) md FROM raw_search WHERE geo=? GROUP BY keyword)
     SELECT r.app_id, MIN(r.position) AS pos
       FROM keyword_cores kc
       JOIN cur ON cur.niche_id=kc.niche_id
       JOIN latest l ON l.keyword=kc.keyword
       JOIN raw_search r ON r.geo=kc.geo AND r.keyword=kc.keyword AND r.snapshot_date=l.md AND r.position<=10
       LEFT JOIN disc_keywords k ON k.geo=kc.geo AND k.keyword=kc.keyword
      WHERE kc.geo=? AND kc.active=1 AND COALESCE(k.is_brand, 0)=0
        AND NOT EXISTS (SELECT 1 FROM raw_app_page p WHERE p.app_id=r.app_id)
      GROUP BY r.app_id
      ORDER BY pos, r.app_id`
  ).all(geo, geo, geo, geo).map((r) => r.app_id);
}

export async function run({ geo, date, runId, cycle = 'discovery', limit = null, force = false, scope = null }) {
  const d = db();
  startRun(runId, 'enrich-apps', geo, cycle, date);
  await ensureRates(date);

  const g0 = geoConf(geo);
  const coreTop = scope === 'core-top';
  const g = coreTop ? { ...g0, hl: [g0.hl[0]] } : g0;
  const budget = config().budget.discovery;
  let todo = coreTop ? pickCoreTop(d, geo) : pickAppsToRefresh(d, geo, date, cycle, budget, force);
  if (coreTop) log(`  ${geo}: топ-10 ниш без карточки нигде — ${todo.length}`);
  if (limit) todo = todo.slice(0, limit);

  const ins = d.prepare(`INSERT OR REPLACE INTO raw_app_page (
    app_id, geo, hl, snapshot_date, run_id, cycle, title, summary, description, description_len,
    max_installs, min_installs, installs_text, installs_country, score, ratings_count, reviews_count, histogram,
    price, currency, free, available, offers_iap, iap_range, iap_min_usd, iap_max_usd, contains_ads,
    size_text, size_mb, android_version, released, updated_ts, version, genre, genre_id, content_rating, badges,
    screenshots_count, video_present, developer, developer_id, developer_email, developer_website,
    developer_address, developer_legal_name, privacy_policy, permissions, similar,
    listing_hash, title_hash, short_desc_hash, raw_json)
    VALUES (@app_id,@geo,@hl,@snapshot_date,@run_id,@cycle,@title,@summary,@description,@description_len,
    @max_installs,@min_installs,@installs_text,@installs_country,@score,@ratings_count,@reviews_count,@histogram,
    @price,@currency,@free,@available,@offers_iap,@iap_range,@iap_min_usd,@iap_max_usd,@contains_ads,
    @size_text,@size_mb,@android_version,@released,@updated_ts,@version,@genre,@genre_id,@content_rating,@badges,
    @screenshots_count,@video_present,@developer,@developer_id,@developer_email,@developer_website,
    @developer_address,@developer_legal_name,@privacy_policy,@permissions,@similar,
    @listing_hash,@title_hash,@short_desc_hash,@raw_json)`);

  const prevStmt = d.prepare(
    `SELECT max_installs, installs_country, listing_hash, available, snapshot_date
       FROM raw_app_page WHERE app_id=? AND geo=? AND hl=? AND snapshot_date<? ORDER BY snapshot_date DESC LIMIT 1`
  );
  const upApp = d.prepare(`UPDATE apps SET title=?, developer=?, developer_id=?, genre_id=? WHERE app_id=?`);

  let done = 0, errors = 0, missing = 0;
  for (const appId of todo) {
    for (const hl of g.hl) {
      let a = null;
      try {
        a = await play.app(appId, geo, hl);
      } catch (e) {
        errors++;
        log(`  карточка ${appId} (${hl}) упала: ${e.message}`);
        continue;
      }
      if (!a) { missing++; continue; }

      const iap = parseIapRange(a.IAPRange);
      const cur = a.currency || g.currency;
      const hash = md5([a.title, a.summary, a.description, a.version, (a.screenshots || []).length,
        a.IAPRange, a.price, a.adSupported, a.updated].join('|'));

      const row = {
        app_id: appId, geo, hl, snapshot_date: date, run_id: runId, cycle,
        title: a.title ?? null, summary: a.summary ?? null,
        description: a.description ?? null, description_len: (a.description || '').length,
        max_installs: a.maxInstalls ?? null, min_installs: a.minInstalls ?? null,
        installs_text: a.installs ?? null,
        installs_country: a.installsCountry ?? null, // Play отдаёт не всегда; пусто, а не ноль
        score: a.score ?? null, ratings_count: a.ratings ?? null, reviews_count: a.reviews ?? null,
        histogram: a.histogram ? JSON.stringify(a.histogram) : null,
        price: a.price ?? null, currency: cur, free: a.free ? 1 : 0, available: a.available === false ? 0 : 1,
        offers_iap: a.offersIAP ? 1 : 0, iap_range: a.IAPRange ?? null,
        iap_min_usd: toUsd(iap.min, cur, date), iap_max_usd: toUsd(iap.max, cur, date),
        contains_ads: a.adSupported ? 1 : 0,
        size_text: a.size ?? null, size_mb: parseSizeMb(a.size),
        android_version: a.androidVersionText ?? a.androidVersion ?? null,
        released: a.released ?? null, updated_ts: a.updated ?? null, version: a.version ?? null,
        genre: a.genre ?? null, genre_id: a.genreId ?? null, content_rating: a.contentRating ?? null,
        badges: JSON.stringify({
          playPass: !!a.isAvailableInPlayPass, preregister: !!a.preregister, earlyAccess: !!a.earlyAccessEnabled,
        }),
        screenshots_count: (a.screenshots || []).length, video_present: a.video ? 1 : 0,
        developer: a.developer ?? null, developer_id: a.developerId ?? null,
        developer_email: a.developerEmail ?? a.developerLegalEmail ?? null,
        developer_website: a.developerWebsite ?? null,
        developer_address: a.developerAddress ?? a.developerLegalAddress ?? null,
        developer_legal_name: a.developerLegalName ?? null,
        privacy_policy: a.privacyPolicy ?? null,
        permissions: null, similar: null,
        listing_hash: hash,
        // A1: локализация определяется расхождением заголовка или краткого описания
        // с версией hl=en, gl=US. Хеши считаются здесь, сравниваются в расчётном слое.
        title_hash: md5(String(a.title || '').trim().toLowerCase()),
        short_desc_hash: md5(String(a.summary || '').trim().toLowerCase()),
        raw_json: JSON.stringify({
          appId: a.appId, title: a.title, maxInstalls: a.maxInstalls, score: a.score, ratings: a.ratings,
          histogram: a.histogram, IAPRange: a.IAPRange, adSupported: a.adSupported, updated: a.updated,
          released: a.released, genreId: a.genreId, contentRating: a.contentRating, version: a.version,
          developerId: a.developerId, developerAddress: a.developerAddress, developerWebsite: a.developerWebsite,
        }),
      };

      const prev = prevStmt.get(appId, geo, hl, date);
      d.transaction(() => {
        ins.run(row);
        upApp.run(a.title ?? null, a.developer ?? null, a.developerId ?? null, a.genreId ?? null, appId);
      })();

      if (prev) {
        if (prev.listing_hash !== hash) logEvent('listing_changed', { date, geo, appId, detail: a.version });
        if ((prev.installs_country ?? null) !== (row.installs_country ?? null)) {
          logEvent('installs_country_change', { date, geo, appId, detail: `${prev.installs_country} -> ${row.installs_country}` });
        }
        if (prev.available === 1 && row.available === 0) logEvent('became_unavailable', { date, geo, appId });
        if (prev.max_installs && row.max_installs && prev.max_installs >= 50000) {
          const growth = (row.max_installs - prev.max_installs) / prev.max_installs;
          if (growth > 0.10) logEvent('installs_spike', { date, geo, appId, detail: `${(growth * 100).toFixed(2)}% за ${((Date.parse(date) - Date.parse(prev.snapshot_date)) / 86400000).toFixed(0)} дн.` });
        }
      }
      done++;
    }
    if (done % 50 === 0 && done) log(`  карточки: ${done}`);
  }

  finishRun(runId, 'enrich-apps', geo, { requests: done + errors, errors, notes: `${done} карточек, 404: ${missing}` });
  log(`  ${geo}: карточек ${done}, ошибок ${errors}, не найдено ${missing}`);
  return { done, errors, missing };
}
