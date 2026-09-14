// Второй вариант отчёта: разрез строго по методике «стоит ли копировать приложение» v1.1.
// Каждый пункт методики — своя вкладка, гео переключается сверху, отдельная вкладка
// «финалисты» отвечает на главный вопрос: что копировать — по текущему гео и по всем сразу.
//
// Первый отчёт (dashboard) отвечает на вопрос «что с системой и что она нашла».
// Этот — на вопрос «что говорит методика по каждому слою». Данные те же, из тех же таблиц.
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT, DB_PATH } from '../lib/db.js';
import { config, referenceGeo, activeGeos } from '../lib/config.js';
import { median, log } from '../lib/util.js';
import { packRows, UNPACK_JS } from '../lib/pack.js';
import { latestShownDate, screenAsOf, screenDateAsOf } from '../lib/snapshots.js';

const one = (d, sql, ...p) => d.prepare(sql).get(...p);
const all = (d, sql, ...p) => d.prepare(sql).all(...p);

// Шесть проверок методики (раздел 1). Каждая — три состояния, потому что методика
// прямо запрещает считать непроверенное пройденным: 1 = прошла, 0 = провалена, null = не знаем.
export function sixChecks(r) {
  // 1. Спрос существует и он органический, а не созданный рекламой.
  //    demand — нормированная по квантилям ниши величина; src_ads_pct — доля отзывов «пришёл из рекламы».
  let c1 = null;
  if (r.demand != null) {
    if (r.src_ads_pct != null && r.src_ads_pct > 0.15) c1 = 0;
    else c1 = r.demand >= 0.5 ? 1 : (r.demand < 0.25 ? 0 : null);
  }

  // 2. Инкумбент побеждаем — слаб, заброшен или узко проиндексирован.
  let c2 = null;
  const weakSignals = [
    r.weakness != null ? (r.weakness >= 0.4) : null,
    r.index_gap != null ? (r.index_gap > 0.4) : null,
    r.target_sdk_risk === 1 ? true : null,
  ].filter((v) => v !== null);
  if (weakSignals.length) c2 = weakSignals.some(Boolean) ? 1 : 0;

  // 3. Вырос без закупки — самый важный пункт методики.
  let c3 = null;
  if (['google', 'meta', 'both'].includes(r.ads_found) || r.attribution_sdk === 1) c3 = 0;
  else if (r.ads_found === 'none' && r.attribution_sdk === 0) c3 = 1;
  // всё остальное — не знаем: «отсутствие в библиотеках не доказывает отсутствие закупки»

  // 4. Дёшев в повторении.
  const c4 = r.feasibility == null ? null : (r.feasibility >= 0.75 ? 1 : (r.feasibility <= 0.25 ? 0 : null));

  // 5. Монетизация доказана — факт в карточке, не гипотеза.
  const c5 = r.monetization_proof == null ? null : (r.monetization_proof >= 1 ? 1 : 0);

  // 6. Клон переживёт модерацию — ручной гейт, по умолчанию не пройден.
  const c6 = r.policy_ok === 1 ? 1 : (r.policy_ok === 0 && r.policy_auto_ok === 0 ? 0 : null);

  const list = [c1, c2, c3, c4, c5, c6];
  return {
    checks: list,
    passed: list.filter((v) => v === 1).length,
    failed: list.filter((v) => v === 0).length,
    unknown: list.filter((v) => v === null).length,
  };
}

const APP_COLUMNS = `
  m.app_id, m.watch_level, m.niche_id, m.prescore, m.copy_score_gp, m.copy_score_provisional,
  m.demand, m.growth_s, m.weakness, m.openness, m.feasibility, m.organic,
  m.installs, m.score, m.ratings_count, m.age_months, m.days_since_update, m.target_sdk_risk,
  m.size_mb, m.size_mb_apk, m.screenshots_count, m.video_present, m.description_len,
  m.permissions_risky, m.content_rating, m.policy_ok, m.policy_auto_ok,
  m.iap_min_usd, m.iap_max_usd, m.contains_ads, m.monetization_type, m.monetization_proof,
  m.iap_products_count, m.has_annual_tier,
  m.polarization, m.crash_pct, m.rating_recent_30d, m.installs_per_rating,
  m.fraud_ok, m.burst_flag, m.template_review_pct, m.review_lang_mismatch,
  m.ads_found, m.attribution_sdk, m.ad_sdks, m.paywall_sdk, m.compute_location,
  m.wom_index, m.portfolio_size, m.suggest_depth, m.index_gap, m.index_breadth,
  m.kw_top10_count, m.kw_top50_count, m.head_kw_in_title, m.installs_per_month_lifetime,
  m.localized_geo_count, m.pain_dominant, m.pain_fit, m.pain_money, m.pain_ads, m.pain_broken,
  m.src_ads_pct, m.src_ugc_pct, m.verification_level, m.geo_multiplier`;

function collectGeo(d, geo, date) {
  const apps = all(d,
    `SELECT ${APP_COLUMNS},
            a.title, a.developer,
            n.head_keyword AS niche_head, n.door AS niche_door, n.weak_share AS niche_weak_share,
            t.found AS tracking_found, t.matched_names AS tracking_matched
       FROM metrics_app_geo m
       JOIN apps a ON a.app_id = m.app_id
       ${screenAsOf()}
       LEFT JOIN metrics_niche_geo n ON n.niche_id=m.niche_id AND n.geo=m.geo AND n.snapshot_date=m.snapshot_date
       LEFT JOIN (SELECT t1.* FROM raw_tracking_scan t1
                    JOIN (SELECT app_id, MAX(checked_at) md FROM raw_tracking_scan GROUP BY app_id) f
                      ON f.app_id=t1.app_id AND f.md=t1.checked_at) t ON t.app_id=m.app_id
      WHERE m.geo=? AND m.snapshot_date=? AND s.reject_reason IS NULL
      ORDER BY m.prescore DESC`, geo, date)
    .map((r) => ({ ...r, ...sixChecks(r) }));

  const niches = all(d,
    `SELECT niche_id, head_keyword, concept, keywords_count, apps_count, door, best_door,
            wall_installs, wall_ratings, demand_installs, weak_share, new_share_18m, leader_share,
            exact_in_title, jaccard_top5_median, relevance_gap_pct, generic_demand_share,
            suggest_score_sum, index_gap_leader, top10_turnover_7d, top10_turnover_14d, top10_turnover_30d
       FROM metrics_niche_geo WHERE geo=? AND snapshot_date=?
      ORDER BY CASE WHEN door IS NULL THEN 1 ELSE 0 END, door ASC`, geo, date);

  const funnel = all(d,
    `SELECT COALESCE(reject_reason,'passed') AS reason, COUNT(*) AS count
       FROM screen_result WHERE geo=? AND snapshot_date=? GROUP BY reason ORDER BY count DESC`, geo, screenDateAsOf(d, geo, date));

  return { date, apps, niches, funnel };
}

export function collect(d, selectedGeo, date) {
  const cfg = config();
  const ref = referenceGeo();
  const active = activeGeos();

  const geoDate = {};
  for (const g of cfg.geos.geos) {
    geoDate[g.geo] = latestShownDate(d, g.geo);
  }

  const geoData = {};
  for (const g of cfg.geos.geos) {
    if (!geoDate[g.geo]) continue;
    geoData[g.geo] = collectGeo(d, g.geo, geoDate[g.geo]);
  }

  const geoIndex = cfg.geos.geos.map((g) => {
    const gd = geoData[g.geo];
    const doors = gd ? gd.niches.map((n) => n.door).filter((v) => v != null) : [];
    return {
      geo: g.geo, tier: g.tier, hl: g.hl.join(', '), currency: g.currency,
      active: g.active ? 1 : 0, is_reference: g.geo === ref ? 1 : 0,
      ecpm_rel_us: g.ecpm_rel_us, arpu_rel_us: g.arpu_rel_us,
      has_data: gd ? 1 : 0, date: geoDate[g.geo],
      apps: gd ? gd.apps.length : 0,
      niches: gd ? gd.niches.length : 0,
      door_median: doors.length ? Math.round(median(doors)) : null,
    };
  });

  // Финалисты по всем гео: одно приложение живёт в нескольких гео, для каждого берём
  // гео, где оно выглядит лучше всего, и считаем, в скольких гео оно вообще прошло воронку.
  const byApp = new Map();
  for (const [geo, gd] of Object.entries(geoData)) {
    for (const a of gd.apps) {
      if (!byApp.has(a.app_id)) {
        byApp.set(a.app_id, {
          app_id: a.app_id, title: a.title, developer: a.developer,
          geos: [], best: null,
        });
      }
      const rec = byApp.get(a.app_id);
      rec.geos.push({ geo, prescore: a.prescore, passed: a.passed, door: a.niche_door });
      if (!rec.best || (a.prescore ?? -1) > (rec.best.prescore ?? -1)) {
        rec.best = { ...a, geo };
      }
    }
  }
  const globalFinalists = [...byApp.values()]
    .map((r) => ({
      app_id: r.app_id, title: r.title, developer: r.developer,
      geos_count: r.geos.length,
      geos_list: r.geos.map((g) => g.geo).sort().join(', '),
      best_geo: r.best.geo,
      prescore: r.best.prescore,
      passed: r.best.passed, failed: r.best.failed, unknown: r.best.unknown,
      checks: r.best.checks,
      installs: r.best.installs, score: r.best.score,
      niche_head: r.best.niche_head, niche_door: r.best.niche_door,
      organic: r.best.organic, ads_found: r.best.ads_found,
      attribution_sdk: r.best.attribution_sdk, tracking_matched: r.best.tracking_matched,
      monetization_type: r.best.monetization_type, verification_level: r.best.verification_level,
      // Медиана door по всем гео, где приложение встречается: где вход дешевле всего.
      cheapest_geo: r.geos.filter((g) => g.door != null).sort((a, b) => a.door - b.door)[0] || null,
    }))
    .sort((a, b) => (b.passed - a.passed) || ((b.prescore ?? -1) - (a.prescore ?? -1)));

  // Кросс-гео по концептам — вкладка «слой F».
  const nicheRows = all(d,
    `SELECT n.concept, n.geo, n.niche_id, n.head_keyword, n.door, n.wall_installs, n.weak_share,
            a.geo_arbitrage, a.wall_ratio, a.demand_ratio, a.money_ratio
       FROM metrics_niche_geo n
       JOIN (SELECT geo, MAX(snapshot_date) md FROM metrics_niche_geo WHERE concept IS NOT NULL GROUP BY geo) f
         ON f.geo = n.geo AND f.md = n.snapshot_date
       LEFT JOIN metrics_geo_arbitrage a
         ON a.niche_id=n.niche_id AND a.geo=n.geo AND a.snapshot_date=n.snapshot_date
      WHERE n.concept IS NOT NULL`);
  const conceptMap = new Map();
  for (const r of nicheRows) {
    if (!conceptMap.has(r.concept)) conceptMap.set(r.concept, { concept: r.concept, cells: {} });
    const cur = conceptMap.get(r.concept).cells[r.geo];
    if (!cur || (r.door != null && (cur.door == null || r.door < cur.door))) {
      conceptMap.get(r.concept).cells[r.geo] = r;
    }
  }
  const crossGeoGeos = cfg.geos.geos.map((g) => g.geo).filter((g) => nicheRows.some((r) => r.geo === g));
  const crossRows = [...conceptMap.values()].map((row) => ({
    concept: row.concept,
    ref_head: row.cells[ref] ? row.cells[ref].head_keyword : null,
    ref_door: row.cells[ref] ? row.cells[ref].door : null,
    geos_present: Object.keys(row.cells).length,
    cells: row.cells,
  })).sort((a, b) => {
    if (a.ref_door == null) return 1;
    if (b.ref_door == null) return -1;
    return a.ref_door - b.ref_door;
  });

  const counts = {
    geos_with_data: Object.keys(geoData).length,
    geos_total: cfg.geos.geos.length,
    apps_passed: Object.values(geoData).reduce((a, g) => a + g.apps.length, 0),
    apps_unique: byApp.size,
    niches: Object.values(geoData).reduce((a, g) => a + g.niches.length, 0),
    policy_confirmed: one(d, `SELECT COUNT(*) c FROM organic_labels WHERE evidence='policy' AND label='policy_ok'`).c,
    ads_checked: one(d, `SELECT COUNT(*) c FROM raw_ads_google`).c + one(d, `SELECT COUNT(*) c FROM raw_ads_meta`).c,
    tracking_scanned: one(d, `SELECT COUNT(*) c FROM raw_tracking_scan`).c,
    tracking_found: one(d, `SELECT COUNT(*) c FROM raw_tracking_scan WHERE found=1`).c,
    apk_parsed: one(d, `SELECT COUNT(*) c FROM raw_apk`).c,
    planner_rows: one(d, `SELECT COUNT(*) c FROM raw_external_keyword_planner`).c,
    trends_rows: one(d, `SELECT COUNT(*) c FROM raw_external_trends`).c,
  };

  return {
    meta: {
      date, reference_geo: ref,
      selected_geo: geoData[selectedGeo] ? selectedGeo : (Object.keys(geoData)[0] || selectedGeo),
      generated_at: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      db_size_mb: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size / 1048576 : 0,
    },
    counts, geoIndex, geoData, globalFinalists,
    crossGeo: { geos: crossGeoGeos, rows: crossRows },
  };
}

export async function run({ geo, date }) {
  const d = db();
  const data = collect(d, geo, date);

  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'report', 'methodology.html'), 'utf8');
  const json = JSON.stringify(packRows(data)).replace(/</g, '\\u003c');
  const fragment = tpl.replace('__RADAR_DATA__', () => json).replace('__UNPACK_JS__', () => UNPACK_JS);

  const outDir = path.join(ROOT, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'methodology-artifact.html'), fragment, 'utf8');
  fs.writeFileSync(path.join(outDir, 'methodology.html'), `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0">
${fragment}
</body>
</html>`, 'utf8');

  log(`  отчёт по методике: out/methodology.html (${(fragment.length / 1024).toFixed(0)} КБ), ` +
      `гео ${data.counts.geos_with_data}, приложений ${data.counts.apps_passed}, уникальных ${data.counts.apps_unique}`);
  return { geos: data.counts.geos_with_data, apps: data.counts.apps_passed };
}
