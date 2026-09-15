// 9.x Расчётный слой. Считается по последнему полному дню, из сырья.
// Веса — записанная гипотеза; сырьё хранится, чтобы пересчитать задним числом.
import { db, startRun, finishRun, logEvent } from '../lib/db.js';
import { config, geoConf, referenceGeo } from '../lib/config.js';
import { qv, clearQCache } from './quantiles.js';
import { resolveInstallsSource } from '../lib/installs.js';
import { setWatchLevel } from '../lib/registry.js';
import { norm, clamp, median, log } from '../lib/util.js';
import { hostOf, META_DETECTOR } from './check-ads.js';
import { ageMonthsAt } from '../lib/dates.js';

const DAY = 86400000;

function safeLog10(x) { return x == null || x <= 0 ? null : Math.log10(x); }

// Взвешенная сумма только по доступным слагаемым: «пусто, а не ноль» (принцип 7).
function weightedAvailable(parts) {
  let sum = 0, w = 0;
  for (const [value, weight] of parts) {
    if (value == null || !Number.isFinite(value)) continue;
    sum += value * weight; w += weight;
  }
  return w === 0 ? null : sum / w;
}

export async function run({ geo, date, runId, cycle = 'daily' }) {
  const d = db();
  startRun(runId, 'score', geo, cycle, date);
  clearQCache();
  const cfg = config();
  const g = geoConf(geo);
  const inst = cfg.institutions;
  const sc = cfg.scoring;
  const W = sc.prescore_weights;
  const cheap = new Set(inst.cheap_categories);
  const hard = new Set(inst.hard_categories);
  const thinRe = new RegExp(inst.thin_app_regex, 'i');
  const isRef = geo === referenceGeo();

  // Правило последнего полного дня.
  const rowsToday = d.prepare(`SELECT COUNT(DISTINCT app_id) c FROM raw_app_page WHERE geo=? AND snapshot_date=?`).get(geo, date).c;
  const prevDay = d.prepare(`SELECT snapshot_date, COUNT(DISTINCT app_id) c FROM raw_app_page WHERE geo=? AND snapshot_date<? GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 1`).get(geo, date);
  const partial = prevDay && prevDay.c > 0 && rowsToday < prevDay.c * 0.6 ? 1 : 0;
  d.prepare(`INSERT OR REPLACE INTO day_status (geo, snapshot_date, rows_today, rows_prev, partial, suspect) VALUES (?,?,?,?,?,?)`)
    .run(geo, date, rowsToday, prevDay?.c ?? null, partial, 0);
  if (partial) {
    logEvent('day_partial', { date, geo, detail: `${rowsToday} < 60% от ${prevDay.c}` });
    log(`  ! день ${date} помечен partial (${rowsToday} против ${prevDay.c}) — считаю по нему, но флаг стоит`);
  }

  const cards = d.prepare(
    `SELECT p.*, a.niche_id, a.watch_level, a.status
       FROM raw_app_page p JOIN apps a ON a.app_id=p.app_id
      WHERE p.geo=? AND p.snapshot_date=? AND p.hl=?`
  ).all(geo, date, g.hl[0]);
  if (!cards.length) {
    finishRun(runId, 'score', geo, { status: 'skipped', notes: 'нет карточек за день' });
    return { rows: 0 };
  }

  // --- предвыборки ---
  const prevCard = d.prepare(`SELECT * FROM raw_app_page WHERE app_id=? AND geo=? AND hl=? AND snapshot_date<? ORDER BY snapshot_date DESC LIMIT 1`);
  const cardAtOrBefore = d.prepare(`SELECT * FROM raw_app_page WHERE app_id=? AND geo=? AND hl=? AND snapshot_date<=? ORDER BY snapshot_date DESC LIMIT 1`);

  const kwStats = new Map(d.prepare(
    `SELECT ak.app_id,
            SUM(CASE WHEN ak.best_position<=10 THEN 1 ELSE 0 END) AS top10,
            SUM(CASE WHEN ak.best_position<=50 THEN 1 ELSE 0 END) AS top50,
            MIN(ak.best_position) AS best_pos,
            MAX(k.suggest_depth) AS sug_depth
       FROM disc_app_keyword ak JOIN disc_keywords k ON k.geo=ak.geo AND k.keyword=ak.keyword
      WHERE ak.geo=? AND k.is_brand=0 GROUP BY ak.app_id`
  ).all(geo).map((r) => [r.app_id, r]));

  const nicheCoreSize = new Map(d.prepare(
    `SELECT niche_id, COUNT(*) c FROM keyword_cores WHERE geo=? AND active=1 GROUP BY niche_id`
  ).all(geo).map((r) => [r.niche_id, r.c]));
  const nicheInCore = new Map(d.prepare(
    `SELECT kc.niche_id, ak.app_id, SUM(CASE WHEN ak.best_position<=50 THEN 1 ELSE 0 END) AS in50
       FROM keyword_cores kc JOIN disc_app_keyword ak ON ak.geo=kc.geo AND ak.keyword=kc.keyword
      WHERE kc.geo=? AND kc.active=1 GROUP BY kc.niche_id, ak.app_id`
  ).all(geo).map((r) => [`${r.niche_id}|${r.app_id}`, r.in50]));

  const nicheMetrics = new Map(d.prepare(
    `SELECT * FROM metrics_niche_geo WHERE geo=? AND snapshot_date=?`
  ).all(geo, date).map((r) => [r.niche_id, r]));

  // Ниша приложения в ЭТОМ гео. apps.niche_id один на приложение и заполняется первым гео,
  // где его нашли, а id ниш привязаны к гео — в остальных гео строка метрик ссылалась на
  // чужую нишу и не находила ни door, ни квантилей ниши (в CA к своей нише были привязаны
  // 4 строки из 1151). Нишей считается та из посчитанных на эту дату, где у приложения больше
  // всего ключей ядра в топ-50; при равенстве — с меньшим ядром, то есть более узкая.
  const nicheOfApp = new Map();
  for (const [key, in50] of nicheInCore) {
    if (!in50) continue;
    const sep = key.indexOf('|');
    const nicheId = key.slice(0, sep), appId = key.slice(sep + 1);
    if (!nicheMetrics.has(nicheId)) continue;
    const size = nicheCoreSize.get(nicheId) || Infinity;
    const cur = nicheOfApp.get(appId);
    if (!cur || in50 > cur.in50 || (in50 === cur.in50 && size < cur.size)) nicheOfApp.set(appId, { nicheId, in50, size });
  }

  // --- A2: канонические установки из installs_source_geo, контроль по всем гео ---
  const installsSrc = resolveInstallsSource(date);

  // --- A1: локализация. Эталон — заголовок и краткое описание с hl=en, gl=US.
  // Приложение считается локализованным под hl, если хотя бы один из хешей отличается.
  const refGeo = referenceGeo();
  const refHash = new Map(d.prepare(
    `SELECT p.app_id, p.title_hash, p.short_desc_hash
       FROM raw_app_page p
       JOIN (SELECT app_id, MAX(snapshot_date) md FROM raw_app_page
              WHERE geo=? AND hl='en' GROUP BY app_id) f
         ON f.app_id=p.app_id AND f.md=p.snapshot_date
      WHERE p.geo=? AND p.hl='en'`
  ).all(refGeo, refGeo).map((r) => [r.app_id, r]));

  const locByApp = new Map();
  for (const r of d.prepare(
    `SELECT p.app_id, p.geo, p.hl, p.title_hash, p.short_desc_hash
       FROM raw_app_page p
       JOIN (SELECT app_id, geo, hl, MAX(snapshot_date) md FROM raw_app_page GROUP BY app_id, geo, hl) f
         ON f.app_id=p.app_id AND f.geo=p.geo AND f.hl=p.hl AND f.md=p.snapshot_date`
  ).all()) {
    const ref = refHash.get(r.app_id);
    if (!ref) continue;
    const differs = (r.title_hash && r.title_hash !== ref.title_hash) ||
                    (r.short_desc_hash && r.short_desc_hash !== ref.short_desc_hash);
    if (!differs) continue;
    if (!locByApp.has(r.app_id)) locByApp.set(r.app_id, { geos: new Set(), hls: new Set() });
    locByApp.get(r.app_id).geos.add(r.geo);
    locByApp.get(r.app_id).hls.add(r.hl);
  }

  // Бренд в подсказках -> wom_index.
  const suggestions = d.prepare(`SELECT suggestion, MIN(position) pos FROM raw_suggest WHERE geo=? GROUP BY suggestion`).all(geo);

  // 2.2 методики: размер портфеля разработчика. Последний известный снимок раздела
  // «About the developer», не обязательно из сегодняшнего прогона.
  const portfolioByDev = new Map(d.prepare(
    `SELECT developer_id, apps_count FROM raw_developer rd
       WHERE (developer_id, snapshot_date) IN (
         SELECT developer_id, MAX(snapshot_date) FROM raw_developer GROUP BY developer_id)`
  ).all().map((r) => [r.developer_id, r.apps_count]));

  // Агрегаты по отзывам.
  const revAgg = new Map(d.prepare(
    `SELECT app_id,
            COUNT(*) AS n,
            SUM(CASE WHEN rating<=3 THEN 1 ELSE 0 END) AS neg,
            SUM(CASE WHEN rating=5 THEN 1 ELSE 0 END) AS five,
            SUM(CASE WHEN review_date >= date(?, '-30 day') THEN 1 ELSE 0 END) AS n30,
            AVG(CASE WHEN review_date >= date(?, '-30 day') THEN rating END) AS rating30,
            SUM(CASE WHEN review_date >= date(?, '-90 day') THEN 1 ELSE 0 END) AS n90,
            SUM(CASE WHEN review_date >= date(?, '-7 day') THEN 1 ELSE 0 END) AS n7,
            MIN(review_date) AS first_date, MAX(review_date) AS last_date
       FROM raw_reviews WHERE geo=? GROUP BY app_id`
  ).all(date, date, date, date, geo).map((r) => [r.app_id, r]));

  const labelVersion = cfg.lexicon.version;
  const labelAgg = new Map();
  for (const r of d.prepare(
    `SELECT rv.app_id, l.label, COUNT(*) c,
            SUM(CASE WHEN rv.review_date >= date(?, '-90 day') THEN 1 ELSE 0 END) c90
       FROM review_labels l JOIN raw_reviews rv ON rv.review_id=l.review_id
      WHERE rv.geo=? AND l.classifier_version=? GROUP BY rv.app_id, l.label`
  ).all(date, geo, labelVersion)) {
    if (!labelAgg.has(r.app_id)) labelAgg.set(r.app_id, {});
    labelAgg.get(r.app_id)[r.label] = { c: r.c, c90: r.c90 };
  }

  // A4: доля отзывов на языках, под которые листинг НЕ локализован.
  // Языки берутся по всем гео: для уровня A снимаются все 18.
  const revLangs = new Map();
  for (const r of d.prepare(`SELECT app_id, lang, COUNT(*) c FROM raw_reviews GROUP BY app_id, lang`).all()) {
    if (!revLangs.has(r.app_id)) revLangs.set(r.app_id, new Map());
    revLangs.get(r.app_id).set(r.lang, r.c);
  }
  const baseLang = (x) => String(x || '').toLowerCase().split('-')[0];

  // ads_found ∈ {google, meta, both, none, unchecked}. «none» ставится только если
  // проверены оба источника и оба пусты: пустой результат — «не найдено», не «органика».
  // Отрицательный результат Meta засчитывается только от детектора v2. Детектор v1 искал
  // ссылку на Play в сыром виде, которого на странице Ad Library нет вовсе, — его «не
  // найдено» означает «не смотрели», и ставить по нему none значило бы выдать пустоту
  // за ноль. Положительные находки v1 настоящие (сырая ссылка действительно была).
  const metaSeen = new Map();
  for (const r of d.prepare(
    `SELECT app_id, MAX(found_by_package_id) f FROM raw_ads_meta
      WHERE found_by_package_id IS NOT NULL AND (found_by_package_id=1 OR note LIKE ?)
      GROUP BY app_id`
  ).all(`${META_DETECTOR}%`)) {
    metaSeen.set(r.app_id, r.f ? 1 : 0);
  }
  // Домен приложения — ровно как его строит очередь K7: сайт разработчика, а если его нет —
  // хост privacy policy. Раньше сопоставление шло только по сайту, и приложения, чей домен
  // K7 взял из политики, оставались unchecked навсегда, хотя проверка давно была.
  const googleByDomain = new Map(d.prepare(
    `SELECT developer_domain, MAX(creatives_found) f FROM raw_ads_google
      WHERE creatives_found IS NOT NULL GROUP BY developer_domain`
  ).all().map((r) => [r.developer_domain, r.f ? 1 : 0]));
  // Домены берутся из уже загруженных карточек этого гео: проход по всей raw_app_page
  // с GROUP BY app_id занимал минуты на каждое гео и превращал пересчёт в часы.
  const googleSeen = new Map();
  for (const r of cards) {
    if (googleSeen.get(r.app_id) === 1) continue;
    for (const host of [hostOf(r.developer_website), hostOf(r.privacy_policy)]) {
      if (host && googleByDomain.has(host)) {
        const f = googleByDomain.get(host);
        if (f === 1 || !googleSeen.has(r.app_id)) googleSeen.set(r.app_id, f);
        break;
      }
    }
  }
  const adsFound = new Map();
  for (const appId of new Set([...metaSeen.keys(), ...googleSeen.keys()])) {
    const gFound = googleSeen.get(appId), mFound = metaSeen.get(appId);
    if (gFound === 1 && mFound === 1) adsFound.set(appId, 'both');
    else if (gFound === 1) adsFound.set(appId, 'google');
    else if (mFound === 1) adsFound.set(appId, 'meta');
    else if (gFound === 0 && mFound === 0) adsFound.set(appId, 'none');
  }
  const apkLabels = new Map(d.prepare(`SELECT app_id, label FROM organic_labels WHERE evidence='apk'`).all().map((r) => [r.app_id, r.label]));
  const policyOk = new Map(d.prepare(`SELECT app_id, CASE WHEN label='policy_ok' THEN 1 ELSE 0 END v FROM organic_labels WHERE evidence='policy'`).all().map((r) => [r.app_id, r.v]));

  const ins = d.prepare(`INSERT OR REPLACE INTO metrics_app_geo (
    app_id, geo, snapshot_date, niche_id, watch_level,
    installs, ratings_count, score, installs_per_rating, age_months, days_since_update,
    target_sdk_risk, size_mb, screenshots_count, video_present, description_len,
    localized_geo_count, localized_hl_list, localization_quality, available_in_geo, localized_here,
    installs_source_geo, installs_consistency, iap_min_usd, iap_max_usd, contains_ads,
    monetization_type, monetization_proof, permissions_risky, policy_risk_category, content_rating,
    head_kw_in_title, installs_per_month_lifetime, kw_top10_count, kw_top50_count, index_breadth, index_gap,
    polarization, wom_index, suggest_depth, portfolio_size,
    installs_delta_1d, installs_growth_1d, ratings_delta_24h, listing_changed, new_reviews_24h, rank_best, rank_delta_24h,
    installs_growth_7d, ratings_per_day_7d, burst_flag, spearman_rank_installs, rank_volatility,
    reviews_labeled, growth, growth_conf, growth_s,
    pain_money, pain_ads, pain_broken, pain_missing, pain_trust, pain_dominant, pain_fit,
    src_ads_pct, src_ugc_pct, src_store_pct, crash_pct, repeat_use_pct, rating_recent_30d,
    template_review_pct, review_lang_mismatch, missing_language_pct, fraud_ok,
    installs_growth_30d, organic, ads_found, attribution_sdk, policy_ok, policy_auto_ok, verification_level,
    paywall_sdk, compute_location, ad_sdks, size_mb_apk, locales_apk, iap_products_count, has_annual_tier,
    demand, fake, weakness, openness, feasibility, policy_penalty, prescore, copy_score_gp,
    copy_score_provisional, geo_multiplier)
    VALUES (@app_id,@geo,@snapshot_date,@niche_id,@watch_level,
    @installs,@ratings_count,@score,@installs_per_rating,@age_months,@days_since_update,
    @target_sdk_risk,@size_mb,@screenshots_count,@video_present,@description_len,
    @localized_geo_count,@localized_hl_list,@localization_quality,@available_in_geo,@localized_here,
    @installs_source_geo,@installs_consistency,@iap_min_usd,@iap_max_usd,@contains_ads,
    @monetization_type,@monetization_proof,@permissions_risky,@policy_risk_category,@content_rating,
    @head_kw_in_title,@installs_per_month_lifetime,@kw_top10_count,@kw_top50_count,@index_breadth,@index_gap,
    @polarization,@wom_index,@suggest_depth,@portfolio_size,
    @installs_delta_1d,@installs_growth_1d,@ratings_delta_24h,@listing_changed,@new_reviews_24h,@rank_best,@rank_delta_24h,
    @installs_growth_7d,@ratings_per_day_7d,@burst_flag,@spearman_rank_installs,@rank_volatility,
    @reviews_labeled,@growth,@growth_conf,@growth_s,
    @pain_money,@pain_ads,@pain_broken,@pain_missing,@pain_trust,@pain_dominant,@pain_fit,
    @src_ads_pct,@src_ugc_pct,@src_store_pct,@crash_pct,@repeat_use_pct,@rating_recent_30d,
    @template_review_pct,@review_lang_mismatch,@missing_language_pct,@fraud_ok,
    @installs_growth_30d,@organic,@ads_found,@attribution_sdk,@policy_ok,@policy_auto_ok,@verification_level,
    @paywall_sdk,@compute_location,@ad_sdks,@size_mb_apk,@locales_apk,@iap_products_count,@has_annual_tier,
    @demand,@fake,@weakness,@openness,@feasibility,@policy_penalty,@prescore,@copy_score_gp,
    @copy_score_provisional,@geo_multiplier)`);

  const riskyLabels = inst.risky_permission_labels.map((s) => s.toLowerCase());
  const blockedApps = new Set(d.prepare(`SELECT value FROM blocklist WHERE kind='app'`).all().map((r) => r.value));
  const blockedDevs = new Set(d.prepare(`SELECT value FROM blocklist WHERE kind='developer'`).all().map((r) => r.value));
  const regulated = new Set(inst.regulated_categories);
  // B2: результаты разбора APK (ручной, редкий) и автоматического скана трекеров
  // (описание/privacy policy/Data Safety, замена APK по умолчанию).
  const apkRows = new Map(d.prepare(`SELECT * FROM raw_apk`).all().map((r) => [r.app_id, r]));
  const trackingRows = new Map(d.prepare(
    `SELECT t.* FROM raw_tracking_scan t
       JOIN (SELECT app_id, MAX(checked_at) md FROM raw_tracking_scan GROUP BY app_id) f
         ON f.app_id=t.app_id AND f.md=t.checked_at`
  ).all().map((r) => [r.app_id, r]));
  const policyRiskCats = new Set(inst.policy_risk_categories);
  const rows = [];

  for (const c of cards) {
    const nicheId = nicheOfApp.get(c.app_id)?.nicheId
      ?? (c.niche_id && c.niche_id.startsWith(`${geo}-`) && nicheMetrics.has(c.niche_id) ? c.niche_id : null);
    const nm = nicheId ? nicheMetrics.get(nicheId) : null;
    const Q = (m, lvl) => qv(nicheId, geo, m, date, lvl);

    const srcInfo = installsSrc.get(c.app_id) || null;
    const installs = srcInfo ? srcInfo.installs : (c.max_installs ?? null);
    const ratings = c.ratings_count ?? null;
    const ipr = ratings > 0 && installs != null ? installs / ratings : null;
    const ageMonths = ageMonthsAt(c.released, c.hl, date);
    const daysUpd = c.updated_ts ? (Date.parse(date) - c.updated_ts) / DAY : null;
    const p90upd = Q('days_since_update', 'p90');
    const hist = c.histogram ? JSON.parse(c.histogram) : null;
    const polarization = hist && hist['5'] ? hist['1'] / hist['5'] : null;
    const perms = c.permissions ? JSON.parse(c.permissions) : null;
    const permsRisky = perms ? (perms.some((p) => riskyLabels.some((l) => String(p).toLowerCase().includes(l))) ? 1 : 0) : null;
    const policyRiskCat = policyRiskCats.has(c.genre_id) ? 1 : 0;

    const ks = kwStats.get(c.app_id) || { top10: 0, top50: 0, best_pos: null, sug_depth: null };
    const coreSize = nicheId ? nicheCoreSize.get(nicheId) : null;
    const inCore50 = nicheId ? (nicheInCore.get(`${nicheId}|${c.app_id}`) || 0) : null;
    const indexBreadth = coreSize ? inCore50 / coreSize : null;
    const indexGap = indexBreadth == null ? null : 1 - indexBreadth;

    // wom_index: бренд в подсказках при малом числе установок.
    const brandTok = String(c.title || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 3)[0];
    let womPos = null;
    if (brandTok) {
      for (const s of suggestions) {
        if (String(s.suggestion).toLowerCase().includes(brandTok)) {
          womPos = womPos == null ? s.pos : Math.min(womPos, s.pos);
        }
      }
    }
    const lg = safeLog10(installs);
    const womIndex = lg && lg > 0 ? (womPos != null ? Math.max(0, 11 - womPos) : 0) / lg : null;

    const headKw = nm?.head_keyword;
    const headKwInTitle = headKw ? (String(c.title || '').toLowerCase().includes(headKw.toLowerCase()) ? 1 : 0) : null;

    // --- дельты ---
    const prev = prevCard.get(c.app_id, geo, g.hl[0], date);
    let installsDelta = null, installsGrowth1d = null, ratingsDelta = null, listingChanged = null;
    // A2: дельты считаются только при неизменном installs_source_geo между сравниваемыми днями.
    const prevMetric = d.prepare(
      `SELECT installs, installs_source_geo FROM metrics_app_geo
        WHERE app_id=? AND geo=? AND snapshot_date<? ORDER BY snapshot_date DESC LIMIT 1`
    ).get(c.app_id, geo, date);
    const sourceGeo = srcInfo ? srcInfo.source_geo : null;
    if (prev) {
      listingChanged = prev.listing_hash !== c.listing_hash ? 1 : 0;
      if (prev.ratings_count != null && ratings != null) ratingsDelta = ratings - prev.ratings_count;
    }
    if (prevMetric && prevMetric.installs != null && installs != null &&
        (prevMetric.installs_source_geo ?? null) === (sourceGeo ?? null)) {
      installsDelta = installs - prevMetric.installs;
      if (prevMetric.installs >= 50000) installsGrowth1d = installsDelta / prevMetric.installs;
    }
    const growthOver = (days) => {
      const from = new Date(Date.parse(date) - days * DAY).toISOString().slice(0, 10);
      const past = d.prepare(
        `SELECT installs, installs_source_geo, snapshot_date FROM metrics_app_geo
          WHERE app_id=? AND geo=? AND snapshot_date<=? ORDER BY snapshot_date DESC LIMIT 1`
      ).get(c.app_id, geo, from);
      if (!past || past.installs == null || installs == null) return null;
      // Окно, пересекающее смену источника установок, не считается.
      if ((past.installs_source_geo ?? null) !== (sourceGeo ?? null)) return null;
      if (past.installs < 50000) return null;
      if (past.snapshot_date === date) return null;
      return (installs - past.installs) / past.installs;
    };

    // --- отзывы ---
    const ra = revAgg.get(c.app_id);
    const la = labelAgg.get(c.app_id) || {};
    const cnt = (k) => la[k]?.c || 0;
    const cnt90 = (k) => la[k]?.c90 || 0;
    const neg = ra?.neg || 0;
    const share = (k) => (neg >= 5 ? cnt(k) / neg : null);
    const painMoney = share('money'), painAds = share('ads'), painBroken = share('broken');
    const painMissing = share('missing'), painTrust = share('trust');
    let painDominant = null;
    if (neg >= 5) {
      const pairs = [['money', painMoney], ['ads', painAds], ['broken', painBroken], ['missing', painMissing], ['trust', painTrust]];
      const best = pairs.filter(([, v]) => v != null && v >= 0.15).sort((a, b) => b[1] - a[1])[0];
      painDominant = best ? best[0] : null;
    }
    const painFit = painMoney == null ? null : clamp(painMoney + (painAds || 0) - 0.5 * (painBroken || 0));

    const totalRev = ra?.n || 0;
    const srcAdsPct = totalRev >= 20 ? cnt('src_ads') / totalRev : null;
    const srcUgcPct = totalRev >= 20 ? cnt('src_ugc') / totalRev : null;
    const srcStorePct = totalRev >= 20 ? cnt('src_store') / totalRev : null;
    const crashPct = (ra?.n90 || 0) >= 20 ? cnt90('crash') / ra.n90 : null;
    const repeatUsePct = totalRev >= 20 ? cnt('repeat_use') / totalRev : null;
    const missingLangPct = neg >= 5 ? cnt('missing_language') / neg : null;
    const templatePct = (ra?.five || 0) >= 10 ? cnt('template_short') / ra.five : null;

    // growth по кривой отзывов: две равные половины, сегодняшний день отброшен.
    let growth = null, growthConf = 0;
    if (ra?.first_date && ra?.last_date) {
      const from = Date.parse(ra.first_date), to = Math.min(Date.parse(ra.last_date), Date.parse(date) - DAY);
      const coveredDays = (to - from) / DAY;
      if (coveredDays >= 4) {
        const mid = new Date(from + (to - from) / 2).toISOString().slice(0, 10);
        const oldHalf = d.prepare(`SELECT COUNT(*) c FROM raw_reviews WHERE app_id=? AND geo=? AND review_date>=? AND review_date<?`).get(c.app_id, geo, ra.first_date, mid).c;
        const newHalf = d.prepare(`SELECT COUNT(*) c FROM raw_reviews WHERE app_id=? AND geo=? AND review_date>=? AND review_date<?`).get(c.app_id, geo, mid, date).c;
        if (oldHalf > 0) growth = newHalf / oldHalf;
        growthConf = (coveredDays >= sc.growth.min_days ? 0.5 : 0) + (oldHalf >= sc.growth.min_old_half_reviews ? 0.5 : 0);
      }
    }
    // Нормируется СЫРОЙ growth (отношение половин кривой отзывов), поэтому и границы —
    // квантили growth, а не growth_s: у growth_s другая шкала (0–1), и на его квантилях
    // norm схлопывался в 1,0 у всех.
    const gLo = Q('growth', 'p25'), gHi = Q('growth', 'p90');
    const growthNorm = growth == null ? null : norm(growth, gLo ?? 0.5, gHi ?? 2.0);
    // Неизвестный рост = 0,3 — нейтрально, не штраф.
    const growthS = growthNorm == null ? sc.growth.unknown_value
      : sc.growth.unknown_value + (growthNorm - sc.growth.unknown_value) * growthConf;

    // Всплеск: > 30 % всех отзывов за одну неделю.
    let burst = null;
    if (totalRev >= 30) {
      const wk = d.prepare(
        `SELECT strftime('%Y-%W', review_date) w, COUNT(*) c FROM raw_reviews WHERE app_id=? AND geo=? AND review_date IS NOT NULL GROUP BY w ORDER BY c DESC LIMIT 1`
      ).get(c.app_id, geo);
      burst = wk && wk.c / totalRev > 0.3 ? 1 : 0;
    }

    // --- гейты ---
    const p99ipr = Q('installs_per_rating', 'p99'), p01ipr = Q('installs_per_rating', 'p01');
    const p95tpl = Q('template_review_pct', 'p95');
    let fraudOk = 1;
    const fraudWhy = [];
    if (ipr != null && p99ipr != null && ipr > p99ipr) { fraudOk = 0; fraudWhy.push('installs/rating > p99'); }
    if (ipr != null && p01ipr != null && ipr < p01ipr) { fraudOk = 0; fraudWhy.push('installs/rating < p01'); }
    if (burst === 1) { fraudOk = 0; fraudWhy.push('всплеск отзывов'); }
    if (templatePct != null && p95tpl != null && templatePct > p95tpl) { fraudOk = 0; fraudWhy.push('шаблонные отзывы > p95'); }
    if (c.score != null && c.score > 4.9 && ratings >= 10000) { fraudOk = 0; fraudWhy.push('рейтинг > 4.9 при 10K+ оценок'); }

    // --- органика: только прямые свидетельства ---
    // Два источника атрибуции: реальный APK (raw_apk, ручной, редкий, но авторитетный —
    // подтверждает и присутствие, и ОТСУТСТВИЕ трекера) и автоматический скан текста
    // (raw_tracking_scan — описание/privacy policy/Data Safety, без скачивания файла).
    // У скана текста находка так же весома, как у APK (имя трекера просто так не всплывает),
    // а вот "не найдено" НЕ считается подтверждённым отсутствием — политика могла быть
    // неполной или не прочитаться, поэтому verified_none даёт только реальный разбор APK.
    const ads = adsFound.get(c.app_id) || 'unchecked';
    const apkScan = apkRows.get(c.app_id) || null;
    const textScan = trackingRows.get(c.app_id) || null;
    let attributionSdk = null;
    if (apkScan) attributionSdk = apkScan.attribution_sdk;
    else if (textScan && textScan.found) attributionSdk = 1;
    const apkChecked = !!apkScan;
    const trackingChecked = !!textScan;
    const checkedSomehow = apkChecked || trackingChecked || apkLabels.has(c.app_id);

    const p95srcAds = Q('src_ads_pct', 'p95');
    let organic;
    if (['google', 'meta', 'both'].includes(ads)) organic = 0;
    else if (attributionSdk === 1) organic = 0;
    else if (srcAdsPct != null && p95srcAds != null && srcAdsPct > p95srcAds) organic = sc.organic_defaults.src_ads_high;
    else if (ads === 'none' && apkChecked && attributionSdk === 0) organic = sc.organic_defaults.verified_none;
    else organic = sc.organic_defaults.unknown;

    const pOk = policyOk.get(c.app_id) ?? 0;
    const verification = (ads !== 'unchecked' ? 1 : 0) + (checkedSomehow ? 1 : 0) + (policyOk.has(c.app_id) ? 1 : 0);
    const verificationLevel = verification === 3 ? 'полностью' : verification === 0 ? 'не проверено' : 'частично';

    // --- компоненты скора ---
    const p10i = safeLog10(Q('installs', 'p10')), p90i = safeLog10(Q('installs', 'p90'));
    const demandBase = norm(safeLog10((installs ?? 0) + 1), p10i, p90i);
    const p90ipr = Q('installs_per_rating', 'p90');
    const fake = norm(safeLog10(ipr), safeLog10(p90ipr), safeLog10(p99ipr)) ?? 0;
    const demand = demandBase == null ? null : demandBase * (1 - sc.fake.demand_penalty * fake);

    const p75score = Q('score', 'p75');
    const wFirst = p75score != null && c.score != null ? clamp((p75score - c.score) / 1.5) : null;
    const weakness = wFirst == null ? null : (painFit != null ? 0.5 * wFirst + 0.5 * painFit : 0.5 * wFirst);

    const doorLo = qv(`${geo}:niches`, geo, 'door', date, 'p10', { nicheFirst: false });
    const doorHi = qv(`${geo}:niches`, geo, 'door', date, 'p90', { nicheFirst: false });
    const doorPart = nm?.door != null ? 1 - (norm(nm.door, doorLo, doorHi) ?? 0.5) : null;
    const ageLo = Q('age_months', 'p10'), ageHi = Q('age_months', 'p90');
    const agePart = ageMonths != null ? 1 - (norm(ageMonths, ageLo, ageHi) ?? 0.5) : null;
    const openness = weightedAvailable([[doorPart, sc.openness_mix.door], [agePart, sc.openness_mix.age]]);

    const catScore = cheap.has(c.genre_id) ? 1 : hard.has(c.genre_id) ? 0 : 0.5;
    const thin = thinRe.test(`${c.title || ''} ${c.summary || ''}`) ? sc.feasibility.thin_bonus : 0;
    const abandoned = p90upd != null && daysUpd != null && daysUpd > p90upd ? sc.feasibility.abandoned_bonus : 0;
    const feasibility = clamp(catScore + thin + abandoned);

    const policyPenalty = (permsRisky === 1 || policyRiskCat === 1) ? sc.policy_penalty : 1;

    const prescoreCore = weightedAvailable([
      [demand, W.demand], [growthS, W.growth_s], [weakness, W.weakness],
      [openness, W.openness], [feasibility, W.feasibility], [organic, W.organic],
    ]);
    const prescore = prescoreCore == null ? null : 100 * policyPenalty * prescoreCore;

    // --- copy_score_gp ---
    const monetizationType = c.contains_ads && c.offers_iap ? 'гибрид' : c.contains_ads ? 'реклама' : c.offers_iap ? 'IAP' : 'нет';
    const monetizationProof = (c.iap_max_usd != null && c.iap_max_usd >= sc.monetization_proof.iap_max_usd_prior) || c.contains_ads
      ? sc.monetization_proof.ok : sc.monetization_proof.weak;

    let geoMultiplier = 1;
    if (!isRef && nicheId) {
      const arb = d.prepare(`SELECT geo_arbitrage FROM metrics_geo_arbitrage WHERE niche_id=? AND geo=? AND snapshot_date=?`).get(nicheId, geo, date);
      geoMultiplier = arb?.geo_arbitrage ?? 1;
    }
    const doorTerm = nm?.door != null ? Math.log10(1 + nm.door) : null;
    const copyCore = (demand != null && nm && doorTerm)
      ? Math.pow(Math.max(demand, 0), 0.5) * (nm.weak_share ?? 0) * (1 - (nm.leader_share ?? 0)) *
        (0.5 + (nm.new_share_18m ?? 0)) * (0.5 + (indexGap ?? 0)) * organic * monetizationProof * geoMultiplier / doorTerm
      : null;
    const copyProvisional = copyCore == null ? null : fraudOk * copyCore;
    const copyScore = copyProvisional == null ? null : pOk * copyProvisional;

    // A1
    const loc = locByApp.get(c.app_id);
    const localizedGeoCount = refHash.has(c.app_id) ? (loc ? loc.geos.size : 0) : null;
    const localizedHlList = loc ? [...loc.hls].sort().join(',') : null;
    const localizedHere = loc ? (loc.geos.has(geo) ? 1 : 0) : (refHash.has(c.app_id) ? 0 : null);

    // A4: только уровень A, все языки сняты, не меньше 200 отзывов суммарно.
    const langCounts = revLangs.get(c.app_id);
    let reviewLangMismatch = null;
    if (c.watch_level === 'A' && langCounts) {
      const totalAll = [...langCounts.values()].reduce((a, b) => a + b, 0);
      if (totalAll >= 200) {
        const localizedBase = new Set([...(loc ? loc.hls : [])].map(baseLang));
        let foreign = 0;
        for (const [lang, cnt] of langCounts) if (!localizedBase.has(baseLang(lang))) foreign += cnt;
        reviewLangMismatch = foreign / totalAll;
      }
    }

    // C1: описательный автогейт. policy_ok он не заменяет и в скор не входит.
    const policyAutoOk = (permsRisky === 0 &&
      !regulated.has(c.genre_id) && policyRiskCat === 0 &&
      !blockedApps.has(c.app_id) && !blockedDevs.has(c.developer_id)) ? 1 : (permsRisky == null ? null : 0);

    rows.push({
      app_id: c.app_id, geo, snapshot_date: date, niche_id: nicheId ?? null, watch_level: c.watch_level,
      installs, ratings_count: ratings, score: c.score ?? null,
      installs_per_rating: ipr, age_months: ageMonths, days_since_update: daysUpd,
      target_sdk_risk: p90upd != null && daysUpd != null && daysUpd > p90upd ? 1 : 0,
      size_mb: c.size_mb ?? null, screenshots_count: c.screenshots_count ?? null, video_present: c.video_present ?? null,
      description_len: c.description_len ?? null,
      localized_geo_count: localizedGeoCount,
      localized_hl_list: localizedHlList,
      localization_quality: null,    // считается при 2+ активных гео
      available_in_geo: c.available ?? null,
      localized_here: localizedHere,
      installs_source_geo: sourceGeo,
      installs_consistency: srcInfo ? srcInfo.consistency : null,
      iap_min_usd: c.iap_min_usd ?? null, iap_max_usd: c.iap_max_usd ?? null, contains_ads: c.contains_ads ?? null,
      monetization_type: monetizationType, monetization_proof: monetizationProof,
      permissions_risky: permsRisky, policy_risk_category: policyRiskCat, content_rating: c.content_rating ?? null,
      head_kw_in_title: headKwInTitle,
      installs_per_month_lifetime: installs != null && ageMonths ? installs / ageMonths : null,
      kw_top10_count: ks.top10, kw_top50_count: ks.top50,
      index_breadth: indexBreadth, index_gap: indexGap,
      polarization, wom_index: womIndex, suggest_depth: ks.sug_depth ?? null,
      portfolio_size: c.developer_id ? (portfolioByDev.get(c.developer_id) ?? null) : null,
      installs_delta_1d: installsDelta, installs_growth_1d: installsGrowth1d,
      ratings_delta_24h: ratingsDelta, listing_changed: listingChanged,
      new_reviews_24h: null, rank_best: ks.best_pos ?? null, rank_delta_24h: null,
      installs_growth_7d: growthOver(7), ratings_per_day_7d: ra?.n7 != null ? ra.n7 / 7 : null,
      burst_flag: burst, spearman_rank_installs: null, rank_volatility: null,
      reviews_labeled: totalRev, growth, growth_conf: growthConf, growth_s: growthS,
      pain_money: painMoney, pain_ads: painAds, pain_broken: painBroken, pain_missing: painMissing,
      pain_trust: painTrust, pain_dominant: painDominant, pain_fit: painFit,
      src_ads_pct: srcAdsPct, src_ugc_pct: srcUgcPct, src_store_pct: srcStorePct,
      crash_pct: crashPct, repeat_use_pct: repeatUsePct, rating_recent_30d: ra?.rating30 ?? null,
      template_review_pct: templatePct,
      review_lang_mismatch: reviewLangMismatch,
      missing_language_pct: missingLangPct, fraud_ok: fraudOk,
      installs_growth_30d: growthOver(30), organic, ads_found: ads,
      attribution_sdk: attributionSdk,
      policy_ok: pOk, policy_auto_ok: policyAutoOk, verification_level: verificationLevel,
      paywall_sdk: apkScan?.paywall_sdk ?? null, compute_location: apkScan?.compute_location ?? null,
      ad_sdks: apkScan?.ad_sdks ?? null, size_mb_apk: apkScan?.size_mb_apk ?? null,
      locales_apk: apkScan?.locales_apk ?? null,
      iap_products_count: apkScan?.iap_products_count ?? null,
      has_annual_tier: apkScan?.has_annual_tier ?? null,
      demand, fake, weakness, openness, feasibility, policy_penalty: policyPenalty,
      prescore, copy_score_gp: copyScore, copy_score_provisional: copyProvisional, geo_multiplier: geoMultiplier,
    });

    if (fraudOk === 0 && fraudWhy.length) {
      logEvent('fraud_gate', { date, geo, appId: c.app_id, detail: fraudWhy.join('; ') });
    }
  }

  d.transaction(() => { for (const r of rows) ins.run(r); })();

  // Перезаписываем prescore в screen_result — очередь на проверку строится по нему.
  const upScreen = d.prepare(`UPDATE screen_result SET prescore=?, niche_id=? WHERE app_id=? AND geo=? AND snapshot_date=?`);
  d.transaction(() => { for (const r of rows) upScreen.run(r.prescore, r.niche_id, r.app_id, geo, date); })();

  // --- 9.9 автоматические понижения ---
  let downgraded = 0;
  for (const r of rows) {
    if (!['A', 'B'].includes(r.watch_level)) continue;
    let why = null;
    if (r.fraud_ok === 0) why = 'fraud_ok = 0';
    else if (['google', 'meta', 'both'].includes(r.ads_found)) why = `реклама найдена (${r.ads_found})`;
    else {
      const seen = d.prepare(
        `SELECT MAX(snapshot_date) md FROM raw_search WHERE geo=? AND app_id=? AND position<=50`
      ).get(geo, r.app_id)?.md;
      if (seen && (Date.parse(date) - Date.parse(seen)) / DAY >= 14) why = 'вне топ-50 по всем ключам ядра 14 дней';
    }
    if (why && setWatchLevel(r.app_id, 'C', why, date, geo)) downgraded++;
  }

  // --- Слой F: гео-арбитраж относительно US ---
  if (!isRef) {
    const ref = referenceGeo();
    const refEcon = geoConf(ref), geoEcon = g;
    const insArb = d.prepare(`INSERT OR REPLACE INTO metrics_geo_arbitrage
      (niche_id, geo, snapshot_date, wall_ratio, door_ratio, demand_ratio, money_ratio, geo_arbitrage) VALUES (?,?,?,?,?,?,?,?)`);
    const here = d.prepare(`SELECT * FROM metrics_niche_geo WHERE geo=? AND snapshot_date=?`).all(geo, date);
    d.transaction(() => {
      for (const n of here) {
        // Сопоставление по concept, а не по head_keyword: «document scanner» в US и
        // «dokumente scannen» в DE — одна ниша, но по строке они не сходятся никогда.
        const refN = n.concept
          ? d.prepare(`SELECT * FROM metrics_niche_geo WHERE geo=? AND concept=? ORDER BY snapshot_date DESC LIMIT 1`).get(ref, n.concept)
          : d.prepare(`SELECT * FROM metrics_niche_geo WHERE geo=? AND head_keyword=? ORDER BY snapshot_date DESC LIMIT 1`).get(ref, n.head_keyword);
        if (!refN) continue;
        const wallRatio = n.wall_installs ? refN.wall_installs / n.wall_installs : null;
        const doorRatio = n.door ? refN.door / n.door : null;
        const demandRatio = refN.suggest_score_sum ? n.suggest_score_sum / refN.suggest_score_sum : null;
        const moneyRatio = refEcon.ecpm_rel_us ? (geoEcon.ecpm_rel_us + geoEcon.arpu_rel_us) / (refEcon.ecpm_rel_us + refEcon.arpu_rel_us) : null;
        const arb = [wallRatio, demandRatio, moneyRatio].every((v) => v != null) ? wallRatio * demandRatio * moneyRatio : null;
        insArb.run(n.niche_id, geo, date, wallRatio, doorRatio, demandRatio, moneyRatio, arb);
      }
    })();
  }

  finishRun(runId, 'score', geo, { notes: `${rows.length} строк, понижений ${downgraded}, partial=${partial}` });
  log(`  ${geo}: метрик ${rows.length}, автопонижений ${downgraded}${partial ? ', день partial' : ''}`);
  return { rows: rows.length, downgraded, partial };
}
