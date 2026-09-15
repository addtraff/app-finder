// kw-report: отчёт модуля объёма поиска — out/kw-volume.html (локально) и out/kw-volume-artifact.html
// (фрагмент для публикации). Тот же collect() отдаёт данные локальному сервису (src/kw-serve.js).
//
// Отчёт показывает ровно то, что разрешает уровень доверия (раздел 8): без откалиброванной модели
// в колонке «Показы/день» нет чисел — только замок или относительная шкала с подписью.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/db.js';
import { config, referenceGeo, primaryHl } from '../lib/config.js';
import { log, spearman, daysAgoUTC } from '../lib/util.js';
import { packRows, UNPACK_JS } from '../lib/pack.js';
import { kwDb, kwConfig } from '../lib/kw/schema.js';
import { geoMaturity, STAGES } from '../lib/kw/maturity.js';

const all = (d, sql, ...p) => d.prepare(sql).all(...p);
const one = (d, sql, ...p) => d.prepare(sql).get(...p);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

function collectGeo(d, geo, date) {
  const cfg = kwConfig();
  const maturity = geoMaturity(d, geo, date);
  const day = one(d, `SELECT MAX(day) m FROM kw_metrics WHERE geo=? AND day<=?`, geo, date).m;

  const keywords = all(d,
    `SELECT k.term, s.day AS signals_day, s.score_method AS method, s.probes, s.requests, s.tracked, s.category, s.score_group,
            s.score_raw, s.score_raw_norm, s.min_prefix_len, s.avg_suggest_pos, s.prefix_hit_share, s.prefixes_total,
            s.top10_installs_median, s.top10_reviews_median, s.title_match_share, s.total_results, s.installs_spread,
            s.suggest_geo_count, s.words, s.chars, s.is_brand, s.is_translit, s.kp_volume, s.asa_popularity, s.trends_index, s.serp_date,
            m.popularity_score, m.confidence_level, m.impressions_est, m.impressions_lo, m.impressions_hi, m.bucket,
            m.model_version, m.model_kind, m.calibrated_at, m.seasonal_mult,
            dk.source
       FROM kw_signals s
       JOIN (SELECT keyword_id, MAX(day) md FROM kw_signals WHERE geo=? AND day<=? GROUP BY keyword_id) f
         ON f.keyword_id=s.keyword_id AND f.md=s.day
       JOIN keywords k ON k.keyword_id=s.keyword_id
       LEFT JOIN kw_metrics m ON m.keyword_id=s.keyword_id AND m.geo=s.geo AND m.day=?
       LEFT JOIN disc_keywords dk ON dk.geo=s.geo AND dk.keyword=k.term
      WHERE s.geo=?
      ORDER BY m.popularity_score DESC, s.score_raw DESC`, geo, date, day, geo)
    .map((r) => ({
      ...r,
      score_raw: r3(r.score_raw), score_raw_norm: r3(r.score_raw_norm), avg_suggest_pos: r3(r.avg_suggest_pos),
      prefix_hit_share: r3(r.prefix_hit_share), title_match_share: r3(r.title_match_share), installs_spread: r3(r.installs_spread),
      popularity_score: r.popularity_score == null ? null : Math.round(r.popularity_score * 10) / 10,
      kp_volume: r3(r.kp_volume),
      source: r.source || (r.tracked ? 'watch' : null),
    }));

  // Слова словаря, по которым score ещё не посчитан, — тоже в таблице, с замком.
  const pending = all(d,
    `SELECT dk.keyword AS term, dk.source FROM disc_keywords dk
      WHERE dk.geo=? AND dk.dead=0
        AND NOT EXISTS (SELECT 1 FROM keywords k JOIN kw_signals s ON s.keyword_id=k.keyword_id AND s.geo=dk.geo WHERE k.term=dk.keyword)`, geo);

  // Ответы подсказок по снятым префиксам — один раз на префикс: префиксы разных фраз пересекаются.
  const since = daysAgoUTC(cfg.score.suggest_cache_days, new Date(`${date}T12:00:00Z`));
  const prefixes = new Set();
  for (const k of keywords) {
    const chars = Array.from(k.term);
    for (const [i, , kind] of JSON.parse(k.probes || '[]')) if (kind === 's' || kind === 'a') prefixes.add(chars.slice(0, i).join(''));
  }
  const suggest = {};
  const q = d.prepare(
    `SELECT suggestion FROM raw_suggest WHERE geo=? AND prefix=? AND snapshot_date=(
        SELECT MAX(snapshot_date) FROM raw_suggest WHERE geo=? AND prefix=? AND snapshot_date BETWEEN ? AND ?)
      ORDER BY position`);
  for (const p of prefixes) suggest[p] = q.all(geo, p, geo, p, since, date).map((r) => r.suggestion);

  const withRaw = keywords.filter((k) => k.score_raw != null);
  const positive = withRaw.filter((k) => k.score_raw > 0);
  const rho = (a, b, rows) => {
    const rs = rows.filter((k) => k[a] != null && k[b] != null);
    return rs.length >= 10 ? r3(spearman(rs.map((k) => k[a]), rs.map((k) => k[b]))) : null;
  };
  const diagnostics = {
    n: withRaw.length, n_positive: positive.length,
    // Среди всплывших фраз: связь с длиной — смещение формулы; связь с установками топ-10 — грубая
    // проверка здравого смысла, не валидация (установки топ-10 — не объём поиска).
    rho_len_spec: rho('score_raw', 'chars', positive), rho_len_norm: rho('score_raw_norm', 'chars', positive),
    rho_inst_spec: rho('score_raw', 'top10_installs_median', positive), rho_inst_norm: rho('score_raw_norm', 'top10_installs_median', positive),
    min_prefix: Object.entries(positive.reduce((acc, k) => { acc[k.min_prefix_len] = (acc[k.min_prefix_len] || 0) + 1; return acc; }, {}))
      .map(([len, n]) => ({ len: Number(len), n })).sort((a, b) => a.len - b.len),
    zero: withRaw.length - positive.length,
    by_method: all(d, `SELECT score_method AS method, COUNT(*) n FROM kw_signals WHERE geo=? GROUP BY score_method`, geo),
    length_points: positive.map((k) => ({ term: k.term, chars: k.chars, raw: k.score_raw, norm: k.score_raw_norm })),
  };

  const models = all(d,
    `SELECT model_version, kind, stage, trained_at, window_from, window_to, metric_kind, n_rows, n_terms, n_apps, apps,
            spearman, bucket_hit, sum_ratio, censored_below_share, validation, active, note
       FROM kw_models WHERE geo=? ORDER BY trained_at DESC, kind DESC`, geo)
    .map((m) => ({ ...m, apps: JSON.parse(m.apps || '[]'), validation: JSON.parse(m.validation || '{}') }));
  const ctr = all(d, `SELECT fitted_at, ctr1, alpha, n, positions, source FROM kw_ctr_curve WHERE geo=? ORDER BY fitted_at DESC LIMIT 6`, geo);

  const consoleApps = all(d,
    `SELECT app_id, metric_kind, COUNT(*) rows, SUM(is_censored) censored, COUNT(DISTINCT term) terms,
            MIN(day) first, MAX(day) last, SUM(visitors) visitors, SUM(unique_clicks) conversions
       FROM console_search_terms WHERE geo=? GROUP BY app_id, metric_kind`, geo)
    .map((a) => ({ ...a, cvr: a.visitors > 0 ? r3(a.conversions / a.visitors) : null }));

  const runs = all(d, `SELECT day, status, requests, cache_hits, errors, shape_errors, empty, notes, started_at, finished_at
                         FROM kw_runs WHERE geo=? AND stage='kw-signals' ORDER BY started_at DESC LIMIT 5`, geo);
  const fetch30 = one(d, `SELECT COUNT(*) n, SUM(ok=0) failed FROM raw_suggest_fetch WHERE geo=? AND snapshot_date>=?`,
    geo, daysAgoUTC(30, new Date(`${date}T12:00:00Z`)));
  const geoCheck = one(d, `SELECT checked_at, hl, prefix, expect, found, suggestions, error FROM kw_geo_check WHERE geo=? ORDER BY checked_at DESC LIMIT 1`, geo);
  const serpRun = one(d, `SELECT snapshot_date, empty_pct, status FROM runs WHERE geo=? AND stage='keyword-serp' ORDER BY started_at DESC LIMIT 1`, geo);

  return {
    geo, hl: primaryHl(geo), metrics_day: day, maturity,
    keywords, pending: pending.map((p) => p.term), suggest, diagnostics, models, ctr, consoleApps,
    health: {
      runs, suggest_fetch_30d: fetch30, geo_check: geoCheck ? { ...geoCheck, suggestions: JSON.parse(geoCheck.suggestions || '[]') } : null,
      serp: serpRun || null,
    },
  };
}

export function collect(date, geos = null) {
  const d = kwDb();
  const cfg = kwConfig();
  const list = geos || all(d, `SELECT DISTINCT geo FROM kw_signals UNION SELECT DISTINCT geo FROM console_search_terms`).map((r) => r.geo);
  if (!list.length) list.push(referenceGeo());
  const names = new Intl.DisplayNames(['ru'], { type: 'region' });
  return {
    meta: { date, generated_at: new Date().toISOString(), reference_geo: referenceGeo() },
    config: {
      buckets_month: cfg.buckets_month, validation: cfg.validation, ctr: cfg.ctr, score: cfg.score,
      calibration: { window_days: cfg.calibration.window_days, holdout_days: cfg.calibration.holdout_days, min_rows_gbm: cfg.calibration.min_rows_gbm, min_apps_gbm: cfg.calibration.min_apps_gbm },
    },
    stages: STAGES,
    geos: list.sort((a, b) => (a === referenceGeo() ? -1 : b === referenceGeo() ? 1 : a.localeCompare(b)))
      .map((g) => ({ geo: g, name: names.of(g), active: config().geos.geos.find((x) => x.geo === g)?.active ?? false })),
    geoData: Object.fromEntries(list.map((g) => [g, collectGeo(d, g, date)])),
  };
}

export function render(data, { live = false } = {}) {
  const tpl = fs.readFileSync(path.join(ROOT, 'src', 'report', 'kw-volume.html'), 'utf8');
  const json = JSON.stringify(packRows(data)).replace(/</g, '\\u003c');
  return tpl.replace('__KW_DATA__', () => json).replace('__UNPACK_JS__', () => UNPACK_JS).replace('__KW_LIVE__', live ? 'true' : 'false');
}

export async function run({ date, geos = null }) {
  const data = collect(date, geos);
  const fragment = render(data);
  const outDir = path.join(ROOT, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'kw-volume-artifact.html'), fragment, 'utf8');
  fs.writeFileSync(path.join(outDir, 'kw-volume.html'),
    `<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body style="margin:0">\n${fragment}\n</body>\n</html>`, 'utf8');
  const n = Object.values(data.geoData).reduce((a, g) => a + g.keywords.length, 0);
  log(`  отчёт: out/kw-volume.html (${(fragment.length / 1024).toFixed(0)} КБ), гео ${Object.keys(data.geoData).join(', ')}, слов ${n}`);
  return { keywords: n };
}
