// Воронка отсева, этапы 0–2 (ТЗ 8). Ничего не удаляется: отсеянное остаётся с причиной и датой.
// Все пороги — квантили из niche_quantiles (принцип 9). Единственные абсолютные величины —
// те, что ТЗ явно разрешает: 4.9 при большом числе оценок и порог методики iap_max ≈ 20 $ ± 15 %.
import { db, startRun, finishRun } from '../lib/db.js';
import { config, geoConf } from '../lib/config.js';
import { qv, geoRows } from './quantiles.js';
import { setWatchLevel } from '../lib/registry.js';
import { log } from '../lib/util.js';
import { ageMonthsAt } from '../lib/dates.js';

const REF_CHART_GEOS = ['US', 'GB', 'DE', 'FR', 'CA', 'AU'];

function domainOf(url) {
  if (!url) return null;
  try { return new URL(url.startsWith('http') ? url : `http://${url}`).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return null; }
}
function globToRe(pattern) {
  return new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
}
function stripCountrySuffix(title, suffixes) {
  let t = String(title || '').trim();
  const re = new RegExp(`[\\s\\-–—:(\\[]*\\b(${suffixes.join('|')})\\b[\\s\\)\\]]*$`, 'i');
  t = t.replace(re, '').trim();
  return t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export async function run({ geo, date, runId, cycle = 'discovery' }) {
  const d = db();
  startRun(runId, 'screen', geo, cycle, date);
  const inst = config().institutions;
  const scoring = config().scoring;
  const g = geoConf(geo);
  const seedCats = new Set(d.prepare(`SELECT category FROM seed_categories WHERE geo=?`).all(geo).map((r) => r.category));

  const domainRes = inst.domain_patterns.map(globToRe);
  const pkgRes = inst.package_patterns.map(globToRe);
  const nameRes = inst.name_regex.map((r) => new RegExp(r, 'i'));
  const regulated = new Set(inst.regulated_categories);
  const policyRisk = new Set(inst.policy_risk_categories);
  const riskyPermLabels = inst.risky_permission_labels.map((s) => s.toLowerCase());

  const blocked = new Set(d.prepare(`SELECT value FROM blocklist WHERE kind='app'`).all().map((r) => r.value));
  const blockedDevs = new Set(d.prepare(`SELECT value FROM blocklist WHERE kind='developer'`).all().map((r) => r.value));
  const factories = new Set(d.prepare(`SELECT DISTINCT developer_id FROM developer_clusters WHERE is_factory=1`).all().map((r) => r.developer_id));

  // Каталог названий из чартов референсных гео — для regional_clone.
  const refTitles = new Map();
  for (const row of d.prepare(
    `SELECT DISTINCT c.app_id, a.title FROM raw_charts c JOIN apps a ON a.app_id=c.app_id
      WHERE c.geo IN (${REF_CHART_GEOS.map(() => '?').join(',')}) AND a.title IS NOT NULL`
  ).all(...REF_CHART_GEOS)) {
    const key = stripCountrySuffix(row.title, inst.regional_clone_suffixes);
    if (key.length >= 4) {
      if (!refTitles.has(key)) refTitles.set(key, new Set());
      refTitles.get(key).add(row.app_id);
    }
  }

  // Один снимок на приложение (первый hl гео).
  const cards = d.prepare(
    `SELECT p.*, a.developer_id AS reg_dev_id
       FROM raw_app_page p JOIN apps a ON a.app_id=p.app_id
      WHERE p.geo=? AND p.snapshot_date=? AND p.hl=?`
  ).all(geo, date, g.hl[0]);

  const kwStat = d.prepare(
    `SELECT ak.app_id,
            SUM(CASE WHEN ak.best_position<=10 AND k.is_brand=0 THEN 1 ELSE 0 END) AS generic_top10,
            SUM(CASE WHEN ak.best_position<=10 THEN 1 ELSE 0 END) AS any_top10,
            SUM(CASE WHEN ak.best_position<=20 THEN 1 ELSE 0 END) AS any_top20,
            MIN(ak.best_position) AS best_pos,
            COUNT(*) AS kw_count
       FROM disc_app_keyword ak JOIN disc_keywords k ON k.geo=ak.geo AND k.keyword=ak.keyword
      WHERE ak.geo=? GROUP BY ak.app_id`
  ).all(geo);
  const kwBy = new Map(kwStat.map((r) => [r.app_id, r]));
  const paths = new Map(d.prepare(`SELECT app_id, discovery_paths_count FROM disc_apps WHERE geo=?`).all(geo)
    .map((r) => [r.app_id, r.discovery_paths_count]));

  const Q = (m, lvl) => qv(null, geo, m, date, lvl, { nicheFirst: false });
  // Порог «слишком крупного» — квантиль установок гео, по умолчанию p75 (решение заказчика
  // 18.09): при p95 он был 117–237 млн, и в воронку проходили приложения на десятки миллионов
  // установок — ChatGPT-клиенты, Claude. p75 — 8–15 млн в зависимости от гео.
  const bigQ = scoring.funnel?.too_big_quantile || 'p75';
  const big_inst = Q('installs', bigQ);
  const p50_inst = Q('installs', 'p50');
  const p90_upd = Q('days_since_update', 'p90');
  const p10_score = Q('score', 'p10');
  const p25_score = Q('score', 'p25');
  const p50_ratings = Q('ratings_count', 'p50');
  const p99_ipr = Q('installs_per_rating', 'p99');
  const p01_ipr = Q('installs_per_rating', 'p01');
  const p90_size = Q('size_mb', 'p90');
  const p90_loc = Q('localized_geo_count', 'p90');
  // A1: дисквалификатор budget — локализация под слишком много гео при малом возрасте.
  const localized = new Map(geoRows(d, geo, date).map((r) => [r.app_id, r.localized_geo_count]));
  const iapPrior = scoring.monetization_proof.iap_max_usd_prior * 0.85; // допуск ±15 % на курс

  const ins = d.prepare(`INSERT OR REPLACE INTO screen_result
    (app_id, geo, snapshot_date, stage_reached, reject_reason, prescore, niche_id, detail) VALUES (?,?,?,?,?,?,?,?)`);
  const upApp = d.prepare(`UPDATE apps SET status=?, reject_reason=? WHERE app_id=?`);

  const reasons = {};
  let passed = 0;

  for (const c of cards) {
    const kw = kwBy.get(c.app_id) || { generic_top10: 0, any_top10: 0, any_top20: 0, best_pos: 999, kw_count: 0 };
    const devDomain = domainOf(c.developer_website);
    const legal = `${c.developer_legal_name || ''} ${c.developer || ''}`;
    const daysUpd = c.updated_ts ? (Date.now() - c.updated_ts) / 86400000 : null;
    const ageMonths = ageMonthsAt(c.released, c.hl, date);
    const ipr = c.ratings_count > 0 ? c.max_installs / c.ratings_count : null;
    const perms = c.permissions ? JSON.parse(c.permissions) : null;

    let stage = 0, reason = null, detail = null;

    // --- Этап 1: выдача и разработчик ---
    if (!reason && blocked.has(c.app_id)) reason = 'blocklist';
    if (!reason && (blockedDevs.has(c.developer_id) || blockedDevs.has(c.reg_dev_id))) reason = 'blocklist';
    if (!reason && factories.has(c.developer_id)) reason = 'factory';
    if (!reason && (paths.get(c.app_id) || 0) <= 1 && kw.best_pos >= 31 && kw.best_pos <= 50) reason = 'periphery';
    if (!reason && seedCats.size && c.genre_id && !seedCats.has(c.genre_id)) { reason = 'off_category'; detail = c.genre_id; }
    if (!reason && kw.kw_count > 0 && kw.any_top10 > 0 && kw.generic_top10 === 0) reason = 'branded_only';
    if (!reason && (
      (devDomain && domainRes.some((re) => re.test(devDomain))) ||
      pkgRes.some((re) => re.test(c.app_id)) ||
      nameRes.some((re) => re.test(legal)) ||
      nameRes.some((re) => re.test(String(c.title || '')))
    )) { reason = 'institution'; detail = devDomain || legal.trim(); }
    if (!reason && regulated.has(c.genre_id)) { reason = 'regulated_category'; detail = c.genre_id; }
    if (reason) stage = 1;

    // --- Этап 2: карточка ---
    if (!reason) {
      stage = 2;
      const key = stripCountrySuffix(c.title, inst.regional_clone_suffixes);
      const refSet = refTitles.get(key);
      if (c.available === 0) reason = 'not_available';
      else if (refSet && refSet.size && !refSet.has(c.app_id) && key !== String(c.title || '').toLowerCase().trim()) {
        reason = 'regional_clone'; detail = key;
      } else if (big_inst != null && c.max_installs != null && c.max_installs > big_inst) {
        reason = 'too_big'; detail = `installs ${c.max_installs} > ${bigQ} ${Math.round(big_inst)}`;
      } else if (p90_upd != null && daysUpd != null && daysUpd > p90_upd && p50_inst != null && c.max_installs < p50_inst) {
        reason = 'dead'; detail = `${Math.round(daysUpd)} дн. без апдейта`;
      } else if (p10_score != null && c.score != null && c.score < p10_score && p50_ratings != null && c.ratings_count >= p50_ratings) {
        reason = 'broken'; detail = `рейтинг ${c.score} < p10 ${p10_score?.toFixed(2)}`;
      } else if (!c.contains_ads && !c.offers_iap && c.free) {
        reason = 'no_monetization';
      } else if (!c.contains_ads && c.iap_max_usd != null && c.iap_max_usd < iapPrior) {
        reason = 'low_monetization'; detail = `iap_max ${c.iap_max_usd?.toFixed(2)}$`;
      } else if (ipr != null && ((p99_ipr != null && ipr > p99_ipr) || (p01_ipr != null && ipr < p01_ipr))) {
        reason = 'fraud_extreme'; detail = `installs/rating ${ipr.toFixed(1)}`;
      } else if (c.score != null && c.score > 4.9 && c.ratings_count >= 10000) {
        reason = 'fraud_extreme'; detail = 'рейтинг > 4.9 при 10K+ оценок';
      } else if (perms && perms.some((p) => riskyPermLabels.some((l) => String(p).toLowerCase().includes(l)))) {
        reason = 'policy_risk_permissions';
        detail = perms.filter((p) => riskyPermLabels.some((l) => String(p).toLowerCase().includes(l))).slice(0, 3).join('; ');
      } else if (policyRisk.has(c.genre_id)) {
        reason = 'policy_risk_category'; detail = c.genre_id;
      } else if (p90_loc != null && ageMonths != null && ageMonths < 24 &&
                 localized.get(c.app_id) != null && localized.get(c.app_id) > p90_loc) {
        reason = 'budget';
        detail = `локализовано в ${localized.get(c.app_id)} гео при возрасте ${Math.round(ageMonths)} мес`;
      } else if (p90_size != null && c.size_mb != null && c.size_mb > p90_size && p25_score != null && c.score < p25_score) {
        reason = 'heavy_and_bad';
      }
    }

    if (!reason) { stage = 3; passed++; }
    reasons[reason || 'passed'] = (reasons[reason || 'passed'] || 0) + 1;

    ins.run(c.app_id, geo, date, stage, reason, null, null, detail);
    if (reason) {
      upApp.run('rejected', reason, c.app_id);
      // Топ-20 выдачи, не прошедшие воронку, — фон (уровень C), а не отвал:
      // door, стена и оборот топ-10 считаются по составу выдачи целиком.
      setWatchLevel(c.app_id, kw.any_top20 > 0 ? 'C' : 'D', reason, date, geo);
    } else {
      upApp.run('watched', null, c.app_id);
      setWatchLevel(c.app_id, 'B', 'прошёл воронку', date, geo);
    }
  }

  finishRun(runId, 'screen', geo, { notes: JSON.stringify(reasons) });
  log(`  ${geo}: воронка — ${cards.length} карточек, прошло ${passed}`);
  log(`     ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  return { total: cards.length, passed, reasons };
}
