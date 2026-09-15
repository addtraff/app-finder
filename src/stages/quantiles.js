// Источник ВСЕХ порогов (принцип 9: абсолютные числа в конфиге не допускаются).
// scope='geo'  — по всем снятым в гео за последний полный день (нужен воронке до кластеризации);
// scope='niche' — по приложениям ниши (нужен скору и автоматическим понижениям).
import { db, startRun, finishRun } from '../lib/db.js';
import { referenceGeo } from '../lib/config.js';
import { quantileSet, log } from '../lib/util.js';
import { ageMonthsAt } from '../lib/dates.js';

const GEO_METRICS = [
  'installs', 'score', 'ratings_count', 'installs_per_rating', 'days_since_update',
  'age_months', 'size_mb', 'description_len', 'screenshots_count', 'iap_max_usd',
  'localized_geo_count',
];
const NICHE_METRICS = [
  'installs', 'score', 'ratings_count', 'installs_per_rating', 'days_since_update',
  'age_months', 'size_mb', 'description_len', 'iap_max_usd', 'index_gap',
  'growth', 'growth_s', 'pain_fit', 'src_ads_pct', 'crash_pct', 'template_review_pct',
  'review_lang_mismatch', 'wom_index', 'door', 'localized_geo_count', 'installs_growth_1d',
];

export function geoRows(d, geo, date) {
  const ref = referenceGeo();
  // localized_geo_count (правка A1): число гео, где заголовок или краткое описание
  // отличаются от версии с hl=en в референсном гео.
  return d.prepare(
    `WITH refcard AS (
       SELECT p.app_id, p.title_hash, p.short_desc_hash
         FROM raw_app_page p
         JOIN (SELECT app_id, MAX(snapshot_date) md FROM raw_app_page
                WHERE geo = ? AND hl = 'en' GROUP BY app_id) f
           ON f.app_id = p.app_id AND f.md = p.snapshot_date
        WHERE p.geo = ? AND p.hl = 'en'
     ),
     loc AS (
       SELECT p.app_id, COUNT(DISTINCT p.geo) AS n
         FROM raw_app_page p
         JOIN refcard r ON r.app_id = p.app_id
         JOIN (SELECT app_id, geo, hl, MAX(snapshot_date) md FROM raw_app_page
                GROUP BY app_id, geo, hl) f
           ON f.app_id = p.app_id AND f.geo = p.geo AND f.hl = p.hl AND f.md = p.snapshot_date
        WHERE p.title_hash <> r.title_hash OR p.short_desc_hash <> r.short_desc_hash
        GROUP BY p.app_id
     )
     SELECT p.app_id,
            COALESCE(loc.n, CASE WHEN refcard.app_id IS NULL THEN NULL ELSE 0 END) AS localized_geo_count,
            p.max_installs AS installs,
            p.score,
            p.ratings_count,
            CASE WHEN p.ratings_count > 0 THEN CAST(p.max_installs AS REAL) / p.ratings_count END AS installs_per_rating,
            CASE WHEN p.updated_ts IS NOT NULL THEN (julianday(?) - julianday(p.updated_ts/1000, 'unixepoch')) END AS days_since_update,
            p.released, p.hl,
            p.size_mb, p.description_len, p.screenshots_count, p.iap_max_usd
       FROM raw_app_page p
       LEFT JOIN loc ON loc.app_id = p.app_id
       LEFT JOIN refcard ON refcard.app_id = p.app_id
      WHERE p.geo=? AND p.snapshot_date=? AND p.hl=(SELECT MIN(hl) FROM raw_app_page x WHERE x.app_id=p.app_id AND x.geo=p.geo AND x.snapshot_date=p.snapshot_date)`
  ).all(ref, ref, date, geo, date)
    // Возраст — в JS: julianday() не понимает ни «May 23, 2025», ни локализованные даты.
    .map(({ released, hl, ...r }) => ({ ...r, age_months: ageMonthsAt(released, hl, date) }));
}

function write(d, scope, scopeId, geo, date, rows, metrics) {
  const ins = d.prepare(`INSERT OR REPLACE INTO niche_quantiles
    (scope, scope_id, geo, metric, snapshot_date, p01, p10, p25, p50, p75, p90, p95, p99, n)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let written = 0;
  d.transaction(() => {
    for (const m of metrics) {
      const q = quantileSet(rows.map((r) => r[m]));
      if (!q) continue;
      ins.run(scope, scopeId, geo, m, date, q.p01, q.p10, q.p25, q.p50, q.p75, q.p90, q.p95, q.p99, q.n);
      written++;
    }
  })();
  return written;
}

export async function run({ geo, date, runId, scope = 'geo', cycle = 'discovery' }) {
  const d = db();
  startRun(runId, `quantiles-${scope}`, geo, cycle, date);
  let written = 0;

  if (scope === 'geo') {
    const rows = geoRows(d, geo, date);
    written = write(d, 'geo', geo, geo, date, rows, GEO_METRICS);
    log(`  квантили гео ${geo}: ${written} метрик по ${rows.length} приложениям`);
  } else {
    const rows = d.prepare(
      `SELECT * FROM metrics_app_geo WHERE geo=? AND snapshot_date=? AND niche_id IS NOT NULL`
    ).all(geo, date);
    const byNiche = new Map();
    for (const r of rows) {
      if (!byNiche.has(r.niche_id)) byNiche.set(r.niche_id, []);
      byNiche.get(r.niche_id).push(r);
    }
    // Те же метрики в разрезе гео: очередь K7 и автопонижения смотрят на гео-квантили,
    // когда ниша ещё не посчитана.
    if (rows.length) written += write(d, 'geo', geo, geo, date, rows, NICHE_METRICS);
    const doorRows = d.prepare(`SELECT niche_id, door FROM metrics_niche_geo WHERE geo=? AND snapshot_date=?`).all(geo, date);
    for (const [nicheId, list] of byNiche) {
      if (list.length < 5) continue; // мало данных — пороги берутся из гео
      written += write(d, 'niche', nicheId, geo, date, list, NICHE_METRICS);
    }
    // Квантиль door по всем нишам гео — нужен для «ниша с door выше p90 -> уровень C».
    written += write(d, 'geo', `${geo}:niches`, geo, date, doorRows, ['door']);
    log(`  квантили ниш ${geo}: ${byNiche.size} ниш, ${written} записей`);
  }

  finishRun(runId, `quantiles-${scope}`, geo, { notes: `${written} метрик` });
  return { written };
}

// Порог берётся из ниши, если она посчитана, иначе из гео. Никаких абсолютных чисел.
const cache = new Map();
export function q(scope, scopeId, geo, metric, date) {
  const key = `${scope}|${scopeId}|${geo}|${metric}|${date}`;
  if (cache.has(key)) return cache.get(key);
  const row = db().prepare(
    `SELECT * FROM niche_quantiles WHERE scope=? AND scope_id=? AND geo=? AND metric=? AND snapshot_date<=?
      ORDER BY snapshot_date DESC LIMIT 1`
  ).get(scope, scopeId, geo, metric, date);
  cache.set(key, row || null);
  return row || null;
}
export function qv(scopeId, geo, metric, date, level, { nicheFirst = true } = {}) {
  let row = nicheFirst && scopeId ? q('niche', scopeId, geo, metric, date) : null;
  if (!row) row = q('geo', geo, geo, metric, date);
  return row ? row[level] : null;
}
export function clearQCache() { cache.clear(); }
