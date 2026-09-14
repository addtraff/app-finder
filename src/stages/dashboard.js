// Вывод: односторонний HTML-отчёт по всем гео сразу.
// out/report.html   — открывается локально
// out/artifact.html — тот же контент фрагментом, для публикации на claude.ai/code
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT, DB_PATH } from '../lib/db.js';
import { config, referenceGeo, activeGeos } from '../lib/config.js';
import { planForDays, maturity, pendingWork, schedule } from '../lib/schedule.js';
import { buildQueue } from './check-ads.js';
import { median, log } from '../lib/util.js';
import { packRows, UNPACK_JS } from '../lib/pack.js';
import { latestShownDate, screenAsOf, screenDateAsOf } from '../lib/snapshots.js';

const one = (d, sql, ...p) => d.prepare(sql).get(...p);
const all = (d, sql, ...p) => d.prepare(sql).all(...p);

// ---------- данные одного гео ----------
function collectGeo(d, geo, date) {
  const funnel = all(d,
    `SELECT COALESCE(reject_reason,'passed') AS reason, MIN(stage_reached) AS stage, COUNT(*) AS count
       FROM screen_result WHERE geo=? AND snapshot_date=? GROUP BY reason ORDER BY count DESC`, geo, screenDateAsOf(d, geo, date));
  funnel.sort((a, b) => (a.reason === 'passed' ? -1 : b.reason === 'passed' ? 1 : b.count - a.count));

  const niches = all(d,
    `SELECT * FROM metrics_niche_geo WHERE geo=? AND snapshot_date=?
      ORDER BY CASE WHEN door IS NULL THEN 1 ELSE 0 END, door ASC`, geo, date)
    .map((n) => ({
      ...n,
      top_apps: n.top_apps ? JSON.parse(n.top_apps) : [],
      core: all(d, `SELECT keyword FROM keyword_cores WHERE niche_id=? AND geo=? AND is_head=0 ORDER BY keyword LIMIT 12`, n.niche_id, geo)
        .map((r) => r.keyword),
    }));

  // Прошедшие воронку — полный список, а не только верх очереди. Каждая строка несёт все
  // поля metrics_app_geo (m.*), а не узкий набор: раскрывающаяся детализация в таблице
  // показывает пять типов жалоб, источники прихода, антифрод-сигналы и дельты дней 1/7/30 —
  // они посчитаны, но без этого нигде не были видны.
  const passed = all(d,
    `SELECT m.*, a.title, a.developer, n.head_keyword AS niche_head, n.door AS niche_door,
            t.found AS tracking_found, t.matched_names AS tracking_matched_names,
            t.matched_in AS tracking_matched_in, t.checked_at AS tracking_checked_at
       FROM metrics_app_geo m
       JOIN apps a ON a.app_id = m.app_id
       ${screenAsOf()}
       LEFT JOIN metrics_niche_geo n ON n.niche_id=m.niche_id AND n.geo=m.geo AND n.snapshot_date=m.snapshot_date
       LEFT JOIN (SELECT t1.* FROM raw_tracking_scan t1
                    JOIN (SELECT app_id, MAX(checked_at) md FROM raw_tracking_scan GROUP BY app_id) f
                      ON f.app_id=t1.app_id AND f.md=t1.checked_at) t ON t.app_id=m.app_id
      WHERE m.geo=? AND m.snapshot_date=? AND s.reject_reason IS NULL
      ORDER BY COALESCE(m.policy_auto_ok, 0) DESC,
               CASE WHEN m.prescore IS NULL THEN 1 ELSE 0 END, m.prescore DESC`, geo, date);

  const k7 = buildQueue(d, geo, date).slice(0, 60);

  const quantiles = all(d,
    `SELECT metric, p01, p10, p25, p50, p75, p90, p95, p99, n FROM niche_quantiles
      WHERE scope='geo' AND scope_id=? AND geo=? AND snapshot_date=? ORDER BY metric`, geo, geo, date);

  const keywords = all(d,
    `SELECT k.keyword, k.source, k.suggest_score, k.suggest_depth, k.is_brand, k.dead,
            (SELECT COUNT(*) FROM disc_app_keyword ak WHERE ak.geo=k.geo AND ak.keyword=k.keyword) AS apps
       FROM disc_keywords k WHERE k.geo=? ORDER BY k.suggest_score DESC, apps DESC LIMIT 150`, geo);

  const counts = {
    keywords: one(d, `SELECT COUNT(*) c FROM disc_keywords WHERE geo=?`, geo).c,
    keywords_brand: one(d, `SELECT COUNT(*) c FROM disc_keywords WHERE geo=? AND is_brand=1`, geo).c,
    serp_rows: one(d, `SELECT COUNT(*) c FROM raw_search WHERE geo=?`, geo).c,
    cards: one(d, `SELECT COUNT(*) c FROM raw_app_page WHERE geo=?`, geo).c,
    cards_today: one(d, `SELECT COUNT(DISTINCT app_id) c FROM raw_app_page WHERE geo=? AND snapshot_date=?`, geo, date).c,
    reviews: one(d, `SELECT COUNT(*) c FROM raw_reviews WHERE geo=?`, geo).c,
    discovered: one(d, `SELECT COUNT(*) c FROM disc_apps WHERE geo=?`, geo).c,
    niches: niches.length,
    niches_with_door: niches.filter((n) => n.door != null).length,
    screened: funnel.reduce((a, r) => a + r.count, 0),
    passed: passed.length,
    verified_full: passed.filter((r) => r.verification_level === 'полностью').length,
    ads_checked: one(d, `SELECT COUNT(*) c FROM metrics_app_geo WHERE geo=? AND snapshot_date=? AND ads_found<>'unchecked'`, geo, date).c,
  };

  return { funnel, niches, passed, k7, quantiles, keywords, counts };
}

// ---------- состояние сбора ----------
function collectStatus(d, geo, date) {
  const ds = one(d, `SELECT * FROM day_status WHERE geo=? AND snapshot_date=?`, geo, date);
  const runs = all(d, `SELECT stage, status, requests, errors, empty_pct, notes, started_at, finished_at
                         FROM runs WHERE geo=? AND snapshot_date=? ORDER BY started_at`, geo, date);
  const suspect = runs.some((r) => r.status === 'suspect' || (r.empty_pct != null && r.empty_pct > 0.1));
  const pending = pendingWork(geo, date);
  const blocking = pending.filter((p) => p.count > 0 && ['keyword-serp', 'enrich-apps'].includes(p.key));

  // Готовность дня: собрано / собирается / недостаточно.
  let readiness = 'собрано', why = 'все обязательные стадии дня закрыты';
  if (!ds || !ds.rows_today) { readiness = 'нет данных'; why = 'за сегодня нет ни одной карточки'; }
  else if (ds.partial) { readiness = 'недостаточно'; why = `снимок ${ds.rows_today} строк — меньше 60 % от вчерашних ${ds.rows_prev}, день помечен partial`; }
  else if (blocking.length) { readiness = 'собирается'; why = blocking.map((b) => `${b.title} — ${b.count}`).join('; '); }
  else if (suspect) { readiness = 'собирается'; why = 'на части стадий больше 10 % пустых ответов, стоит перезапустить'; }

  return {
    geo, readiness, why,
    rows_today: ds?.rows_today ?? 0, rows_prev: ds?.rows_prev ?? null,
    partial: ds?.partial ? 1 : 0, suspect: suspect ? 1 : 0,
    runs, pending, maturity: maturity(geo, date),
  };
}

export function collect(d, selectedGeo, date) {
  const cfg = config();
  const ref = referenceGeo();
  const active = activeGeos();
  const withData = new Set(all(d, `SELECT DISTINCT geo FROM raw_app_page`).map((r) => r.geo));

  // Детерминированное время: каждое гео снимается в свой час UTC (ТЗ 4.6), поэтому на границе
  // суток гео закономерно расходятся по датам последнего снимка. Раздел «данные для просмотра»
  // (ниши, воронка, очередь) показывает СВОЙ последний день каждого гео, а не общий `date` —
  // иначе гео, ещё не обновившееся сегодня, показывалось бы пустым, хотя данные за вчера есть.
  // `date` остаётся датой отчёта: по нему меряется «собрано ли за сегодня» (readiness) и строится
  // план на месяц — эти два вопроса про текущие сутки, а не про то, что можно показать.
  const geoDate = {};
  for (const g of cfg.geos.geos) {
    geoDate[g.geo] = latestShownDate(d, g.geo);
  }

  const geoData = {};
  for (const g of cfg.geos.geos) {
    if (!withData.has(g.geo)) continue;
    geoData[g.geo] = collectGeo(d, g.geo, geoDate[g.geo]);
    geoData[g.geo].date = geoDate[g.geo];
  }

  const geoIndex = cfg.geos.geos.map((g) => {
    const gd = geoData[g.geo];
    const last = geoDate[g.geo];
    const doors = gd ? gd.niches.map((n) => n.door).filter((v) => v != null) : [];
    const arb = last ? one(d, `SELECT AVG(geo_arbitrage) a FROM metrics_geo_arbitrage WHERE geo=? AND snapshot_date=?`, g.geo, last)?.a ?? null : null;
    return {
      geo: g.geo, hl: g.hl.join(', '), review_langs: g.review_langs.join(', '),
      currency: g.currency, tier: g.tier, active: g.active ? 1 : 0,
      start_hour_utc: g.start_hour_utc, ecpm_rel_us: g.ecpm_rel_us, arpu_rel_us: g.arpu_rel_us,
      is_reference: g.geo === ref ? 1 : 0,
      has_data: gd ? 1 : 0, last_snapshot: last,
      apps: gd ? gd.counts.discovered : 0,
      cards: gd ? gd.counts.cards_today : 0,
      niches: gd ? gd.counts.niches : 0,
      door_median: doors.length ? Math.round(median(doors)) : null,
      passed: gd ? gd.counts.passed : 0,
      screened: gd ? gd.counts.screened : 0,
      keywords: gd ? gd.counts.keywords : 0,
      reviews: gd ? gd.counts.reviews : 0,
      geo_arbitrage: arb,
    };
  });

  // Статус сбора («собрано / собирается / нет данных») меряется по дате отчёта (обычно —
  // сегодня), а не по последнему доступному снимку: вопрос здесь буквально «случился ли
  // сегодняшний прогон», и подменять его прошлым днём значило бы врать про readiness.
  // collectStatus сама возвращает «нет данных» для гео без данных вообще — отдельная
  // заглушка не нужна и раньше давала гео с пустой историей две записи статуса вместо одной.
  const status = active.map((g) => collectStatus(d, g.geo, date));

  // Кросс-гео: одна и та же ниша во всех гео. Сопоставление идёт по concept,
  // потому что head_keyword в каждом гео на своём языке. Каждое гео берётся по своему
  // последнему снимку (см. geoDate выше) — на границе суток гео законно расходятся датами.
  const nicheRows = all(d,
    `SELECT n.concept, n.geo, n.niche_id, n.head_keyword, n.door, n.best_door, n.wall_installs,
            n.weak_share, n.new_share_18m, n.leader_share, n.suggest_score_sum, n.apps_count,
            a.geo_arbitrage, a.wall_ratio, a.door_ratio, a.demand_ratio, a.money_ratio
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
    // Если в гео несколько ниш одного концепта, берём ту, у которой вход уже.
    if (!cur || (r.door != null && (cur.door == null || r.door < cur.door))) {
      conceptMap.get(r.concept).cells[r.geo] = r;
    }
  }
  const crossGeoGeos = cfg.geos.geos.map((g) => g.geo).filter((g) => nicheRows.some((r) => r.geo === g));
  const crossRows = [...conceptMap.values()].map((row) => {
    const refCell = row.cells[ref];
    return {
      concept: row.concept,
      ref_head: refCell ? refCell.head_keyword : null,
      ref_door: refCell ? refCell.door : null,
      geos_present: Object.keys(row.cells).length,
      best_arbitrage: Object.values(row.cells)
        .filter((c) => c.geo !== ref && c.geo_arbitrage != null)
        .sort((a, b) => b.geo_arbitrage - a.geo_arbitrage)[0] || null,
      cells: row.cells,
    };
  }).sort((a, b) => {
    if (a.ref_door == null) return 1;
    if (b.ref_door == null) return -1;
    return a.ref_door - b.ref_door;
  });

  const events = all(d,
    `SELECT e.snapshot_date, e.geo, e.kind, e.app_id, e.detail, a.title
       FROM events e LEFT JOIN apps a ON a.app_id=e.app_id
      ORDER BY e.id DESC LIMIT 250`);

  const globalCounts = {
    apps_total: one(d, `SELECT COUNT(*) c FROM apps`).c,
    level_a: one(d, `SELECT COUNT(*) c FROM apps WHERE watch_level='A'`).c,
    level_b: one(d, `SELECT COUNT(*) c FROM apps WHERE watch_level='B'`).c,
    level_c: one(d, `SELECT COUNT(*) c FROM apps WHERE watch_level='C'`).c,
    level_d: one(d, `SELECT COUNT(*) c FROM apps WHERE watch_level='D'`).c,
    level_none: one(d, `SELECT COUNT(*) c FROM apps WHERE watch_level IS NULL`).c,
    reviews: one(d, `SELECT COUNT(*) c FROM raw_reviews`).c,
    reviews_labeled: one(d, `SELECT COUNT(DISTINCT review_id) c FROM review_labels`).c,
    events: one(d, `SELECT COUNT(*) c FROM events`).c,
    geos_active: active.length,
    geos_total: cfg.geos.geos.length,
    geos_with_data: Object.keys(geoData).length,
    niches: geoIndex.reduce((a, g) => a + g.niches, 0),
    passed: geoIndex.reduce((a, g) => a + g.passed, 0),
    screened: geoIndex.reduce((a, g) => a + g.screened, 0),
    keywords: geoIndex.reduce((a, g) => a + g.keywords, 0),
    ads_checked: Object.values(geoData).reduce((a, g) => a + g.counts.ads_checked, 0),
    verified_full: Object.values(geoData).reduce((a, g) => a + g.counts.verified_full, 0),
  };

  const s = schedule();
  const plan = planForDays(date, 30);
  // Прогноз запросов в день на гео: карточки A/B плюс выдача по ядру.
  const avgKeywords = active.length
    ? Math.round(geoIndex.filter((g) => g.active).reduce((a, g) => a + g.keywords, 0) / active.length) : 0;
  const forecast = Math.max(1, Math.round((globalCounts.level_a + globalCounts.level_b) * 1.2) + avgKeywords);

  const apkDone = one(d, `SELECT COUNT(*) c FROM raw_apk`).c;
  const trackScanned = one(d, `SELECT COUNT(*) c FROM raw_tracking_scan`).c;
  const trackFound = one(d, `SELECT COUNT(*) c FROM raw_tracking_scan WHERE found=1`).c;
  const gaps = [
    { name: 'locales_count → localized_geo_count (A1)', why: `список локалей Play не публикует, поэтому метрика переопределена: приложение считается локализованным под hl, если заголовок или краткое описание отличаются от версии hl=en, gl=${ref}. Сейчас сравнение идёт по ${Object.keys(geoData).length} гео из 30 — это нижняя оценка, и она растёт по мере включения гео.` },
    { name: 'installs_country → installs_source_geo (A2)', why: 'домашней страны установок в Play нет — на чужой базе она возникала как артефакт запроса без явного country. Мы запрашиваем с явным gl, поэтому источник известен по построению: каноническое installs берётся из installs_source_geo, дельты считаются только при неизменном источнике, расхождение между гео больше 1 % даёт installs_consistency = 0.' },
    { name: 'size_mb (A3)', why: 'формат AAB: у большинства приложений Play показывает «зависит от устройства». Поле стало описательным, гейт heavy_and_bad срабатывает только при объявленном размере — это ожидаемое поведение, не дефект. Точный размер — size_mb_apk, доступен только при ручном разборе реального APK.' },
    { name: 'review_lang_mismatch (A4)', why: 'переопределена как доля отзывов на языках, под которые листинг не локализован. Считается только для уровня A, где сняты все 18 языков, и при ≥ 200 отзывов; для B пусто.' },
    { name: 'attribution_sdk (замена разбора APK)', why: `ищется по имени (AppsFlyer, Adjust, Branch и т.п.) в описании карточки, тексте privacy policy и Data Safety — без скачивания APK. Просканировано ${trackScanned} приложений уровня A/B, трекер найден у ${trackFound}. Находка — прямая улика (organic=0); отсутствие находки НЕ считается подтверждённой органикой (текст мог не упомянуть трекер, который реально есть) — это слабее, чем чтение самого APK. Настоящий разбор APK (paywall_sdk, compute_location, ad_sdks, size_mb_apk, locales_apk — раздел ниже) остаётся ручным дополнением: node src/cli.js stage analyze-apk.` },
    { name: 'paywall_sdk · compute_location · ad_sdks · iap_products_count · has_annual_tier', why: apkDone ? `разобрано настоящих APK: ${apkDone}.` : 'доступны только из настоящего разбора APK (ручной, опциональный шаг — см. attribution_sdk выше); до заполнения iap_max_usd ≥ 20 $ работает как прокси has_annual_tier.' },
    { name: 'ads_found', why: globalCounts.ads_checked === 0
        ? 'K7 не выполнен: Ads Transparency отдаёт 302 не-браузерным запросам и требует настоящего браузера. Пусто = «не проверено», НЕ «органика», поэтому organic = 0,35 — нейтрально, без штрафа и без награды.'
        : `проверено у ${globalCounts.ads_checked} приложений.` },
    { name: 'policy_ok (C1)', why: 'ручной гейт (проверка №6), по умолчанию не пройден: пока он 0, copy_score_gp равен нулю у всех. Чтобы аналитик не смотрел всё подряд, добавлен описательный policy_auto_ok — он не заменяет ручной гейт и в скор не входит, но поднимает наверх тех, у кого нет рискованных разрешений и регулируемой категории. Подтверждение пакетное: лист out/export/e7-политики.csv, обратно — import-policy --file.' },
    { name: 'store_web_ratio · сезонность', why: 'ручные модули E1 и E2 — Keyword Planner и Google Trends, выгрузка CSV раз в квартал.' },
    { name: 'top10_turnover_30d (C3)', why: 'нужен снимок выдачи 30-дневной давности. До 30-го дня считаются top10_turnover_7d и top10_turnover_14d с пометкой окна в имени; при пропусках снимков ставится partial_window.' },
  ];

  return {
    meta: {
      date,
      selected_geo: geoData[selectedGeo] ? selectedGeo : (Object.keys(geoData)[0] || selectedGeo),
      reference_geo: ref,
      generated_at: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      classifier_version: cfg.lexicon.version,
      core_version: one(d, `SELECT core_version FROM niches ORDER BY created_at DESC LIMIT 1`)?.core_version || null,
      db_size_mb: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size / 1048576 : 0,
    },
    counts: globalCounts,
    status, plan,
    schedule: {
      full_crawl_cycle: s.full_crawl.cycle_days,
      full_crawl_per_day: s.full_crawl.geos_per_day_max,
      light_crawl_weekday: s.light_crawl.weekday,
      k7_a: s.k7.level_a_days, k7_b: s.k7.level_b_days,
      monthly: s.monthly, quarterly: s.quarterly,
      forecast_requests_per_geo_day: forecast,
    },
    geoIndex, geoData, events, gaps,
    crossGeo: { geos: crossGeoGeos, rows: crossRows },
  };
}

export async function run({ geo, date }) {
  const d = db();
  const data = collect(d, geo, date);

  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'report', 'template.html'), 'utf8');
  const json = JSON.stringify(packRows(data)).replace(/</g, '\\u003c');
  const fragment = tpl.replace('__RADAR_DATA__', () => json).replace('__UNPACK_JS__', () => UNPACK_JS);

  const outDir = path.join(ROOT, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'artifact.html'), fragment, 'utf8');

  const standalone = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0">
${fragment}
</body>
</html>`;
  fs.writeFileSync(path.join(outDir, 'report.html'), standalone, 'utf8');
  fs.writeFileSync(path.join(outDir, 'report-data.json'), JSON.stringify(data, null, 2), 'utf8');

  log(`  отчёт: out/report.html (${(standalone.length / 1024).toFixed(0)} КБ), гео с данными ${data.counts.geos_with_data}, ниш ${data.counts.niches}, прошло воронку ${data.counts.passed}`);
  return { geos: data.counts.geos_with_data, niches: data.counts.niches, passed: data.counts.passed };
}
