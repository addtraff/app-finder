// Отчёт «AppRadar 2» — ТЗ docs/tz-appradar-v2.md, разделы 6–9.
//
// Оформление AppRadar, данные — таблицы методики v2.0 (стадия radar-v2). Отчёт ничего не
// пересчитывает: берёт готовые метрики гео и только сводит их ворлдвайд — выбирает лучшее
// гео приложения и ниши с учётом денег гео с низким весом (решение заказчика №1).
import fs from 'node:fs';
import path from 'node:path';
import { db, ROOT, DB_PATH } from '../lib/db.js';
import { config, referenceGeo } from '../lib/config.js';
import { quantile, norm, log } from '../lib/util.js';
import { packRows, UNPACK_JS } from '../lib/pack.js';
import { qv, clearQCache } from './quantiles.js';
import { collectCollection } from './dashboard.js';

const one = (d, sql, ...p) => d.prepare(sql).get(...p);
const all = (d, sql, ...p) => d.prepare(sql).all(...p);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Number(Number(v).toPrecision(4)));
const parse = (s, def = null) => { try { return s == null ? def : JSON.parse(s); } catch { return def; } };

function geoQ(d, geo, date, metric, level) {
  const row = one(d, `SELECT ${level} v FROM niche_quantiles WHERE scope='geo' AND scope_id=? AND metric=? AND snapshot_date=?`, `${geo}:v2`, metric, date);
  return row ? row.v : null;
}

export function collect(d) {
  clearQCache();
  const cfg = config();
  const V = cfg.scoring.v2;
  const ref = referenceGeo();
  const refConf = cfg.geos.geos.find((g) => g.geo === ref);
  const moneyOf = (g) => (g.ecpm_rel_us ?? 0) + (g.arpu_rel_us ?? 0);
  const money = Object.fromEntries(cfg.geos.geos.map((g) => [g.geo, moneyOf(refConf) ? moneyOf(g) / moneyOf(refConf) : null]));
  const mvals = Object.values(money);
  const mp10 = quantile(mvals, 0.1), mp90 = quantile(mvals, 0.9);
  const moneyN = Object.fromEntries(Object.entries(money).map(([g, v]) => [g, norm(v, mp10, mp90) ?? 0.5]));
  const pick = (score, geo) => (score == null ? null : score * (1 - V.money_weight + V.money_weight * moneyN[geo]));
  // Лучшее гео для рекомендуемого топа: процентиль у первых мест гео одинаковый (100), поэтому
  // при равенстве решает сырой рекомендуемый скор, как и везде — с поправкой на деньги гео.
  const recOrder = (x, y) => (pick(y.rec_pct, y.geo) - pick(x.rec_pct, x.geo)) || ((pick(y.rec_score, y.geo) ?? -1) - (pick(x.rec_score, x.geo) ?? -1));

  const geos = [], appRows = [], nicheRows = [], keyRows = [];
  for (const g of cfg.geos.geos) {
    const date = one(d, `SELECT MAX(snapshot_date) m FROM metrics_app_v2 WHERE geo=?`, g.geo)?.m;
    const base = {
      geo: g.geo, tier: g.tier, currency: g.currency, is_reference: g.geo === ref ? 1 : 0,
      money_ratio: r4(money[g.geo]), money_n: r4(moneyN[g.geo]),
      snapshots: one(d, `SELECT COUNT(DISTINCT snapshot_date) c FROM raw_app_page WHERE geo=?`, g.geo).c,
      keywords_total: one(d, `SELECT COUNT(*) c FROM disc_keywords WHERE geo=?`, g.geo).c,
      discovered: one(d, `SELECT COUNT(*) c FROM disc_apps WHERE geo=?`, g.geo).c,
    };
    if (!date) { geos.push({ ...base, date: null }); continue; }

    // Строка приложения — последняя за report_carry_days: дневной проход обновляет не все
    // карточки, и без переноса приложение выпадало бы из отчёта в день, когда его не сняли.
    // Вердикт воронки — тоже последний: прошедшее раньше, но отсеянное сегодня не переносится.
    const carryFrom = new Date(Date.parse(date) - (V.report_carry_days ?? 7) * 864e5).toISOString().slice(0, 10);
    const niches = all(d, `SELECT * FROM metrics_niche_v2 WHERE geo=? AND snapshot_date=?`, g.geo, date);
    const nicheDate = niches[0]?.niche_date || date;
    const baseNiches = all(d, `SELECT niche_id, weak_share, index_gap_leader, wall_installs, wall_ratings, leader_share, new_share_18m, suggest_score_sum
                                 FROM metrics_niche_geo WHERE geo=? AND snapshot_date=?`, g.geo, nicheDate);
    const baseById = new Map(baseNiches.map((n) => [n.niche_id, n]));
    const calib = one(d, `SELECT * FROM metrics_geo_calibration WHERE geo=? AND snapshot_date=?`, g.geo, date) || {};
    const thresholds = {
      weakT: r4(quantile(baseNiches.map((n) => n.weak_share), 2 / 3)),
      gapT: r4(quantile(baseNiches.map((n) => n.index_gap_leader), 2 / 3)),
      updP90: r4(qv(null, g.geo, 'days_since_update', date, 'p90', { nicheFirst: false })),
      asoP25: r4(geoQ(d, g.geo, date, 'aso_share', 'p25')),
      purityP50: r4(geoQ(d, g.geo, date, 'organic_purity', 'p50')),
      fdsP75: r4(geoQ(d, g.geo, date, 'free_demand_share', 'p75')),
      freeKeysP75: r4(geoQ(d, g.geo, date, 'free_keys_count', 'p75')),
      doorKeyP25: r4(geoQ(d, g.geo, date, 'door_key', 'p25')),
      ubtP75: r4(geoQ(d, g.geo, date, 'ubt_share_mentioned', 'p75')),
      ubtNicheP75: r4(geoQ(d, g.geo, date, 'ubt_niche_share', 'p75')),
    };

    const apps = all(d,
      `SELECT v.*, m.prescore, m.score, m.ratings_count, m.monetization_type, m.iap_min_usd, m.iap_max_usd, m.contains_ads,
              m.demand, m.src_ads_pct, m.feasibility, m.monetization_proof, m.policy_ok, m.policy_auto_ok, m.fraud_ok,
              m.days_since_update, m.installs_per_month_lifetime, m.pain_dominant, m.pain_money, m.pain_ads, m.pain_broken,
              m.kw_top10_count, m.kw_top50_count,
              a.title, a.developer, a.genre_id,
              n.concept, n.head_keyword AS niche_head, n.freedom_pct AS niche_freedom, n.quadrant AS niche_quadrant,
              n.door AS niche_door, n.organic_capacity AS niche_capacity, n.ubt_flag AS niche_ubt_flag
         FROM metrics_app_v2 v
         JOIN metrics_app_geo m ON m.app_id=v.app_id AND m.geo=v.geo AND m.snapshot_date=v.snapshot_date
         JOIN apps a ON a.app_id=v.app_id
         LEFT JOIN metrics_niche_v2 n ON n.niche_id=v.niche_id AND n.geo=v.geo AND n.snapshot_date=v.snapshot_date
        WHERE v.geo=? AND v.passed_funnel=1
          AND v.snapshot_date=(SELECT MAX(x.snapshot_date) FROM metrics_app_v2 x
                                WHERE x.app_id=v.app_id AND x.geo=v.geo AND x.snapshot_date<=? AND x.snapshot_date>=?)
        ORDER BY m.prescore DESC`, g.geo, date, carryFrom);
    // В отчёт идут сильнейшие строки гео: страница ограничена 16 МБ, а хвост по индексу
    // копируемости в решении не участвует. Сколько отброшено — видно на странице «Сбор и планы».
    // Рекомендуемые (первые top_n × 3 по рекомендуемому скору) остаются в отчёте, даже если по
    // индексу копируемости они ниже отсечки: рекомендуемый топ считается по всем строкам гео.
    const cap = process.env.RADAR_REPORT_FULL ? Infinity : (V.report_apps_per_geo || 500);
    const recKeep = new Set(apps.filter((a) => a.rec_pct != null).sort((x, y) => y.rec_pct - x.rec_pct)
      .slice(0, (V.recommended?.top_n || 50) * 3).map((a) => a.app_id));
    const kept = apps.filter((a, i) => i < cap || recKeep.has(a.app_id));
    const trimmed = apps.length - kept.length;
    apps.length = 0;
    apps.push(...kept);

    for (const a of apps) {
      appRows.push({
        geo: g.geo, app_id: a.app_id, title: a.title, developer: a.developer, genre_id: a.genre_id,
        niche_id: a.niche_id, concept: a.concept, niche_head: a.niche_head, niche_freedom: r4(a.niche_freedom),
        niche_quadrant: a.niche_quadrant, niche_door: a.niche_door, niche_capacity: r4(a.niche_capacity),
        prescore: r4(a.prescore), installs: a.installs, score: r4(a.score), ratings_count: a.ratings_count,
        age_months: r4(a.age_months), released: a.released, young: a.young,
        delta30: r4(a.installs_delta_30d), delta_w: a.delta_window_days, delta_partial: a.delta_partial,
        dp: r4(a.delta_preview), dp_raw: a.delta_preview_raw, dp_w: a.delta_preview_w, dp_from: a.delta_preview_from,
        row_date: a.snapshot_date,
        level: a.organic_level, evidence_date: a.evidence_date, evidence_age: a.evidence_age_days, ads_found: a.ads_found,
        g_checked: a.ads_google_checked, g_host: a.ads_google_host, g_creatives: a.ads_google_creatives,
        g_first: a.ads_google_first_seen, g_last: a.ads_google_last_seen, g_active: a.ads_google_active,
        m_checked: a.ads_meta_checked, tracking: a.tracking_names, apk: a.apk_parsed, attribution_sdk: a.attribution_sdk,
        weight: r4(a.search_weight), explained: r4(a.explained), aso_share: r4(a.aso_share), traffic: a.traffic_source,
        spike: r4(a.exogenous_spike_rate),
        checks: parse(a.checks, []), passed: a.passed, failed: a.failed, disq: parse(a.disq, []),
        monetization_type: a.monetization_type, iap_min_usd: r4(a.iap_min_usd), iap_max_usd: r4(a.iap_max_usd), contains_ads: a.contains_ads,
        demand: r4(a.demand), src_ads_pct: r4(a.src_ads_pct), p95src: r4(qv(a.niche_id, g.geo, 'src_ads_pct', date, 'p95')),
        feasibility: r4(a.feasibility), monetization_proof: a.monetization_proof, policy_ok: a.policy_ok, policy_auto_ok: a.policy_auto_ok,
        fraud_ok: a.fraud_ok, days_since_update: r4(a.days_since_update), ipm: r4(a.installs_per_month_lifetime),
        pain_dominant: a.pain_dominant, pain_money: r4(a.pain_money), pain_ads: r4(a.pain_ads), pain_broken: r4(a.pain_broken),
        kw_top10: a.kw_top10_count, kw_top50: a.kw_top50_count,
        kw: parse(a.keywords_json, []).slice(0, 8).map((k) => [k.kw, k.pos, r4(k.contrib)]),
        niche_weak: r4(baseById.get(a.niche_id)?.weak_share ?? null), niche_gap: r4(baseById.get(a.niche_id)?.index_gap_leader ?? null),
        ubt: a.ubt_signal, ubt_mentions: a.ubt_mentions, ubt_reviews: a.ubt_reviews, ubt_share: r4(a.ubt_share), ubt_related: a.ubt_related,
        rec_pct: r4(a.rec_pct), rec_score: r4(a.rec_score), rec_parts: parse(a.rec_parts),
        niche_ubt: a.niche_ubt_flag ?? null,
      });
    }

    for (const n of niches) {
      const top = parse(n.head_top10, []);
      const b = baseById.get(n.niche_id) || {};
      nicheRows.push({
        geo: g.geo, niche_id: n.niche_id, concept: n.concept, head: n.head_keyword, keywords_count: n.keywords_count,
        door: n.door, door_head: n.door_head, door_tail: n.door_tail, door_velocity: r4(n.door_velocity), wall: n.wall_installs,
        free_keys: n.free_keys_count, fds: r4(n.free_demand_share), demand_per_app: r4(n.demand_per_app),
        aso_saturation: r4(n.aso_saturation), relevance_gap: r4(n.relevance_gap_pct),
        entry_rate: n.entry_rate_90d, last_entry_days: n.last_entry_days, history_days: n.history_days,
        time_to_door: r4(n.time_to_door_median), turnover_up_new: r4(n.turnover_up_new), turnover_w: n.turnover_window_days,
        hhi: r4(n.hhi_top10), clone_density: r4(n.clone_density),
        components: parse(n.freedom_components, []), freedom_raw: r4(n.freedom_raw), freedom: r4(n.freedom_pct), closed: n.closed_flag,
        capacity: r4(n.organic_capacity), capacity_lo: r4(n.organic_capacity_lo), capacity_hi: r4(n.organic_capacity_hi),
        money_ratio: r4(n.money_ratio), money_capacity: r4(n.money_capacity),
        purity: r4(n.organic_purity), purity_cov: r4(n.purity_coverage), top10_ads_share: r4(n.top10_ads_share),
        young: n.young_organic_count, young_installs: n.young_organic_installs, young_apps: parse(n.young_organic_apps, []).slice(0, 12),
        tto: r4(n.time_to_organic), tto_kind: n.time_to_organic_kind,
        cand: n.candidates_count, cand_organic: n.candidates_organic_count, cand_paid: n.candidates_paid_count,
        monetized: r4(n.monetized_share), pain: parse(n.leaders_pain), top10: top,
        rank: r4(n.niche_rank), rank_basis: n.rank_basis, rank_pct: r4(n.rank_pct), quadrant: n.quadrant, tail_clean: n.tail_clean,
        incomplete: parse(n.incomplete, []), partial: n.partial_window,
        leader_share: r4(b.leader_share ?? null), new_share_18m: r4(b.new_share_18m ?? null), weak_share: r4(b.weak_share ?? null),
        index_gap_leader: r4(b.index_gap_leader ?? null),
        ubt_share: r4(n.ubt_share), ubt_apps: n.ubt_apps, ubt: n.ubt_flag,
        rec_pct: r4(n.rec_pct), rec_score: r4(n.rec_score), rec_parts: parse(n.rec_parts),
      });
    }
    for (const k of all(d, `SELECT niche_id, keyword, is_head, suggest_score, door_key, is_free, paid_ctr_share, ads_checked_share, top10_cards
                              FROM metrics_keyword_geo WHERE geo=? AND snapshot_date=?`, g.geo, date)) {
      keyRows.push({ geo: g.geo, niche_id: k.niche_id, keyword: k.keyword, head: k.is_head, sug: r4(k.suggest_score), door_key: k.door_key,
        free: k.is_free, paid: r4(k.paid_ctr_share), checked: r4(k.ads_checked_share), cards: k.top10_cards });
    }

    const allV2 = all(d, `SELECT organic_level, evidence_age_days, age_months FROM metrics_app_v2 WHERE geo=? AND snapshot_date=?`, g.geo, date);
    const share = (arr, f) => (arr.length ? r4(arr.filter(f).length / arr.length) : null);
    geos.push({
      ...base, date, niche_date: nicheDate, ...thresholds,
      k_geo: r4(calib.k_geo ?? null), k_status: calib.status ?? null, k_window: calib.window_days ?? 0, k_obs: calib.n_obs ?? 0,
      niches: niches.length, apps: apps.length, apps_trimmed: trimmed,
      history_days: niches.reduce((m, n) => Math.max(m, n.history_days || 0), 0),
      age_cov: share(allV2, (a) => a.age_months != null),
      ads_cov: share(apps, (a) => ['found', 'confirmed', 'no_signs'].includes(a.organic_level)),
      door_cov: share(niches, (n) => n.door != null),
      freedom_cov: share(niches, (n) => n.freedom_pct != null),
      purity_cov: share(niches, (n) => n.organic_purity != null),
      expiring7: allV2.filter((a) => ['no_signs', 'confirmed'].includes(a.organic_level) && a.evidence_age_days != null && a.evidence_age_days > V.evidence_ttl_days - 7).length,
      stale: allV2.filter((a) => a.organic_level === 'stale').length,
    });
  }

  // ---------- ворлдвайд: приложения ----------
  const byApp = new Map();
  for (const a of appRows) {
    if (!byApp.has(a.app_id)) byApp.set(a.app_id, []);
    byApp.get(a.app_id).push(a);
  }
  const worldApps = [];
  for (const [id, rows] of byApp) {
    let best = null, bestScore = -Infinity;
    for (const r of rows) {
      const s = pick(r.prescore, r.geo) ?? -1;
      if (s > bestScore || (s === bestScore && r.geo === ref)) { best = r; bestScore = s; }
    }
    const us = rows.find((r) => r.geo === ref);
    // Для рекомендуемого топа — гео, где рекомендуемый скор выше (он может не совпадать с лучшим по индексу).
    const recBest = rows.filter((r) => r.rec_pct != null).sort(recOrder)[0] || null;
    worldApps.push({ app_id: id, geo: best.geo, geos: rows.map((r) => r.geo).sort().join(','), geos_count: rows.length,
      us_prescore: us ? us.prescore : null, rec_geo: recBest ? recBest.geo : null, rec_pct: recBest ? recBest.rec_pct : null,
      rec_geos: rows.filter((r) => r.rec_pct != null && r.rec_pct >= 90).length,
      ubt_any: rows.some((r) => r.ubt === 1) ? 1 : 0 });
  }

  // ---------- ворлдвайд: ниши по концепту ----------
  const byConcept = new Map();
  for (const n of nicheRows) {
    if (!n.concept) continue;
    if (!byConcept.has(n.concept)) byConcept.set(n.concept, new Map());
    const perGeo = byConcept.get(n.concept);
    const cur = perGeo.get(n.geo);
    if (!cur || (n.rank ?? -1) > (cur.rank ?? -1)) perGeo.set(n.geo, n);
  }
  const worldNiches = [];
  for (const [concept, perGeo] of byConcept) {
    const rows = [...perGeo.values()];
    let best = null, bestScore = -Infinity;
    for (const r of rows) {
      const s = pick(r.rank_pct, r.geo) ?? -1;
      if (s > bestScore || (s === bestScore && r.geo === ref)) { best = r; bestScore = s; }
    }
    const cheapest = rows.filter((r) => r.door != null).sort((a, b) => a.door - b.door)[0] || null;
    const young = new Set();
    for (const r of rows) for (const y of r.young_apps) young.add(y.app_id);
    const us = perGeo.get(ref) || null;
    worldNiches.push({
      concept, geo: best.geo, niche_id: best.niche_id, geos_count: rows.length,
      target_geos: rows.filter((r) => r.quadrant === 'target').length,
      cheapest_geo: cheapest ? cheapest.geo : null, cheapest_door: cheapest ? cheapest.door : null,
      young_unique: young.size, us_niche_id: us ? us.niche_id : null,
      rec_geo: (rows.filter((r) => r.rec_pct != null).sort(recOrder)[0] || {}).geo || null,
      rec_niche_id: (rows.filter((r) => r.rec_pct != null).sort(recOrder)[0] || {}).niche_id || null,
      rec_geos: rows.filter((r) => r.rec_pct != null && r.rec_pct >= 90).length,
      ubt_geos: rows.filter((r) => r.ubt === 1).length,
    });
  }

  const timeline = all(d, `SELECT snapshot_date AS date, geo, COUNT(DISTINCT app_id) AS cards FROM raw_app_page GROUP BY snapshot_date, geo ORDER BY snapshot_date`);
  const lastDate = geos.map((g) => g.date).filter(Boolean).sort().pop() || null;

  return {
    meta: {
      generated_at: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      date: lastDate, reference_geo: ref,
      db_size_mb: fs.existsSync(DB_PATH) ? Math.round(fs.statSync(DB_PATH).size / 1048576) : 0,
      ttl: V.evidence_ttl_days, young_months: V.young_months, min_window: V.min_window_days, full_window: V.full_window_days, carry_days: V.report_carry_days ?? 7,
      entry_window: V.entry_window_days, calib_min: V.calibration_min_obs, money_weight: V.money_weight, purity_min: V.purity_min_checked_share,
      ubt_min_mentions: V.ubt_min_mentions, ubt_min_reviews: V.ubt_min_reviews, ubt_niche_min_apps: V.ubt_niche_min_apps,
      rec: V.recommended,
    },
    geos, apps: appRows, niches: nicheRows, keys: keyRows, worldApps, worldNiches, timeline,
    collection: collectCollection(d, lastDate),
  };
}

export async function run() {
  const d = db();
  const data = collect(d);
  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'report', 'appradar2.html'), 'utf8');
  const json = JSON.stringify(packRows(data)).replace(/</g, '\\u003c');
  const fragment = tpl.replace('__RADAR_DATA__', () => json).replace('__UNPACK_JS__', () => UNPACK_JS);
  // RADAR_REPORT_FULL=1 — полная версия без отсечки строк, в out/full: для просмотра локально
  // (http://localhost:8777/full/…), в артефакт такой файл не помещается.
  const outDir = path.join(ROOT, 'out', process.env.RADAR_REPORT_FULL ? 'full' : '');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'appradar2-artifact.html'), fragment, 'utf8');
  fs.writeFileSync(path.join(outDir, 'appradar2.html'), `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0">
${fragment}
</body>
</html>`, 'utf8');
  log(`  AppRadar 2: out/appradar2.html (${(fragment.length / 1048576).toFixed(1)} МБ), гео ${data.geos.filter((g) => g.date).length}, ` +
      `строк приложений ${data.apps.length}, уникальных ${data.worldApps.length}, ниш ${data.niches.length}, концептов ${data.worldNiches.length}`);
  return { apps: data.apps.length };
}
